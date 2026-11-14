// Region 1 · Task graph, batch e (n303..n319): the clarify and drawing gates of a birth, the words of live work, the hold and the attempt's states.
// Each test runs the node's real code through tests/sma/r01-world-e2.ts.
import { describe, expect, it, vi } from "vitest";
import { awaitingObs, claimedObs, clarifyConfirmedObs, clarifyNeededObs, clarifyNotNeededObs, completedObs, designConfirmedObs, designGateNeededObs, designGateNotObs, designNeededObs, dryRunObs, gateHoldObs, heldObs, queuedObs, reopenObs, wordsObs } from "./r01-world-e2";

vi.setConfig({ testTimeout: 120_000 });

describe("the birth of a task (tb_*), second part", () => {
  it("[sma:tb_clarify_needed] an open clarification question refuses the row (blank questions do not count)", () => {
    const seen = clarifyNeededObs();
    expect(seen.open).toEqual([["clarify_open"], "the task has open clarification questions: Which currency? — answer them (ask the owner if only he knows), fold the answers into the contract and drop clarify, then send it again"]);
    expect(seen.answered).toEqual([[], []]);
  });

  it("[sma:tb_clarify_confirmed] with owner.words on, a clarification the PM answered is sent back; the owner's own answer settles it", () => {
    const seen = clarifyConfirmedObs();
    expect(seen.pm).toEqual([["clarify_needs_owner"], true]);
    expect(seen.owner).toEqual([]);
    expect(seen.off).toEqual([]);
  });

  it("[sma:tb_clarify_not_needed] no question, a blank one, or a bench arm (no promise by design) raises no clarify or promise finding", () => {
    expect(clarifyNotNeededObs()).toEqual({ none: [[], []], blank: [[], []], bench: [[], []] });
  });

  it("[sma:tb_dry_run] a check is judged by its program: a missing one is refused; shell syntax, a pathed program and a program that exists are not", () => {
    expect(dryRunObs()).toEqual({ program: ["npm", null, "make"], missing: ["check_not_runnable"], present: [], shell: [], pathed: [] });
  });

  it("[sma:tb_design_needed] a medium screen change with no drawing is warned; low risk, a named drawing, plain logic and a phase's piece are not", () => {
    expect(designNeededObs()).toEqual({ medium: true, low: false, named: false, logic: false, phasePiece: false });
  });

  it("[sma:tb_design_gate_needed] a piece that changes a screen makes the drawing «needed», and the gate holds until a drawing is made", () => {
    const seen = designGateNeededObs();
    expect(seen.screens).toEqual(["needed", "pieces that change screens: p1", "screens"]);
    expect(seen.asked).toEqual(["needed", "the PM asked for a drawing"]);
    expect(seen.held[0]).toBe(false);
    expect(JSON.stringify(seen.held[1])).toContain("no drawing");
  });

  it("[sma:tb_design_gate_confirmed] a design yes counts only for the drawing hash it names", () => {
    expect(designConfirmedObs()).toEqual({ same: true, redrawn: false, noWord: false });
  });

  it("[sma:tb_design_gate_not] «not needed» is a written word that opens the gate; no word at all is not a decision", () => {
    const seen = designGateNotObs();
    expect(seen.silent[0]).toBe(false);
    expect(JSON.stringify(seen.silent[1])).toContain("the design decision is not made");
    expect(seen.written).toBe(true);
    expect(seen.decided).toEqual(["not_needed", "no piece changes a screen"]);
  });

  it("[sma:tb_words] a running task's words are stored and the live writer is steered with a new edition; finished work is refused and nothing changes", async () => {
    const seen = await wordsObs();
    expect(seen.running).toEqual({ ok: true, state: "running", steered: 1, editions: 2 });
    expect(seen.finished).toEqual({ ok: false, code: "task_finished", editions: 2 });
  });

  it("[sma:tb_reopen] a word change on a queued task replaces its contract and plan, mints an edition and sends the pipeline again from pm-read", async () => {
    const seen = await reopenObs();
    expect(seen.started).toBe("waiting");
    expect(seen).toMatchObject({ ok: true, state: "queued", title: "Updated title", outputs: ["out-updated.txt"], dependsKept: ["dep-1"], plan: "New canonical plan for task", critique: true, reruns: [true], waiting: "waiting" });
    expect(seen.editions).toEqual([1, 2]);
  });

  it("[sma:tb_gate_hold] a hold without a date sits at year 2999 (still in the future), a dated hold keeps its date, and another run's task is refused", async () => {
    const seen = await gateHoldObs();
    expect(seen.fresh).toBeNull();
    expect(seen.forever).toBe(true);
    expect(seen.foreverInFuture).toBe(true);
    expect(seen.reply).toEqual([["t1"], [{ taskId: "other", why: "not a task of run run1" }], "released by hand"]);
    expect(seen.dated).toEqual([["t2"], true]);
  });
});

describe("the states of a task's row (tr_*)", () => {
  it("[sma:tr_queued] a new attempt is queued, and every retry lands in queued until its attempts run out", () => {
    expect(queuedObs()).toEqual({ created: "queued", formed: "queued", retried: ["queued", "queued", "queued", "queued", "queued"], exhausted: "blocked", open: true, states: "queued" });
  });

  it("[sma:tr_held] a held task is visible on the board as held, no other task is, and a release lifts it", async () => {
    expect(await heldObs()).toEqual({ before: [false, false], held: [true, false], released: [["t1"], null, null], after: [false, false] });
  });

  it("[sma:tr_claimed] an attempt holds its row while its loop lives; one whose loop is gone and that has not moved is taken back, the live one is left", async () => {
    expect(await claimedObs()).toEqual({ resumed: ["attA"] });
  });

  it("[sma:tr_awaiting] a verified task waits for the owner's word to land; his yes opens it, his no is said as no", () => {
    const seen = awaitingObs();
    expect(seen.waits).toEqual([true, true]);
    expect(seen.yes).toBeNull();
    expect(seen.no).toBe("owner_word: the owner said no to this task — не сливать");
    expect(seen.notAsked).toBeNull();
  });

  it("[sma:tr_completed] a yes and passed checks accept the attempt; accepted is an end: not open, not failed, never retried", () => {
    const seen = completedObs();
    expect(seen).toMatchObject({ gap: null, accepted: "accepted", open: false, failed: false });
    expect(seen.retry).toBe("retry is not legal from accepted");
  });
});
