// Region 0 (Phase graph), batch f: the roles per stage, the pause family, the stops, the returns, the correction, the answer and the compensation (n140 … n157, n1769).
// Each test takes the card's input and checks the result the card names — the roles, the state the phase was left in, what was (not) issued, the attempt's state, the book part — on the
// real code (observations in tests/sma/r00-world-f.ts). Several nodes also keep their older tests (tests/sma/phase-controls-*.test.ts, tests/phase-stop.test.ts, parity-b6-phase).
import { describe, expect, it } from "vitest";
import { observe } from "./r00-world-f";

describe("region 0 · roles, the book and the pause family", () => {
  it("[sma:pc_roles] each stage has its own roles: the plan researchers, a planner and a checker; the drawing a designer and a checker that is another role", () => {
    const s = observe.roles();
    expect(s.plan).toEqual([["research", "analyst"], ["patterns", "analyst"], ["strategy", "auditor"], ["plan", "planner"], ["plan_critic", "plan-critic"]]);
    expect(s.draw).toEqual([["material", "specialist:design-lead"], ["draw", "specialist:design-lead"], ["check", "plan-critic"]]);
    const checker = s.draw.find(([id]) => id === "check")![1];
    expect(s.draw.filter(([id]) => id !== "check").every(([, role]) => role !== checker)).toBe(true);
  });

  it("[sma:pc_roles_judge] a drawing reviewed by its own designer, or by nobody, is held; another role opens the gate", () => {
    const s = observe.separateness();
    expect(s.own).toBe("the reviewer of the drawing is its designer: it must be a separate role");
    expect(s.none).toBe("the drawing is not reviewed by a separate role");
    expect(s.other).toBe("open");
  });

  it("[sma:pc_parent_guard] a plan that is not the one that was checked is refused at issue: nothing is dispatched and nothing is recorded as issued", async () => {
    const s = await observe.parentGuard();
    expect(s.refused).toBe("the plan changed since it was checked: return the phase to planning");
    expect(s.dispatched).toEqual([]);
    expect(s.issued).toEqual({});
  });

  it("[sma:pc_book] the book shows the goal and the chain's state, and a rewritten part is named", () => {
    const s = observe.book();
    expect(s.head).toBe("# Phase ph_1: Sums");
    expect(s.status).toBe("Stage: acceptance · state: active · edition 1 · chain: intact (2 parts)");
    expect(s.goal).toBe(true);
    expect(s.broken).toBe("Stage: acceptance · state: active · edition 1 · chain: BROKEN at part 2");
  });

  it("[sma:px_pause] [sma:cg_phase_pause] a pause by the PM's intent pauses the whole phase and its pass issues none of its pieces", async () => {
    const s = await observe.pause();
    expect(s).toEqual({ state: "paused", afterDrive: "paused", issued: {}, dispatched: [], booked: ["pm"] });
  });

  it("[sma:px_requested] a requested pause becomes paused on the next pass, before anything is issued", async () => {
    const s = await observe.requested();
    expect(s).toEqual({ state: "paused", issued: {}, dispatched: [] });
  });

  it("[sma:px_paused] a paused phase stands: it does not ask the PM for anything and names the resume", async () => {
    const s = await observe.paused();
    expect(s.waitsForPm).toBe(false);
    expect(s.text).toBe(`Phase ${s.id} «controls» is paused; lane_pilot_phase {action:"resume", phaseId:"${s.id}"} moves it on.`);
  });

  it("[sma:px_continue] resume is the word that moves a paused phase to active, and a closed phase is never resumed", async () => {
    const s = await observe.resume();
    expect(s.paused).toBe("paused");
    expect(s.resumed).toBe("active");
    expect(s.closedRefusal).toMatch(/is closed: open a new phase for new work$/);
  });
});

describe("region 0 · the interrupt, the stops and the closing", () => {
  it("[sma:px_force] [sma:px_reconciling] an interrupt is refused on an active or a quiet phase; a stop not yet proved keeps the phase pause_requested with the open stop named, and the next pass finishes it", async () => {
    const s = await observe.interrupt();
    expect(s.active).toMatch(/is active: an interrupt is for a pausing or paused phase — pause it first$/);
    expect(s.quiet).toMatch(/has no running work to interrupt: it is already still$/);
    expect(s).toMatchObject({ unconfirmed: 1, midState: "pause_requested", midInterrupting: "owner", midNamed: 1, booked: 1 });
    expect(s).toMatchObject({ afterState: "paused", afterInterrupting: null, issuedSha: "interrupted", attempt: "canceled" });
  });

  it("[sma:px_stop] the running writer is stopped first and only then the phase; a stop not observed keeps the phase open and asks again", async () => {
    const s = await observe.stop();
    expect(s.open).toEqual({ unconfirmed: 1, state: "active", stopping: "wrong goal", attempt: "cancel_requested" });
    expect(s.state).toBe("stopped");
    expect(s.stopping).toBeNull();
    expect(s.attempt).toBe("canceled");
    expect(s.booked).toBe("canceled: piece");
  });

  it("[sma:px_close] the phase closes only in words, and the words are kept with who said them", async () => {
    const s = await observe.close();
    expect(s.refused).toBe("closing in words carries the words: why the phase ends here");
    expect(s.blank).toBe(s.refused);
    expect(s).toMatchObject({ state: "closed", stage: "closed", closing: { by: "owner", words: "the owner stopped the goal" } });
  });
});

describe("region 0 · returns, corrections, the wave, the answer and the compensation", () => {
  it("[sma:px_return_exec] only a prepared phase returns to execution: the preparation is withdrawn and the piece is marked for the next redo", async () => {
    const s = await observe.returnExec();
    expect(s.early).toMatch(/^a return to execution is allowed only from acceptance, on a frozen verdict/);
    expect(s.noNote).toBe("a return carries a note: what changed and why");
    expect(s).toMatchObject({ stage: "execution", verification: null, acceptance: null, verified: null, issuedSha: "returned" });
  });

  it("[sma:px_return_record] the return is durable: its words ride with the redo and are booked with the stage it left and who sent it, and the candidate branch stays", async () => {
    const s = await observe.returnExec();
    expect(s.returnNote).toBe("the header is wrong");
    expect(s.booked).toEqual(["acceptance → execution by owner: the header is wrong"]);
    expect(s.branchKept).toBe("phase/x");
  });

  it("[sma:px_redirect] a correction goes to the writer that is running and to no other, and the book says where it went", async () => {
    const s = await observe.correct();
    expect(s.sent).toEqual(["task-r"]);
    expect(s.threads).toEqual(["thr_w"]);
    expect(s.text).toMatch(/Correction from the PM: keep the blank cell$/);
    expect(s.booked).toEqual(["keep the blank cell → task-r"]);
  });

  it("[sma:px_wave] stopping the wave cancels the queued pieces, leaves the running writer at work and holds the phase", async () => {
    const s = await observe.wave();
    expect(s).toEqual({ canceled: ["task-q"], state: "paused", queued: "canceled", running: "running", booked: ["queued pieces canceled: task-q"] });
  });

  it("[sma:px_answer] the answer is written onto its question with who gave it; an unknown question is refused", async () => {
    const s = await observe.answer();
    expect(s).toEqual({ unknown: "no question nope", open: 1, openAfter: 0, question: { answer: "the daily one", answeredBy: "owner" }, booked: ["q1: the daily one"] });
  });

  it("[sma:px_compensate] only this phase's accepted pieces are reverted, and the book records each revert's state", async () => {
    const s = await observe.compensate();
    expect(s).toEqual({ reverted: ["task-done"], results: [{ taskId: "task-done", state: "merged" }], booked: ["undo the piece: task-done merged"], live: "running" });
  });
});
