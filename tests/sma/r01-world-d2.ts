// Region 1 · Task graph, batch d (second world file): the dispatch that is delivered twice, the closing of a phase, the phase's acceptance lines and package,
// the task's acceptance card. Shared by four-proofs-r01-d2 and the scene probe. Real code on a scratch database; no model, no hub write.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { acceptanceLines, nextAction, type Phase, type PhaseRecord } from "../../src/rooms/phase";
import { appendPart, getPhase, insertPhase, savePhase } from "../../src/rooms/phase/store";
import { installSteps } from "../../src/rooms/phase/server/driver-steps";
import { createAttempt, createRun, createTask, listAttemptsForTask, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { buildAcceptanceCard } from "../../src/rooms/acceptance/card";
import { postOwnerItem } from "../../src/rooms/owner-waiting";
import { taskWordItemPrefix, type TaskV2 } from "../../src/rooms/contracts";
import { createCore } from "../../src/rooms/core/server/core";
import { createPhaseDriver } from "../phase-driver";
import plugin, { type Services } from "../../server";
import { taskOf } from "./r01-world-d";

/** n281: the same dispatch delivered again is recognised as that task, not run as a new one. */
export async function observeIdempotent() {
  const projectId = "project-test", pmThreadId = "pm-thread", runId = "run-idem";
  const config = { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" };
  const task: TaskV2 = {
    schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:suite-green", id: "suite-green", title: "Idempotent dispatch", risk: "low", lane: "writer", project_cwd: config.writerWorkspacePath,
    read_first: ["README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["hello.txt"], owns_paths: ["hello.txt"], never_touch: [".git/**"], depends_on: [],
    objective: "create hello", acceptance: ["never"], verify: "none", verification: [],
  };
  let releaseBase!: () => void;
  const baseHeld = new Promise<void>((resolve) => { releaseBase = resolve; });
  const saved = process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
  process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    getPluginMetadata: async ({ threadId }: { threadId: string }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : { role: "writer" },
    spawn: async () => ({ id: "writer-idem" }), wait: async () => new Promise(() => undefined),
    get: async ({ threadId }: { threadId: string }) => threadId === pmThreadId ? { id: pmThreadId, status: "idle", projectId } as never : { id: threadId, status: "active" } as never,
    output: async () => ({ text: "" }), list: async () => [] as never, stop: async () => ({}) as never,
  }, environments: { listProviders: async () => [] as never }, providers: {
    list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
    models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: ["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
  }, files: { read: async () => ({ content: "fixture\n" }), write: async () => ({ ok: true }) } },
  experimental_callHostRpc: async (call: { method: string; input?: unknown }) => {
    if (call.method === "gitOwnershipBase") { await baseHeld; return { hostId: "host-test", status: "not-git" as const, branch: null, headSha: null, baseRef: null, baseSha: null, compareCommitted: false, reason: "fixture" }; }
    if (call.method === "classifyPlan") return { hostId: "host-test", status: "ok", effort: "xhigh", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
    if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
    return { hostId: "host-test", exitCode: 0, stdout: String((call.input as { command?: string }).command ?? "").includes("porcelain") ? "[]" : "", stderr: "" };
  } } as never);
  const db = openDatabase(bb);
  savePrototypeConfig(db, config as never);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  saveProjectSetting(db, projectId, "memory.enabled", false);
  createRun(db, runId, projectId, "bb", config.writerWorkspacePath);
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatch = async (next: Partial<TaskV2> = {}, plan = "Plan for the idempotent dispatch") => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm: true, objective: "Dispatch check", plan, task: { ...task, ...next } }, { threadId: pmThreadId, projectId },
  ))) as Record<string, unknown>;
  const count = () => (db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE run_id=?").get(runId) as { count: number }).count;
  try {
    const first = await dispatch();
    const again = await dispatch();
    const otherPlan = await dispatch({}, "A different plan for the same task id");
    return {
      first: { taskId: first.taskId, state: first.state, dedup: first.deduplicated ?? null },
      again: { taskId: again.taskId, sameAttempt: again.attemptId === first.attemptId, state: again.state, dedup: again.deduplicated ?? null },
      otherPlanDedup: otherPlan.deduplicated ?? null, tasks: count(), attempts: listAttemptsForTask(db, runId, "suite-green").length,
    };
  } finally {
    releaseBase();
    if (saved === undefined) delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS; else process.env.LANE_PILOT_DISPATCH_ANSWER_MS = saved;
    await harness.lifecycle.dispose();
  }
}

const NOW = 1_700_000_000_000;

/** n285: the phase is closed only after its closing documents read back as written; an unfaithful read-back keeps it open and says so once a day. */
export async function observeClosed() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  const db = openDatabase(bb);
  createRun(db, "r", "p", "bb", "/ws");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h1' WHERE id='r'").run();
  insertPhase(db, { id: "ph_x", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "g", at: NOW });
  savePhase(db, "ph_x", { stage: "closed", state: "active", record: {}, at: NOW });
  const summaryPath = ".agents/phases/ph_x/SUMMARY.md";
  const bookPath = ".agents/phases/ph_x/BOOK.md";
  const make = async (readSha: Record<string, string>) => {
    const tools = { ctx: { log: () => undefined, isDisposed: () => false }, services: {}, db, bb, now: () => NOW, reactions: {},
      mustGet: (id: string) => getPhase(db, id)!, book: (p: { id: string }, s: never, k: string, t: string) => appendPart(db, p.id, { section: s as never, kind: k, text: t, at: NOW }),
      move: () => undefined, facts: () => new Map(), readText: async () => null,
      readFile: async (_p: Phase, path: string) => ({ sha256: readSha[path] ?? "x", sizeBytes: 1 }),
      writeDocs: async () => ({ written: [summaryPath], commit: null, shas: { [summaryPath]: "shaS" } }),
      writeBook: async (p: Phase) => { savePhase(db, p.id, { record: { ...getPhase(db, p.id)!.record, bookWritten: { seq: 1, sha256: "shaB", at: NOW } }, at: NOW }); },
      pmCheckoutPath: async () => null, candidates: () => null, redoId: (i: string) => i, stop: async () => ({ phase: getPhase(db, "ph_x")! }),
      open: async () => getPhase(db, "ph_x")! };
    return installSteps(tools as never).finishClosed(getPhase(db, "ph_x")!);
  };
  const held = await make({ [summaryPath]: "tampered", [bookPath]: "shaB" });
  const notices = () => sent.filter((text) => text.includes("did not read back intact")).length;
  const heldNotices = notices();
  await make({ [summaryPath]: "tampered", [bookPath]: "shaB" });
  const sameDayNotices = notices();
  savePhase(db, "ph_x", { record: { ...getPhase(db, "ph_x")!.record, closedDocs: undefined }, at: NOW });
  const closed = await make({ [summaryPath]: "shaS", [bookPath]: "shaB" });
  return { heldState: held.state, heldClosedDocs: held.record.closedDocs ?? null, heldNotices, sameDayNotices, closedState: closed.state, closedDocs: Boolean(closed.record.closedDocs) };
}

const phaseOf = (record: PhaseRecord, stage: Phase["stage"] = "acceptance"): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});
const piece = { id: "p1", title: "Sum", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: {} };
const fact = (state: string) => ({ taskId: "p1", state, planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "passed", qaPlanned: true }) as never;

/** n286: the machine lines come from the work; the two person decisions are lines of their own and stay red until the person decides. */
export function observeLines() {
  const record: PhaseRecord = {
    plan: { items: [piece], sha: "plan", contextSha: "ctx", admittedSha: "plan" },
    verification: { verdict: { state: "passed", detail: "green", mainSha: "abc", at: 1, inputSha: "in" }, model: { state: "met", by: "goal", summary: "met", at: 1 } },
  };
  const ok = (lines: ReturnType<typeof acceptanceLines>) => Object.fromEntries(lines.map((line) => [line.id, line.ok]));
  const base = { mainSha: "abc", openDeferrals: 0 };
  const open = ok(acceptanceLines(phaseOf(record), new Map([["p1", fact("running")]]), base));
  const landed = ok(acceptanceLines(phaseOf({ ...record, ownerWords: true }), new Map([["p1", fact("accepted")]]), base));
  const asked = acceptanceLines(phaseOf({ ...record, ownerWords: true }), new Map([["p1", fact("accepted")]]), base);
  return { open: { landed: open.landed, useful: open.result_useful, limits: open.limits_acknowledged }, landed: { landed: landed.landed, useful: landed.result_useful, limits: landed.limits_acknowledged },
    ids: asked.map((line) => line.id).filter((id) => ["result_useful", "limits_acknowledged"].includes(id)) };
}

/** n282: with the checks passed and only the person's decisions left, the phase is declared prepared and waits for his keyed decision on that package. */
export function observePreparedPhase() {
  const line = (id: string, ok: boolean) => ({ id, ok, detail: id });
  const base: PhaseRecord = {
    ownerWords: true, plan: { items: [piece], sha: "plan", contextSha: "ctx", admittedSha: "plan" },
    verification: { verdict: { state: "passed", detail: "green", mainSha: "abc", at: 1, inputSha: "in" } },
  };
  const ready = { ...base, acceptance: { lines: [line("landed", true), line("checks_passed", true), line("result_useful", false), line("limits_acknowledged", false)], at: 1, accepted: false } } as PhaseRecord;
  const notReady = { ...base, acceptance: { lines: [line("landed", false), line("result_useful", false)], at: 1, accepted: false } } as PhaseRecord;
  const a = nextAction(phaseOf(ready), new Map());
  const b = nextAction(phaseOf(notReady), new Map());
  return { ready: { waitsForPm: a.waitsForPm, prepared: /is prepared and awaits the owner's keyed decision on package [0-9a-f]{16} /.test(a.text), key: /package ([0-9a-f]{16}) /.exec(a.text)?.[1] ?? null },
    notReady: { prepared: b.text.includes("is prepared and awaits"), text: b.text.slice(0, 120) } };
}

/** n287: the package the person decides on carries the shown key, the frozen verdict and the diff stat; the task's card says what decided each stage. */
export async function observeView() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const phases = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined }, rollback: {} } as unknown as Services).phases;
  const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Pkg", goal: "pkg" });
  savePhase(db, ph.id, { stage: "acceptance", record: { ...ph.record, ownerWords: true, plan: { items: [{ ...piece, id: "p1" }], contextSha: "c", sha: "s", admittedSha: "s" },
    execution: { issued: { p1: "t1" }, baseSha: "base0" }, verification: { verdict: { state: "passed", detail: "all proved", mainSha: "head9", at: 1, inputSha: "in1" } } } as never, at: 2 });
  const pkg = await phases.acceptancePackage(ph.id);
  const status = phases.status(ph.id) as { ownerWord: { acceptanceKey: string } };
  // The task's own card.
  createRun(db, "run2", "projA");
  createTask(db, { id: "tk1", runId: "run2", kind: "bb", contract: taskOf("tk1") });
  recordStage(db, { runId: "run2", taskId: "tk1", stageId: "verification", state: "pending", input: "x" });
  recordStage(db, { runId: "run2", taskId: "tk1", stageId: "verification", state: "running", input: "x" });
  recordStage(db, { runId: "run2", taskId: "tk1", stageId: "verification", state: "passed", input: "x" });
  recordStage(db, { runId: "run2", taskId: "tk1", stageId: "code-critique", state: "pending", input: "y" });
  recordStage(db, { runId: "run2", taskId: "tk1", stageId: "code-critique", state: "running", input: "y" });
  recordStage(db, { runId: "run2", taskId: "tk1", stageId: "code-critique", state: "passed", input: "y" });
  postOwnerItem(db as never, { key: `${taskWordItemPrefix("run2", "tk1")}a1`, source: "writer", kind: "task_word", projectId: "projA", wake: false, what: "waits", why: "word" } as never);
  const card = buildAcceptanceCard(db, { runId: "run2", taskId: "tk1" })!;
  await harness.lifecycle.dispose();
  return {
    verdict: pkg?.verdict, keyHex: /^[0-9a-f]{16}$/.test(pkg?.key ?? ""), keyIsShown: pkg?.key === status.ownerWord.acceptanceKey,
    proofs: Object.fromEntries(card.receipts.map((row) => [row.stageId, `${row.state}:${row.proof}`])), awaitsWord: card.awaitsWord,
    notRun: card.notRun.map((row) => row.stageId).sort(), risk: card.risk, objective: card.contract.objective,
  };
}

export { appendPart, createAttempt };
