import { execFileSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { ceilingLine, tailWords } from "../../src/rooms/work-graph";
import { workerSecretReach } from "../../src/rooms/verification";
import { explainCatalog, explainWord, firstSection, VERDICT_LIST_COMMAND, verdictFiles, verdictInventory } from "../../src/rooms/tools";
import { DRAFT_KEEP_MS, MAX_DRAFT_CONTRACTS, createFromDraft, getDraft, proposeDraft } from "../../src/rooms/tasks/server";
import { createAttempt, createRun, createTask, freezeRunBinding, migrations, openDatabase, saveProjectSetting, savePrototypeConfig, setAttemptWorkspace, setRunThread } from "../../src/rooms/plugin-db";
import { landingOf } from "../../src/rooms/rollback";
import { getAttemptChange } from "../../src/rooms/rollback/server";
import { writeTaskOutcome } from "../../src/rooms/writer/server/services/attempt-reactions";
import { snapshotDryRun } from "../../src/rooms/host-worker";
import { workGraphRpc } from "../../src/rooms/work-graph/server";
import { registerCli } from "../../src/rooms/tools/server";
import { createCore } from "../../src/rooms/core/server/core";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import plugin from "../../server";
import { withOwnWorktrees } from "../own-worktree-host";
import type { TaskV2 } from "../../src/rooms/contracts";
import type { Services } from "../../server";
import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The worker probe's `sudo test -r`: readable paths are whatever the test puts in `readable`.
const calls: Array<{ program: string; args: string[] }> = [];
const readable = new Set<string>();
vi.mock("@lane-pilot/kit", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, spawnAsync: async (program: string, args: string[]) => {
    calls.push({ program, args });
    return { status: readable.has(args.at(-1) ?? "") ? 0 : 1, stdout: "", stderr: "" };
  } };
});

describe("parity d10-rest-2", () => {
  it("[sma:sc_spend] ceilingLine({turns:4}, {monthUsd:45, cap:50}) names 4 of 5 turns and marks the money over 90 percent; with cap null it shows the spend only", () => {
    const line = ceilingLine({ turns: 4 }, { monthUsd: 45, cap: 50 });
    expect(line.turns).toEqual({ n: 4, max: 5 });
    expect(line.monthUsd).toBe(45);
    expect(line.hot).toBe(true);
    const open = ceilingLine({ turns: null }, { monthUsd: 45, cap: null });
    expect(open.turns).toBeNull();
    expect(open.cap).toBeNull();
    expect(open.hot).toBe(false);
    expect(ceilingLine({ turns: 4 }, { monthUsd: 10, cap: 50 }).hot).toBe(false);
  });

  // The event shape is the one tests/errand-episode.test.ts feeds from real threads.events.list rows:
  // { type: "item/completed", seq, data: { item: { type: "toolCall", server, tool, arguments, status } } }, and a call is
  // several events (item/started, item/updated, item/completed).
  const completed = (seq: number, item: Record<string, unknown>) => ({ type: "item/completed", seq, data: { item } });
  const realEvents = [
    { type: "item/started", seq: 1, data: { item: { type: "toolCall", server: "bb", tool: "read", arguments: { path: "a.ts" }, status: "inProgress" } } },
    completed(2, { type: "toolCall", server: "bb", tool: "read", arguments: { path: "a.ts" }, status: "completed" }),
    { type: "item/updated", seq: 3, data: { item: { type: "commandExecution", command: "npm test", status: "inProgress" } } },
    completed(4, { type: "commandExecution", command: "npm test", exitCode: 0, status: "completed" }),
    completed(5, { type: "fileChange", changes: {} }),
    completed(6, { type: "mysteryType", tool: "x" }),
    completed(7, { type: "agentMessage", text: "done" }),
  ];

  it("[sma:m_ws_attempt_log] tailWords reads real events: a call counts once (completed only), reads, runs, edits and answers become lines, an unknown type is dropped, 8 at most", () => {
    expect(tailWords(realEvents)).toEqual(["читает файл…", "запускает проверку", "правит файл…", "пишет ответ"]);
    const many = Array.from({ length: 12 }, (_, index) => completed(index, { type: "commandExecution", command: `check ${index}` }));
    expect(tailWords(many)).toHaveLength(8);
    expect(tailWords([])).toEqual([]);
  });

  it("[sma:m_ws_attempt_log] the attempt_log_tail RPC answers the latest attempt's thread in words, reads 40 events once, and refuses a run of another project when the window names its project", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-log", "proj-a", "bb", "/tmp/w");
    createTask(db, { id: "t-log", runId: "run-log", kind: "bb", contract: {} });
    createAttempt(db, { id: "att-log", runId: "run-log", taskId: "t-log" });
    db.prepare("UPDATE lane_pilot_attempt SET thread_id=? WHERE id=?").run("thr-w", "att-log");
    const asked: unknown[] = [];
    const host = { sdk: { threads: { events: { list: async (query: unknown) => { asked.push(query); return [...realEvents].reverse(); } } } } };
    const handlers = workGraphRpc({ bb: host as never, db } as never, { tokenCursorRow: (() => null) as never });
    const own = await handlers.attempt_log_tail({ runId: "run-log", taskId: "t-log", projectId: "proj-a" });
    expect(own).toEqual({ threadId: "thr-w", lines: ["читает файл…", "запускает проверку", "правит файл…", "пишет ответ"] });
    expect(asked).toEqual([{ threadId: "thr-w", order: "desc", limit: "40" }]);
    await expect(handlers.attempt_log_tail({ runId: "run-log", taskId: "t-log", projectId: "proj-b" })).rejects.toThrow(/run_not_in_project/);
    expect(asked).toHaveLength(1);
    // No project named (an old window): as before.
    expect((await handlers.attempt_log_tail({ runId: "run-log", taskId: "t-log" })).lines).toHaveLength(4);
    db.close?.();
  });

  it("[sma:k_v_explain + k_lib_explain] explain a verb gives summary and usage, a topic gives the doc's first section, an unknown word yields the catalog", () => {
    const verbs = [{ name: "memory-eval", summary: "score the memory", usage: "bb lane-pilot memory-eval <project>" }];
    const docs = [
      { file: "docs/guide/memory.md", text: "---\ntitle: Memory\ntopic: memory\n---\n# Memory\n\nOne fact store.\n\n## Details\n\nlong part\n", topic: "memory" },
      { file: "docs/guide/flow.md", text: "---\ntitle: Flow\ntopic: flow\n---\n# Flow\n\nUses `memory-eval`.\n", topic: "flow" },
    ];
    const verb = explainWord("memory-eval", verbs, docs);
    expect(verb?.kind).toBe("verb");
    expect(verb?.text).toContain("score the memory");
    expect(verb?.text).toContain("bb lane-pilot memory-eval");
    expect(verb?.source).toBe("docs/guide/flow.md");
    const topic = explainWord("memory", verbs, docs);
    expect(topic?.kind).toBe("topic");
    expect(topic?.text).toContain("One fact store.");
    expect(topic?.text).not.toContain("long part");
    expect(firstSection(docs[0]!.text)).toContain("# Memory");
    expect(explainWord("zzz", verbs, docs)).toBeNull();
    expect(explainCatalog(verbs, docs)).toEqual(["flow", "memory", "memory-eval"]);
  });

  it("[sma:k_pl_spikes] the verdict inventory lists each spike and sketch with question and verdict; missing verdict is open", () => {
    const root = mkdtempSync(join(tmpdir(), "verdicts-"));
    mkdirSync(join(root, ".agents/planning/spikes"), { recursive: true });
    mkdirSync(join(root, ".agents/planning/sketches"), { recursive: true });
    writeFileSync(join(root, ".agents/planning/spikes/s1.md"), "---\nquestion: can the queue hold 1k tasks?\nverdict: yes\n---\n# spike\n");
    writeFileSync(join(root, ".agents/planning/sketches/home.html"), "---\ntitle: home sketch\n---\n<html/>\n");
    // The plugin runs this command in the project's checkout on its own machine (a host call) and reads only what comes back.
    const listed = (cwd: string) => verdictFiles(execFileSync("/bin/bash", ["-c", VERDICT_LIST_COMMAND], { cwd, encoding: "utf8" }));
    const rows = verdictInventory(listed(root));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.kind === "spike")).toMatchObject({ file: ".agents/planning/spikes/s1.md", question: "can the queue hold 1k tasks?", verdict: "yes" });
    expect(rows.find((r) => r.kind === "sketch")).toMatchObject({ file: ".agents/planning/sketches/home.html", question: "home sketch", verdict: "open" });
    expect(verdictInventory(listed(mkdtempSync(join(tmpdir(), "verdicts-empty-"))))).toEqual([]);
  });

  it("[sma:k_pl_spikes] bb lane-pilot planning verdicts <project> asks the project's own machine, prints the inventory and exits 0; without a project it exits 1", async () => {
    const root = mkdtempSync(join(tmpdir(), "verdicts-cli-"));
    mkdirSync(join(root, ".agents/planning/spikes"), { recursive: true });
    writeFileSync(join(root, ".agents/planning/spikes/s1.md"), "---\nquestion: can the queue hold 1k tasks?\nverdict: yes\n---\n# spike\n");
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId: "proj_v", hostId: "host-far", pmWorkspacePath: root, writerWorkspacePath: root, pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "m" });
    const core = createCore(bb, db);
    // The machine that holds the checkout answers the call; the hub's own process opens no project file.
    const asked: Array<{ hostId: string; cwd: string }> = [];
    core.host = { call: async (_method: string, input: { requestedHostId: string; command: string; cwd: string }) => {
      asked.push({ hostId: input.requestedHostId, cwd: input.cwd });
      return { hostId: input.requestedHostId, exitCode: 0, stderr: "", stdout: execFileSync("/bin/bash", ["-c", input.command], { cwd: input.cwd, encoding: "utf8" }) };
    } } as never;
    registerCli(core, {} as Services, migrations);
    const ran = await harness.behavior.runCli(["planning", "verdicts", "proj_v"]);
    expect(ran.exitCode).toBe(0);
    expect(ran.stdout).toContain("can the queue hold 1k tasks?");
    expect(ran.stdout).toContain("yes");
    expect(asked).toEqual([{ hostId: "host-far", cwd: root }]);
    expect((await harness.behavior.runCli(["planning"])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["planning", "verdicts"])).exitCode).toBe(1);
    expect((await harness.behavior.runCli(["planning", "verdicts", "proj_unknown"])).exitCode).toBe(1);
  });


  // ---- task drafts (n832, n833) ----

  const memoryDb = () => { const db = new Database(":memory:"); for (const statement of migrations) db.exec(statement); return db; };
  const queued = (contract: unknown) => ({ runId: "r", taskId: String((contract as { id: string }).id), state: "queued" });

  it("[sma:m_sw_batch_draft] a throw and a rejection in the middle are recorded with their reason, never as an id; pressing again creates only the contracts not yet created", async () => {
    const db = memoryDb();
    const draft = proposeDraft(db, { runId: "r", projectId: "p", threadId: "t", kind: "batch", contracts: [1, 2, 3, 4, 5].map((n) => ({ id: `t-${n}` })) });
    const sent: string[] = [];
    const first = await createFromDraft(db, draft.id, async (contract) => {
      const id = (contract as { id: string }).id;
      sent.push(id);
      if (id === "t-3") throw new Error("host went away");
      if (id === "t-4") return { runId: "r", state: "rejected", reason: "owns_paths overlap" };
      return queued(contract);
    });
    expect(sent).toEqual(["t-1", "t-2", "t-3", "t-4", "t-5"]);
    expect(first.state).toBe("partial");
    expect(first.taskIds).toEqual(["t-1", "t-2", "t-5"]);
    expect(first.failed).toEqual([{ index: 2, reason: "host went away" }, { index: 3, reason: "owns_paths overlap" }]);
    const stored = getDraft(db, draft.id)!;
    expect(stored.state).toBe("partial");
    expect(stored.taskIds).not.toContain("");
    expect(stored.results[2]).toEqual({ state: "failed", reason: "host went away" });
    sent.length = 0;
    const second = await createFromDraft(db, draft.id, async (contract) => { sent.push((contract as { id: string }).id); return queued(contract); });
    expect(sent).toEqual(["t-3", "t-4"]);
    expect(second.state).toBe("created");
    expect(second.taskIds).toEqual(["t-1", "t-2", "t-3", "t-4", "t-5"]);
    expect(getDraft(db, draft.id)!.state).toBe("created");
    sent.length = 0;
    expect((await createFromDraft(db, draft.id, async (contract) => { sent.push("again"); return queued(contract); })).state).toBe("already_created");
    expect(sent).toEqual([]);
    db.close();
  });

  it("[sma:m_sw_chat_draft + m_sw_batch_draft] two overlapping presses create each contract once; the second reads already_created", async () => {
    const db = memoryDb();
    const draft = proposeDraft(db, { runId: "r", projectId: "p", threadId: "t", contracts: [{ id: "a" }, { id: "b" }, { id: "c" }] });
    const sent: string[] = [];
    const slow = async (contract: unknown) => { sent.push((contract as { id: string }).id); await new Promise((done) => setTimeout(done, 15)); return queued(contract); };
    const [one, two] = await Promise.all([createFromDraft(db, draft.id, slow), createFromDraft(db, draft.id, slow)]);
    expect(sent).toEqual(["a", "b", "c"]);
    expect([one.state, two.state].sort()).toEqual(["already_created", "created"]);
    expect(two.taskIds).toEqual(["a", "b", "c"]);
    db.close();
  });

  it("[sma:m_sw_batch_draft] the server bounds a batch at 50 contracts and the bytes of their JSON, and a new proposal deletes drafts untouched for 30 days", () => {
    const db = memoryDb();
    expect(MAX_DRAFT_CONTRACTS).toBe(50);
    const fifty = Array.from({ length: 50 }, (_, i) => ({ id: `t-${i}` }));
    expect(proposeDraft(db, { runId: null, projectId: "p", threadId: null, contracts: fifty }).contracts).toHaveLength(50);
    expect(() => proposeDraft(db, { runId: null, projectId: "p", threadId: null, contracts: [...fifty, { id: "t-50" }] })).toThrow(/at most 50/);
    expect(() => proposeDraft(db, { runId: null, projectId: "p", threadId: null, contracts: [{ id: "x".repeat(1_100_000) }] })).toThrow(/bytes/);
    expect(() => proposeDraft(db, { runId: null, projectId: "p", threadId: null, contracts: [] })).toThrow(/at least one/);
    const t0 = Date.now();
    const old = proposeDraft(db, { runId: null, projectId: "p", threadId: null, contracts: [{ id: "old" }], at: t0 });
    const fresh = proposeDraft(db, { runId: null, projectId: "p", threadId: null, contracts: [{ id: "fresh" }], at: t0 + DRAFT_KEEP_MS - 1000 });
    expect(getDraft(db, old.id)).not.toBeNull();
    const newest = proposeDraft(db, { runId: null, projectId: "p", threadId: null, contracts: [{ id: "newest" }], at: t0 + DRAFT_KEEP_MS + 1000 });
    expect(getDraft(db, old.id)).toBeNull();
    expect(getDraft(db, fresh.id)).not.toBeNull();
    expect(getDraft(db, newest.id)).not.toBeNull();
    db.close();
  });

  const fullTask = (id: string): TaskV2 => ({ schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: `feature:${id}`, id, title: `Write ${id}`, risk: "low", lane: "writer", project_cwd: "/tmp/w",
    read_first: [], interfaces: ["file exists"], invariants: ["only its own file"], out_of_scope: ["other files"], expected_outputs: [`${id}.txt`], owns_paths: [`${id}.txt`],
    never_touch: [".git/**"], depends_on: [], objective: `Write ${id}.txt`, acceptance: ["file is present"], verify: "none", verification: [] });

  async function draftWorld() {
    const projectId = "proj-a";
    const pmThreadId = "pm-d";
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadId === pmThreadId ? { role: "pm", lanePilotRunId: "run-d" } : {}),
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: threadId === "thr-arch" ? "running" : "idle", projectId }),
        list: async () => [] as never,
      } },
    } as never);
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-d", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/w", pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "c" });
    createRun(db, "run-d", projectId, "bb", null);
    setRunThread(db, "run-d", pmThreadId);
    await plugin(bb);
    const kv = bb.storage.kv as unknown as { set(key: string, value: unknown): Promise<unknown> };
    const railsOn = () => kv.set(`phase-intake:${pmThreadId}`, { requestId: "r1", kind: "process", by: "rules", phaseId: null, at: Date.now(), hinted: true, architectThreadId: "thr-arch" });
    const railsOff = () => kv.set(`phase-intake:${pmThreadId}`, null);
    const tool = async (name: string, params: unknown, project = projectId) => String(await harness.behavior.callAgentTool(name, params as never, { threadId: pmThreadId, projectId: project }));
    return { bb, harness, db, projectId, pmThreadId, railsOn, railsOff, tool };
  }

  it("[sma:m_sw_chat_draft] a draft the rails refuse is refused by the PM's confirmed call and by the card's RPC, exactly as lane_pilot_dispatch_writer refuses it; with the rails quiet the dispatch's own gates answer and a rejection is recorded as failed", async () => {
    const w = await draftWorld();
    const contracts = [fullTask("c-1"), fullTask("c-2")];
    await w.railsOn();
    const viaTool = proposeDraft(w.db, { runId: "run-d", projectId: w.projectId, threadId: w.pmThreadId, kind: "batch", contracts });
    const viaRpc = proposeDraft(w.db, { runId: "run-d", projectId: w.projectId, threadId: w.pmThreadId, kind: "batch", contracts });
    const dispatchRefusal = JSON.parse(await w.tool("lane_pilot_dispatch_writer", { confirm: true, plan: "p", objective: "o", task: fullTask("c-1") })) as { ok: boolean; error: { code: string; message: string } };
    expect(dispatchRefusal.error.code).toBe("phase_rails");
    const fromTool = JSON.parse(await w.tool("lane_pilot_propose", { draftId: viaTool.id, create: true })) as { state: string; taskIds: string[]; failed: Array<{ reason: string }> };
    const fromRpc = await w.harness.behavior.callRpc("task_draft_create", { draftId: viaRpc.id, projectId: w.projectId }) as typeof fromTool;
    for (const answer of [fromTool, fromRpc]) {
      expect(answer.state).toBe("partial");
      expect(answer.taskIds).toEqual([]);
      expect(answer.failed).toHaveLength(2);
      expect(answer.failed[0]!.reason).toBe(dispatchRefusal.error.message.slice(0, 600));
    }
    expect((w.db.prepare("SELECT count(*) AS n FROM lane_pilot_task").get() as { n: number }).n).toBe(0);
    // Rails quiet: the draft is pressed again, and the real dispatchWriter answers with the persisted binding refusal (no task id).
    await w.railsOff();
    const again = await w.harness.behavior.callRpc("task_draft_create", { draftId: viaRpc.id, projectId: w.projectId }) as typeof fromTool;
    expect(again.state).toBe("partial");
    expect(again.failed.map((f) => f.reason).join("\n")).toMatch(/run has no persisted writer host and workspace binding/);
    expect(getDraft(w.db, viaRpc.id)!.taskIds).toEqual([]);
    expect(getDraft(w.db, viaRpc.id)!.state).toBe("partial");
    await w.harness.lifecycle.dispose();
  }, 30_000);

  it("[sma:m_sw_chat_draft] a draft of project B is refused from project A: the RPC creates nothing and reads no card, the PM tool of project A does not find it", async () => {
    const w = await draftWorld();
    const other = proposeDraft(w.db, { runId: null, projectId: "proj-b", threadId: "pm-b", contracts: [{ id: "b-1" }] });
    await expect(w.harness.behavior.callRpc("task_draft_create", { draftId: other.id, projectId: "proj-a" })).rejects.toThrow(/draft_not_in_project/);
    expect(await w.harness.behavior.callRpc("task_draft_card", { draftId: other.id, projectId: "proj-a" })).toBeNull();
    expect(await w.harness.behavior.callRpc("task_draft_card", { draftId: other.id, projectId: "proj-b" })).toMatchObject({ id: other.id, state: "proposed" });
    expect(JSON.parse(await w.tool("lane_pilot_propose", { draftId: other.id, create: true }))).toMatchObject({ error: expect.stringContaining("does not exist") });
    expect(getDraft(w.db, other.id)).toMatchObject({ state: "proposed", results: [] });
    await w.harness.lifecycle.dispose();
  }, 30_000);

  // ---- n1750: what a landed merge records, through the real finish path ----

  it("[sma:k_lib_landing] a task that lands green leaves one landing record on its attempt-change row — the merge commit, the checks-green count, the files — and no receipt; the receipt table is untouched", async () => {
    const projectId = "proj-land";
    const pmThreadId = "pm-land";
    const hostId = "host-land";
    const folder = mkdtempSync(join(tmpdir(), "land-project-"));
    writeFileSync(join(folder, "landed.txt"), "content\n");
    const commit = "d".repeat(40);
    const dirt = new Map<string, Map<string, string>>();
    const base = withOwnWorktrees({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadId === pmThreadId ? { role: "pm", lanePilotRunId: "run-land" } : { role: "writer" }),
          spawn: async (input: { pluginMetadata: Record<string, unknown>; environment: { workspace?: { path?: string } } }) => {
            const cwd = String(input.environment.workspace?.path ?? "");
            dirt.set(cwd, new Map([["landed.txt", "a".repeat(64)]]));
            return { id: "writer-land" };
          },
          wait: async () => ({ matched: true, thread: { status: "idle" } }),
          get: async ({ threadId }: { threadId: string }) => (threadId === pmThreadId ? { id: pmThreadId, status: "idle", projectId, sourceThreadId: pmThreadId, lifecycleOwnerThreadId: pmThreadId } : { id: threadId, status: "idle" }),
          output: async () => ({ text: "writer output" }),
          list: async () => [] as never,
        },
        providers: {
          list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
          models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
        },
        environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, projectId, hostId, path: folder, status: "ready", managed: true, workspaceProvisionType: "managed-worktree" }) },
        files: { read: async ({ path }: { path: string }) => ({ content: path.endsWith(".txt") ? "content\n" : null }), write: async () => ({ ok: true }) },
      },
      experimental_callHostRpc: (call: { method: string; input: unknown }) => {
        if (call.method === "gitOwnershipBase") return { hostId, status: "not-git" as const, branch: null, headSha: null, baseRef: null, baseSha: null, compareCommitted: false, reason: "synthetic fixture" };
        const input = call.input as { cwd?: string; command?: string };
        if (input.cwd === folder && String(input.command ?? "").includes("--show-toplevel")) {
          return { hostId, exitCode: 0, stdout: JSON.stringify({ state: "localNoOrigin", cwd: folder, root: folder, hasCommit: true }), stderr: "" };
        }
        if (!String(input.command ?? "").includes("porcelain")) return { hostId, exitCode: 0, stdout: "", stderr: "" };
        const files = dirt.get(String(input.cwd ?? "")) ?? new Map<string, string>();
        return { hostId, exitCode: 0, stdout: JSON.stringify([...files].map(([path, sha256]) => ({ path, sha256 }))), stderr: "" };
      },
    } as never, hostId);
    // The merge answers with the files it carried, as integrateWorktree does on a real repository.
    const merging = { ...base, experimental_callHostRpc: async (call: { method: string; hostId: string; input: unknown }) =>
      call.method === "runSandboxedCommand"
        ? { hostId, exitCode: 0, stdout: "", stderr: "", backend: "linux-bubblewrap", policySha256: "a".repeat(64), workspacePath: folder, cwd: folder }
      : call.method === "gitIntegrate"
        ? { hostId, status: "merged", commit, base: "b".repeat(40), conflicts: [], reason: null, changed: [{ status: "A", path: "landed.txt" }, { status: "M", path: "keep.txt" }] }
        : (base as { experimental_callHostRpc: (c: unknown) => unknown }).experimental_callHostRpc(call) };
    const { bb, harness } = createFakePluginHost(merging as never);
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId, pmWorkspacePath: "/tmp/pm", writerWorkspacePath: folder, pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" });
    saveProjectSetting(db, projectId, "plan_critique.enabled", false);
    saveProjectSetting(db, projectId, "memory.enabled", false);
    createRun(db, "run-land", projectId, "bb", null);
    freezeRunBinding(db, "run-land", { environmentId: "env-land", hostId, workspacePath: folder });
    setRunThread(db, "run-land", pmThreadId);
    await plugin(bb);
    const task: TaskV2 = { schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:landed", id: "landed", title: "Write landed", risk: "low", lane: "writer", project_cwd: folder,
      read_first: [], interfaces: ["file exists"], invariants: ["only its own file"], out_of_scope: ["other files"], expected_outputs: ["landed.txt"], owns_paths: ["landed.txt"],
      never_touch: [".git/**"], depends_on: [], objective: "Write landed.txt", acceptance: ["file is present"], verify: "none",
      verification: [{ command: "test -f landed.txt", cwd: folder, timeout_sec: 5 }, { command: "grep -q content landed.txt", cwd: folder, timeout_sec: 5 }] };
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка посадки", plan: "Write landed.txt", task }, { threadId: pmThreadId, projectId }))) as { attemptId: string };
    expect(dispatched, JSON.stringify(dispatched)).toHaveProperty("attemptId");
    const waited = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId: "run-land", timeoutSec: 10 }, { threadId: pmThreadId, projectId }))) as { state: string };
    expect(waited.state, JSON.stringify(waited)).toBe("accepted");
    const change = getAttemptChange(db, dispatched.attemptId)!;
    expect(change).toMatchObject({ outcome: "merged", mergeCommit: commit, checksGreen: 2 });
    expect(landingOf(change)).toEqual({ commit, checksGreen: 2, files: 2, line: `landed ${commit.slice(0, 12)} · 2 checks green · 2 files` });
    // Nothing was added to the receipt table: it still holds only what reverify and revert write.
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_task_receipt").get() as { n: number }).n).toBe(0);
    await harness.lifecycle.dispose();
  }, 60_000);

  // ---- n1616: OUTCOME.md ----

  function outcomeWorld(folderExists: boolean, setting: "on" | "off" | "unset" = "on") {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    if (setting !== "unset") saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "task.outcome_file", setting);
    const workspace = mkdtempSync(join(tmpdir(), "outcome-ws-"));
    if (folderExists) mkdirSync(join(workspace, ".agents/plans/items/t-out"), { recursive: true });
    createRun(db, "run-o", "p", "bb", workspace);
    createTask(db, { id: "t-out", runId: "run-o", kind: "bb", contract: {} });
    createAttempt(db, { id: "att-o", runId: "run-o", taskId: "t-out" });
    setAttemptWorkspace(db, "att-o", { path: workspace, environmentId: null, decision: {} });
    const writes: Array<{ path: string; createParents: boolean; content: string }> = [];
    const files = {
      write: async (args: { path: string; content: string; createParents?: boolean }) => {
        writes.push({ path: args.path, createParents: Boolean(args.createParents), content: args.content });
        if (args.createParents) mkdirSync(join(args.path, ".."), { recursive: true });
        writeFileSync(args.path, args.content);
        return { ok: true };
      },
    };
    const ctx = { bb: { sdk: { files } }, db, log: () => undefined,
      host: { call: async (_method: string, input: unknown) => snapshotDryRun(input as never, {} as never) } };
    const event = (reason: string, status = "accepted") => ({ scope: "task", status, taskId: "t-out", attemptId: "att-o", reason, config: { hostId: "h" } }) as never;
    return { ctx: ctx as never, workspace, writes, event };
  }

  it("[sma:k_pl_quick] the reaction writes OUTCOME.md into a task folder that exists, with the reason on one line of at most 200 characters and a credential masked", async () => {
    const w = outcomeWorld(true);
    const secret = "sk-" + "a1b2c3d4e5".repeat(4);
    await writeTaskOutcome(w.ctx, w.event(`broke\nin two lines ${secret} ${"x".repeat(400)}`, "blocked"));
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]!.createParents).toBe(false);
    const text = readFileSync(join(w.workspace, ".agents/plans/items/t-out/OUTCOME.md"), "utf8");
    const stateLine = text.split("\n").find((line) => line.startsWith("state:"))!;
    expect(stateLine.startsWith("state: blocked · broke in two lines ***")).toBe(true);
    expect(stateLine.length).toBeLessThanOrEqual("state: blocked · ".length + 200);
    expect(text).not.toContain(secret);
  });

  it("[sma:k_pl_quick] task.outcome_file off writes nothing even into an existing task folder; unset (the default) writes OUTCOME.md", async () => {
    const off = outcomeWorld(true, "off");
    await writeTaskOutcome(off.ctx, off.event("done"));
    expect(off.writes).toEqual([]);
    const unset = outcomeWorld(true, "unset");
    await writeTaskOutcome(unset.ctx, unset.event("done"));
    expect(unset.writes).toHaveLength(1);
    expect(unset.writes[0]!.path).toBe(join(unset.workspace, ".agents/plans/items/t-out/OUTCOME.md"));
    expect(unset.writes[0]!.content).toContain("state: accepted · done");
  });

  it("[sma:k_pl_quick] no task folder means no write: nothing is created, not even the parents, for a canceled task whose folder never existed", async () => {
    const w = outcomeWorld(false);
    await writeTaskOutcome(w.ctx, w.event("owner canceled", "canceled"));
    expect(w.writes).toEqual([]);
    expect(existsSync(join(w.workspace, ".agents"))).toBe(false);
    // A running status writes nothing either.
    await writeTaskOutcome(w.ctx, w.event("x", "running"));
    expect(w.writes).toEqual([]);
  });

  // ---- m_ac_identity_probe ----

  it("[sma:m_ac_identity_probe] workerSecretReach names a readable credential path as exposed and a closed one as not; ~/.lane-pilot is not probed, so a readable ~/.lane-pilot alone gives no warning; an invalid user fails without running sudo", async () => {
    const home = "/home/owner";
    calls.length = 0;
    readable.clear();
    readable.add(`${home}/.ssh`);
    const probe = await workerSecretReach("lp-worker", home);
    expect(probe.ok).toBe(false);
    expect(probe.reachable).toEqual([`${home}/.ssh`]);
    expect(calls.every((call) => call.args.slice(0, 4).join(" ") === "-n -u lp-worker /usr/bin/test")).toBe(true);
    expect(calls.map((call) => call.args.at(-1))).not.toContain(`${home}/.lane-pilot`);
    readable.clear();
    readable.add(`${home}/.lane-pilot`);
    expect(await workerSecretReach("lp-worker", home)).toEqual({ ok: true, reachable: [] });
    await expect(workerSecretReach("root;rm -rf /")).rejects.toThrow(/worker_user_invalid/);
    readable.clear();
  });

  describe("scripts/lp-worker-user.sh with a fake sudo on PATH", () => {
    const script = join(process.cwd(), "scripts/lp-worker-user.sh");
    function run(verb: "check" | "create", options: { readable?: string[]; unreachable?: boolean } = {}) {
      const dir = mkdtempSync(join(tmpdir(), "lp-fake-sudo-"));
      const home = join(dir, "home");
      mkdirSync(join(dir, "bin"), { recursive: true });
      mkdirSync(home, { recursive: true });
      writeFileSync(join(dir, "bin/sudo"), `#!/usr/bin/env bash
if [ "$1" = "-n" ] && [ "$2" = "-u" ]; then
  shift 3
  if [ "$1" = "/usr/bin/true" ]; then [ -n "$FAKE_UNREACHABLE" ] && exit 1; exit 0; fi
  if [ "$1" = "/usr/bin/test" ]; then for p in $FAKE_READABLE; do [ "$p" = "$3" ] && exit 0; done; exit 1; fi
  exit 1
fi
[ "$1" = "tee" ] && cat >/dev/null
exit 0
`);
      writeFileSync(join(dir, "bin/id"), "#!/usr/bin/env bash\nexit 0\n");
      chmodSync(join(dir, "bin/sudo"), 0o755);
      chmodSync(join(dir, "bin/id"), 0o755);
      const ran = spawnSync("bash", [script, verb], { encoding: "utf8", env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, HOME: home, USER: "owner", SUDO_USER: "",
        FAKE_READABLE: (options.readable ?? []).map((rel) => join(home, rel)).join(" "), FAKE_UNREACHABLE: options.unreachable ? "1" : "" } });
      return { status: ran.status, out: `${ran.stdout}${ran.stderr}`, home };
    }

    it("check and create exit as before (0 when the worker is reachable) while the owner's readable credential paths are printed as warning lines", () => {
      const checked = run("check", { readable: [".ssh", ".codex/auth.json"] });
      expect(checked.status).toBe(0);
      expect(checked.out).toContain(`warning: lp-worker can read ${checked.home}/.ssh`);
      expect(checked.out).toContain(`warning: lp-worker can read ${checked.home}/.codex/auth.json`);
      const created = run("create", { readable: [".ssh"] });
      expect(created.status).toBe(0);
      expect(created.out).toContain("sudoers rule");
      expect(created.out).toContain("warning: lp-worker can read");
    });

    it("a readable ~/.lane-pilot alone gives no warning, and an unreachable worker still exits 1", () => {
      const quiet = run("check", { readable: [".lane-pilot"] });
      expect(quiet.status).toBe(0);
      expect(quiet.out).not.toContain("warning");
      const down = run("check", { unreachable: true });
      expect(down.status).toBe(1);
      expect(down.out).toContain("unreachable");
    });
  });
});
