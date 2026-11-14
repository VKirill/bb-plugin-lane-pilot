// The tails batch of the SMA parity work: the nodes no region batch owns. Every case checks the result the card names; the values come from tests/sma/tails-world.ts,
// which the scene probe reads again (scripts/lp_drill/scenes/sma_tails.py). A UI node of the batch (n835) is in four-proofs-tails.test.tsx.
import { describe, expect, it } from "vitest";
import { obsBatchPhrase, obsConveyor, obsHardCalls, obsLearnings, obsParity, obsResearch, obsShip, obsSteer, obsUiQa } from "./tails-world";

describe("tails · switches and intake", () => {
  it("[sma:m_cfg_pipeline_off] the conveyor switch is a stored flag with its reason: a fresh store has it ON (the factory value of this product), off keeps the first time and reason, on clears it, the start line names the way back", async () => {
    const seen = await obsConveyor();
    // On purpose a deviation from the card («off from the factory»): work flows until the owner stops it; the default stays on.
    expect(seen.fresh).toEqual({ on: true, since: null, reason: null });
    expect(seen.off).toEqual({ on: false, reason: "night maintenance", sinceIsIso: true });
    expect(seen.sameSinceAndReason).toBe(true);
    expect(seen.stored).toEqual({ atIsNumber: true, reason: "night maintenance" });
    expect(seen.line).toBe("Lane Pilot: the conveyor is OFF since <iso> (night maintenance): no new work is issued. Turn it on with: bb lane-pilot conveyor on");
    expect(seen.back).toEqual({ on: true, since: null, reason: null });
    expect(seen.longReason).toBe(300);
  });

  it("[sma:m_ce_batch] the words «make a batch» are not read as a batch by the rules, in either language or as a list: the rules give small and unsure, so no machine start follows (the judge, not a phrase, reads a batch)", () => {
    const seen = obsBatchPhrase();
    expect(seen.bare).toEqual({ kind: "small", confident: false });
    expect(seen.ru).toEqual({ kind: "small", confident: false });
    expect(seen.list).toEqual({ kind: "small", confident: false });
    expect(seen.kinds).toEqual(["small", "small", "small"]);
  });

  it("[sma:m_cf_hard_calls] release, tag and push are refused to a writer, a plain git read is not; the phase waits for the owner's word before it issues; the PM session text names money, deleting and access", () => {
    const seen = obsHardCalls();
    expect(seen.writerDenied).toEqual([["git push origin main", true], ["git tag v1.0", true], ["gh release create v1.0", true]]);
    expect(seen.writerAllowed).toBe(false);
    expect(seen.phaseWaits).toEqual({ key: "execution:word:issue", mentionsOwner: true });
    expect(seen.pmText).toEqual([true, true, true]);
  });
});

describe("tails · a word to a worker, the phase's learnings, the check's report, parity, publish, research", () => {
  it("[sma:m_sd_steer] a word to a running worker goes into the worker's own thread as a steer, no attempt is spent; the control run (a word kept for the task) sends nothing", async () => {
    const seen = await obsSteer();
    expect(seen.control).toEqual({ ok: true, delivered: false, sent: 0 });
    expect(seen.live).toEqual({ ok: true, delivered: true, attemptId: "a1" });
    expect(seen.sent).toEqual([{ threadId: "thr_w", mode: "steer-if-active", hasWord: true, hasControlWord: false }]);
    expect(seen.attempts).toBe(1);
    expect(seen.state).toBe("running");
  });

  it("[sma:k_c_learnings] what a phase learned is written once as a note of its project through the memory door (hub memory, no LEARNINGS.md file); a refused write is named in the phase book and returned", () => {
    const seen = obsLearnings();
    expect(seen.ok).toBeNull();
    expect(seen.writes).toBe(1);
    expect([seen.projectId, seen.audience, seen.origin, seen.sourceIsPhaseAndText]).toEqual(["proj1", "subagent", "phase-lessons", true]);
    expect(seen.entries).toEqual([{ kind: "note", content: "decisions: one road; pattern: gate before wave; surprise: a stale lock", concepts: ["phase", "lessons"] }]);
    expect(seen.refused).toBe("memory budget is full");
    expect(seen.book).toEqual([["lessons", "memory_refused", "the memory door refused the lesson: memory budget is full"]]);
  });

  it("[sma:k_pl_uiqa] the live check's report keeps its cases and summary; a pass without every case passed is blocked, never a pass; no verdict block is blocked with its reason", () => {
    const seen = obsUiQa();
    expect(seen.failed).toEqual({ verdict: "failed", status: "rework", summary: "the save button reaches no write", cases: [{ case: "save form", viewport: "375", result: "failed", note: "no control reaches the write" }] });
    expect(seen.silent).toEqual({ verdict: "blocked", status: "block" });
    expect(seen.bare).toBe("blocked");
    expect(seen.passed).toEqual({ verdict: "passed", status: "pass", summary: "both cases held", cases: 2 });
    expect(seen.none).toEqual({ verdict: "blocked", summary: "browser_qa_thread_returned_no_verdict" });
  });

  it("[sma:k_lib_parity] the parity report has six lines in the fixed order; same names its count, a difference names each side, a layer one side did not record is «not compared», never «same»", () => {
    const seen = obsParity();
    expect(seen.order).toEqual(["hooks", "memory", "rules", "skills", "permissions", "model"]);
    expect(seen.allSame).toBe(true);
    expect(seen.sameCount).toEqual({ layer: "memory", same: true, detail: "2 entries" });
    expect(seen.memory).toEqual({ layer: "memory", same: false, detail: "only in the session: m3; only in the terminal: m2" });
    expect(seen.skills).toEqual({ layer: "skills", same: false, detail: "only in the terminal: s9" });
    expect(seen.oneSide).toEqual({ layer: "skills", same: false, detail: "only in the session: b" });
    expect(seen.missing).toEqual({ layer: "permissions", same: null, detail: "not compared: permissions were not recorded on the attempt, or the terminal side could not be computed" });
  });

  it("[sma:m_sh_publish] publish runs only behind the gate marker: a failing marker ends held with its reasons and the PR step never runs; a clean run opens the PR once and ends shipped with its url", async () => {
    const seen = await obsShip();
    expect(seen.held).toEqual({ ran: ["gate", "held_gate"], out: { status: "held", pr_url: "", held_by: ["integration gate not run"], hooks_failed: [] }, openPrCalls: 0 });
    expect(seen.shipped.ran).toEqual(["gate", "preflight", "open_pr", "hooks", "goal_check", "shipped"]);
    expect(seen.shipped.out).toEqual({ status: "shipped", pr_url: "https://x/pr/1", held_by: [], hooks_failed: [] });
    expect(seen.shipped.openPrCalls).toBe(1);
  });

  it("[sma:k_pl_researchdir] the research step sits between the owner's answers and the requirements, writes the four research files into .agents/planning/research and never overwrites; it is skipped when the tree is off", async () => {
    const seen = await obsResearch();
    expect(seen.before).toEqual(["research"]);
    expect(seen.after).toEqual(["requirements"]);
    expect(seen.thenRecap).toEqual(["recap"]);
    expect(seen.folder).toBe(true);
    expect(seen.files).toEqual(["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"]);
    expect(seen.neverOverwrites).toBe(true);
    expect(seen.role).toBe("specialist:tavily");
    expect(seen.skipWhen).toBe("tree.enabled != 'on'");
    expect(seen.skipOut).toEqual({ research_notes: "" });
  });
});
