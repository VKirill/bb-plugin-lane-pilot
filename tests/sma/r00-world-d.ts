// Region 0 (Phase graph), batch d: acceptance, landing, closure, the rollback watch and the lessons trigger (n90 … n119). Every observation runs the REAL code of the node
// (the acceptance calculation, the phase driver on a scratch database and a fake host, the phase logic) and returns plain JSON. tests/sma/four-proofs-r00-d.test.ts asserts on it
// and the scene scripts/lp_drill/scenes/sma_r00_d.py proves the nodes that write no hub row. No model, no hub write, nothing outside the machine.
import { sha256Hex } from "@lane-pilot/kit";
import {
  acceptanceKey, acceptanceLines, lessonsNeeded, nextAction, observationOutcome, type Phase, type PhaseRecord, type TaskFact,
} from "../../src/rooms/phase/logic";
import { autoDue } from "../../src/rooms/phase/server/auto-stages";
import { appendPart, getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { saveRunGoal } from "../../src/rooms/run-goal/store";
import { admitted, drv, fact, H, M, piece, pure } from "./r00-world-c";

const VERDICT = { state: "passed", detail: "every piece accepted and proved", mainSha: null, at: 1, inputSha: "b".repeat(64) } as const;
const MODEL = { state: "met", by: "audit", summary: "the goal is met", at: 2 } as const;
type Rows = Array<[string, Partial<TaskFact>]>;
type Now = Parameters<typeof acceptanceLines>[2];
const NOW: Now = { mainSha: null, openDeferrals: 0 };

/** The plan of the batch c world, its verdict passed and its goal audit met: every line of the acceptance holds on the facts of `rows`. */
export const green = (over: Partial<PhaseRecord> = {}, items = [piece("a")]): PhaseRecord => ({ ...admitted(items), verification: { verdict: { ...VERDICT }, model: { ...MODEL } }, ...over });
/** The acceptance lines of a record on the facts of `rows`, by id. */
export const linesOf = (record: PhaseRecord, rows: Rows = [["a", {}]], now: Now = NOW): Record<string, { ok: boolean; detail: string }> =>
  Object.fromEntries(acceptanceLines(pure(record, "acceptance"), new Map(rows.map(([id, over]) => [id, fact(id, over)])), now).map((line) => [line.id, { ok: line.ok, detail: line.detail }]));
const red = (lines: Record<string, { ok: boolean }>) => Object.entries(lines).filter(([, line]) => !line.ok).map(([id]) => id);
const refusal = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); return "not refused"; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };
type Drv = Awaited<ReturnType<typeof drv>>;
const withDrv = async <T>(o: Parameters<typeof drv>[0], run: (f: Drv) => Promise<T>): Promise<T> => { const f = await drv(o); try { return await run(f); } finally { f.restore(); } };
const word = (key: string | undefined, over: Record<string, unknown> = {}) => ({ turn: "acceptance" as const, decision: "yes" as const, by: "owner", text: "да", at: 2, useful: true, limits: true, ...(key ? { key } : {}), ...over });
const parts = (f: Drv, kind: string) => listParts(f.db, f.id).filter((part) => part.kind === kind).map((part) => part.text);
const candidate = (extra: Record<string, unknown> = {}) => ({ branch: "phase/ph_1", trees: { "/repo": { path: "/repo/wt", startSha: "s" } }, ...extra }) as PhaseRecord["candidate"];

export const observe = {
  /** n90 · a UAT line is answered by its number: an unknown number is refused, one answer changes that line alone, the session word waits for every line. */
  async uatLine() {
    return withDrv({ words: true }, async (f) => {
      const items = [piece("p1"), piece("p2"), piece("p3")];
      f.seed("acceptance", { ...admitted(items), uat: { path: ".agents/phases/x/UAT.md", sha256: "s", at: 1, lines: items.map((row, n) => ({ n: n + 1, pieceId: row.id, state: "open" as const })) } });
      const states = () => f.get().record.uat!.lines!.map((row) => [row.n, row.pieceId, row.state, row.note ?? null]);
      const refused = await refusal(() => f.phases.uatLine({ phaseId: f.id, line: 4, result: "pass" }));
      await f.phases.uatLine({ phaseId: f.id, line: 2, result: "fail", note: "the bar is missing" });
      const afterFail = states();
      const early = await refusal(() => f.phases.word({ phaseId: f.id, turn: "uat", decision: "yes", text: "да", by: "owner via screen" }));
      for (const n of [2, 1, 3]) await f.phases.uatLine({ phaseId: f.id, line: n, result: "pass" });
      const after = await f.phases.word({ phaseId: f.id, turn: "uat", decision: "yes", text: "да", by: "owner via screen" });
      return { refused, afterFail, early, afterPass: states(), word: after.record.words?.at(-1)?.turn, booked: parts(f, "uat_line") };
    });
  },

  /** n91 · UAT.md lands on main only after the phase itself landed: before the landing the answers live in the record, after it the file is written once. */
  async recordAfter() {
    return withDrv({ words: true }, async (f) => {
      const items = [piece("p1")];
      f.seed("acceptance", { ...admitted(items), candidate: candidate({ verified: { "/repo": "v" } }) });
      await f.phases.drive(f.get());
      const before = f.get().record;
      const uatWrites = () => f.writes.filter((file) => file.path.endsWith("UAT.md"));
      const early = { lines: before.uat?.lines?.length ?? 0, sha: before.uat?.sha256 ?? null, writes: uatWrites().length };
      f.seed("acceptance", { uat: { ...before.uat!, lines: [{ n: 1, pieceId: "p1", state: "passed", by: "owner", at: 3 }] }, candidate: { ...before.candidate!, landedAt: 4 } });
      await f.phases.drive(f.get());
      return { early, after: { writes: uatWrites().length, text: uatWrites()[0]?.content.split("\n").find((line) => line.startsWith("- [")) ?? null, sha: f.get().record.uat?.sha256 === sha256Hex(uatWrites()[0]?.content ?? "") } };
    });
  },

  /** n92 · the package the person decides on: the key, the frozen verdict and the diffstat of the work, only at acceptance and only with a verdict. */
  async acceptancePackage() {
    return withDrv({}, async (f) => {
      const record = { ...admitted([piece("a")]), execution: { issued: {}, baseSha: H }, verification: { verdict: { ...VERDICT, mainSha: M } } };
      f.seed("acceptance", record);
      const shown = await f.phases.acceptancePackage(f.id);
      f.seed("execution", {});
      const wrongStage = await f.phases.acceptancePackage(f.id);
      f.seed("acceptance", { verification: undefined });
      const noVerdict = await f.phases.acceptancePackage(f.id);
      return { shown, key: acceptanceKey(record), wrongStage, noVerdict };
    });
  },

  /** n94 · a changed record is a new edition of the phase (the plan and the result are weighed by it), the same record is not. */
  async editions() {
    return withDrv({}, async (f) => {
      const edition = () => getPhase(f.db, f.id)!.edition;
      const start = edition();
      const record = { ...f.get().record, appetiteNote: "one" } as PhaseRecord;
      savePhase(f.db, f.id, { record, at: 5 });
      const afterChange = edition();
      savePhase(f.db, f.id, { record: { ...record }, at: 6 });
      const afterSame = edition();
      savePhase(f.db, f.id, { stage: "planning", at: 7 });
      const afterStage = edition();
      savePhase(f.db, f.id, { record: { ...record, appetiteNote: "two" } as PhaseRecord, at: 8 });
      return { start, afterChange, afterSame, afterStage, afterSecond: edition() };
    });
  },

  /** n93 · the lines are decided by code from the phase's facts: a claim stored on the record improves nothing, one worse fact worsens exactly its own line. */
  lineCalc() {
    const claimed = linesOf(green({ acceptance: { lines: [], at: 1, accepted: true } }), [["a", { verification: "failed" }]]);
    return { green: red(linesOf(green())), claimedRed: red(claimed), claimedDetail: claimed.checks_passed,
      goal: linesOf(green()).goal_met, noAudit: linesOf(green({ verification: { verdict: { ...VERDICT } } })).goal_met, unmet: linesOf(green({ verification: { verdict: { ...VERDICT }, model: { ...MODEL, state: "unmet", summary: "the cart is still hidden" } } })).goal_met };
  },

  /** n95 · the evidence is read as it is: a failed browser check, a planned one not passed, a live check on another head; one that passed or is not owed says so. */
  qaRead() {
    const detail = (rows: Rows, record = green()) => linesOf(record, rows).qa_read;
    const live = green({ candidate: candidate({ verified: { "/repo": "a".repeat(40) } }), verification: { verdict: { ...VERDICT }, model: { ...MODEL }, live: { head: "b".repeat(40) } as never } });
    return { none: detail([["a", {}]]), failed: detail([["a", { browserQa: "failed" }]]), owed: detail([["a", { browserQa: "skipped", qaPlanned: true }]]), passed: detail([["a", { browserQa: "passed", qaPlanned: true }]]), stale: detail([["a", {}]], live) };
  },

  /** n96 · the judged edition is the confirmed one: the line is green on the admitted plan and says what changed otherwise. */
  contractLine() {
    const changed = green({ plan: { ...green().plan!, admittedSha: "e".repeat(64) } });
    const never = green({ plan: { ...green().plan!, admittedSha: undefined } });
    return { current: linesOf(green()).contract_current, changed: linesOf(changed).contract_current, neverAdmitted: linesOf(never).contract_current };
  },

  /** n97 · each promise needs the receipt of plan-fact: the line names the pieces that have none. */
  promiseLine() {
    const two = green({}, [piece("a"), piece("b")]);
    const both: Rows = [["a", {}], ["b", {}]];
    return { proved: linesOf(two, both).promises_proved, oneFailed: linesOf(two, [["a", {}], ["b", { planFact: "failed" }]]).promises_proved, noReceipt: linesOf(two, [["a", { planFact: null }], ["b", {}]]).promises_proved };
  },

  /** n98 · the daemon's own regression: the checks of every piece passed, the line names the pieces whose checks failed. */
  checksLine() {
    const two = green({}, [piece("a"), piece("b")]);
    return { passed: linesOf(two, [["a", {}], ["b", {}]]).checks_passed, oneFailed: linesOf(two, [["a", {}], ["b", { verification: "failed" }]]), bothFailed: linesOf(two, [["a", { verification: "failed" }], ["b", { verification: "failed" }]]).checks_passed };
  },

  /** n99 · the independent check admits only on a positive receipt: a blocking critic, no receipt and a skipped one are all red, each said in its own words. */
  criticLine() {
    return { passed: linesOf(green()).independent_check, blocked: linesOf(green(), [["a", { codeCritique: "blocked" }]]).independent_check, noReceipt: linesOf(green(), [["a", { codeCritique: null }]]).independent_check,
      skipped: linesOf(green(), [["a", { codeCritique: "skipped" }]]).independent_check };
  },

  /** n100 · the landing tree is ready: every piece merged (into main, or into the phase candidate), and the line names the pieces that are not. */
  landedLine() {
    const two = green({}, [piece("a"), piece("b")]);
    return { main: linesOf(two, [["a", {}], ["b", {}]]).landed, oneNot: linesOf(two, [["a", {}], ["b", { state: "running" }]]).landed, bothNot: linesOf(two, [["a", { state: "queued" }], ["b", { state: "running" }]]).landed,
      candidate: linesOf(green({ candidate: candidate() }), [["a", {}]]).landed };
  },

  /** n101 · «the result is clear and useful» is a person's decision: yes to «useful» under the shown key; it does not count for «limits». */
  usefulLine() {
    const asked = green({ ownerWords: true });
    const key = acceptanceKey(asked);
    const say = (over: Record<string, unknown>) => linesOf({ ...asked, words: [word(key, over)] });
    return { notAsked: linesOf(green()).result_useful, waiting: linesOf(asked).result_useful, usefulOnly: { useful: say({ limits: false }).result_useful, limits: say({ limits: false }).limits_acknowledged },
      limitsOnly: { useful: say({ useful: false }).result_useful, limits: say({ useful: false }).limits_acknowledged }, no: say({ decision: "no", text: "not yet" }).result_useful };
  },

  /** n102 · the limits are acknowledged: a deferred check with no term holds the line whatever the person said; with terms the line says what stays open. */
  limitsLine() {
    const asked = green({ ownerWords: true });
    const key = acceptanceKey(asked);
    const said = { ...asked, words: [word(key)] };
    const noTerm = [{ id: "def-1", what: "browser" }];
    return { notAsked: linesOf(green()).limits_acknowledged, noTermNotAsked: linesOf(green(), [["a", {}]], { ...NOW, openDeferrals: 1, noTerm }).limits_acknowledged,
      noTermAsked: linesOf(said, [["a", {}]], { ...NOW, openDeferrals: 1, noTerm }).limits_acknowledged, openAsked: linesOf(said, [["a", {}]], { ...NOW, openDeferrals: 2 }).limits_acknowledged,
      waiting: linesOf(asked).limits_acknowledged };
  },

  /** n104 · the phase is authorized by a person's word on this very package: the yes under the shown key opens the person's lines; another key, no key and «no» do not. */
  authorized() {
    const asked = green({ ownerWords: true });
    const key = acceptanceKey(asked);
    const both = (words: unknown[]) => { const lines = linesOf({ ...asked, words: words as never }); return { useful: lines.result_useful, limits: lines.limits_acknowledged }; };
    return { shown: both([word(key)]), otherPackage: both([word("0123456789abcdef")]), noKey: both([word(undefined)]), no: both([word(key, { decision: "no", text: "not yet" })]), none: both([]), key };
  },

  /** n108 · the key of the package: sixteen hex characters; the plan, the verdict's input, the tree it saw and the drawing each make a new key, nothing else does. */
  key() {
    const base = green();
    const keyOf = (record: PhaseRecord) => acceptanceKey(record);
    const verdict = (over: Record<string, unknown>) => green({ verification: { verdict: { ...VERDICT, ...over } as never, model: { ...MODEL } } });
    const drawn = (sha256: string, first = "d/UI-SPEC.md") => green({ design: { decision: "needed", why: "screens", drawing: { paths: [first, "d/kit.html"], sha256, designer: "x" } } as never });
    return { shape: /^[0-9a-f]{16}$/.test(keyOf(base)), same: keyOf(base) === keyOf(green()),
      plan: keyOf(base) !== keyOf(green({ plan: { ...base.plan!, sha: "f".repeat(64) } })), input: keyOf(base) !== keyOf(verdict({ inputSha: "c".repeat(64) })), tree: keyOf(base) !== keyOf(verdict({ mainSha: "d".repeat(40) })),
      drawing: keyOf(base) !== keyOf(drawn("aaa")), redrawn: keyOf(drawn("aaa")) !== keyOf(drawn("bbb")), contract: keyOf(drawn("aaa")) !== keyOf(drawn("aaa", "d/other.md")), unrelated: keyOf(base) === keyOf(green({ ownerWords: true })) };
  },

  /** n109 · the verdict saw another main than the one there now: the phase goes back to verification with no verdict, and the person's word is asked on the new package. */
  async mainMoved() {
    return withDrv({}, async (f) => {
      const record = { ...admitted([]), verification: { verdict: { ...VERDICT, mainSha: M }, model: { ...MODEL } } };
      const goal = (headSha: string) => saveRunGoal(f.db, { runId: "run1", projectId: "projA", state: "passed", tasks: 0, headSha, red: [], detail: null, failureCode: null, at: 3, coverage: { planned: 0, ran: 0, skipped: 0 } });
      f.seed("acceptance", record);
      goal(M);
      const same = await f.phases.drive(f.get());
      f.seed("acceptance", { acceptance: undefined });
      goal(H);
      const moved = await f.phases.drive(f.get());
      return { same: { stage: same.stage, verdict: same.record.verification?.verdict?.state ?? null }, moved: { stage: moved.stage, verification: moved.record.verification ?? null, acceptance: moved.record.acceptance ?? null }, stages: parts(f, "stage") };
    });
  },

  /** n106 · the book is closed only after its documents read back as written: a read that differs keeps the phase open and pokes the PM, an intact read closes it. */
  async closingDocs() {
    return withDrv({}, async (f) => {
      f.seed("closed", admitted([]));
      await f.phases.tick();
      const bookPath = `.agents/phases/${f.id}/BOOK.md`;
      const summaryPath = `.agents/phases/${f.id}/SUMMARY.md`;
      const open = { state: f.get().state, closedDocs: f.get().record.closedDocs ?? null, said: parts(f, "closing_docs_unconfirmed"), concluded: parts(f, "concluded").length };
      f.fileShas.set(bookPath, "x");
      f.fileShas.set(summaryPath, "x");
      await f.phases.tick();
      return { open, closed: { state: f.get().state, closedDocs: !!f.get().record.closedDocs, concluded: parts(f, "concluded"), said: parts(f, "closing_docs_unconfirmed").length }, files: [summaryPath.split("/").at(-1), bookPath.split("/").at(-1)] };
    });
  },

  /** n115 / n117 / n118 · the phase's outcome decides the analysis: a straight phase closes with the reason booked, a return, a blocked attempt or a failed verdict asks for lessons. */
  async outcomes() {
    const run = async (prepare: (f: Drv) => void) => withDrv({}, async (f) => {
      f.seed("acceptance", { ...admitted([]), verification: { verdict: { ...VERDICT }, model: { ...MODEL } } });
      // The fake host answers every write with the hash «x»: the book read back is the one written, so «book_closed» holds.
      f.fileShas.set(`.agents/phases/${f.id}/BOOK.md`, "x");
      prepare(f);
      const after = await f.phases.drive(f.get());
      return { stage: after.stage, lessons: after.record.lessons ?? null, none: parts(f, "none"), booked: parts(f, "concluded").length };
    });
    const at = (f: Drv, kind: string, text: string) => appendPart(f.db, f.id, { section: kind === "return" ? "decisions" : "verification", kind, text, at: 5 });
    return {
      straight: await run(() => undefined),
      returned: await run((f) => { at(f, "return", "back to planning"); }),
      failedVerdict: await run((f) => { at(f, "blind_verdict", "failed: the cart is hidden (input abc)"); at(f, "blind_verdict", "passed (input def)"); }),
      attempt: await run((f) => { f.settle("t1", "provider_error"); }),
      all: await run((f) => { at(f, "return", "back"); at(f, "blind_verdict", "failed: x"); f.settle("t1", "timeout"); }),
    };
  },

  /** n117 · is an analysis needed: each trigger alone, none, and the reasons said together. */
  calc() {
    return { none: lessonsNeeded({ returns: 0, failedAttempts: 0, verdictFailures: 0 }), returns: lessonsNeeded({ returns: 1, failedAttempts: 0, verdictFailures: 0 }), attempts: lessonsNeeded({ returns: 0, failedAttempts: 2, verdictFailures: 0 }),
      verdicts: lessonsNeeded({ returns: 0, failedAttempts: 0, verdictFailures: 3 }), all: lessonsNeeded({ returns: 1, failedAttempts: 2, verdictFailures: 3 }) };
  },

  /** n114 · the observation outcome: a revert is a failure, nothing readable is no data, an open window is incomplete, the first pass after the window ends the watch. */
  outcome() {
    const day = 86_400_000;
    return { failure: observationOutcome(0, 2 * day, { reverted: ["p1 (task t)"], readable: true }), noData: observationOutcome(0, 2 * day, { reverted: [], readable: false }), incomplete: observationOutcome(0, 2 * day, { reverted: [], readable: true }),
      atEnd: observationOutcome(0, 7 * day, { reverted: [], readable: true }), after: observationOutcome(0, 8 * day, { reverted: [], readable: true }), lateFailure: observationOutcome(0, 9 * day, { reverted: ["p1"], readable: true }) };
  },

  /** n116 · the lessons pass every tick: a phase at lessons with a run and no analysis is due for one; with an analysis, with no run, after the tries or not active it is not. */
  pass() {
    const at = (record: Partial<PhaseRecord>, over: Partial<Phase> = {}) => { const due = autoDue({ ...pure({ lessons: { needed: true, why: "a return" }, ...record }, "lessons"), ...over }); return due ? due.kind : null; };
    return { due: at({}), analysed: at({ lessons: { needed: true, why: "a return", analysis: "done" } }), noRun: at({}, { runId: null as never }), tried: at({ autoFailures: { lessons: 2 } }), paused: at({}, { state: "paused" }), execution: autoDue(pure({}, "execution")) === null };
  },

  /** n119 · the analysis awaits a worker: the PM is told once to run the retrospective; with the analysis written nothing waits. */
  pending() {
    const base = pure({ lessons: { needed: true, why: "1 return(s) to an earlier stage" } }, "lessons");
    const waiting = nextAction(base, new Map());
    const written = nextAction({ ...base, record: { ...base.record, lessons: { needed: true, why: "1 return(s) to an earlier stage", analysis: "the cause is x" } } }, new Map());
    return { waiting: { key: waiting.key, waitsForPm: waiting.waitsForPm, text: waiting.text.slice(0, 120), asks: waiting.text.includes("retrospective") }, written: { key: written.key, waitsForPm: written.waitsForPm } };
  },

  /** n107 · what the full acceptance screen is given: the lines of the acceptance with what they saw, the package key it shows (the one the yes must carry) and what the phase waits for. */
  async view() {
    return withDrv({ words: true }, async (f) => {
      const record = { ...admitted([]), verification: { verdict: { ...VERDICT, mainSha: M }, model: { ...MODEL } }, execution: { issued: {}, baseSha: H } };
      f.seed("acceptance", record);
      f.fileShas.set(`.agents/phases/${f.id}/BOOK.md`, "x");
      await f.phases.drive(f.get());
      const status = f.phases.status(f.id);
      const shown = await f.phases.acceptancePackage(f.id);
      const lines = status.phase.record.acceptance?.lines ?? [];
      return { accepted: status.phase.record.acceptance?.accepted ?? null, red: lines.filter((line) => !line.ok).map((line) => `${line.id}: ${line.detail}`), green: lines.filter((line) => line.ok).length,
        key: shown?.key ?? null, keyIsOwnerWordKey: shown?.key === status.ownerWord.acceptanceKey, verdict: shown?.verdict ?? null, next: status.next.key.split(":").slice(0, 3).join(":"), waitsForPm: status.next.waitsForPm };
    });
  },

  /** n111 · the closure is by completeness: a requirement or a locked decision no piece carries out holds the close (also after a withdrawal); «already met» and full coverage close it. */
  closure() {
    const context = (requirements: string[], decisions: string[] = []) => ({ ...green().context!, requirements, decisions }) as never;
    const covering = (id: string, covers: string[]) => ({ ...piece(id), covers });
    const open = (items: ReturnType<typeof piece>[], ctx: unknown): PhaseRecord => ({ ...admitted(items), context: ctx as never, verification: { verdict: { ...VERDICT }, model: { ...MODEL } } });
    const rows = (ids: string[]): Rows => ids.map((id) => [id, {}]);
    const line = (record: PhaseRecord, ids: string[]) => linesOf(record, rows(ids)).nothing_missing;
    const both = [covering("a", ["r1"]), covering("b", ["r2", "d1"])];
    const afterWithdraw = [covering("a", ["r1"])];
    const base = open(both, context(["r1", "r2"], ["d1"]));
    const met = open([covering("a", [])], context(["r1"]));
    return { covered: line(base, ["a", "b"]), uncovered: line(open([covering("a", ["r1"])], context(["r1", "r2"], ["d1"])), ["a"]), afterWithdraw: line({ ...base, plan: { ...base.plan!, items: afterWithdraw } }, ["a"]),
      alreadyMet: line({ ...met, plan: { ...met.plan!, alreadyMet: { evidence: "src/a.ts already does it" } } }, ["a"]), notMet: line(met, ["a"]), none: line(green(), ["a"]) };
  },

  /** n112 · a withdrawal is agreed: an unissued piece leaves with its note and the plan is admitted again as it now is; an issued piece, an unknown one and the last one are refused. */
  async withdrawal() {
    return withDrv({}, async (f) => {
      const items = [piece("keep"), piece("drop"), piece("more")];
      f.seed("execution", { ...admitted(items), execution: { issued: { keep: "task-keep" }, startedAt: 1 } });
      const issued = await refusal(async () => f.phases.withdraw({ phaseId: f.id, pieces: ["keep"], note: "no" }));
      const unknown = await refusal(async () => f.phases.withdraw({ phaseId: f.id, pieces: ["gone"], note: "no" }));
      const out = f.phases.withdraw({ phaseId: f.id, pieces: ["drop"], note: "the owner dropped it", by: "owner" });
      const record = f.get().record;
      return { issued, unknown, left: out.record.plan?.items.map((row) => row.id), withdrawn: out.record.scope?.withdrawn, readmitted: record.plan?.admittedSha === record.plan?.sha && record.plan?.sha !== undefined,
        book: parts(f, "scope_withdrawn") };
    });
  },
};
