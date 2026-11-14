// Region 0 (Phase graph), batch c: execution by plans and the phase's own verification (n59 … n89, n67 is another batch's). Every observation runs the REAL code of
// the node (the phase driver on a scratch database and a fake host, the phase logic) and returns plain JSON. tests/sma/four-proofs-r00-c.test.ts asserts on it
// and the scene scripts/lp_drill/scenes/sma_r00_c.py proves the nodes that write no hub row. No model, no hub write, nothing outside the machine.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  acceptanceLines, blindVerdict, contextSignature, executionGate, issuable, nextAction, phaseFolder, pieceLines, pieceSha, piecesOfWave, planSignature, wavePackage, wavesOf,
  type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";
import { autoInputs } from "../../src/rooms/phase/server/auto-stages";
import { issuedContract, piecePlan, uatText } from "../../src/rooms/phase/stages";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { recordStage } from "../../src/rooms/runs/server";
import { closeRun, createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";
import { saveProjectSetting } from "../../src/rooms/storage";

const H = "a".repeat(40);
const M = "b".repeat(40);
const DOCS = [{ path: "docs/CONTEXT.md", sha256: sha256Hex("docs/CONTEXT.md"), bytes: 120 }];
export const piece = (id: string, wave = 1, extra: Record<string, unknown> = {}, owns?: string[], title = `Piece ${id}`): PlanItem => ({
  id, title, wave, promise: { given: "an empty cell", when: "the sum runs", then: `it skips the cell (${id})` },
  task: { id, owns_paths: owns ?? [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], acceptance: ["works"], ...extra },
});
/** A plan record whose edition was checked: the signature and the admitted signature are the same. */
export const admitted = (items: PlanItem[], extra: Partial<PhaseRecord> = {}): PhaseRecord => {
  const context = { docs: DOCS, sha: contextSignature(DOCS), signedAt: 1, risks: { value: "none", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] };
  const sha = planSignature(items, context.sha);
  return { context, plan: { items, contextSha: context.sha, sha, admittedSha: sha, objective: "the goal", premortem: ["r1", "r2", "r3"], critique: { decision: "approve", by: "critic", independence: { ok: true, why: "separate session" } } }, ...extra };
};
export const pure = (record: PhaseRecord, stage: Phase["stage"] = "execution"): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "sums are right", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});
export const fact = (taskId: string, over: Partial<TaskFact> = {}): TaskFact => ({ taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "skipped", ...over });
const facts = (rows: Array<[string, Partial<TaskFact>]>) => new Map(rows.map(([id, over]) => [id, fact(id, over)]));
const refusal = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return "not refused"; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };
const lineOf = (lines: Array<{ id: string; ok: boolean; detail: string }>, id: string) => { const row = lines.find((line) => line.id === id)!; return { ok: row.ok, detail: row.detail }; };
const sliceVerdict = (v: { state: string; detail: string; mainSha: string | null }) => ({ state: v.state, detail: v.detail, mainSha: v.mainSha });

type Goal = { state: string; detail?: string | null; headSha?: string | null } | null;
const ALL_PROVED = { "plan-fact": "passed", verification: "passed", "code-critique": "passed" } as const;

/** The phase driver on a scratch database and a fake host: the dispatched pieces, the regression runs, the goal checks and the files of the host are all captured. */
export async function drv(o: { words?: boolean } = {}) {
  const previous = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = o.words ? "on" : "off";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send" as never, async () => ({}));
  harness.sdk.stub("threads.stop" as never, async () => ({}));
  harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list" as never, async () => []);
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const writes: Array<{ path: string; content: string }> = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") return { status: "applied", writes: (input.edits as Array<{ path: string; content: string }>).map((edit) => { writes.push(edit); return { path: edit.path, status: "applied", afterSha256: "x" }; }) };
    if (method === "gitCommitDocs") return { commit: "c".repeat(40) };
    if (method === "runCommand") return { exitCode: 0, stdout: `${H}\n`, stderr: "" };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  if (o.words) saveProjectSetting(db, "projA", "owner.words", "on");
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const dispatched: Array<{ task: Record<string, unknown>; plan: string }> = [];
  const regressions: Array<Record<string, unknown>> = [];
  const goalChecks: Goal[] = [];
  const goalAnswers: Goal[] = [];
  const fileShas = new Map<string, string>();
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    runGoal: { check: async () => { const answer = goalAnswers.shift() ?? null; goalChecks.push(answer); return answer; } },
    readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: fileShas.get(path) ?? sha256Hex(path), sizeBytes: 10, content: "x" }),
    dispatchWriter: async (input: { task: Record<string, unknown>; plan?: string }) => {
      dispatched.push({ task: input.task, plan: input.plan ?? "" });
      createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task });
      return { ok: true, taskId: input.task.id, runId: "run1" };
    },
    regression: { run: async (input: Record<string, unknown>) => { regressions.push(input);
      const tasks = (db.prepare("SELECT id FROM lane_pilot_task WHERE run_id='run1'").all() as Array<{ id: string }>).map((row) => ({ taskId: row.id, checks: [{ command: "npm test", state: "green" }] }));
      return { projects: [{ projectId: "projA", head: H, tasks, findings: [] }] }; } },
    rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services).phases;
  const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  const get = () => getPhase(db, opened.id)!;
  const seed = (stage: Phase["stage"], patch: Partial<PhaseRecord>) => savePhase(db, opened.id, { stage, runId: "run1", record: { ...get().record, ...(o.words ? { ownerWords: true } : {}), ...patch }, at: 2 });
  /** An attempt of a task in the run with the receipts of its stages; `at` orders it among the attempts of its family. */
  const settle = (taskId: string, state: string, receipts: Record<string, string> = {}, at = 10) => {
    if (!db.prepare("SELECT 1 FROM lane_pilot_task WHERE id=?").get(taskId)) createTask(db, { id: taskId, runId: "run1", kind: "bb", contract: { id: taskId } });
    const attempt = `att-${taskId}`;
    createAttempt(db, { id: attempt, runId: "run1", taskId });
    db.prepare("UPDATE lane_pilot_attempt SET state=?, created_at=? WHERE id=?").run(state, at, attempt);
    for (const [stageId, stateOf] of Object.entries(receipts)) recordStage(db, { runId: "run1", taskId, stageId: stageId as never, state: stateOf as never, attempt: 1, input: stageId });
  };
  const restore = () => { if (previous === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = previous; };
  return { db, phases, id: opened.id, get, seed, settle, dispatched, regressions, goalChecks, goalAnswers, fileShas, writes, restore, parts: (kind: string) => listParts(db, opened.id).filter((part) => part.kind === kind).map((part) => part.text) };
}
type Drv = Awaited<ReturnType<typeof drv>>;
const withDrv = async <T>(o: Parameters<typeof drv>[0], run: (f: Drv) => Promise<T>): Promise<T> => { const f = await drv(o); try { return await run(f); } finally { f.restore(); } };

export const observe = {
  /** n59 · the plan is the edition that was checked: the same hash is unchanged, a rewrite or a re-signed rewrite is not; the acceptance line and the issue say so. */
  async planFile() {
    return withDrv({}, async (f) => {
      const a = piece("a");
      f.seed("execution", admitted([a]));
      const untouched = f.get();
      const unchanged = f.phases.planUnchanged(untouched);
      const line = (record: PhaseRecord) => lineOf(acceptanceLines(pure(record, "acceptance"), new Map(), { mainSha: null, openDeferrals: 0 }), "contract_current");
      const rewritten = piece("a"); rewritten.promise = { ...rewritten.promise, then: "something else" };
      const resigned = { ...untouched.record, plan: { ...untouched.record.plan!, items: [rewritten], sha: planSignature([rewritten], untouched.record.plan!.contextSha) } };
      f.seed("execution", resigned);
      const before = f.dispatched.length;
      const refused = await refusal(() => f.phases.drive(f.get()));
      return { unchanged, unchangedLine: line(untouched.record), rewritten: { unchanged: f.phases.planUnchanged(f.get()), line: line(resigned), refused: refused.split("\n")[0], dispatched: f.dispatched.length - before },
        // The items were edited and the stored signature left as it was: the hash recomputed from the pieces no longer matches the admitted one.
        edited: f.phases.planUnchanged({ ...untouched, record: { ...untouched.record, plan: { ...untouched.record.plan!, items: [rewritten] } } }) };
    });
  },

  /** n60 · the plan's piece goes out as a work piece: its own contract with the fields the machine knows itself filled in, its promise, its own task id. */
  async pieceContract() {
    return withDrv({}, async (f) => {
      const bare = piece("p1", 1, {}, undefined, "Skeleton   view");
      const own = piece("p2", 1, { display_title: "Own title", kind: "fix", area: "billing", promise: { given: "x", when: "y", then: "z" } });
      const withCases = piece("p3", 1, { qa_cases: ["opens"], qa_env_class: "dev", qa_dev_server: "npm run dev" });
      const withUrl = piece("p4", 1, { qa_cases: ["opens"], qa_url: "http://localhost:3000" });
      const pick = (made: ReturnType<typeof issuedContract>) => ({ display_title: made.task.display_title, kind: made.task.kind, area: made.task.area, promise: made.task.promise, qa_cases: made.task.qa_cases ?? null, dropped: made.dropped });
      const phase = { id: "ph_1" };
      f.seed("execution", admitted([bare]));
      await f.phases.drive(f.get());
      const sent = f.dispatched[0]!.task;
      return { bare: pick(issuedContract(phase, bare)), own: pick(issuedContract(phase, own)), withCases: pick(issuedContract(phase, withCases)), withUrl: pick(issuedContract(phase, withUrl)),
        sent: { id: sent.id, display_title: sent.display_title, kind: sent.kind, area: String(sent.area).replace(f.id, "<id>"), promise: sent.promise, objective: sent.objective, owns_paths: sent.owns_paths, verification: sent.verification, acceptance: sent.acceptance } };
    });
  },

  /** n61 · the binding of a piece and its work: the task id and the contract print are written on the phase with the run; a passed pass does not issue again, a changed contract does. */
  async binding() {
    return withDrv({}, async (f) => {
      const a = piece("a");
      f.seed("execution", admitted([a]));
      const first = await f.phases.drive(f.get());
      const row = f.db.prepare("SELECT run_id FROM lane_pilot_phase WHERE id=?").get(f.id) as { run_id: string };
      const afterFirst = { dispatched: f.dispatched.length, issued: first.record.execution?.issued, printIsPiece: first.record.execution?.issuedSha?.a === pieceSha(a), runId: row.run_id, book: f.parts("issued") };
      await f.phases.drive(f.get());
      const again = { dispatched: f.dispatched.length, issued: f.get().record.execution?.issued };
      const changed = piece("a", 1, { acceptance: ["works", "and one more"] });
      f.seed("execution", { ...admitted([changed]), execution: f.get().record.execution });
      const third = await f.phases.drive(f.get());
      return { afterFirst, again, changed: { dispatched: f.dispatched.length, secondId: f.dispatched[1]?.task.id, issued: third.record.execution?.issued, printIsNewPiece: third.record.execution?.issuedSha?.a === pieceSha(changed), reissued: f.parts("reissued") } };
    });
  },

  /** n62 · the wave is the piece's address: earliest wave first, each wave's table and each issue line name it, the plan text goes out with it. */
  async waveAddress() {
    return withDrv({}, async (f) => {
      const a = piece("a", 2), b = piece("b", 1), c = piece("c", 2);
      f.seed("execution", admitted([a, b, c]));
      await f.phases.drive(f.get());
      return { waves: wavesOf([a, b, c]), wave2: piecesOfWave([a, b, c], 2).map((item) => item.id), wave1: piecesOfWave([a, b, c], 1).map((item) => item.id),
        order: f.dispatched.map((row) => String(row.task.id)), firstLines: f.dispatched.map((row) => row.plan.split("\n")[0]!.replace(/Phase ph_\w+/, "Phase <id>")),
        issued: f.parts("issued"), tables: f.parts("wave_table").map((text) => text.split("\n")) };
    });
  },

  /** n63 · a piece that builds screens carries the phase drawing (its task and its plan text); a piece that does not, carries none. */
  async drawingInPiece() {
    return withDrv({}, async (f) => {
      const ui = piece("ui", 1, {}, ["src/App.tsx"]), logic = piece("a", 1, {}, ["src/a.ts"]);
      const drawing = { paths: [`${phaseFolder("ph_1")}/design/UI-SPEC.md`, `${phaseFolder("ph_1")}/design/kit.html`], sha256: "d".repeat(64), designer: "design-lead", reviewer: "ui-review", feasible: true };
      f.seed("execution", admitted([ui, logic], { design: { decision: "needed", why: "screens", drawing, confirmedAt: 3 } }));
      await f.phases.drive(f.get());
      const phase = pure({ design: { decision: "needed", why: "screens", drawing } });
      const line = (text: string) => text.split("\n").filter((row) => row.includes("the screens follow the phase drawing"));
      return { sentDrawing: f.dispatched.map((row) => [row.task.id, row.task.drawing ?? null]), planLines: f.dispatched.map((row) => [row.task.id, line(row.plan)]),
        pure: { ui: line(piecePlan(phase, ui)), logic: line(piecePlan(phase, logic)), noDrawing: line(piecePlan(pure({}), ui)) } };
    });
  },

  /** n64 · a piece goes once its own dependencies are accepted, not the whole earlier wave; a broken one holds what depends on it and nobody else. */
  deps() {
    const a = piece("a", 1), c = piece("c", 1), b = piece("b", 2, { depends_on: ["a"] }), d = piece("d", 3, { depends_on: ["b", "c"] }), ghost = piece("e", 2, { depends_on: ["nobody"] }), self = piece("f", 2, { depends_on: ["f"] });
    const items = [a, c, b, d, ghost, self];
    const ids = (issued: Record<string, string>, rows: Array<[string, Partial<TaskFact>]>) => issuable(items, issued, facts(rows)).map((item) => item.id);
    return {
      none: ids({}, []),
      oneAcceptedOneRunning: ids({ a: "a", c: "c" }, [["a", {}], ["c", { state: "running" }]]),
      oneBlocked: ids({ a: "a", c: "c" }, [["a", { state: "blocked" }], ["c", {}]]),
      notIssuedYet: ids({}, [["a", {}]]),
      bothDone: ids({ a: "a", c: "c", b: "b" }, [["a", {}], ["c", {}], ["b", { state: "running" }]]),
      afterB: ids({ a: "a", c: "c", b: "b" }, [["a", {}], ["c", {}], ["b", {}]]),
      queuedIsNotAccepted: ids({ a: "a" }, [["a", { state: "queued" }]]),
    };
  },

  /** n65 · each piece is its own work: its own task id and contract (checks, acceptance), quality mode full, a plan text with the steps of its contract. */
  async pieceRuns() {
    return withDrv({}, async (f) => {
      const a = piece("a", 1, { priority: "high" }), b = piece("b", 1, { acceptance: ["b works", "b is fast"], verification: [{ command: "npm test -- b" }, { command: "npm run lint" }] });
      f.seed("execution", admitted([a, b]));
      await f.phases.drive(f.get());
      const view = (row: { task: Record<string, unknown>; plan: string }) => ({ id: row.task.id, quality_mode: row.task.quality_mode, priority: row.task.priority ?? null, verification: row.task.verification, acceptance: row.task.acceptance, owns_paths: row.task.owns_paths,
        steps: row.plan.split("\n").filter((line) => /^(\d\.|   )/.test(line) || line.startsWith("Done")) });
      return f.dispatched.map(view);
    });
  },

  /** n66 · the plan is a nested batch: a phase executing its plan in a run closes with that run when a person closes it, naming the run; the hub's own cleaning of the run ends nobody's plan. */
  async nestedBatch() {
    const run = async (closedBy: string) => withDrv({}, async (f) => {
      f.seed("execution", admitted([piece("a")]));
      closeRun(f.db, "run1", closedBy as never);
      await f.phases.tick();
      const after = f.get();
      return { state: after.state, stage: after.stage, closing: after.record.closing?.words ?? null, book: f.parts("close"), dispatched: f.dispatched.length };
    });
    return { cli: await run("cli"), rpc: await run("rpc"), sweep: await run("sweep"), ttl: await run("ttl") };
  },

  /** n68 · the execution waits for every piece: one not issued or not accepted is named, the gate opens when all are accepted. */
  executionWait() {
    const items = [piece("a", 1), piece("b", 1)];
    const why = (issued: Record<string, string>, rows: Array<[string, Partial<TaskFact>]>) => { const gate = executionGate(items, issued, facts(rows)); return gate.ok ? [] : gate.why; };
    return {
      nothingIssued: why({}, []), half: why({ a: "a" }, [["a", {}]]), running: why({ a: "a", b: "b" }, [["a", {}], ["b", { state: "running" }]]), blocked: why({ a: "a", b: "b" }, [["a", {}], ["b", { state: "blocked" }]]),
      noFact: why({ a: "a", b: "b" }, [["a", {}]]), allIn: why({ a: "a", b: "b" }, [["a", {}], ["b", {}]]),
    };
  },

  /** n69 · the execution command the PM reads: what runs, what is blocked, what could not be issued, each with its own key and who waits. */
  executionText() {
    const items = [piece("a", 1), piece("b", 1), piece("c", 1)];
    const phase = (record: PhaseRecord) => pure({ ...admitted(items), ...record });
    const say = (record: PhaseRecord, rows: Array<[string, Partial<TaskFact>]>) => { const action = nextAction(phase(record), facts(rows)); return { key: action.key, waitsForPm: action.waitsForPm, text: action.text }; };
    return {
      running: say({ execution: { issued: { a: "a", b: "b" }, startedAt: 1 } }, [["a", { state: "accepted" }], ["b", { state: "running" }]]),
      blocked: say({ execution: { issued: { a: "a" }, startedAt: 1 } }, [["a", { state: "blocked" }]]),
      issueError: say({ execution: { issued: {}, startedAt: 1, issueErrors: { b: "dispatch refused" } } }, []),
    };
  },

  /** n71 · what each piece's work did is read from its latest attempt and the receipts of its stages, never from what the worker said. */
  async calc() {
    return withDrv({}, async (f) => {
      const a = piece("a"), b = piece("b"), c = piece("c");
      f.seed("execution", { ...admitted([a, b, c]), execution: { issued: { a: "a", b: "b", c: "c" }, startedAt: 1 } });
      f.settle("a", "failed", { "plan-fact": "failed", verification: "failed" }, 10);
      f.settle("a.2", "accepted", { ...ALL_PROVED, "browser-qa": "passed", "plan-critique": "failed" } as never, 20);
      f.db.prepare("UPDATE lane_pilot_task SET contract_json=? WHERE id='a.2'").run(JSON.stringify({ id: "a.2", qa_cases: ["opens"] }));
      f.settle("b", "running", {}, 30);
      const read = f.phases.facts(f.get());
      const view = (id: string) => { const row = read.get(id)!; return { taskId: row.taskId, state: row.state, planFact: row.planFact, verification: row.verification, codeCritique: row.codeCritique, browserQa: row.browserQa ?? null, qaPlanned: row.qaPlanned ?? null, attempt: row.attemptId }; };
      return { a: view("a"), b: view("b"), c: view("c") };
    });
  },

  /** n72 · each piece's cycle is judged by its receipts: no receipt is no reading, and a claim grants nothing. */
  pieceCycle() {
    const code = piece("a"), docs = piece("d", 1, { kind: "docs" });
    const lines = (item: PlanItem, row: TaskFact | undefined) => Object.fromEntries(pieceLines(item, row, undefined, false).map((line) => [line.id, [line.ok, line.detail] as [boolean, string]]));
    return {
      proved: lines(code, fact("a")),
      noReceipts: lines(code, fact("a", { planFact: null, verification: null, codeCritique: null })),
      blocked: lines(code, fact("a", { codeCritique: "blocked" })),
      failed: lines(code, fact("a", { planFact: "failed", verification: "failed", state: "running" })),
      docsSkipped: lines(docs, fact("d", { planFact: "skipped" })),
      neverIssued: lines(code, undefined),
    };
  },

  /** n73 · a wave is handed in as a package of its pieces' facts with the lines they hold; written to the book once; a blocked piece is not handed in. */
  async waveIn() {
    return withDrv({}, async (f) => {
      const a = piece("a"), b = piece("b");
      const issuedSha = { a: pieceSha(a), b: pieceSha(b) };
      f.seed("execution", { ...admitted([a, b]), waveReview: true, execution: { issued: { a: "a", b: "b" }, issuedSha, startedAt: 1 } });
      f.settle("a", "accepted", ALL_PROVED, 10);
      f.settle("b", "accepted", { "plan-fact": "passed", verification: "passed" }, 20);
      await f.phases.drive(f.get());
      const once = f.parts("wave_in");
      await f.phases.drive(f.get());
      const wave = f.get().record.execution!.waves!["1"]!;
      const read = f.phases.facts(f.get());
      const handedIn = { book: once.map((text) => text.replace(wave.packageSha.slice(0, 12), "<pkg>")), bookAfterSecondPass: f.parts("wave_in").length, packageIsOfThePieces: wave.packageSha === wavePackage([a, b], read), stage: f.get().stage,
        lines: Object.fromEntries(wave.lines.map((line) => [line.id, [line.ok, line.detail] as [boolean, string]])), pieceLines: Object.fromEntries(Object.entries(wave.pieces ?? {}).map(([id, rows]) => [id, rows.filter((line) => !line.ok).map((line) => line.id)])) };
      const held = await drv();
      try {
        held.seed("execution", { ...admitted([a, b]), waveReview: true, execution: { issued: { a: "a", b: "b" }, issuedSha, startedAt: 1 } });
        held.settle("a", "accepted", ALL_PROVED, 10);
        held.settle("b", "blocked", {}, 20);
        await held.phases.drive(held.get());
        const next = nextAction(held.get(), held.phases.facts(held.get()));
        return { handedIn, blocked: { waveIn: held.parts("wave_in").length, wavesRecorded: Object.keys(held.get().record.execution?.waves ?? {}), stage: held.get().stage, key: next.key, waitsForPm: next.waitsForPm, decides: next.text.includes(`piece:"b", choice:"skip"|"retry"|"cancel"`) } };
      } finally { held.restore(); }
    });
  },

  /** n74 · a browser check that was planned and has not passed is not a pass, one that failed is red, one taken on another candidate does not transfer. */
  liveQa() {
    const candidate = (verified: string, live?: string): PhaseRecord => ({ plan: { items: [piece("a")], contextSha: "c", sha: "s", admittedSha: "s" }, candidate: { branch: "phase/ph_1", trees: { "/repo": { path: "/repo/wt", startSha: "s" } }, verified: { "/repo": verified } }, ...(live ? { verification: { live: { head: live } } as never } : {}) });
    const qa = (over: Partial<TaskFact>, record: PhaseRecord = candidate("2".repeat(40))) => lineOf(acceptanceLines(pure(record, "acceptance"), facts([["a", over]]), { mainSha: null, openDeferrals: 0 }), "qa_read");
    return {
      notRun: qa({ qaPlanned: true, browserQa: null }), failed: qa({ qaPlanned: true, browserQa: "failed" }), passed: qa({ qaPlanned: true, browserQa: "passed" }), nonePlanned: qa({}),
      foreignGreen: qa({ qaPlanned: true, browserQa: "passed" }, candidate("2".repeat(40), "1".repeat(40))), sameCandidate: qa({ qaPlanned: true, browserQa: "passed" }, candidate("2".repeat(40), "2".repeat(40))),
    };
  },

  /** n75 · the phase leaves the execution only when every issued piece is accepted: not while one still runs, not while one is not issued. */
  async toVerification() {
    return withDrv({}, async (f) => {
      const a = piece("a"), b = piece("b");
      const issuedSha = { a: pieceSha(a), b: pieceSha(b) };
      f.seed("execution", { ...admitted([a, b]), waveReview: false, execution: { issued: { a: "a", b: "b" }, issuedSha, startedAt: 1 } });
      f.settle("a", "accepted", ALL_PROVED, 10);
      f.settle("b", "running", {}, 20);
      const whileRunning = (await f.phases.drive(f.get())).stage;
      f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-b'").run();
      const moved = await f.phases.drive(f.get());
      const half = await drv();
      try {
        half.seed("execution", { ...admitted([a, b]), waveReview: false, execution: { issued: { a: "a" }, issuedSha: { a: issuedSha.a }, startedAt: 1 } });
        half.settle("a", "accepted", ALL_PROVED, 10);
        const notIssued = (await half.phases.drive(half.get())).stage;
        return { whileRunning, afterAccepted: moved.stage, book: f.parts("stage"), notIssued };
      } finally { half.restore(); }
    });
  },

  /** n76 / n85 · the barrier of the phase: one regression run over the whole candidate (every tree of it), its goal on the phase record, the heads frozen as the package. */
  async barrier() {
    return withDrv({}, async (f) => {
      const a = piece("a"), b = piece("b");
      f.seed("verification", { ...admitted([a, b]), waveReview: false, execution: { issued: { a: "a", b: "b" }, issuedSha: { a: pieceSha(a), b: pieceSha(b) }, startedAt: 1 }, candidate: { branch: "phase/ph_1", trees: { "/repo": { path: "/repo/.git/lp-phases/ph_1", startSha: "s" } } } });
      f.settle("a", "accepted", ALL_PROVED, 10);
      f.settle("b", "accepted", ALL_PROVED, 20);
      f.regressions.length = 0;
      const out = await f.phases.drive(f.get());
      const candidate = out.record.candidate!;
      return { regression: f.regressions.map((row) => ({ projectId: row.projectId, runId: row.runId, force: row.force, mode: row.mode, basePaths: row.basePaths })), goalCheckOfMain: f.goalChecks.length,
        goal: candidate.goal ? { state: candidate.goal.state, tasks: candidate.goal.tasks, headSha: candidate.goal.headSha, runId: candidate.goal.runId } : null, verified: candidate.verified ?? null,
        verdict: out.record.verification?.verdict ? sliceVerdict(out.record.verification.verdict) : null };
    });
  },

  /** n77 / n83 · what the goal audit is handed: every piece's promise and contract, its dependencies, the diff range of the phase, the drawing, the verdict's words. */
  closeInputs() {
    const p1 = piece("p1", 1, { acceptance: ["acc-p1"] }), p2 = piece("p2", 2, { acceptance: ["acc-p2"], depends_on: ["p1"] });
    const drawing = { paths: ["d/UI-SPEC.md", "d/one.html"], sha256: "drawsha", designer: "a" };
    const base: PhaseRecord = { plan: { items: [p1, p2], contextSha: "c", sha: "s", admittedSha: "s" }, execution: { issued: {}, startedAt: 1, baseSha: "base0" }, verification: { verdict: { state: "passed", detail: "the blind detail", mainSha: "m1", at: 1, inputSha: "i1" } },
      design: { decision: "needed", why: "x", drawing }, candidate: { branch: "phase/ph_1", trees: { "/repo": { path: "/repo/wt", startSha: "s0" } } } };
    const inputs = (record: PhaseRecord) => autoInputs(pure(record, "verification"), { kind: "close" });
    const full = inputs(base) as { goals: Array<{ id: string; done_when: string; depends_on: string[]; contract: Record<string, unknown> }>; merged_commits: string[]; drawing?: Record<string, unknown>; summary: string; goal: string };
    const landed = inputs({ ...base, candidate: { ...base.candidate!, landedAt: 5 } }) as { merged_commits: string[]; summary: string };
    const plain = inputs({ ...base, candidate: undefined, design: undefined, execution: { issued: {}, startedAt: 1 } }) as { merged_commits: string[]; drawing?: unknown; summary: string };
    const points = inputs({ ...base, designPoints: true, verification: { ...base.verification!, points: [{ id: "design_1", text: "a primary button", met: false }] } as never }) as { drawing?: { points?: unknown } };
    return { goal: full.goal, goals: full.goals.map((g) => ({ id: g.id, done_when: g.done_when, depends_on: g.depends_on, contract: g.contract })), merged: full.merged_commits, drawing: full.drawing, summary: full.summary,
      landed: { merged: landed.merged_commits, summary: landed.summary }, plain: { merged: plain.merged_commits, drawing: plain.drawing ?? null, summary: plain.summary }, points: points.drawing?.points ?? null };
  },

  /** n78 / n79 / n81 / n84 / n86 · the blind verdict is decided by code from the pieces' receipts and the goal check: each reason is named, a piece anywhere in the plan counts, a claim does not. */
  verdicts() {
    const items = [piece("a"), piece("b"), piece("c")];
    const proved: Array<[string, Partial<TaskFact>]> = [["a", {}], ["b", {}], ["c", {}]];
    const goal = { state: "passed", detail: null, headSha: "h1" };
    const run = (rows: Array<[string, Partial<TaskFact>]>, g: Goal = goal) => { const v = blindVerdict(items, facts(rows), g as never, 10); return { state: v.state, detail: v.detail, mainSha: v.mainSha }; };
    const withFact = (id: string, over: Partial<TaskFact>) => proved.map(([row, base]): [string, Partial<TaskFact>] => (row === id ? [row, { ...base, ...over }] : [row, base]));
    const same = blindVerdict(items, facts(proved), goal as never, 10), later = blindVerdict(items, facts(proved), goal as never, 99999);
    const changed = (v: ReturnType<typeof blindVerdict>) => v.inputSha !== same.inputSha;
    return {
      allProved: run(proved),
      firstChecksFailed: run(withFact("a", { verification: "failed" })), lastPlanFactFailed: run(withFact("c", { planFact: "failed" })), noPlanFactReceipt: run(withFact("b", { planFact: null })), planFactSkipped: run(withFact("b", { planFact: "skipped" })),
      noChecksReceipt: run(withFact("b", { verification: null })), checksSkipped: run(withFact("b", { verification: "skipped" })), criticBlocks: run(withFact("c", { codeCritique: "blocked" })),
      oneRunning: run(withFact("b", { state: "running" })), oneNotIssued: run([["a", {}], ["c", {}]]),
      goalRunning: run(proved, { state: "running" }), goalFailed: run(proved, { state: "failed", detail: "npm test is red" }), goalPartial: run(proved, { state: "partial" }), goalNever: run(proved, null),
      stable: { sameFactsSameInput: same.inputSha === later.inputSha, newFactNewInput: changed(blindVerdict(items, facts(withFact("a", { planFact: "failed" })), goal as never, 10)),
        newGoalNewInput: changed(blindVerdict(items, facts(proved), { ...goal, headSha: "h2" } as never, 10)), fewerPiecesNewInput: changed(blindVerdict(items.slice(1), facts(proved), goal as never, 10)),
        drawingBound: changed(blindVerdict(items, facts(proved), goal as never, 10, { sha256: "aaa", contract: "d/UI-SPEC.md" })),
        drawingHashNewInput: blindVerdict(items, facts(proved), goal as never, 10, { sha256: "aaa", contract: "d/UI-SPEC.md" }).inputSha !== blindVerdict(items, facts(proved), goal as never, 10, { sha256: "bbb", contract: "d/UI-SPEC.md" }).inputSha,
        drawingPathNewInput: blindVerdict(items, facts(proved), goal as never, 10, { sha256: "aaa", contract: "d/UI-SPEC.md" }).inputSha !== blindVerdict(items, facts(proved), goal as never, 10, { sha256: "aaa", contract: "d/DESIGN.md" }).inputSha },
      drawingChanged: sliceVerdict(blindVerdict(items, facts(proved), goal as never, 10, { sha256: "bbb", contract: "d/UI-SPEC.md", changed: "confirmed aaa, now bbb" })),
      drawingUnchanged: sliceVerdict(blindVerdict(items, facts(proved), goal as never, 10, { sha256: "aaa", contract: "d/UI-SPEC.md", changed: null })),
    };
  },

  /** n80 / n84 · the blind verdict is frozen once: a goal check still running freezes nothing, the first verdict stays whatever the goal check says later and is written to the book once. */
  async frozen() {
    return withDrv({}, async (f) => {
      const a = piece("a");
      f.seed("verification", { ...admitted([a]), waveReview: false, execution: { issued: { a: "a" }, issuedSha: { a: pieceSha(a) }, startedAt: 1 } });
      f.settle("a", "accepted", ALL_PROVED, 10);
      f.goalAnswers.push({ state: "running" }, { state: "passed", detail: null, headSha: H }, { state: "failed", detail: "npm test is red", headSha: M });
      const pending = await f.phases.drive(f.get());
      const pendingView = { verdict: pending.record.verification?.verdict ?? null, book: f.parts("blind_verdict").length, checks: f.goalChecks.length };
      const first = await f.phases.drive(f.get());
      const verdict = first.record.verification!.verdict!;
      const frozen = { state: verdict.state, detail: verdict.detail, mainSha: verdict.mainSha, book: f.parts("blind_verdict").map((text) => text.replace(verdict.inputSha.slice(0, 12), "<input>")), checks: f.goalChecks.length };
      const later = await f.phases.drive(f.get());
      const again = later.record.verification!.verdict!;
      return { pending: pendingView, frozen, later: { sameVerdict: JSON.stringify(again) === JSON.stringify(verdict), state: again.state, book: f.parts("blind_verdict").length, checks: f.goalChecks.length } };
    });
  },

  /** n82 · the verdict is bound to the confirmed drawing: its hash is recomputed from the files, a drawing changed after confirmation fails the verdict and names both hashes. */
  async drawingBound() {
    const run = async (changeFile: boolean) => withDrv({}, async (f) => {
      const a = piece("a", 1, {}, ["src/App.tsx"]);
      const path = `${phaseFolder("ph_x")}/design/UI-SPEC.md`;
      const confirmed = sha256Hex(`${path}:${sha256Hex(path)}`);
      f.seed("verification", { ...admitted([a]), waveReview: false, execution: { issued: { a: "a" }, issuedSha: { a: pieceSha(a) }, startedAt: 1 }, design: { decision: "needed", why: "screens", drawing: { paths: [path], sha256: confirmed, designer: "design-lead", reviewer: "ui-review", feasible: true } } });
      f.settle("a", "accepted", { ...ALL_PROVED, "browser-qa": "passed" }, 10);
      if (changeFile) f.fileShas.set(path, "f".repeat(64));
      f.goalAnswers.push({ state: "passed", detail: null, headSha: H });
      const out = await f.phases.drive(f.get());
      const verdict = out.record.verification!.verdict!;
      return { state: verdict.state, detail: verdict.detail.replace(confirmed.slice(0, 12), "<confirmed>").replace(sha256Hex(`${path}:${"f".repeat(64)}`).slice(0, 12), "<now>"), inputSha: verdict.inputSha };
    });
    const same = await run(false), changed = await run(true);
    return { same: { state: same.state, detail: same.detail }, changed: { state: changed.state, detail: changed.detail }, differentInput: same.inputSha !== changed.inputSha };
  },

  /** n87 · acceptance holds when main is no longer the commit the verdict saw: the line says so, the driver verifies again on the main that is there. */
  async mainMoved() {
    const line = (verdictMain: string | null, nowMain: string | null) => lineOf(acceptanceLines(pure({ plan: { items: [piece("a")], contextSha: "c", sha: "s", admittedSha: "s" }, verification: { verdict: { state: "passed", detail: "ok", mainSha: verdictMain, at: 1, inputSha: "i" } } }, "acceptance"), facts([["a", {}]]), { mainSha: nowMain, openDeferrals: 0 }), "main_unmoved");
    const pureLines = { same: line(M, M), moved: line(M, H), unknownNow: line(M, null), unknownThen: line(null, H) };
    return withDrv({}, async (f) => {
      const a = piece("a");
      const verdict = { state: "passed" as const, detail: "ok", mainSha: M, at: 1, inputSha: "i".repeat(64) };
      f.seed("acceptance", { ...admitted([a]), waveReview: false, execution: { issued: { a: "a" }, issuedSha: { a: pieceSha(a) }, startedAt: 1 }, candidate: { branch: "phase/ph_1", trees: { "/repo": { path: "/repo/wt", startSha: "s" } }, verified: { "/repo": M }, goal: { state: "passed", headSha: M, red: [], detail: null, at: 1, tasks: 1, runId: "run1", projectId: "projA" } },
        verification: { verdict, model: { state: "met", by: "lp.close", summary: "met", at: 2 } } });
      f.settle("a", "accepted", ALL_PROVED, 10);
      const out = await f.phases.drive(f.get());
      return { lines: pureLines, driver: { stage: out.stage, verdict: out.record.verification ?? null, acceptance: out.record.acceptance ?? null, candidate: { verified: out.record.candidate?.verified ?? null, goal: out.record.candidate?.goal ?? null }, book: f.parts("stage").at(-1) ?? null } };
    });
  },

  /** n88 · the work verification session opens only on the candidate's frozen heads: its lines are numbered from 1, one per piece. */
  async uatStage() {
    const run = async (candidate: PhaseRecord["candidate"]) => withDrv({ words: true }, async (f) => {
      const items = [piece("p1"), piece("p2"), piece("p3")];
      f.seed("acceptance", { ...admitted(items), waveReview: false, ...(candidate ? { candidate } : {}) });
      const out = await f.phases.drive(f.get());
      return { uat: out.record.uat ? { path: out.record.uat.path.replace(f.id, "<id>"), sha256: out.record.uat.sha256, lines: out.record.uat.lines } : null, written: f.writes.filter((file) => file.path.endsWith("UAT.md")).length };
    });
    const tree = { "/repo": { path: "/repo/wt", startSha: "s" } };
    return { unverified: await run({ branch: "phase/ph_1", trees: tree }), verified: await run({ branch: "phase/ph_1", trees: tree, verified: { "/repo": H } }), noCandidate: await run(undefined) };
  },

  /** n89 · the verification document: one numbered line per promise, where to test, the person's answers as they stand. */
  uatDocument() {
    const items = [piece("p1"), piece("p2")];
    const base = (extra: Partial<PhaseRecord> = {}) => ({ id: "ph_7", title: "Sums", goal: "sums are right", record: { plan: { items, contextSha: "c", sha: "s" } as never, ...extra } });
    const trees = { branch: "phase/ph_7", trees: { "/repo": { path: "/repo/wt", startSha: "s" } } };
    const answered = base({ uat: { path: "p", sha256: "", at: 1, lines: [{ n: 1, pieceId: "p1", state: "passed" }, { n: 2, pieceId: "p2", state: "failed", note: "the bar is gone" }] } });
    return { plain: uatText(base()).split("\n"), answered: uatText(answered).split("\n").filter((line) => line.startsWith("- [")), onCandidate: uatText(base({ candidate: trees })).split("\n")[4],
      onVerified: uatText(base({ candidate: { ...trees, verified: { "/repo": H } } })).split("\n")[4], landed: uatText(base({ candidate: { ...trees, landedAt: 5 } })).split("\n")[4], none: uatText({ ...base(), record: {} }).split("\n").filter((line) => line.startsWith("- [")) };
  },
};

export { H, M };
