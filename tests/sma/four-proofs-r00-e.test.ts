// Region 0 (Phase graph), batch e: the lessons stage (n120 … n129) and the phase control work (n130 … n139; n132 is another batch's). Each test takes the card's input and checks the result
// the card names — the row the phase was left with, the memory note, the refusal in its words, the book line, the workflow the pass started — on the real code (observations in tests/sma/r00-world-e.ts).
// Card check against the owner's decisions: memory lives only on the hub (the lesson goes through the memory door of this plugin's own database), the owner is asked for the lesson only with owner.words on,
// the phase never waits for it: no card of this batch contradicts a decision.
import { describe, expect, it } from "vitest";
import { ANALYSIS, observe } from "./r00-world-e";

const REFUSED = "the lessons are not proven read by their reviewer";
const NOTE = { kind: "note", audience: "subagent", content: `Phase «Hud» lessons: ${ANALYSIS}`, concepts: ["phase", "lessons"] };

describe("region 0 · the lessons analysis", () => {
  it("[sma:p7_row] the driver's pass starts the lessons analysis for a phase at lessons with a run and no analysis, handed that run; with an analysis, with no run it starts nothing", async () => {
    const s = await observe.lessonsStart();
    expect(s.due).toEqual({ kind: "lessons" });
    expect(s.withAnalysis).toBeNull();
    expect(s.noRun).toBeNull();
    expect(s.stepped).toBe(true);
    expect(s.runId).toBe("r");
    expect(s.auto).toBe("lessons");
    expect(s.wfRunId).toBe("wfrun_r");
    const d = await observe.lessonsDone();
    expect(d.row).toMatchObject({ needed: true, why: "a return", analysis: ANALYSIS });
  });

  it("[sma:p7_cmd] the phase review command is the retrospective: the driver starts that workflow and its graph reads the run, stages the insights and ends done with what it staged", async () => {
    const s = await observe.lessonsStart();
    expect(s.workflow).toBe("retrospective");
    const r = await observe.retro();
    expect(r.path).toEqual(["retro", "report", "living", "stage", "done"]);
    expect(r.status).toBe("succeeded");
    expect(r.output).toEqual({ status: "done", insights: [{ id: "INS-1a2b3c4d" }, { id: "INS-5e6f7a8b" }], retro_path: "retro/r-sample.md", candidates_staged: 2 });
  });

  it("[sma:p7_author] the analysis is kept with its author: the session that handed it to the reviewer, not the reviewer's own", async () => {
    const d = await observe.lessonsDone();
    expect(d.stage).toBe("closed");
    expect(d.row.author).toBe("thr_retro");
    expect(d.row.author).not.toBe(d.row.reviewer);
    expect(d.analysisPart).toEqual([`${ANALYSIS} (by thr_retro, read by thr_stage in wf_read, input ${d.measured12})`]);
  });

  it("[sma:p7_reviewer] the reviewer is a session other than the author's: a run whose reviewer is the author's own session is refused in those words and writes nothing", async () => {
    const d = await observe.lessonsDone();
    expect(d.row.reviewer).toBe("thr_stage");
    const s = await observe.lessonsRefused();
    expect(s.out.wf_self).toEqual({ message: REFUSED, why: ["the reviewer of wf_self is not a session other than the analysis's author"] });
    expect([s.stage, s.analysis, s.memory]).toEqual(["lessons", null, 0]);
  });

  it("[sma:p7_saw_bytes] the lessons are taken only from a run of this project whose reviewer step was handed exactly these bytes and was measured on them: each other run is refused in its own words", async () => {
    const s = await observe.lessonsRefused();
    expect(s.out.wf_none).toEqual({ message: REFUSED, why: ["workflow run wf_none is not in the journal: the lessons name the run whose reviewer read them"] });
    expect(s.out.wf_other?.why).toEqual(["workflow run wf_other belongs to project OTHER, not to this phase's projA"]);
    expect(s.out.wf_elsewhere?.why).toEqual(["the reviewer step «stage» of wf_elsewhere did not receive these bytes: the analysis is not in its input"]);
    expect(s.out.wf_forged?.why).toEqual(["the journal's measurement of the reviewer's input does not match its bytes in wf_forged"]);
    expect(s.out.wf_nostage?.why).toEqual(["no finished reviewer step «stage» in workflow run wf_nostage"]);
    const d = await observe.lessonsDone();
    expect(d.row.hash).toBe(true);
    expect(d.row.reviewRun).toBe("wf_read");
  });

  it("[sma:p7_write] the analysis goes through the memory door as a note of the project for the subagents, tagged phase and lessons — once, with the phase's title", async () => {
    const d = await observe.lessonsDone();
    expect(d.memory).toEqual([NOTE]);
    expect(d.row.draft).toBeNull();
  });

  it("[sma:p7_staged] with the owner's word on the lesson is a staged draft: nothing is in memory until his yes writes it; a no declines it and writes nothing", async () => {
    const s = await observe.lessonDraft();
    expect(s.staged).toEqual({ stage: "closed", draft: { state: "staged", text: NOTE.content }, memory: 0, parts: ["the lesson waits as a draft for the owner's word «lesson»"] });
    expect(s.after).toEqual({ draft: "applied", memory: [NOTE], parts: ["the owner applied the lesson draft: it is in memory"] });
    const no = await observe.lessonDeclined();
    expect(no).toEqual({ state: "declined", memory: 0, parts: ["the owner declined the lesson draft"], applied: [] });
  });

  it("[sma:p7_blocked] a memory write the door refused is booked in the door's own words, nothing is written and the draft stays staged with its error", async () => {
    const s = await observe.lessonRefused();
    expect(s.mid).toEqual({ state: "staged", error: "memory door closed", memory: 0, parts: ["the memory door refused the lesson: memory door closed"], applied: [] });
  });

  it("[sma:p7_book] the lessons section of the book carries the analysis, the draft and the refusal with its reason, in their order; the chain stays intact", async () => {
    const s = await observe.lessonRefused();
    expect(s.lessonsSection).toEqual([
      `**analysis** — ${ANALYSIS} (by thr_retro, read by thr_stage in wf_read, input ${(await observe.lessonsDone()).measured12})`,
      "**staged** — the lesson waits as a draft for the owner's word «lesson»",
      "**memory_refused** — the memory door refused the lesson: memory door closed",
      "**lesson_applied** — the owner applied the lesson draft: it is in memory",
    ]);
    const b = await observe.bookSection();
    expect(b.heads[7]).toBe("## 8. Lessons");
    expect(b.lines).toEqual([s.lessonsSection[0], s.lessonsSection[1]]);
    expect(b.chain).toBe("chain: intact (5 parts)");
    expect(b.otherSection).toBe(false);
  });

  it("[sma:pc_row] a phase is a row of its own, born active at the first stage and tied to the PM's run; it is no task row, so no writer can claim it", async () => {
    const s = await observe.phaseRow();
    expect(s.row).toMatchObject({ stage: "discussion", state: "active", runId: "run1", pm: "thr_pm", project: "projA", title: "Hud" });
    expect([s.tasks, s.attempts, s.dispatched]).toEqual([0, 0, 0]);
    expect(s.live).toEqual([true]);
  });

  it("[sma:pc_contract] a context written again with other files voids the owner's earlier yes and mints a new edition; the same files keep the word", async () => {
    const s = await observe.resign();
    expect(s.before.words).toBe(1);
    expect(s.same).toMatchObject({ words: 1, sha: true });
    expect(s.changed).toMatchObject({ words: 0, sha: false });
    expect(s.same.edition).toBeGreaterThan(s.before.edition);
    expect(s.changed.edition).toBeGreaterThan(s.same.edition);
  });

  it("[sma:pc_home] a phase's files live under .agents/phases/<id>: one folder per phase, and the book the driver writes goes there", async () => {
    const s = await observe.home();
    expect(s.folder).toBe(".agents/phases/ph_abc");
    expect(s.other).toBe(".agents/phases/ph_other");
    expect(s.paths.filter((path) => path.endsWith("BOOK.md"))).toEqual([".agents/phases/<id>/BOOK.md"]);
  });

  it("[sma:pc_live] a stage whose workflow run is running or waiting is not started again and keeps its run; a phase with no run on it starts one", async () => {
    const s = await observe.stageLive();
    for (const held of [s.running, s.waiting]) expect(held).toEqual({ stepped: true, started: [], booked: [], auto: "wf-live" });
    expect(s.none).toEqual({ stepped: true, started: ["start"], booked: ["auto_started"], auto: "wf-new" });
  });

  it("[sma:pc_commands] the stage commands are one dictionary and the runner takes the command from it, not from the title the phase carries", async () => {
    const s = await observe.stageCommands();
    expect(s.dictionary).toEqual({ analyze: "lp.analyze", plan: "lp.plan", check: "lp.plan", draw: "lp.draw", review: "lp.review", close: "lp.close", lessons: "retrospective", live: "ui-audit", bounce: "plan-review-convergence", diagnose: "debug" });
    expect(s.started).toEqual(["retrospective"]);
  });

  it("[sma:pc_no_auto] no action of the phase tool takes a flag that decides for the person: each refuses force, skip, auto and noGates as unknown keys", () => {
    const s = observe.noFlags();
    expect(s.actions).toBeGreaterThan(20);
    expect(s.lax).toEqual([]);
    expect(s.plain).toBe(true);
    expect(s.withFlag).toBe(false);
  });

  it("[sma:pc_title] the stage title is «Phase <id> «<title>» — stage, what it awaits», in words: the phase's title, not its goal, and never a command line", () => {
    const s = observe.stageTitle();
    expect(s.discussion).toMatch(/^Phase ph_1 «Sums» — stage 1, discussion\. Goal: sums are righ/);
    expect(s.planning).toMatch(/^Phase ph_1 «Sums» — stage 2, planning, on context/);
    expect(s.lessons).toMatch(/^Phase ph_1 «Sums» — stage 7, lessons \(a return\)\./);
    expect(s.paused).toBe("Phase ph_1 «Sums» is paused");
    for (const line of [s.discussion, s.planning, s.lessons]) expect(line).not.toMatch(/^(lane_pilot|\/|lp\.)/);
  });

  it("[sma:pc_priority] a piece a phase issues goes before every backlog task, urgent included, unless its plan set a priority of its own; the backlog keeps its order", () => {
    const s = observe.queue();
    expect(s.ranks).toEqual([0, 1, 2, 3]);
    expect(s.stage).toBe(4);
    expect(s.urgent).toBe(3);
    expect(s.noBirth).toBe(1);
    expect(s.mixed).toEqual(["phase-piece", "urgent-pm", "normal-pm", "phase-low"]);
    expect(s.twoPieces).toEqual(["a", "b"]);
  });

  it("[sma:pc_no_gates] every stage but the last names the gate that lets the phase out, each name is a gate of the phase logic, and the status says out loud why the first stages are not yet through", async () => {
    const s = await observe.stageGates();
    expect(s.map).toEqual({ discussion: "discussionGate", planning: "planGate", design: "designGate", execution: "executionGate", verification: "blindVerdict", acceptance: "acceptanceLines", lessons: "lessonsNeeded" });
    expect(Object.values(s.named)).toEqual(Array(7).fill("function"));
    expect(s.statusKeys).toEqual(["discussion", "plan", "design"]);
    expect(s.discussion.ok).toBe(false);
    expect(s.discussion.why).toHaveLength(4);
    expect(s.discussion.why[0]).toMatch(/^no context documents/);
  });

  it("[sma:p7_recover] an accepted analysis whose write did not land is finished by a later pass from the same text, without a new analysis: written once, the error cleared", async () => {
    const s = await observe.lessonRefused();
    expect(s.idleBefore).toBe(0);
    expect(s.after).toEqual({ state: "applied", error: null, memory: [NOTE], analysis: ANALYSIS, applied: ["the owner applied the lesson draft: it is in memory"] });
  });
});
