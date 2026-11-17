import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { taskV2Schema, type PrototypeConfig } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, saveReasoningTrace, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { openTaskHome, recordTaskFile, type TaskFileIo } from "../../src/rooms/storage";
import { createWriterFinish } from "../../src/rooms/writer/server/finish";
import { requireHelperSpawn } from "../../src/rooms/runs/server/run-routing";
import { stageHelperSettings } from "../../src/rooms/settings/server/stage-settings";
import { sha256Hex } from "@lane-pilot/kit";

// RP1: the fresh code-repair fallback starts a new thread that remembers nothing. The prompt it gets must carry
// the writer's whole contract through the same holdout-filtered sections the first writer got — visible checks
// with their cwd, never_touch, invariants, the task-home pointer — while the same-thread repair keeps the
// compact brief. These tests drive the real finish → runCodeCritiqueGate path on a real db with a fake host, so
// a regression that passes the compact repairPrompt to the fresh spawn fails the assertions on the spawn's own
// prompt, not on a test-side recomposition.
const APPROVE = JSON.stringify({ decision: "approve", summary: "fine", findings: [] });
const CHANGES = JSON.stringify({ decision: "changes_requested", summary: "counter wrong", findings: [
  { id: "f-1", severity: "blocking", finding: "the counter never increments", criterion: "the counter renders", path: "src/widget/counter.ts" },
] });
const EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort }));

const CONFIG: PrototypeConfig = {
  projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo",
  pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
};

const TASK = taskV2Schema.parse({
  schema_version: 2, id: "t1", title: "Fix the widget counter", risk: "medium", lane: "writer",
  project_cwd: "/repo", read_first: [], interfaces: [],
  invariants: ["the widget keeps its public api"], out_of_scope: [],
  expected_outputs: ["src/widget/counter.ts"],
  owns_paths: ["src/widget/**"], never_touch: ["src/widget/preserved.ts"], depends_on: [],
  objective: "Make the widget count again.", acceptance: ["the counter renders"], verify: "none",
  verification: [
    { command: "node scripts/check-widget.mjs --case fresh-repair", cwd: "/repo/checks" },
    { command: "node scripts/holdout-widget.mjs", cwd: "/repo", hidden: true },
  ],
  forecast: { files: 1, checks_pass_first_try: false, model: "FORECAST-SECRET-MARKER" },
});

const BODY = "export const counter = 1;\n";
const PATCH = "@@ -1 +1 @@\n-old\n+new\n";

async function world(opts: { writerStatus: "idle" | "active" }) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const files = new Map<string, string>([["/repo/src/widget/counter.ts", BODY]]);
  const spawns: Array<Record<string, unknown>> = [];
  const sends: Array<Record<string, unknown>> = [];
  harness.sdk.stub("providers.list", async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }]);
  harness.sdk.stub("providers.models", async () => ({ models: ["test-model", "codex-test"].map((id) => ({ id, model: id, supportedReasoningEfforts: EFFORTS })) }));
  harness.sdk.stub("threads.get", async ({ threadId }: { threadId?: string } = {}) =>
    ({ id: threadId ?? "pm", projectId: "P", status: threadId === "writer-t1" ? opts.writerStatus : "idle" }));
  harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: `thr-${spawns.length}` }; });
  let repairSentAt = 0;
  harness.sdk.stub("threads.send", async (input: Record<string, unknown>) => { sends.push(input); repairSentAt = Date.now(); return {}; });
  harness.sdk.stub("threads.stop", async () => undefined);
  // After the send the writer actually picked the repair up: the follow-up request the gate's waitThreadIdle
  // (requestedAfter=repairSentAt) looks for, then the turn it watches. Same seam critique-committed-evidence uses.
  harness.sdk.stub("threads.events.list", async ({ threadId }: { threadId?: string }) => [
    ...(threadId === "writer-t1" && repairSentAt ? [{ type: "client/turn/requested", threadId, seq: 0, createdAt: repairSentAt }] : []),
    { type: "turn/started", threadId, seq: 1 },
    { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } },
  ]);
  harness.sdk.stub("threads.output", async ({ threadId }: { threadId?: string } = {}) =>
    ({ output: threadId === "thr-1" ? CHANGES : APPROVE }));
  harness.sdk.stub("files.read", async ({ path }: { path: string }) => ({ content: files.get(path) ?? null }));
  harness.sdk.stub("files.write", async ({ path, content }: { path: string; content: string }) => { files.set(path, content); return { outcome: "written" }; });
  harness.sdk.stub("plugins.callRpc", async ({ method }: { method: string }) => method === "files"
    ? { outcome: "available", files: [{ path: "src/widget/counter.ts", revision: "r1" }], initialPatches: [{ path: "src/widget/counter.ts", patch: PATCH, truncated: false }] }
    : { outcome: "available", patches: {} });
  bb.hosts.experimental_client = (() => ({ call: async () => ({}) })) as never;

  createRun(db, "r", "P", "cli", "/repo");
  setRunThread(db, "r", "pm");
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: TASK });
  createAttempt(db, { id: "a1", runId: "r", taskId: "t1" });
  transitionAttempt(db, "a1", "spawn_requested");
  setAttemptWorkspace(db, "a1", { path: "/repo", environmentId: "env_wt", decision: { reason: "managed_worktree" } });
  transitionAttempt(db, "a1", "running", { threadId: "writer-t1" });
  saveProjectSetting(db, "P", "code_critique.enabled", true);
  saveProjectSetting(db, "P", "code_critique.mode", "gate");
  // The task home the writer's first brief pointed at: plan, check log and the attempt folder.
  const io: TaskFileIo = {
    read: async (path) => files.get(path) ?? null,
    write: async (path, content) => { files.set(path, content); },
  };
  openTaskHome(db, { taskId: "t1", projectId: "P", runId: "r", basePath: "/repo", hostId: "h" });
  await recordTaskFile(db, io, { taskId: "t1", kind: "plan", name: "PLAN.md", content: "# widget plan\n",
    producer: { node: "dispatch", graph: "lp-task-pipeline", stage_id: "dispatch" }, readers: ["writer"] });
  await recordTaskFile(db, io, { taskId: "t1", kind: "check-log", name: "checks/CHECKS.log", content: "check failed\n",
    producer: { node: "verify", graph: "lp-task-pipeline", stage_id: "verify" }, readers: ["writer"] });

  // The same dispatch context spawn-brief recorded for the first writer, so the gate's helper-policy check passes.
  const policy = requireHelperSpawn({ bb: bb as never, db, projectId: "P", runId: "r" });
  saveReasoningTrace(db, {
    attemptId: "a1", runId: "r", threadId: "writer-t1", providerId: "codex", model: "test-model",
    effectiveReasoningLevel: "high", requestedReasoningLevel: "high", serviceTier: null, requestedServiceTier: "default",
    planSha256: "fixture", sourceLength: 1, fallbackReason: null,
    dispatchContext: { memoryText: "", executionPacket: "", executionPacketSha256: "", pmReadContext: "", agent: "writer",
      helperMode: policy.mode, helperRequired: policy.policy?.required === true },
  });

  const ctx = {
    state: { disposed: false },
    bb: { storage: bb.storage, log: { warn() {}, error() {}, info() {} }, sdk: bb.sdk,
      hosts: { experimental_client: async () => ({ call: async () => ({}) }) } },
    db, getThreadBounded: async () => ({ status: "idle" }),
    host: { call: async (method: string) => method === "runCommand"
      ? { hostId: "h", exitCode: 0, stdout: `${"f".repeat(40)}\n`, stderr: "" } : ({}) },
    isDisposed: () => false, log: () => undefined,
  };
  let validations = 0;
  const finish = createWriterFinish(ctx as never, {
    validateWriterResult: async () => {
      validations++;
      // Stop after observing the repair: this fixture proves the spawn's prompt, not a second review.
      if (validations > 1) return { status: "blocked", reason: "fixture_repair_checked" };
      return { status: "accepted", output: "done", produced: ["src/widget/counter.ts"], verification: [] };
    },
    persistWriterAcceptance: async () => ({ state: "passed" }),
    workspaceDirt: async () => ({ ok: true, snapshots: [{ path: "src/widget/counter.ts", sha256: sha256Hex(BODY) }] }),
    stageHelperSettings,
    runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }),
  } as never);
  const run = () => finish.finishWriterAttempt({ projectId: "P", config: CONFIG, task: TASK, runId: "r", taskId: "t1",
    attemptId: "a1", pmThreadId: "pm", writerThreadId: "writer-t1", dirtBefore: [] });
  return { db, run, spawns, sends, get validations() { return validations; } };
}

describe("code critique fresh repair fallback", () => {
  it("a new repair thread gets the writer's whole contract — visible checks, boundaries and the task home", async () => {
    const w = await world({ writerStatus: "active" });
    try {
      const result = await w.run();
      expect(result).toMatchObject({ status: "blocked", reason: "fixture_repair_checked" });
      // Two spawns: the code critic, then the fresh repair writer. The original writer was never sent.
      expect(w.spawns).toHaveLength(2);
      expect(w.sends).toHaveLength(0);
      const repair = w.spawns[1]!;
      expect(repair.pluginMetadata).toMatchObject({ role: "writer", lanePilotTaskId: "t1", repairRound: 1 });
      const prompt = String(repair.prompt);
      // The compact repair brief is still there — same reply contract, same findings.
      expect(prompt).toContain("TASK BRIEF:");
      expect(prompt).toContain("the counter never increments");
      expect(prompt).toContain('"replies"');
      expect(prompt).toContain("dispute");
      // What the fresh thread could not know: the visible check with its own cwd, the boundaries, the home.
      expect(prompt).toContain("node scripts/check-widget.mjs --case fresh-repair");
      expect(prompt).toContain('"cwd":"/repo/checks"');
      expect(prompt).toContain("owns_paths: src/widget/**");
      expect(prompt).toContain("never_touch: src/widget/preserved.ts");
      expect(prompt).toContain("the widget keeps its public api");
      expect(prompt).toContain(".agents/tasks/t1/");
      expect(prompt).toContain("Read the plan first: .agents/tasks/t1/PLAN.md");
      expect(prompt).toContain("The last failed check's full log: .agents/tasks/t1/checks/CHECKS.log");
      expect(prompt).toContain("attempts/a1/");
      // Hidden holdout stays hidden — counted, never printed; the PM forecast is never in a writer brief.
      expect(prompt).toContain("verification_hidden_count: 1");
      expect(prompt).not.toContain("holdout-widget");
      expect(prompt).not.toContain("FORECAST-SECRET-MARKER");
    } finally { w.db.close(); }
  });

  it("the same-thread repair keeps the compact brief — no contract sections, no task home", async () => {
    const w = await world({ writerStatus: "idle" });
    try {
      const result = await w.run();
      expect(result).toMatchObject({ status: "blocked", reason: "fixture_repair_checked" });
      // Only the critic spawned; the repair went to the idle writer's own thread.
      expect(w.spawns).toHaveLength(1);
      expect(w.sends).toHaveLength(1);
      const sent = w.sends[0]!;
      expect(sent.threadId).toBe("writer-t1");
      expect(sent.senderThreadId).toBe("pm");
      const text = JSON.stringify((sent.input as Array<{ text?: string }>)?.[0]?.text ?? sent);
      expect(text).toContain("TASK BRIEF:");
      expect(text).toContain("the counter never increments");
      expect(text).toContain("owns_paths: src/widget/**");
      expect(text).not.toContain("node scripts/check-widget.mjs");
      expect(text).not.toContain("preserved.ts");
      expect(text).not.toContain(".agents/tasks/");
      expect(text).not.toContain("verification_hidden_count");
    } finally { w.db.close(); }
  });
});
