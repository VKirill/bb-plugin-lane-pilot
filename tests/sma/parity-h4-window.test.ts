import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../../server";
import { PROBES } from "../../src/rooms/native-agent/server/helper-probe";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../../src/rooms/native-agent/native-session-hooks";
import { buildTaskBoard } from "../../src/rooms/runs/server/task-board";
import { createRun, openDatabase, savePrototypeConfig, setRunThread } from "../../src/rooms/plugin-db";
import { proposeDraft } from "../../src/rooms/tasks/server";
import type { TaskV2 } from "../../src/rooms/contracts";
import { hookEnv } from "../hook-env";
import { useGuardSync } from "../guard-pool";

function db0() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, db: openDatabase(bb) };
}

const fullTask = (id: string): TaskV2 => ({ schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: `feature:${id}`, id, title: `Write ${id}`, risk: "low", lane: "writer", project_cwd: "/tmp/w",
  read_first: [], interfaces: ["file exists"], invariants: ["only its own file"], out_of_scope: ["other files"], expected_outputs: [`${id}.txt`], owns_paths: [`${id}.txt`],
  never_touch: [".git/**"], depends_on: [], objective: `Write ${id}.txt`, acceptance: ["file is present"], verify: "none", verification: [] });

async function pmWorld() {
  const projectId = "proj-a";
  const pmThreadId = "pm-h4";
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadId === pmThreadId ? { role: "pm", lanePilotRunId: "run-h4" } : {}),
      get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId }),
      list: async () => [] as never,
    } },
  } as never);
  const db = openDatabase(bb);
  savePrototypeConfig(db, { projectId, hostId: "host-h4", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/w", pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "c" });
  createRun(db, "run-h4", projectId, "bb", null);
  setRunThread(db, "run-h4", pmThreadId);
  await plugin(bb);
  const tool = async (name: string, params: unknown) => String(await harness.behavior.callAgentTool(name, params as never, { threadId: pmThreadId, projectId }));
  return { bb, harness, db, projectId, pmThreadId, tool };
}

describe("[sma:m_sw_chat_draft] [sma:m_sw_batch_draft] the PM proposes a draft from its own tool list", () => {
  it("lane_pilot_propose is on the PM's folded list, registered, and one task or a batch stores a draft card that starts nothing", async () => {
    const w = await pmWorld();
    expect(NATIVE_LP_BRIDGE_PM_TOOLS).toContain("lane_pilot_propose");
    const registered = w.harness.registrations.agentTools.map((tool) => tool.name);
    expect(registered).toContain("lane_pilot_propose");
    // One task: a draft card in words, nothing enqueued.
    const single = await w.tool("lane_pilot_propose", { task: fullTask("one-1") });
    expect(single).toContain("::lane-draft");
    expect(single).toContain("задачу");
    const drafts = w.db.prepare("SELECT * FROM lane_pilot_task_draft").all() as Array<{ kind: string; contracts_json: string }>;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.kind).toBe("task");
    // A batch of two: one draft of kind batch, still nothing dispatched.
    const batch = await w.tool("lane_pilot_propose", { tasks: [fullTask("b-1"), fullTask("b-2")] });
    expect(batch).toContain("пачку из 2 задач");
    const all = w.db.prepare("SELECT * FROM lane_pilot_task_draft ORDER BY created_at").all() as Array<{ kind: string }>;
    expect(all.map((row) => row.kind)).toEqual(["task", "batch"]);
    expect((w.db.prepare("SELECT count(*) AS n FROM lane_pilot_task").get() as { n: number }).n).toBe(0);
    await w.harness.lifecycle.dispose();
  });
});

describe("[sma:m_sw_unit_card] a batch draft is one card on the board", () => {
  const draft = (db: ReturnType<typeof db0>["db"], state: "proposed" | "partial" | "created") => {
    const d = proposeDraft(db, { runId: "run-b", projectId: "proj-b", threadId: "pm-b", kind: "batch", contracts: [fullTask("x-1"), fullTask("x-2"), fullTask("x-3")] });
    if (state !== "proposed") {
      const results = state === "created" ? [{ state: "created", taskId: "x-1" }, { state: "created", taskId: "x-2" }, { state: "created", taskId: "x-3" }]
        : [{ state: "created", taskId: "x-1" }, { state: "failed", reason: "lint said no" }, { state: "failed", reason: "lint said no" }];
      db.prepare("UPDATE lane_pilot_task_draft SET state=?, results_json=? WHERE id=?").run(state, JSON.stringify(results), d.id);
    }
    return d;
  };

  it("proposed is queued, partial is blocked with the failed count, created is done", () => {
    const { db } = db0();
    draft(db, "proposed");
    draft(db, "partial");
    draft(db, "created");
    const items = buildTaskBoard(db, { projectId: "proj-b", doneSince: Date.now() - 3_600_000 }, []);
    const cards = items.filter((item) => item.kind === "batch");
    expect(cards).toHaveLength(3);
    const byState = Object.fromEntries(cards.map((card) => [card.state, card]));
    expect(byState.proposed).toMatchObject({ column: "queued", phase: "queued", title: "Пачка из 3 задач" });
    expect(byState.partial).toMatchObject({ column: "blocked", phase: "blocked" });
    expect(byState.partial!.detail).toContain("2 из 3");
    expect(byState.created).toMatchObject({ column: "done", phase: "accepted" });
    // The objective of the draft is the card's title when it has one.
    db.prepare("UPDATE lane_pilot_task_draft SET objective=? WHERE state='proposed'").run("Ship the batch", );
    const named = buildTaskBoard(db, { projectId: "proj-b", doneSince: 0 }, []).find((item) => item.kind === "batch" && item.state === "proposed");
    expect(named!.title).toBe("Ship the batch");
    db.close();
  });
});

describe("[sma:m_pr_doc_drill] the role cell is proved by the spawn metadata, not the reply alone", () => {
  const check = (PROBES["documentary.role"] as { check: (args: never) => Promise<{ ok: boolean; reason?: string }> }).check;
  const bbWith = (role: string | null) => ({
    sdk: { threads: { getPluginMetadata: async () => (role === null ? null : { role }) } },
    log: { warn: () => undefined, info: () => undefined, error: () => undefined },
    hosts: { experimental_client: () => ({ call: async () => ({ stdout: "" }) }) },
  });

  it("passes when the thread's plugin metadata carries pm-reader and fails with the real role named otherwise", async () => {
    const args = (bb: unknown) => ({ bb, threadId: "thr", hostId: "h", workspace: "/w", output: "pm-reader" }) as never;
    expect(await check(args(bbWith("pm-reader")))).toEqual({ ok: true });
    const wrong = await check(args(bbWith("writer")));
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toContain("writer");
    const missing = await check(args(bbWith(null)));
    expect(missing.ok).toBe(false);
  });
});

// The real guard process, once per case (SMA d_project_planning): the PM writes the confirmed home's planning
// folders only, text files only; a sibling folder, a non-text file and an unconfirmed home are refused.
const guard = join(process.cwd(), "lane-stack/hooks/guard_shell.py");
const runGuard = useGuardSync(guard);
// Not under /tmp: the guard lets the PM write any temp file anyway (lane-pilot-pm temp roots).
const checkout = mkdtempSync(join(tmpdir(), "lp-h4-checkout-"));
const home = mkdtempSync(join(homedir(), "lp-h4-home-"));
const plain = mkdtempSync(join(homedir(), "lp-h4-plain-"));
execFileSync("git", ["-C", home, "init", "-q"]);
writeFileSync(join(home, "README.md"), "x\n");
execFileSync("git", ["-C", home, "add", "README.md"]);
execFileSync("git", ["-C", home, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"]);

const edit = (path: string, env: Record<string, string> = {}) => runGuard({
  input: JSON.stringify({ agent_type: "lane-pilot-pm", tool_name: "Edit", tool_input: { file_path: path }, cwd: checkout }),
  env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }),
});

describe("[sma:d_project_planning] the PM's editor writes under the confirmed planning home only", () => {
  const withHome = { LANE_PILOT_PLANNING_HOME: home };

  it("lets Edit/Write through inside .agents/phases, .agents/planning, .agents/todos and .agents/notes of the home", () => {
    for (const folder of ["phases", "planning", "todos", "notes"]) {
      const verdict = edit(join(home, ".agents", folder, "note.md"), withHome);
      expect(verdict.status, `${folder}: ${verdict.stdout}`).toBe(0);
    }
  });

  it("refuses a sibling folder of the home, a non-text file in a planning folder, and the home itself when it is not a git work tree", () => {
    // Sibling folder: not one of the four.
    expect(edit(join(home, ".agents", "sma", "note.md"), withHome).status).toBe(2);
    expect(edit(join(home, "src", "code.ts"), withHome).status).toBe(2);
    // A planning folder, but not a text file.
    expect(edit(join(home, ".agents", "todos", "run.sh"), withHome).status).toBe(2);
    // An unconfirmed home: a plain folder, no git work tree — the guard's own check refuses it.
    const unconfirmed = edit(join(plain, ".agents", "todos", "note.md"), { LANE_PILOT_PLANNING_HOME: plain });
    expect(unconfirmed.status).toBe(2);
    // No home at all: outside the checkout is refused as before.
    expect(edit(join(home, ".agents", "todos", "note.md")).status).toBe(2);
  });
});
