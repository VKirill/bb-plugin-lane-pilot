import { describe, expect, it } from "vitest";
import { blindVerdict, designDecision, designGate, issuable, nextAction, pieceSha, waveCleared, waveLines, wavePackage, waveProblems, type Phase, type PhaseRecord, type PlanItem, type TaskFact, type WaveRecord } from "../../src/rooms/phase/logic";
import { pilotOf, type RunTask } from "../../src/rooms/pilot/logic";
import { goalVerdict, pmGoalMessage } from "../../src/rooms/run-goal/logic";
import { spendReserve } from "../../src/rooms/tasks/rails";

const piece = (id: string, wave: number, extra: Record<string, unknown> = {}): PlanItem => ({
  id, title: id, wave, promise: { given: "a cell", when: "the sum runs", then: "the cell is skipped" },
  task: { id, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], ...extra },
});

const fact = (id: string, over: Partial<TaskFact> = {}): TaskFact => ({
  taskId: id, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", ...over,
});

const phase = (record: PhaseRecord, stage: Phase["stage"] = "execution"): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "pm", runId: "run", title: "Batch", goal: "close the batch",
  stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

const task = (id: string, createdAt: number, area = "scripts", kind = "code"): RunTask => ({
  id, area, kind, createdAt, dependsOn: [],
});

const linesOk = (ok = true): WaveRecord["lines"] => [
  { id: "pieces_accepted", ok, detail: ok ? "accepted" : "not accepted: a" },
  { id: "promises_proved", ok: true, detail: "proved" },
  { id: "checks_passed", ok: true, detail: "pass" },
  { id: "no_critic_block", ok: true, detail: "clear" },
];

describe("batch gates", () => {
  it("[sma:bc_calc] a red check is named by task and command; a green pass names nothing missing", () => {
    const failed = goalVerdict({
      tasks: [{ taskId: "piece-a", checks: [{ command: "npm test -- piece-a", state: "red" }] }],
      findings: [{ taskId: "piece-a", command: "npm test -- piece-a", culpritCommit: "abc1234567ff", culpritTask: "piece-a" }],
    });
    expect(failed.state).toBe("failed");
    expect(failed.red).toEqual([{ taskId: "piece-a", command: "npm test -- piece-a", culpritCommit: "abc1234567ff", culpritTask: "piece-a" }]);
    expect(pmGoalMessage("run-1", failed.red)).toContain("piece-a: npm test -- piece-a");
    const passed = goalVerdict({
      tasks: [{ taskId: "piece-a", checks: [{ command: "npm test -- piece-a", state: "green" }] }],
      findings: [],
    });
    expect(passed).toMatchObject({ state: "passed", red: [], detail: null });
  });

  it("[sma:bc_refused] a failed goal check keeps the verdict failed and names the reason", () => {
    const items = [piece("a", 1)];
    const facts = new Map([["a", fact("a")]]);
    const verdict = blindVerdict(items, facts, { state: "failed", detail: "piece-a: npm test -- piece-a" }, 10);
    expect(verdict.state).toBe("failed");
    expect(verdict.detail).toContain("the run's goal check failed: piece-a: npm test -- piece-a");
    const held = nextAction(phase({ verification: { verdict: { ...verdict, state: "failed" } } }, "verification"), facts);
    expect(held.waitsForPm).toBe(true);
    expect(held.text).toContain("verification failed");
    expect(held.text).toContain("piece-a: npm test -- piece-a");
  });

  it("[sma:bf_design_needed] a screen piece is named; a piece that changes no screen needs no drawing", () => {
    const ui = designDecision([piece("card", 1, { owns_paths: ["src/ui/Card.tsx"] }), piece("sum", 1)]);
    expect(ui.decision).toBe("needed");
    expect(ui.why).toContain("card");
    expect(ui.why).not.toContain("sum");
    expect(designDecision([piece("sum", 1)])).toMatchObject({ decision: "not_needed" });
  });

  it("[sma:bf_design_confirm] the drawing stays shut until the owner says yes", () => {
    const record: PhaseRecord = {
      ownerWords: true,
      design: { decision: "needed", why: "screens", drawing: { paths: [".agents/phases/ph_sma/design/UI-SPEC.md"], sha256: "ab", designer: "design-lead", reviewer: "ui-review", feasible: true } },
    };
    const shut = designGate(record);
    expect(shut.ok).toBe(false);
    if (shut.ok) return;
    expect(shut.why.join(" ")).toContain("the drawing awaits the owner's word");
    record.words = [{ turn: "design", decision: "yes", by: "owner", text: "ship the drawing", at: 1 }];
    expect(designGate(record).ok).toBe(true);
    record.words = [{ turn: "design", decision: "no", by: "owner", text: "not this", at: 2 }];
    expect(designGate(record).ok).toBe(false);
  });

  it("[sma:bf_waves] a link to a later wave or a missing piece is refused by name", () => {
    expect(waveProblems([piece("a", 1), piece("b", 1, { depends_on: ["a"] })])).toEqual([
      "b (wave 1) depends on a of wave 1: a dependency belongs to an earlier wave",
    ]);
    expect(waveProblems([piece("a", 2, { depends_on: ["missing"] })])).toEqual(["a depends on missing, which is not in the plan"]);
    expect(waveProblems([piece("a", 1), piece("b", 2, { depends_on: ["a"] })])).toEqual([]);
  });

  it("[sma:bi_confirm] an issued piece is not issued again; a changed contract is", () => {
    const a = piece("a", 1);
    const b = piece("b", 1);
    const first = issuable([a, b], {}, new Map());
    expect(first.map((item) => item.id)).toEqual(["a", "b"]);
    const again = issuable([a, b], { a: "task-a", b: "task-b" }, new Map([["a", fact("a", { state: "running" })], ["b", fact("b", { state: "queued" })]]), () => true, { a: pieceSha(a), b: pieceSha(b) });
    expect(again).toEqual([]);
    const changed = piece("a", 1, { acceptance: ["the cell stays empty"] });
    expect(pieceSha(changed)).not.toBe(pieceSha(a));
    expect(issuable([changed, b], { a: "task-a", b: "task-b" }, new Map([["a", fact("a")], ["b", fact("b")]]), () => true, { a: pieceSha(a), b: pieceSha(b) }).map((item) => item.id)).toEqual(["a"]);
  });

  it("[sma:bi_eligible] [sma:bw_accept] the next wave waits until this wave's lines hold and the owner accepts it", () => {
    const items = [piece("a", 1), piece("c", 2)];
    const accepted = new Map([["a", fact("a")]]);
    const record: PhaseRecord = { ownerWords: true, execution: { issued: { a: "task-a" }, waves: { "1": { packageSha: "pkg", lines: linesOk(), at: 1 } } } };
    expect(waveCleared(record, 1)).toBe(false);
    expect(issuable(items, { a: "task-a" }, accepted, (wave) => waveCleared(record, wave))).toEqual([]);
    record.words = [{ turn: "wave", wave: 1, decision: "no", by: "owner", text: "hold", at: 2 }];
    expect(waveCleared(record, 1)).toBe(false);
    record.words = [{ turn: "wave", wave: 1, decision: "yes", by: "owner", text: "take the wave", at: 3 }];
    expect(waveCleared(record, 1)).toBe(true);
    expect(issuable(items, { a: "task-a" }, accepted, (wave) => waveCleared(record, wave)).map((item) => item.id)).toEqual(["c"]);
    record.execution!.waves!["1"]!.lines = linesOk(false);
    expect(waveCleared(record, 1)).toBe(false);
    expect(issuable(items, { a: "task-a" }, accepted, (wave) => waveCleared(record, wave))).toEqual([]);
  });

  it("[sma:bi_pilot] [sma:bi_fanout] the earliest of three siblings is the only one that starts; the rest name it and wait", () => {
    const wave = [task("a", 1), task("b", 2), task("c", 3)];
    expect(pilotOf("a", wave)).toBeNull();
    expect(pilotOf("b", wave)).toBe("a");
    expect(pilotOf("c", wave)).toBe("a");
    expect(pilotOf("b", wave.slice(0, 2))).toBeNull();
    const ordered = wave.map((row) => row.id === "c" ? { ...row, dependsOn: ["b"] } : row);
    expect(pilotOf("c", ordered)).toBeNull();
  });

  it("[sma:bi_broken] a blocked piece stops issue and names itself for the owner", () => {
    const items = [piece("a", 1), piece("b", 1)];
    const facts = new Map([["a", fact("a", { state: "blocked" })], ["b", fact("b", { state: "running" })]]);
    const action = nextAction(phase({ plan: { items, contextSha: "c", sha: "s" }, execution: { issued: { a: "task-a", b: "task-b" } } }), facts);
    expect(action.waitsForPm).toBe(true);
    expect(action.key).toContain("blocked:a");
    expect(action.text).toContain("a is blocked");
    expect(action.text).not.toContain("Lane Pilot issues the next wave");
  });

  it("[sma:bw_lines] each acceptance line names the piece that failed it", () => {
    const items = [piece("a", 1), piece("b", 1)];
    const facts = new Map([["a", fact("a", { state: "running", planFact: "failed", verification: "failed", codeCritique: "blocked" })], ["b", fact("b")]]);
    const lines = waveLines(items, facts);
    expect(lines.map((line) => line.id)).toEqual(["pieces_accepted", "promises_proved", "checks_passed", "no_critic_block"]);
    expect(lines.every((line) => line.ok === false && /\ba\b/.test(line.detail) && !/\bb\b/.test(line.detail))).toBe(true);
  });

  it.todo("[sma:bw_lines] the wave package and each piece share the same seven acceptance lines");

  it("[sma:bw_package] the same pieces and facts hash to the same package; a changed state is a new package", () => {
    const items = [piece("a", 1)];
    const first = wavePackage(items, new Map([["a", fact("a")]]));
    expect(wavePackage(items, new Map([["a", fact("a")]]))).toBe(first);
    expect(wavePackage(items, new Map([["a", fact("a", { state: "running" })]]))).not.toBe(first);
  });

  it("[sma:bf_issue_needed] with owner.words on, execution asks for the word «issue» before any piece goes out", () => {
    const items = [piece("a", 1)];
    const action = nextAction(phase({ ownerWords: true, plan: { items, contextSha: "c", sha: "s" }, execution: { issued: {} } }), new Map());
    expect(action.waitsForPm).toBe(true);
    expect(action.key).toBe("execution:word:issue");
    expect(action.text).toContain("word «issue»");
  });

  it("[sma:bf_budget] [sma:bw_budget_q] a wave whose appetite does not fit the reserve is held and the shortfall is named", () => {
    const held = spendReserve({ budgetTokens: 100, spentTokens: 40, openAppetites: [50], appetite: 20 });
    expect(held.ok).toBe(false);
    expect(held.free).toBe(10);
    expect(held.why).toContain("10");
    expect(held.why).toContain("20");
    expect(spendReserve({ budgetTokens: 100, spentTokens: 40, openAppetites: [50], appetite: 10 }).ok).toBe(true);
    expect(spendReserve({ budgetTokens: null, spentTokens: 0, openAppetites: [], appetite: 999 }).ok).toBe(true);
  });
});
