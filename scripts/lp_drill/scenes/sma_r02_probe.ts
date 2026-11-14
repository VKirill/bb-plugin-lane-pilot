// Probe of scenes/sma_r02.py: runs the real batch-graph checks of THIS checkout (the commit under drill) on scratch data and prints what
// they returned as one JSON line. It judges nothing: the scene compares each value with the node card's expected result and prove()s it.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../../src/rooms/core/server/core";
import { createPhaseDriver } from "../../../src/rooms/phase/server/driver";
import { createPhaseReactions } from "../../../src/rooms/core/server";
import { acceptanceLines } from "../../../src/rooms/phase/logic/acceptance";
import { designDecision } from "../../../src/rooms/phase/logic/design";
import { nextAction } from "../../../src/rooms/phase/logic/next-action";
import type { Phase, PhaseRecord, PlanItem } from "../../../src/rooms/phase/logic/record";
import { planSignature } from "../../../src/rooms/phase/logic/signatures";
import { executionGate, issuable, waveCleared, type TaskFact } from "../../../src/rooms/phase/logic/waves";
import { savePhase } from "../../../src/rooms/phase/store";
import { pauseRun } from "../../../src/rooms/runs/server/runs-pause";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { createAttempt } from "../../../src/rooms/storage/attempts-store";
import { createRun } from "../../../src/rooms/storage/runs-store";
import { createTask } from "../../../src/rooms/storage/tasks-store";
import { spendReserve } from "../../../src/rooms/tasks/rails";
import { pilotOf, type RunTask } from "../../../src/rooms/writer/server/pilot/logic";

const piece = (id: string, wave = 1, extra: Record<string, unknown> = {}): PlanItem => ({
  id, title: id, wave, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], ...extra },
});
const fact = (id: string, state = "accepted"): TaskFact => ({ taskId: id, state, planFact: "passed", verification: "passed", codeCritique: "passed" });
const phase = (record: PhaseRecord, stage: Phase["stage"] = "execution"): Phase => ({
  id: "ph_probe", projectId: "p", pmThreadId: "pm", runId: "run", title: "Batch", goal: "close the batch", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});
const sibling = (id: string, createdAt: number): RunTask => ({ id, area: "scripts", kind: "code", createdAt, dependsOn: [] });
const ids = (rows: readonly PlanItem[]) => rows.map((row) => row.id);

// n346: closing recomputes coverage — a withdrawn piece leaves its requirement uncovered and holds the acceptance.
function closure() {
  const record: PhaseRecord = {
    context: { docs: [], sha: "c", signedAt: 1, requirements: ["R1"] },
    plan: { items: [{ ...piece("p1"), covers: ["R1"] } as PlanItem], contextSha: "c", sha: "s", admittedSha: "s" },
    verification: { verdict: { state: "passed", detail: "ok", mainSha: "m", at: 1, inputSha: "i" }, model: { state: "met", by: "audit", summary: "met", at: 1 } },
    scope: { revisions: 0, withdrawn: [] },
  };
  const now = { mainSha: "m", openDeferrals: 0 };
  const whole = acceptanceLines(phase(record, "acceptance"), new Map([["p1", fact("t1")]]), now).find((line) => line.id === "nothing_missing")!;
  const dropped = acceptanceLines(phase({ ...record, plan: { ...record.plan!, items: [] }, scope: { revisions: 0, withdrawn: ["p1"] } }, "acceptance"), new Map(), now).find((line) => line.id === "nothing_missing")!;
  return { whole: whole.ok, dropped: dropped.ok, droppedDetail: dropped.detail };
}

// n369 / n370: the stop and the pause on a scratch database (no model, no hub).
async function stopAndPause() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  for (const method of ["threads.stop", "threads.send"]) harness.sdk.stub(method as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const core = createCore(bb, db);
  const phases = createPhaseDriver(core, { runBudgets: { get: () => undefined }, workflowEngine: { cancel: () => true } } as never, createPhaseReactions(db, bb)).phases;
  const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "stop", goal: "stop the batch", rails: true });
  const pieces = ["landed", "open", "queued"].map((id) => piece(id));
  for (const row of pieces) createTask(db, { id: row.id, runId: "run1", kind: "bb", contract: row.task });
  for (const [id, state] of [["landed", "accepted"], ["open", "running"], ["queued", "queued"]] as const) {
    createAttempt(db, { id: `${id}-a`, runId: "run1", taskId: id });
    db.prepare("UPDATE lane_pilot_attempt SET state=?, thread_id=? WHERE id=?").run(state, `thr_${id}`, `${id}-a`);
  }
  const sha = planSignature(pieces, "ctx");
  savePhase(db, opened.id, { stage: "execution", runId: "run1", record: { ...opened.record, plan: { items: pieces, sha, admittedSha: sha, contextSha: "ctx" }, execution: { issued: { landed: "landed", open: "open", queued: "queued" }, startedAt: 1 } } as never, at: 2 });
  const stopped = await phases.stop({ phaseId: opened.id, by: "owner", words: "abandon the batch" });
  const state = (id: string) => (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(`${id}-a`) as { state: string }).state;
  // the pause: a queued piece is held, a running piece is listed as still at work, another run is not touched
  createRun(db, "run2", "projA");
  createTask(db, { id: "w", runId: "run2", kind: "bb", contract: { id: "w" } });
  createTask(db, { id: "q", runId: "run2", kind: "bb", contract: { id: "q" } });
  createAttempt(db, { id: "w-a", runId: "run2", taskId: "w" });
  createAttempt(db, { id: "q-a", runId: "run2", taskId: "q" });
  db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr_w' WHERE id='w-a'").run();
  const paused = await pauseRun(core, "run2", "pause");
  const other = await pauseRun(core, "run1", "status");
  return { canceled: stopped.canceled, phaseState: stopped.phase.state, landed: state("landed"), open: state("open"), queued: state("queued"),
    pause: { paused: paused.paused, waiting: paused.waiting.map((row) => row.taskId), running: paused.running.map((row) => row.taskId), otherRunPaused: other.paused } };
}

const a = piece("a"), b = piece("b", 2, { depends_on: ["a"] });
const held = spendReserve({ budgetTokens: 100, spentTokens: 40, openAppetites: [50], appetite: 20 });
const waveIn: PhaseRecord["execution"] = { issued: {}, waves: { "1": { packageSha: "pkg", lines: [{ id: "landed", ok: true, detail: "merged" }, { id: "checks_passed", ok: true, detail: "pass" }], at: 1 } } };
const decided = (decision: "yes" | "no") => ({ ownerWords: true, wordTurns: undefined, execution: waveIn, words: [{ turn: "wave" as const, wave: 1, decision, by: "owner", text: "wave", at: 2 }] }) as PhaseRecord;
const lineOff: PhaseRecord = { execution: { ...waveIn, waves: { "1": { packageSha: "pkg", lines: [{ id: "landed", ok: true, detail: "merged" }, { id: "checks_passed", ok: false, detail: "red" }], at: 1 } } } };
const wave = [sibling("a", 1), sibling("b", 2), sibling("c", 3)];
const blocked = nextAction(phase({ plan: { items: [piece("a"), piece("b")], contextSha: "c", sha: "s" }, execution: { issued: { a: "a", b: "b" } } }), new Map([["a", fact("a", "blocked")], ["b", fact("b", "running")]]));
const uiPlan = designDecision([piece("card", 1, { owns_paths: ["src/ui/Card.tsx"] }), piece("row", 2, { owns_paths: ["src/ui/Row.tsx"] }), piece("sum", 1)]);
const items = [piece("a"), piece("b"), piece("c", 2), piece("d", 2, { depends_on: ["b"] })];

process.stdout.write(JSON.stringify({
  closure: closure(),
  design: { ui: uiPlan, none: designDecision([piece("sum", 1)]) },
  budget: { held: { ok: held.ok, free: held.free, why: held.why }, fits: spendReserve({ budgetTokens: 100, spentTokens: 40, openAppetites: [50], appetite: 10 }).ok },
  held: { first: ids(issuable([a, b], {}, new Map())), blocked: ids(issuable([a, b], { a: "a" }, new Map([["a", fact("a", "blocked")]]))), after: ids(issuable([a, b], { a: "a" }, new Map([["a", fact("a")]]), {})) },
  pilot: { first: pilotOf("a", wave), second: pilotOf("b", wave), third: pilotOf("c", wave), two: pilotOf("b", wave.slice(0, 2)) },
  barrier: { go: ids(issuable(items, { a: "a", b: "b" }, new Map([["a", fact("a")], ["b", fact("b", "blocked")]]))), clearedUnreviewed: waveCleared({ waveReview: true, ...lineOff }, 1) },
  broken: { waits: blocked.waitsForPm, key: blocked.key, text: blocked.text },
  gate: { notIssued: executionGate([a, b], { a: "a" }, new Map([["a", fact("a")]])), running: executionGate([a, b], { a: "a", b: "b" }, new Map([["a", fact("a")], ["b", fact("b", "running")]])),
    all: executionGate([a, b], { a: "a", b: "b" }, new Map([["a", fact("a")], ["b", fact("b")]])) },
  wave: { yes: waveCleared(decided("yes"), 1), no: waveCleared(decided("no"), 1), lineRed: waveCleared(lineOff, 1) },
  stopAndPause: await stopAndPause(),
}));
