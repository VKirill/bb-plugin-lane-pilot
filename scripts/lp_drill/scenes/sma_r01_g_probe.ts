// Probe of scenes/sma_r01_g.py: real writer finish/reaction and dispatch entrypoints on scratch sqlite/fakeHost.
// It judges nothing; the Python scene compares the returned observations with the node cards.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../../src/rooms/core/server/core";
import { createWriterFinish } from "../../../src/rooms/writer/server/finish";
import { mountWriterAttemptFinished } from "../../../src/rooms/writer/server/attempt-reactions";
import { openDatabase, createAttempt, createRun, createTask, listAttemptsForTask, listStageReceipts, saveProjectSetting, savePrototypeConfig, setRunThread, transitionAttempt } from "../../../src/rooms/plugin-db";
import { readTaskApproach } from "../../../src/rooms/tasks";
import { listRuleProposals } from "@lane-pilot/run-insights";
import { writerMarkers } from "../../../src/rooms/tasks";
import { taskOf } from "../../../tests/sma/r01-world-d";

const out: Record<string, unknown> = {};
const step = async (id: string, run: () => unknown | Promise<unknown>) => {
  try { out[id] = await run(); } catch (error) { out[id] = { error: String((error as Error)?.stack ?? error).slice(0, 500) }; }
};

const config = { projectId: "proj", hostId: "host", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test" };

async function observeMarkers() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.output", async () => ({ text: "done\nAPPROACH: use the narrow marker path\nLESSON: keep the report short" }));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.stop", async () => undefined);
  harness.sdk.stub("files.read", async () => { throw Object.assign(new Error("file does not exist"), { code: "not_found" }); });
  harness.sdk.stub("files.write", async () => ({}));
  const db = openDatabase(bb);
  const task = { ...taskOf("marker-task"), project_cwd: "/tmp/writer", expected_outputs: [], owns_paths: ["note.txt"], verify: "none", verification: [] };
  createRun(db, "run-markers", config.projectId, "bb", "/tmp/writer");
  createTask(db, { id: "marker-task", runId: "run-markers", kind: "bb", contract: task });
  createAttempt(db, { id: "marker-attempt", runId: "run-markers", taskId: "marker-task" });
  transitionAttempt(db, "marker-attempt", "spawn_requested");
  transitionAttempt(db, "marker-attempt", "running", { threadId: "writer-marker" });
  const ctx = createCore(bb, db);
  const finish = createWriterFinish(ctx as never, {
    validateWriterResult: async () => ({ status: "accepted", output: "done", produced: [], verification: [] }),
    persistWriterAcceptance: async () => ({ state: "passed" }),
    workspaceDirt: async () => ({ ok: true, snapshots: [] }),
    runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }),
    providerBreaker: { record: () => undefined },
  } as never);
  const result = await finish.finishWriterAttempt({ projectId: config.projectId, config, task, runId: "run-markers", taskId: "marker-task", attemptId: "marker-attempt", pmThreadId: "pm", writerThreadId: "writer-marker", dirtBefore: [] } as never);
  const note = await readTaskApproach(bb.storage.kv, "run-markers", "marker-task") as { approach?: unknown; lesson?: unknown } | null;
  await harness.lifecycle.dispose();
  return { status: result.state, approach: note?.approach ?? null, lesson: note?.lesson ?? null, warning: JSON.stringify(result).includes("no APPROACH") };
}

async function observeLessonConsumers() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  let answer = "done\nLESSON: run the seed before the check";
  harness.sdk.stub("threads.output", async () => ({ text: answer }));
  harness.sdk.stub("threads.events.list", async () => []);
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run-lessons", config.projectId, "bb", "/tmp/writer");
  mountWriterAttemptFinished(ctx, {} as never);
  saveProjectSetting(db, config.projectId, "writer.lesson_from_accepted", "on");
  const { emitAttemptFinished } = await import("../../../src/rooms/writer/server/attempt-finished");
  const emit = (attemptId: string) => emitAttemptFinished(ctx, {
    scope: "attempt", projectId: config.projectId, runId: "run-lessons", taskId: "lesson-task", attemptId, pmThreadId: "pm", writerThreadId: "writer-lesson",
    task: taskOf("lesson-task"), config, status: "accepted", reason: null, result: null,
  } as never);
  await emit("lesson-attempt");
  const lesson = listRuleProposals(db as never, config.projectId, { state: "proposed" });
  answer = "done\nLESSON: none - nothing new";
  await emit("none-attempt");
  const afterNone = listRuleProposals(db as never, config.projectId, { state: "proposed" });
  const noneMarkers = writerMarkers(answer);
  await harness.lifecycle.dispose();
  return { lesson: lesson[0]?.rule ?? null, noneReason: noneMarkers.noLessonReason, noneLesson: noneMarkers.lesson, proposals: afterNone.length };
}

async function observeIdempotentDispatch() {
  const projectId = "project-test", pmThreadId = "pm-thread", runId = "run-idem";
  const dispatchConfig = { ...config, projectId };
  const task = { ...taskOf("suite-green"), display_title: "Idempotent dispatch", kind: "feature", area: "feature:suite-green", project_cwd: dispatchConfig.writerWorkspacePath, owns_paths: ["hello.txt"], expected_outputs: ["hello.txt"], verify: "none", verification: [] };
  let releaseBase!: () => void;
  const baseHeld = new Promise<void>((resolve) => { releaseBase = resolve; });
  const saved = process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
  process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
    threads: {
      getPluginMetadata: async ({ threadId }: { threadId: string }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : { role: "writer" },
      spawn: async () => ({ id: "writer-idem" }), wait: async () => new Promise(() => undefined),
      get: async ({ threadId }: { threadId: string }) => threadId === pmThreadId ? { id: pmThreadId, status: "idle", projectId } as never : { id: threadId, status: "active" } as never,
      output: async () => ({ text: "" }), list: async () => [] as never, stop: async () => ({}) as never,
    },
    environments: { listProviders: async () => [] as never },
    providers: { list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
      models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: ["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }) },
    files: { read: async () => ({ content: "fixture\n" }), write: async () => ({ ok: true }) },
  }, experimental_callHostRpc: async (call: { method: string; input?: unknown }) => {
    if (call.method === "gitOwnershipBase") { await baseHeld; return { hostId: "host-test", status: "not-git", branch: null, headSha: null, baseRef: null, baseSha: null, compareCommitted: false, reason: "fixture" }; }
    if (call.method === "classifyPlan") return { hostId: "host-test", status: "ok", effort: "xhigh", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
    if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
    return { hostId: "host-test", exitCode: 0, stdout: String((call.input as { command?: string }).command ?? "").includes("porcelain") ? "[]" : "", stderr: "" };
  } } as never);
  const db = openDatabase(bb);
  savePrototypeConfig(db, dispatchConfig as never);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  saveProjectSetting(db, projectId, "memory.enabled", false);
  createRun(db, runId, projectId, "bb", dispatchConfig.writerWorkspacePath);
  setRunThread(db, runId, pmThreadId);
  const { default: plugin } = await import("../../../server");
  await plugin(bb);
  const dispatch = async (plan = "Plan for the idempotent dispatch") => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm: true, objective: "Dispatch check", plan, task }, { threadId: pmThreadId, projectId },
  ))) as Record<string, unknown>;
  const count = () => (db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE run_id=?").get(runId) as { count: number }).count;
  try {
    const first = await dispatch();
    const stagesAfterFirst = listStageReceipts(db, runId, "suite-green").length;
    const again = await dispatch();
    const stagesAfterAgain = listStageReceipts(db, runId, "suite-green").length;
    return {
      first: { taskId: first.taskId, state: first.state, dedup: first.deduplicated ?? null },
      again: { taskId: again.taskId, sameAttempt: again.attemptId === first.attemptId, state: again.state, dedup: again.deduplicated ?? null },
      tasks: count(), attempts: listAttemptsForTask(db, runId, "suite-green").length, stagesAfterFirst, stagesAfterAgain,
    };
  } finally {
    releaseBase();
    if (saved === undefined) delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS; else process.env.LANE_PILOT_DISPATCH_ANSWER_MS = saved;
    await harness.lifecycle.dispose();
  }
}

async function main() {
  await step("n251", observeMarkers);
  await step("n252", observeLessonConsumers);
  await step("n330", observeIdempotentDispatch);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

main().then(() => process.exit(0), (error) => { process.stdout.write(`${JSON.stringify({ fatal: String((error as Error)?.stack ?? error).slice(0, 500) })}\n`); process.exit(0); });
