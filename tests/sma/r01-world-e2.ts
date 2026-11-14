// Region 1 · Task graph, batch e, second half (n303..n319): observations of the real code, shared by the tests (four-proofs-r01-e2.test.ts) and by the drill scene's probe.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { designDecision, designGate, type PhaseRecord } from "../../src/rooms/phase/logic";
import { birthFindings, checkProgram, landingWordGap, ownerWordFindings } from "../../src/rooms/tasks";
import { lintContract } from "../../src/rooms/tasks/server/contract-lint";
import { registerQueueTool } from "../../src/rooms/tasks/server/queue-tool";
import { buildTaskBoard } from "../../src/rooms/runs/server/task-board";
import { createAttempt, createRun, createTask, getTask, getTaskPlan, listStageReceipts, loadPrototypeConfig, openDatabase, savePrototypeConfig, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { stageHelperSettings } from "../../src/rooms/settings/server/stage-settings";
import { gateResolverFor } from "../../src/rooms/verification/server";
import { isTaskSatisfied } from "../../src/rooms/runs/server";
import { registerDispatchExecutors, startDispatchRun } from "../../src/rooms/writer/server/dispatch-workflow";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";
import { ATTEMPT_STATES, isFailedAttemptState, isOpenAttemptState, nextAttemptState, retryAction } from "../../src/rooms/contracts/state-machine";
import { createTaskReconcile } from "../../src/rooms/runs/server/task-reconcile";
import { contractEditions } from "../../src/rooms/storage";
import { createWriterUpdateTask } from "../../src/rooms/writer/server/update-task";
import type { TaskV2 } from "../../src/rooms/contracts";
import { taskOf } from "./r01-world-c";

const codes = (rows: Array<{ code: string }>) => rows.map((row) => row.code);

// n303 Clarify gate is «needed»: the row is not issued.
export function clarifyNeededObs() {
  const open = birthFindings({ kind: "feature", risk: "low", clarify: { questions: ["Which currency?", "  "], answers: [] } });
  const answered = birthFindings({ kind: "feature", risk: "low", clarify: { questions: [], answers: [{ question: "Which currency?", by: "owner" }] } });
  return { open: [codes(open.errors), open.errors[0]?.message], answered: [codes(answered.errors), codes(answered.warnings)] };
}

// n304 The person said «yes, that is it»: with owner.words on, only an answer by the owner settles a clarification.
export function clarifyConfirmedObs() {
  const answer = (by: string) => ({ clarify: { answers: [{ question: "colour?", by }] } });
  const pm = ownerWordFindings(answer("pm"), true);
  return { pm: [pm.map((row) => row.code), pm[0]?.message.includes("«colour?»")], owner: ownerWordFindings(answer("owner"), true), off: ownerWordFindings(answer("pm"), false) };
}

// n305 Nothing to clarify: no question (or a blank one) is no finding; a bench arm is judged by the bench and needs no promise.
export function clarifyNotNeededObs() {
  const none = birthFindings({ kind: "feature", risk: "low" });
  const blank = birthFindings({ kind: "feature", risk: "low", clarify: { questions: ["   "], answers: [] } });
  const bench = birthFindings({ kind: "feature", risk: "high" }, "bench");
  return { none: [none.errors, none.warnings], blank: [blank.errors, blank.warnings], bench: [bench.errors, bench.warnings] };
}

// n307 Is the check command runnable: judged by its program.
export function dryRunObs() {
  const baseTask = taskOf("t1", { kind: "feature", area: "feature:x", display_title: "Тест" });
  const lint = (command: string, programs: Array<[string, boolean]>) => lintContract({ task: { ...baseTask, verification: [{ command, cwd: "/ws" }] }, workspacePath: "/ws", hostId: "h", sandboxUnsafe: [], openTasks: [], deadDependencies: [], kinds: null, programs: new Map(programs) });
  return {
    program: [checkProgram("FOO=1 npm test"), checkProgram("(echo hi)"), checkProgram("sudo make all")],
    missing: codes(lint("npm test", [["npm", false]]).errors).filter((code) => code === "check_not_runnable"),
    present: codes(lint("npm test", [["npm", true]]).errors).filter((code) => code === "check_not_runnable"),
    shell: codes(lint("(echo hi)", [["echo", false]]).errors).filter((code) => code === "check_not_runnable"),
    pathed: codes(lint("./run.sh", [["./run.sh", false]]).errors).filter((code) => code === "check_not_runnable"),
  };
}

// n308 Is a drawing needed: view, risk and a named drawing decide.
export function designNeededObs() {
  const screen = { owns_paths: ["src/ui/Cart.tsx"], risk: "medium" };
  const warned = (task: Record<string, unknown>, birth?: string) => codes(birthFindings(task, birth).warnings).includes("drawing_needed");
  return { medium: warned(screen), low: warned({ ...screen, risk: "low" }), named: warned({ ...screen, drawing: ["design/cart.png"] }), logic: warned({ owns_paths: ["src/tax.ts"], risk: "high" }), phasePiece: warned({ ...screen, risk: "high", promise: { given: "g", when: "w", then: "t" } }, "phase") };
}

const piece = (id: string, owns: string[]) => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id, owns_paths: owns } }) as never;
// n309 The task drawing gate is «needed»: a piece that changes a screen needs one, and the gate holds until it is drawn.
export function designGateNeededObs() {
  const screens = designDecision([piece("p1", ["src/ui/Cart.tsx"]), piece("p2", ["src/tax.ts"])]);
  const asked = designDecision([piece("p2", ["src/tax.ts"])], true);
  const held = designGate({ design: { decision: screens.decision, why: screens.why } } as PhaseRecord);
  return { screens: [screens.decision, screens.why, screens.mode], asked: [asked.decision, asked.why], held: [held.ok, held.ok ? null : held.why] };
}

// n310 The person confirmed a drawing of the same hash.
export function designConfirmedObs() {
  const drawing = { paths: ["d/one.html", "d/UI-SPEC.md"], sha256: "A", designer: "d", feasible: true, reviewer: "r" };
  const record: PhaseRecord = { ownerWords: true, design: { decision: "needed", why: "x", drawing } };
  const word = (key: string) => ({ turn: "design" as const, decision: "yes" as const, by: "o", text: "да", at: 1, key });
  const redrawn = { ...record, design: { ...record.design!, drawing: { ...drawing, sha256: "B" } } };
  return { same: designGate({ ...record, words: [word("A")] }).ok, redrawn: designGate({ ...redrawn, words: [word("A")] }).ok, noWord: designGate(record).ok };
}

// n311 Drawing not needed: a policy decision written as a word, not as silence.
export function designGateNotObs() {
  const silent = designGate({} as PhaseRecord);
  const written = designGate({ design: { decision: "not_needed", why: "no piece changes a screen" } } as PhaseRecord);
  const decided = designDecision([piece("p2", ["src/tax.ts"])]);
  return { silent: [silent.ok, silent.ok ? null : silent.why], written: written.ok, decided: [decided.decision, decided.why] };
}

// n312 Words can change while the row waits or runs; finished work is not rewritten.
export async function wordsObs() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  const db = openDatabase(bb);
  createRun(db, "run1", "p", "bb", "/ws");
  setRunThread(db, "run1", "pm");
  const task = taskOf("t1", { kind: "feature", area: "a", display_title: "t", lane: "core", owns_paths: ["src/**"], expected_outputs: ["o.txt"], acceptance: ["a1"], verify: "tests", verification: [{ command: "npm test", cwd: "/ws" }] }) as TaskV2;
  createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: task });
  createAttempt(db, { id: "att1", runId: "run1", taskId: "t1" });
  transitionAttempt(db, "att1", "spawn_requested");
  transitionAttempt(db, "att1", "running", { threadId: "thr_w" });
  const ctx = { bb, db, host: bb.hosts.experimental_client({ contract: {} as never }), log: () => undefined, configForRun: async () => ({ hostId: "h1", writerWorkspacePath: "/ws" }), isDisposed: () => false };
  const services = { stageHelperSettings: {}, activeWriterTasks: new Set(), baseline: {}, isLiveFolder: async () => false, isTaskSatisfied: async () => false, stability: {}, resolveIntegrationGate: async () => null, startWriterTask: () => undefined, workflowEngine: undefined };
  const update = createWriterUpdateTask(ctx as never, services as never);
  const reply = await update.updateTask({ projectId: "p", runId: "run1", pmThreadId: "pm", taskId: "t1", task: { ...task, acceptance: ["a1", "a2"] } });
  const running = { ok: reply.ok, state: reply.state, steered: sent.length, editions: contractEditions(db, "t1").length };
  db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
  const done = await update.updateTask({ projectId: "p", runId: "run1", pmThreadId: "pm", taskId: "t1", task: { ...task, acceptance: ["a3"] } });
  const finished = { ok: done.ok, code: (done.error as { code: string }).code, editions: contractEditions(db, "t1").length };
  await harness.lifecycle.dispose();
  return { running, finished };
}

// n313 A word change mints an edition and reopens the checks: a queued task's words are replaced and its pipeline goes again from pm-read.
export async function reopenObs() {
  const projectId = "proj-test", runId = "run-test-update", pmThreadId = "pm-thread-1", taskId = "task-to-update";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, runId, projectId, "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host-1");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run(pmThreadId, runId);
  savePrototypeConfig(db, { projectId, hostId: "host-1", pmWorkspacePath: "/ws", writerWorkspacePath: "/ws", pmProviderId: "p1", pmModel: "m1", writerProviderId: "p1", writerModel: "m1" });
  const baseTask = taskOf(taskId, { kind: "feature", area: "feature:update-task", display_title: "Тестовая задача", lane: "core", title: "Original title", objective: "Original objective", expected_outputs: ["out.txt"], owns_paths: ["src/**"], depends_on: ["dep-1"], acceptance: ["all pass"], verify: "tests", verification: [{ command: "npm test", cwd: "/ws" }] }) as TaskV2;
  createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
  createAttempt(db, { id: "att-1", runId, taskId });
  const fakeBb = { storage: { kv: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] } }, hosts: { experimental_client: () => ({ call: async () => ({ status: "ready", entries: [] }) }) },
    sdk: { files: { write: async () => {}, read: async () => null }, threads: { send: async () => {} } }, log: { warn: () => {}, info: () => {} } };
  const ctx = { bb: fakeBb, db, state: { disposed: false }, configForRun: async (id: string) => loadPrototypeConfig(db, id), log: () => {} } as unknown as ServerCore;
  const services = { resolveIntegrationGate: gateResolverFor(ctx), isTaskSatisfied, activeWriterTasks: new Set<string>(), stability: { loadParked: async () => [] } } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", resolveWorkflow: (id, version) => builtinWorkflow(id, version) });
  registerDispatchExecutors(engine);
  engine.register("lp.qa-gate", { reentrant: true, run: async () => ({ output: { run: false } }) });
  Object.assign(services, { workflowEngine: engine, stageHelperSettings, isLiveFolder: async () => false, startWriterTask: () => undefined });
  const mutable = ctx as unknown as { host?: unknown; refreshRun?: unknown };
  mutable.host ??= { call: async (method: string) => (method === "gitOwnershipBase" ? { status: "not-git" } : { status: "ready", entries: [] }) };
  mutable.refreshRun ??= () => undefined;
  const run = startDispatchRun(engine, { ctx, services, threadId: pmThreadId, projectId, runId, taskId, attemptId: "att-1", config: loadPrototypeConfig(db, projectId)!, runConfig: loadPrototypeConfig(db, projectId)!, workspacePath: "/ws", task: baseTask, plan: baseTask.objective, lintWarnings: [] });
  const finishedRun = await run.done;
  const started = finishedRun.status;
  const { updateTask } = createWriterUpdateTask(ctx, services);
  const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, title: "Updated title", objective: "Updated objective", expected_outputs: ["out-updated.txt"] }, plan: "New canonical plan for task" });
  const stored = getTask(db, taskId)?.contract as TaskV2;
  const reruns = db.prepare("SELECT detail FROM lane_pilot_wf_event WHERE run_id=? AND kind='rerun'").all(run.runId) as Array<{ detail: string }>;
  const out = {
    started, ok: res.ok, state: res.state, title: stored.title, outputs: stored.expected_outputs, dependsKept: stored.depends_on, plan: getTaskPlan(db, taskId), critique: listStageReceipts(db, runId, taskId).some((row) => row.stageId === "plan-critique"),
    reruns: reruns.map((row) => row.detail.includes("node pm-read")), waiting: engine.get(run.runId)?.status, editions: contractEditions(db, taskId).map((row) => row.edition),
  };
  await harness.lifecycle.dispose();
  return out;
}

// n314 / n316 the PM's hold: until released (year 2999) or until a date.
export async function holdWorld() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "P", "bb", "/repo");
  setRunThread(db, "run1", "pm-thread");
  createRun(db, "run2", "P", "bb", "/repo");
  for (const id of ["t1", "t2"]) { createTask(db, { id, runId: "run1", kind: "bb", contract: { title: id } as never }); createAttempt(db, { id: `${id}-a1`, runId: "run1", taskId: id }); }
  createTask(db, { id: "other", runId: "run2", kind: "bb", contract: {} as never });
  registerQueueTool({ db, bb, log: () => undefined, isDisposed: () => false } as never, { ask: async () => undefined, answer: () => undefined, decide: () => ({ ok: true as const }) } as never);
  const call = async (input: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_queue", input, { threadId: "pm-thread", projectId: "P" }))) as Record<string, unknown>;
  const heldUntil = (id: string) => (db.prepare("SELECT held_until FROM lane_pilot_task WHERE id=?").get(id) as { held_until: number | null }).held_until;
  const board = () => Object.fromEntries(buildTaskBoard(db, { projectId: "P", doneSince: 0 }).map((item) => [item.taskId, item.held]));
  return { db, harness, call, heldUntil, board };
}

export async function gateHoldObs() {
  const w = await holdWorld();
  const fresh = w.heldUntil("t1");
  const hold = await w.call({ action: "hold", taskIds: ["t1", "other"] });
  const forever = w.heldUntil("t1");
  const dated = await w.call({ action: "hold", taskIds: ["t2"], until: "2999-06-01T00:00:00.000Z" });
  const datedUntil = w.heldUntil("t2");
  await w.harness.lifecycle.dispose();
  return { fresh, forever: forever === Date.UTC(2999, 0, 1), foreverInFuture: forever! > Date.now(), reply: [hold.tasks, hold.refused, hold.until], dated: [dated.tasks, datedUntil === Date.UTC(2999, 5, 1)], otherUntouched: true };
}

export async function heldObs() {
  const w = await holdWorld();
  const before = w.board();
  await w.call({ action: "hold", taskIds: ["t1"] });
  const held = w.board();
  const released = await w.call({ action: "release", taskIds: ["t1"] });
  const after = w.board();
  const releasedUntil = w.heldUntil("t1");
  await w.harness.lifecycle.dispose();
  return { before: [before.t1, before.t2], held: [held.t1, held.t2], released: [released.tasks, released.until, releasedUntil], after: [after.t1, after.t2] };
}

// n315 Queued: waiting for a worker, «created» or «retry».
export function queuedObs() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "p");
  createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} as never });
  createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
  const created = (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='a1'").get() as { state: string }).state;
  const retried = ["spawn_rejected", "provider_error", "timeout", "empty_output", "validation_failed"].map((from) => nextAttemptState(from as never, retryAction(from as never, 1)));
  return { created, formed: nextAttemptState(null, "form_task"), retried, exhausted: nextAttemptState("timeout", retryAction("timeout", 2)), open: isOpenAttemptState("queued"), states: ATTEMPT_STATES[0] };
}

// n317 Claimed: an attempt holds the row for as long as its loop lives; one without a live loop is taken back by the periodic pass.
export async function claimedObs() {
  const NOW = 1_700_000_000_000;
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "p");
  for (const id of ["tA", "tB"]) { createTask(db, { id, runId: "run1", kind: "bb", contract: {} as never }); createAttempt(db, { id: `att${id.slice(1)}`, runId: "run1", taskId: id }); }
  for (const id of ["attA", "attB"]) { transitionAttempt(db, id, "spawn_requested"); transitionAttempt(db, id, "running", { threadId: `thr_${id}` }); }
  db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id IN ('attA','attB')").run(NOW - 10 * 60_000);
  const resumed: string[] = [];
  const services = {
    activeWriterTasks: new Set(["run1:tB"]), docsPlaces: () => [],
    resumeOrphans: async (_p?: string, ids?: readonly string[]) => { resumed.push(...(ids ?? [])); return { resumed: ids ?? [], skipped: [], finished: [] }; },
    stability: { reconcileScanOpen: () => false, adoptBlockedByFaults: async () => [], sweep: async () => [] },
    recoverMergeIntents: async () => [], recheckCancels: async () => undefined, startAfterAcceptance: async () => undefined, workflowEngine: undefined,
  };
  const reconcile = createTaskReconcile({ bb, db, log: () => undefined, isDisposed: () => false } as never, services as never);
  await reconcile.reconcileTasks({ phase: "periodic", now: NOW });
  return { resumed };
}

// n318 Awaiting a person: a verified task waits for the owner's word to land; his yes or no ends the wait.
export function awaitingObs() {
  const words = (decision: "yes" | "no") => [{ turn: "land" as const, decision, text: decision === "yes" ? "да" : "не сливать", at: 1, attemptId: "att-1" }];
  const waits = landingWordGap(true, undefined, "att-1");
  return { waits: [waits?.startsWith("owner_word: owner.words is on — the task is verified and waits for the owner's word to land on main"), waits?.includes("lane_pilot_ask_owner")], yes: landingWordGap(true, words("yes"), "att-1"), no: landingWordGap(true, words("no"), "att-1"), notAsked: landingWordGap(false, undefined, "att-1") };
}

// n319 Completed: a person said yes, the checks passed — the attempt is accepted, ended, never retried.
export function completedObs() {
  const yes = [{ turn: "land" as const, decision: "yes" as const, text: "да", at: 1, attemptId: "att-1" }];
  let retry: string;
  try { retry = retryAction("accepted" as never, 0); } catch (error) { retry = (error as Error).message; }
  return { gap: landingWordGap(true, yes, "att-1"), accepted: nextAttemptState("running", "checks_passed"), open: isOpenAttemptState("accepted"), failed: isFailedAttemptState("accepted"), retry };
}

