// Probe of scenes/sma_r01_f.py (region 1, batch f): runs the real nodes (the queue lanes, the dead letters, the closing words, the repeated enqueue, the held and decided
// work, the phase steps, the accepted state) of THIS checkout on a scratch database and prints what they returned as one JSON line. It judges nothing: the scene
// compares each value with what the node's card expects and prove()s it. No model, no hub write, nothing outside the machine.
import "../../../src/rooms/platform/server";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../../src/rooms/core/server/core";
import { isHeld } from "../../../src/rooms/runs/server/runs-pause";
import { setRunPaused } from "../../../src/rooms/runs/server/runs-halt";
import { pilotOf, type RunTask } from "../../../src/rooms/writer/server/pilot/logic";
import { lintContract } from "../../../src/rooms/tasks/server/contract-lint";
import { HOLD_FOREVER, recordTaskWord } from "../../../src/rooms/tasks";
import { deadLetters, laneQueueOf } from "../../../src/rooms/tasks/rails";
import { designGate, nextAction, PHASE_STAGES, type Phase, type PhaseRecord } from "../../../src/rooms/phase";
import { isLegalMove, nextAttemptState } from "../../../src/rooms/contracts/state-machine";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { createAttempt, createRun, createTask, getAttempt, saveProjectSetting, saveTaskPlan, savePrototypeConfig, setRunThread, setTaskClosedWords, transitionAttempt } from "../../../src/rooms/storage";
import type { TaskV2 } from "../../../src/rooms/contracts";
import { taskOf } from "../../../tests/sma/r01-world-c";
import { readFileSync } from "node:fs";
import { appendPart, getPhase, insertPhase, savePhase } from "../../../src/rooms/phase/store";
import { installMethods } from "../../../src/rooms/phase/server/driver-methods";

void createCore;
const out: Record<string, unknown> = {};
const step = async (id: string, run: () => unknown | Promise<unknown>) => {
  try { out[id] = await run(); } catch (error) { out[id] = { error: String((error as Error)?.stack ?? error).slice(0, 400) }; }
};
const phase = (record: PhaseRecord, stage: Phase["stage"]): Phase => ({
  id: "ph_f", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});
const item = (id: string, wave = 1) => ({ id, title: id, wave, promise: { given: "g", when: "w", then: "t" }, task: { owns_paths: [`${id}/a.ts`] } });

const DPROJECT = "project-test", DPM = "pm-thread";
const dconfig = { projectId: DPROJECT, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" };
const dtask = (id: string): TaskV2 => ({
  schema_version: 2, display_title: "Probe", kind: "feature", area: `feature:${id}`, id, title: "Probe dispatch", risk: "low", lane: "writer", project_cwd: dconfig.writerWorkspacePath,
  read_first: ["README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["hello.txt"],
  owns_paths: ["hello.txt"], never_touch: [".git/**"], depends_on: [], objective: "create hello", acceptance: ["never"], verify: "none", verification: [],
});

/** A plugin on a fake host whose dispatch stays in preflight (the git base call never answers), PM thread bound to `runId`. */
async function dispatchWorld(runId: string, settings: Record<string, unknown>) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      getPluginMetadata: async ({ threadId }) => threadId === DPM ? { role: "pm", lanePilotRunId: runId } : { role: "writer" },
      spawn: async () => ({ id: "writer-probe" }),
      wait: async () => new Promise(() => undefined),
      get: async ({ threadId }) => threadId === DPM ? { id: DPM, status: "idle", projectId: DPROJECT } as never : { id: threadId, status: "active" } as never,
      output: async () => ({ text: "" }),
      list: async () => [] as never,
      stop: async () => ({} as never),
    }, environments: { listProviders: async () => [] as never }, providers: {
      list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
      models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: ["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
    }, files: { read: async () => ({ content: "fixture\n" }), write: async () => ({ ok: true }) } },
    experimental_callHostRpc: async (call) => {
      if (call.method === "gitOwnershipBase") await new Promise(() => undefined);
      if (call.method === "classifyPlan") return { hostId: "host-test", status: "ok", effort: "xhigh", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
      if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
      return { hostId: "host-test", exitCode: 0, stdout: String((call.input as { command?: string }).command ?? "").includes("porcelain") ? "[]" : "", stderr: "" };
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, dconfig);
  saveProjectSetting(db, DPROJECT, "plan_critique.enabled", false);
  saveProjectSetting(db, DPROJECT, "memory.enabled", false);
  for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, DPROJECT, key, value);
  createRun(db, runId, DPROJECT, "bb", dconfig.writerWorkspacePath);
  setRunThread(db, runId, DPM);
  const { createWriterDispatch } = await import("../../../src/rooms/writer/server/dispatch");
  const ctx = createCore(bb, db);
  const services = { stability: { dropParked: async () => [] }, isLiveFolder: async () => false, activeWriterTasks: new Set<string>(), startWriterTask: async () => undefined, wall: undefined, resolveIntegrationGate: async () => null } as never;
  const { dispatchWriter } = createWriterDispatch(ctx, services);
  const dispatch = async (task: TaskV2) => await dispatchWriter({ threadId: DPM, projectId: DPROJECT, task, plan: "Plan for the probe", objective: "Probe" });
  const count =(table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`).get(runId) as { n: number }).n;
  return { bb, harness, db, dispatch, count };
}

async function main() {
  process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50";

  // n322 closing in words is stored on the task row.
  await step("n322", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createTask(db, { id: "t2", runId: "run1", kind: "bb", contract: taskOf("t2") });
    setTaskClosedWords(db, "t1", "obsolete: the screen was removed");
    const words = (id: string) => (db.prepare("SELECT closed_words FROM lane_pilot_task WHERE id=?").get(id) as { closed_words: string | null }).closed_words;
    return { t1: words("t1"), t2: words("t2") };
  });

  // n326 the lane queue of each kind of work.
  await step("n326", () => ({ lanes: [undefined, "feature", "check", "docs", "research"].map((kind) => laneQueueOf(kind)) }));

  // n328 a blocked or rejected task is a dead letter after a day.
  await step("n328", () => {
    const now = 10_000_000, day = 86_400_000;
    const rows = [{ id: "old-blocked", state: "blocked", updatedAt: now - day }, { id: "fresh-blocked", state: "blocked", updatedAt: now - day + 1 }, { id: "old-rejected", state: "spawn_rejected", updatedAt: now - day * 3 }, { id: "old-accepted", state: "accepted", updatedAt: now - day * 2 }];
    return { dead: deadLetters(rows, now).map((row) => row.id) };
  });

  // n333 the third sibling of one area and kind waits for the earliest.
  await step("n333", () => {
    const tasks: RunTask[] = [1, 2, 3].map((n) => ({ id: `p${n}`, area: "page", kind: "feature", createdAt: n, dependsOn: [] }));
    return { first: pilotOf("p1", tasks), third: pilotOf("p3", tasks), twoOnly: pilotOf("p2", tasks.slice(0, 2)), ordered: pilotOf("p3", tasks.map((t) => t.id === "p3" ? { ...t, dependsOn: ["p1"] } : t)) };
  });

  // n334 a paused run is held, another run is not.
  await step("n334", async () => {
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } };
    const before = await isHeld(kv, "run-1");
    await setRunPaused(kv, "run-1", true);
    const held = await isHeld(kv, "run-1"), other = await isHeld(kv, "run-2");
    await setRunPaused(kv, "run-1", false);
    return { before, held, other, after: await isHeld(kv, "run-1") };
  });

  // n335 a task on the files of an open task is told to wait, not refused.
  await step("n335", () => {
    const root = "/tmp/sma-task";
    const task: TaskV2 = { ...dtask("sma-task"), project_cwd: root, owns_paths: ["src/a.ts"], verification: [{ command: "npx vitest run tests/a.test.ts", cwd: root }], verify: "tests" };
    const result = lintContract({ task, workspacePath: root, hostId: "h", sandboxUnsafe: [], deadDependencies: [], kinds: new Map([[`${root}/src/a.ts`, "file"]]),
      openTasks: [{ id: "earlier", owns_paths: ["src/a.ts"], never_touch: [], depends_on: [] }] });
    return { errors: result.errors.map((e) => e.code), warnings: result.warnings.filter((w) => w.code === "owns_overlap_open").map((w) => w.message) };
  });

  // n336 the family the owner said no to is refused before a task exists.
  await step("n336", async () => {
    const w = await dispatchWorld("run-no", { "owner.words": "on" });
    try {
      await recordTaskWord(w.bb.storage.kv as never, "run-no", "probe-no", "no", "not this quarter");
      const refused = await w.dispatch(dtask("probe-no"));
      return { code: (refused.error as { code?: string } | undefined)?.code ?? null, hint: String(refused.hint ?? ""), tasks: w.count("lane_pilot_task"), attempts: w.count("lane_pilot_attempt") };
    } finally { await w.harness.lifecycle.dispose(); }
  });

  // n337..n340, n342 the phase steps.
  await step("n337", () => {
    const bare = nextAction(phase({ design: { decision: "needed", why: "screens" } }, "design"), new Map());
    const drawn = nextAction(phase({ design: { decision: "needed", why: "screens", drawing: { paths: ["d/UI-SPEC.md"], sha256: "S1", designer: "design-lead", feasible: true, reviewer: "ui-review" } } }, "design"), new Map());
    return { stages: PHASE_STAGES.slice(2, 5), bare: { stage: bare.stage, waitsForPm: bare.waitsForPm, key: bare.key }, drawn: { stage: drawn.stage, waitsForPm: drawn.waitsForPm, key: drawn.key } };
  });
  await step("n338", () => {
    const drawing = (over: Record<string, unknown>) => ({ design: { decision: "needed" as const, why: "screens", drawing: { paths: ["d/UI-SPEC.md"], sha256: "S1", designer: "design-lead", reviewer: "ui-review", ...over } } }) as PhaseRecord;
    const gate = (over: Record<string, unknown>) => { const g = designGate(drawing(over)); return g.ok ? { ok: true } : { ok: false, why: g.why }; };
    return { yes: gate({ feasible: true }), none: gate({}), no: gate({ feasible: false, contradiction: "the plan has no table" }) };
  });
  await step("n339", () => {
    const record: PhaseRecord = { plan: { items: [item("a"), item("b"), item("c")], sha: "s", contextSha: "c", admittedSha: "s" }, execution: { issued: { a: "ta", b: "tb" }, waves: {} } };
    const run = nextAction(phase(record, "execution"), new Map([["a", { state: "accepted" }], ["b", { state: "running" }]]) as never);
    const stuck = nextAction(phase(record, "execution"), new Map([["a", { state: "accepted" }], ["b", { state: "blocked" }]]) as never);
    return { run: { stage: run.stage, waitsForPm: run.waitsForPm, key: run.key }, stuck: { waitsForPm: stuck.waitsForPm, key: stuck.key } };
  });
  await step("n340", () => {
    const base: PhaseRecord = { plan: { items: [item("a")], sha: "s", contextSha: "c", admittedSha: "s" } };
    const view = (record: PhaseRecord) => { const a = nextAction(phase(record, "verification"), new Map()); return { waitsForPm: a.waitsForPm, key: a.key }; };
    return {
      running: view(base),
      failed: view({ ...base, verification: { verdict: { state: "failed", detail: "red", mainSha: "m", at: 1, inputSha: "IN1" } } }),
      passed: view({ ...base, verification: { verdict: { state: "passed", detail: "green", mainSha: "m", at: 1, inputSha: "IN2" } } }),
    };
  });
  await step("n342", () => {
    const record: PhaseRecord = { design: { decision: "needed", why: "screens" }, questions: [{ id: "q1", stage: "design", text: "Which grid?", blocking: true, askedAt: 1 }] };
    const asked = nextAction(phase(record, "design"), new Map());
    const answered = nextAction(phase({ ...record, questions: [{ ...record.questions![0]!, answer: "8px" }] }, "design"), new Map());
    return { asked: { waitsForPm: asked.waitsForPm, key: asked.key }, answered: answered.key };
  });

  // n341 nothing is held by default; the hold is the PM's, until released.
  await step("n341", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "run-h" }) } } });
    try {
      const db = openDatabase(bb);
      createRun(db, "run-h", "proj-h");
      createRun(db, "run-other", "proj-h");
      createTask(db, { id: "th1", runId: "run-h", kind: "bb", contract: taskOf("th1") });
      createTask(db, { id: "tx", runId: "run-other", kind: "bb", contract: taskOf("tx") });
      const { registerQueueTool } = await import("../../../src/rooms/tasks/server/queue-tool");
      const { taskWordPort } = await import("../../../src/rooms/lead/server/surfaces");
      registerQueueTool(createCore(bb, db), taskWordPort as never);
      const held = (id: string) => (db.prepare("SELECT held_until FROM lane_pilot_task WHERE id=?").get(id) as { held_until: number | null }).held_until;
      const queue = async (input: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_queue", input, { threadId: "pm-h", projectId: "proj-h" }))) as Record<string, unknown>;
      const fresh = held("th1");
      const hold = await queue({ action: "hold", taskIds: ["th1", "tx"] });
      const during = [held("th1"), held("tx")];
      const release = await queue({ action: "release", taskIds: ["th1"] });
      return { fresh, forever: HOLD_FOREVER, hold: { tasks: hold.tasks, until: hold.until, refused: hold.refused }, during, release: { tasks: release.tasks, until: release.until }, after: held("th1") };
    } finally { await harness.lifecycle.dispose(); }
  });

  // n1772 the accepted state.
  await step("n1772", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr" });
    transitionAttempt(db, "a1", "validation_failed", { reason: "late" });
    const accepted = transitionAttempt(db, "a1", "accepted", { reason: "merged" });
    const stateAfter = getAttempt(db, "a1")?.state;
    const cancel = transitionAttempt(db, "a1", "canceled", { reason: "late cancel" });
    return { legal: ["running", "queued", "cancel_requested", "blocked", "provider_error", "timeout", "empty_output", "validation_failed"].map((from) => isLegalMove(from, "accepted")), notLegal: ["canceled", "spawn_requested", "spawn_rejected", "accepted"].map((from) => isLegalMove(from, "accepted")), table: nextAttemptState("running", "checks_passed"), accepted, stateAfter, cancel, final: getAttempt(db, "a1")?.state };
  });

  // n343 the owner's «no» on a drawing keeps his remark against that edition, archives the drawing and clears it; the phase stays at design.
  await step("n343", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const NOW = 1_700_000_000_000;
    const drawing = { paths: ["d/one.html"], sha256: "D", designer: "d", feasible: true, reviewer: "r" };
    insertPhase(db, { id: "ph_x", projectId: "p", pmThreadId: "t", runId: "r", title: "T", goal: "g", at: NOW });
    savePhase(db, "ph_x", { stage: "design", record: { ownerWords: true, design: { decision: "needed", why: "x", drawing } } as PhaseRecord, at: NOW });
    const reactions = { answerPhaseWord: () => undefined, closeOwnerItem: () => undefined, noteDesignWord: async () => undefined, closeOwnerItemsByPrefix: () => 0, postOwnerItem: () => undefined, askPhaseWord: () => undefined, journalDrawing: async () => undefined, addRoleLine: async () => undefined, roleLine: (x: unknown) => x, critiqueProblems: () => [] };
    const tools = { ctx: { log: () => undefined, isDisposed: () => false }, services: {}, db, bb: { storage: { kv: {} } }, now: () => NOW, reactions,
      mustGet: (id: string) => getPhase(db, id)!, book: (p: { id: string }, section: never, kind: string, text: string) => appendPart(db, p.id, { section: section as never, kind, text, at: NOW }),
      move: (p: Phase, st: Phase["stage"], rec: PhaseRecord) => savePhase(db, p.id, { stage: st, record: rec, at: NOW }), facts: () => new Map(), readFile: async () => ({ sha256: "s", sizeBytes: 1 }), readText: async () => null,
      writeDocs: async () => ({ written: [], commit: null, shas: {} }), journalSteps: () => [], checkerRunBinding: () => null, reviewerRead: () => ({ why: "no" }), writeLesson: () => undefined, settleLesson: () => undefined,
      writeBook: async () => undefined, pmCheckoutPath: async () => null, candidates: () => null, redoId: (id: string) => `${id}.2`, freshTurns: async (p: Phase) => getPhase(db, p.id)!, freshTurnsSync: (p: Phase) => p };
    const api = installMethods(tools as never);
    const after = await api.word({ phaseId: "ph_x", turn: "design", decision: "no", text: "bigger buttons", by: "owner" });
    return { stage: after.stage, feedback: after.record.design!.feedback, drawingLeft: after.record.design!.drawing ?? null, archived: after.record.design!.archived!.map((d) => d.sha256) };
  });

  // n344 the drawing step asks for the design-lead; no other automatic stage names that role.
  await step("n344", () => {
    const load = (name: string) => JSON.parse(readFileSync(`workflows/${name}.json`, "utf8")) as { nodes: Array<{ id: string; role?: string }> };
    const draw = load("lp.draw").nodes.find((node) => node.id === "draw");
    const others = ["lp.plan", "lp.close", "lp.review", "retrospective"].filter((name) => { try { return load(name).nodes.some((node) => String(node.role).includes("design-lead")); } catch { return false; } });
    return { drawRole: draw?.role ?? null, others };
  });

  delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
}

main().then(() => { console.log(JSON.stringify(out)); process.exit(0); }, (error) => { console.log(JSON.stringify({ fatal: String(error?.stack ?? error).slice(0, 400) })); process.exit(1); });
