import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { afterEach, describe, expect, it } from "vitest";
import { runCodeCritique } from "../src/rooms/critique/server/critique-runs";
import { codeCritiquePrompt, codeCritiqueSource } from "../src/rooms/critique/code-critique";
import { stageHelperSettings } from "../src/rooms/settings/server/stage-settings";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, openTaskHome, recordTaskFile, saveProjectSetting, setRunThread } from "../src/rooms/storage";
import { writeDispatchHome } from "../src/rooms/writer/server/task-home";
import type { TaskFileIo } from "../src/rooms/storage";

// 0.1.570 live drill task_home (lprun_a2dc1669e8524c509ad3d4f3f4f8cdba): dispatch snapshots the shared plan into the task home's
// context/plan-source.md, but the code critic only got the task contract — it tried to open `.agents/plans/<shared>.md`, which the
// attempt worktree does not have, and both drill tasks ended `code_critique_failed:helper_blocked`. The critic now resolves the
// snapshot through the manifest like every other stage; a missing or unreadable snapshot is a named block before any spawn.
const APPROVE = JSON.stringify({ decision: "approve", summary: "fine", findings: [] });
const CRITIC_MODELS = ["claude-opus-5-5", "gpt-6.1-sol", "test-model"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort }));
const task = (risk: string) => ({ schema_version: 2, id: "t1", title: "Write", risk, lane: "writer", project_cwd: "/repo", kind: "feature",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/a.ts"], owns_paths: ["src/**"], never_touch: [],
  depends_on: [], objective: "write", acceptance: ["file exists"], verify: "none", verification: [] }) as never;
const config = { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "claude-code", pmModel: "claude-opus-5-5", writerProviderId: "claude-code", writerModel: "claude-opus-5-5" } as never;
const evidence = { truncated: false, artifactRevisionSha256: "d".repeat(64), evidenceSha256: "d".repeat(64), revisionSha256: "d".repeat(64),
  produced: ["src/a.ts"], hashes: {}, baselineHashes: {}, verification: [{ command: "npm test", exitCode: 0 }],
  files: [{ path: "src/a.ts", diff: "+export const a = 1;", content: "export const a = 1;\n" }],
  packetSha256: "d".repeat(64), outputSha256: "d".repeat(64), ownsPaths: ["src/**"], neverTouch: [] } as never;
const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

const io = (files: Map<string, string>): TaskFileIo => ({
  read: async (path) => files.get(path) ?? null,
  write: async (path, content) => { files.set(path, content); },
});

function world() {
  const files = new Map<string, string>();
  const spawns: Array<Record<string, unknown>> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("providers.list", async () => ["claude-code", "codex", "opencode2"].map((id) => ({ id, available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] })));
  harness.sdk.stub("providers.models", async () => ({ models: CRITIC_MODELS.map((id) => ({ id, model: id, supportedReasoningEfforts: EFFORTS })) }));
  harness.sdk.stub("threads.get", async () => ({ id: "pm", projectId: "P", status: "idle" }));
  harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: `crit${spawns.length}` }; });
  harness.sdk.stub("threads.events.list", async () => [{ type: "turn/started", seq: 1 }, { type: "turn/completed", seq: 2, data: { status: "completed" } }]);
  harness.sdk.stub("threads.output", async () => ({ output: APPROVE }));
  harness.sdk.stub("threads.stop", async () => undefined);
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("files.read", async ({ path }: { path: string }) => ({ content: files.get(path), contentEncoding: "utf8" }));
  harness.sdk.stub("files.write", async ({ path, content }: { path: string; content: string }) => { files.set(path, content); return { outcome: "written" }; });
  bb.hosts.experimental_client = (() => ({ call: async () => ({}) })) as never;
  const db = openDatabase(bb);
  createRun(db, "r", "P", "cli", "/repo");
  setRunThread(db, "r", "pm");
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task("medium") });
  createAttempt(db, { id: "a1", runId: "r", taskId: "t1" });
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo', environment_id='env_wt' WHERE id='a1'").run();
  saveProjectSetting(db, "P", "code_critique.enabled", true);
  saveProjectSetting(db, "P", "code_critique.mode", "gate");
  disposals.push(() => harness.lifecycle.dispose());
  return { bb, db, files, spawns };
}

const critique = (w: ReturnType<typeof world>, risk: string) =>
  runCodeCritique({ stageHelperSettings, bb: w.bb, db: w.db, projectId: "P", runId: "r", taskId: "t1", config, task: task(risk), evidence });

describe("code critique reads the task home's plan-source snapshot", () => {
  it("a homed task whose plan named a shared plan gets the snapshot path in every persona's prompt, and the shared file stays absent", async () => {
    const w = world();
    w.files.set("/repo/.agents/plans/shared-plan.md", "# Shared plan\nThe guard is required.\n");
    await writeDispatchHome(w.db, io(w.files), { taskId: "t1", projectId: "P", runId: "r", basePath: "/repo", hostId: "h", task: task("high"), plan: ".agents/plans/shared-plan.md" });
    // The attempt checkout never gets the shared folder: only the task home's snapshot exists.
    w.files.delete("/repo/.agents/plans/shared-plan.md");
    const result = await critique(w, "high");
    expect(result).toMatchObject({ allowed: true, review: "passed" });
    expect(listStageReceipts(w.db, "r", "t1").find((row) => row.stageId === "code-critique")?.state).toBe("passed");
    // risk high: the author and the hostile reviewer each get the same task-home context.
    expect(w.spawns).toHaveLength(2);
    for (const spawn of w.spawns) {
      expect(String(spawn.prompt)).toContain(".agents/tasks/t1/context/plan-source.md");
      expect(String(spawn.prompt)).toContain(".agents/plans/");
    }
  });

  it("an unchanged snapshot reuses the passed receipt; a rewritten snapshot changes the input and re-critiques", async () => {
    const w = world();
    w.files.set("/repo/.agents/plans/shared-plan.md", "# Shared plan\nv1\n");
    await writeDispatchHome(w.db, io(w.files), { taskId: "t1", projectId: "P", runId: "r", basePath: "/repo", hostId: "h", task: task("medium"), plan: ".agents/plans/shared-plan.md" });
    await critique(w, "medium");
    expect(w.spawns).toHaveLength(1);
    await critique(w, "medium");
    expect(w.spawns).toHaveLength(1);
    await recordTaskFile(w.db, io(w.files), { taskId: "t1", kind: "plan-source", name: "context/plan-source.md",
      content: "---\nschema: lp.plan-source/1\nsources:\n  - source_path: .agents/plans/shared-plan.md\n    sha256: " + "0".repeat(64) + "\n---\n\n## .agents/plans/shared-plan.md\n\n# Shared plan\nv2\n",
      producer: { node: "dispatch", graph: "lp-task-pipeline", stage_id: "dispatch" }, readers: ["plan-critique", "writer", "code-critique"] });
    await critique(w, "medium");
    expect(w.spawns).toHaveLength(2);
  });

  it("a plan naming a shared plan with no snapshot in the manifest is a named block before any spawn", async () => {
    const w = world();
    openTaskHome(w.db, { taskId: "t1", projectId: "P", runId: "r", basePath: "/repo", hostId: "h" });
    await recordTaskFile(w.db, io(w.files), { taskId: "t1", kind: "plan", name: "PLAN.md",
      content: "Follow .agents/plans/ghost.md for the details.\n",
      producer: { node: "dispatch", graph: "lp-task-pipeline", stage_id: "dispatch" }, readers: ["pm-read", "plan-critique", "writer"] });
    const result = await critique(w, "medium");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("code_critique_plan_source_missing");
    expect(w.spawns).toHaveLength(0);
    expect(listStageReceipts(w.db, "r", "t1").find((row) => row.stageId === "code-critique")?.state).toBe("blocked");
  });

  it("a manifest-listed snapshot that cannot be read is a named block before any spawn", async () => {
    const w = world();
    w.files.set("/repo/.agents/plans/shared-plan.md", "# Shared plan\n\n");
    await writeDispatchHome(w.db, io(w.files), { taskId: "t1", projectId: "P", runId: "r", basePath: "/repo", hostId: "h", task: task("medium"), plan: ".agents/plans/shared-plan.md" });
    w.files.delete("/repo/.agents/tasks/t1/context/plan-source.md");
    const result = await critique(w, "medium");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("code_critique_plan_source_unreadable");
    expect(w.spawns).toHaveLength(0);
  });

  it("a task on the old layout gets no task-home context: the prompt and the stage input are unchanged", async () => {
    const w = world();
    const result = await critique(w, "medium");
    expect(result).toMatchObject({ allowed: true, review: "passed" });
    expect(w.spawns).toHaveLength(1);
    expect(String(w.spawns[0]!.prompt)).not.toContain("plan-source");
    const receipt = listStageReceipts(w.db, "r", "t1").find((row) => row.stageId === "code-critique")!;
    // The stored input hash is the no-context source, so a receipt written before this change still matches.
    expect(receipt.inputSha256).toBe(sha256Hex(codeCritiqueSource({ evidence: evidence as never, task: task("medium"), agent: "code-critic" })));
  });
});

describe("codeCritiqueSource / codeCritiquePrompt task context", () => {
  const base = { evidence: evidence as never, task: { id: "t1" }, agent: "code-critic" };

  it("the context joins the hashed input only when present, and the prompt names the snapshot only when present", () => {
    const plain = codeCritiqueSource(base);
    expect(plain).not.toContain("planSource");
    const withContext = codeCritiqueSource({ ...base, context: { planSource: { path: ".agents/tasks/t1/context/plan-source.md", sha256: "a".repeat(64) } } });
    expect(withContext).not.toBe(plain);
    expect(withContext).toContain("planSource");
    expect(codeCritiquePrompt({ evidence: evidence as never, task: { id: "t1" }, context: { planSource: { path: ".agents/tasks/t1/context/plan-source.md", sha256: "a".repeat(64) } } })).toContain("context/plan-source.md");
    expect(codeCritiquePrompt({ evidence: evidence as never, task: { id: "t1" } })).not.toContain("plan-source");
  });
});
