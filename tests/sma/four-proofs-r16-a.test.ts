// Region 16 (slash commands and workflows), batch a: the design-phase and execute-phase cards (n1144 … n1173). Every test runs the real code of the node
// through tests/sma/r16-world.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16.py proves) and checks the result the card names.
import { describe, expect, it } from "vitest";
import { ANIMATOR_LAW, DRAWING_RULES } from "../../src/rooms/phase/stages";
import { observe } from "./r16-world";

const RUBRIC_DESIGN_BLOCKING = "Blocking: drawing before reading the plan; a drawing without a contract a check can read; the designer reviewing his own drawing; motion without the animator's rules.";
const MISSING_CONTRACT = "the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths";
const AWAITS_WORD = "the drawing awaits the owner's word for this drawing";

describe("design phase (n1144 … n1162)", () => {
  it("[sma:k_c_design] /sma-design-phase: the drawing waits for the owner's word, a yes for this drawing settles it, a redrawn drawing asks again", async () => {
    const seen = await observe.k_c_design();
    expect(seen.held).toEqual([AWAITS_WORD]);
    expect(seen.confirmed).toBe(true);
    expect(seen.redrawn).toEqual([AWAITS_WORD]);
  });

  it("[sma:k_wd_rubric] the design stage rubric: seven steps in order, four blocking antipatterns — the designer never reviews his own drawing", async () => {
    const { design, closed } = await observe.k_wd_rubric();
    expect(design.startsWith("Order of work: 1) read the phase (CONTEXT, SPEC, PLAN) before drawing; 2) pick the mode: screens, system or mixed; 3) gather the material")).toBe(true);
    expect(design.split("Blocking: ")[0]!.match(/\d\) /g)).toHaveLength(7);
    expect(design.endsWith(RUBRIC_DESIGN_BLOCKING)).toBe(true);
    expect(closed).toBe("");
  });

  it("[sma:k_wd_read] the drawer reads the signed context documents, the spec and the plan, then DESIGN.md — before any drawing", async () => {
    const seen = await observe.k_wd_read();
    expect(seen.design).toEqual([".agents/phases/ph_sma/CONTEXT.md", ".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/PLAN.md", "DESIGN.md"]);
    expect(seen.noDocs).toEqual([".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/PLAN.md", "DESIGN.md"]);
  });

  it("[sma:k_wd_mode] the mode follows the files the pieces own: screens, system (tokens, theme) or mixed; a system mode adds the c4 and event-chain sections", async () => {
    const seen = await observe.k_wd_mode();
    const base = ["actions", "screens_states", "texts", "heuristics", "accessibility"];
    expect(seen.screens).toEqual(["screens", base]);
    expect(seen.system).toEqual(["system", [...base, "c4", "event_chain"]]);
    expect(seen.mixed).toEqual(["mixed", [...base, "c4", "event_chain"]]);
    expect(seen.none).toBe("screens");
  });

  it("[sma:k_wd_version] a replaced drawing goes to the archive with its hash, the same drawing twice does not, the archive keeps ten", async () => {
    const seen = await observe.k_wd_version();
    expect(seen.replaced).toEqual(["a"]);
    expect(seen.same).toBe(0);
    expect(seen.first).toBe(0);
    expect(seen.capped).toEqual(["old1", "old2", "old3", "old4", "old5", "old6", "old7", "old8", "old9", "a"]);
  });

  it("[sma:k_wd_path] a drawing reported by the PM's specialist and one reported by the lp.draw auto stage make the same artifacts and end at the same gate: execution", async () => {
    const { pm, auto } = await observe.k_wd_path();
    const same = { stage: "execution", kept: ["UI-SPEC.md", "kit.png"], committed: [["UI-SPEC.md", "kit.png"]], commit: "ccccccc", book: ["drawing", "drawing_committed"] };
    expect(pm).toMatchObject({ ...same, designer: "design-lead" });
    expect(auto).toMatchObject({ ...same, designer: "lp.draw: specialist design-lead" });
  });

  it("[sma:k_wd_h1] the sketch rules (themes, variants, shared proto script, no build step) and the six scoring axes reach the draw and the check steps of lp.draw", async () => {
    const seen = await observe.k_wd_h1();
    expect(seen.draw.rules && seen.check.rules).toBe(true);
    expect(seen.draw.words).toEqual(seen.words);
    expect(seen.check.words).toEqual(seen.words);
    expect(seen.rulesHave).toEqual(seen.words);
    expect(DRAWING_RULES).toContain("light and dark themes through a data-theme attribute, variants as <screen>--<variant>.html");
  });

  it("[sma:k_wd_h2] the contract of checkable points: UI-SPEC.md or DESIGN.md among the paths, and a heading for every required section", async () => {
    const seen = await observe.k_wd_h2();
    expect(seen.designMd).toBeNull();
    expect(seen.partial).toBe("the drawing's contract misses required section(s): texts, heuristics, accessibility — UI-SPEC.md needs one heading per required section");
    expect(seen.full).toBeNull();
    expect(seen.notNeeded).toBeNull();
  });

  it("[sma:k_wd_h3] the author's check is kept apart: no reviewer and a reviewer equal to the designer are refused, another role passes", async () => {
    const seen = await observe.k_wd_h3();
    expect(seen.none).toEqual(["the drawing is not reviewed by a separate role"]);
    expect(seen.same).toEqual(["the reviewer of the drawing is its designer: it must be a separate role"]);
    expect(seen.other).toBe(true);
  });

  it("[sma:k_wd_snapshot] lp.browser-qa opens the app at the three viewports with the cases, the failed verdict fails the run and the reply stays in the qa step", async () => {
    const seen = await observe.k_wd_snapshot();
    expect(seen.path).toBe("qa verdict done");
    expect(seen.qa).toEqual({ url: "http://127.0.0.1:5173/", viewports: "375,768,1280", cases: ["Open home"], authorized: false });
    expect(seen.out).toEqual({ state: "failed", reply: { reason: "case 1 failed" } });
  });

  it("[sma:k_wd_i1] lp.draw: the material step is skipped by default and runs with phase.draw_material on, handing its path to draw and check", async () => {
    const seen = await observe.k_wd_i1();
    expect(seen.off).toEqual(["draw", "check", "done"]);
    expect(seen.offSkipped).toEqual(["material"]);
    expect(seen.offDraw).toBe("");
    expect(seen.on).toEqual(["material", "draw", "check", "done"]);
    expect(seen.onDraw).toBe("f/design/MATERIAL.md");
    expect(seen.onCheck).toBe("f/design/MATERIAL.md");
  });

  it("[sma:k_wd_i2] at design Lane Pilot draws the screens itself (lp.draw), the PM is told not to start a designer; with a drawing the PM is told how to redraw", async () => {
    const seen = await observe.k_wd_i2();
    expect(seen.bare.waitsForPm).toBe(true);
    expect(seen.bare.text).toBe("Phase ph_x «Sum» — stage 3, design (screens). Lane Pilot draws the screens itself (lp.draw: design-lead draws into .agents/phases/ph_x/design/ with UI-SPEC.md, another role checks)");
    expect(seen.bare.motion).toBe(true);
    expect(seen.drawn.text).toBe("To change the drawing, have design-lead redraw the screens i");
    expect(seen.drawn.mentionsLpDraw).toBe(false);
  });

  it("[sma:k_wd_i3] the check before the gate: a rework verdict sends the drawing back to the designer, a pass ends the graph", async () => {
    const seen = await observe.k_wd_i3();
    expect(seen.path).toEqual(["draw", "check", "draw", "check", "done"]);
    expect(seen.draws).toBe(2);
    expect(seen.checks).toBe(2);
  });

  it("[sma:k_wd_c1] reporting a drawing commits exactly its manifest paths (the contract and the sketches), once, and books the commit", async () => {
    const { pm } = await observe.k_wd_path();
    expect(pm.committed).toEqual([["UI-SPEC.md", "kit.png"]]);
    expect(pm.commit).toBe("ccccccc");
    expect(pm.book).toEqual(["drawing", "drawing_committed"]);
  });

  it("[sma:k_wd_c2] a drawing that waits for the owner's word is recorded as waiting: the phase's one next action names the turn, and the word changes it", async () => {
    const seen = await observe.k_wd_c2();
    expect(seen.wait).toEqual({ key: "design:word:design", waitsForPm: true, text: "Phase ph_sma «Sum» awaits the owner's word at design (owner." });
    expect(seen.after.key).toBe("design:s1:t");
  });

  it("[sma:k_wd_c3] readiness is announced only with the drawing, the feasibility answer, the independent review and the contract: each missing part is named", async () => {
    const seen = await observe.k_wd_c3();
    expect(seen.noPaths).toEqual(["no drawing: the designer draws the screens into the phase's design folder and names the files"]);
    expect(seen.noAnswer).toEqual(["no feasibility answer: feasible, or the contradiction with the plan"]);
    expect(seen.contradicts).toEqual(["the drawing contradicts the plan: needs a backend — return the phase to planning"]);
    expect(seen.noContract).toEqual([MISSING_CONTRACT]);
    expect(seen.ready).toBe(true);
  });
});

describe("execute phase (n1145 … n1173)", () => {
  it("[sma:k_c_execute] /sma-execute-phase: a piece is issued once the pieces it depends on are accepted; the driver issues wave 1 and holds wave 2", async () => {
    const seen = await observe.k_c_execute();
    expect(seen.first).toEqual(["p1", "p3"]);
    expect(seen.afterP1).toEqual(["p2"]);
    expect(seen.sent).toEqual(["q1"]);
    expect(seen.issued).toEqual(["q1"]);
  });

  it("[sma:k_c_execplan] execute-plan (lp.build): every task accepted and the gate green is done, one failed is partial with the accepted commits, none accepted is blocked", async () => {
    const seen = await observe.k_c_execplan();
    expect(seen.done).toEqual({ path: "run_tasks gate done", status: "done", accepted: ["t1", "t2", "t3"], failed: [], commits: ["c-t1", "c-t2", "c-t3"] });
    expect(seen.partial).toEqual({ path: "run_tasks gate partial", status: "partial", accepted: ["t1", "t2"], failed: ["t3"], commits: ["c-t1", "c-t2"] });
    expect(seen.blocked).toEqual({ path: "run_tasks blocked", status: "blocked", accepted: [], failed: [], commits: [] });
  });

  it("[sma:k_c_noderepair] a task that failed its checks goes back to its writer with the failing check, its exit code and how to fix it; an accepted attempt and no attempt carry nothing", async () => {
    const seen = await observe.k_c_noderepair();
    expect(seen.briefLine).toBe("- the check `npm test` failed (exit 1) → run `npm test` yourself, read its output, fix what it names inside owns_paths");
    expect(seen.accepted).toBe("");
    expect(seen.none).toBe("");
  });

  it("[sma:k_we_rubric] the execution rubric: five steps in order and three blocking antipatterns", async () => {
    const { execution } = await observe.k_we_rubric();
    expect(execution).toBe("Order of work: 1) initialize: the base commit, the drawing and contract for the writers; 2) issue wave by wave, the wave table into the book; 3) each piece through its gates (lint, base, writer, ownership, checks, plan→fact, critic); 4) review each finished wave by another model; 5) the regression pass of earlier phases after each merge. Blocking: issuing a piece before the pieces it depends on are accepted; a writer editing the drawing it follows; accepting on a model's word alone.");
  });

  it("[sma:k_we_init] the execution context in one list: the drawing's files then the plan; verification and discussion read their own files", async () => {
    const seen = await observe.k_we_init();
    expect(seen.execution).toEqual([".agents/phases/ph_sma/design/UI-SPEC.md", ".agents/phases/ph_sma/design/kit.png", ".agents/phases/ph_sma/PLAN.md"]);
    expect(seen.plain).toEqual([".agents/phases/ph_sma/PLAN.md"]);
    expect(seen.verification).toEqual([".agents/phases/ph_sma/SPEC.md", ".agents/phases/ph_sma/VALIDATION.md", ".agents/phases/ph_sma/design/UI-SPEC.md"]);
    expect(seen.discussion).toEqual([".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", ".agents/phases/ph_sma/DISCUSSION.md"]);
  });

  it("[sma:k_we_resume] on a resume a piece already issued (its contract unchanged) is not issued again, the pieces that wait for it go on, a changed contract is issued again", async () => {
    const seen = await observe.k_we_resume();
    expect(seen.resumed).toEqual(["p2"]);
    expect(seen.stillRunning).toEqual([]);
    expect(seen.changed).toEqual(["p1", "p2"]);
  });

  it("[sma:k_we_headless] a writer keeps off a provider the owner used within ten minutes (and names who and where), not an older one or another provider", async () => {
    const seen = await observe.k_we_headless();
    expect(seen.within).toBe("owner_present:codex used by the owner 2 min ago on mac");
    expect(seen.edge).toBe("owner_present:codex used by the owner 10 min ago on mac");
    expect(seen.after).toBeNull();
    expect(seen.old).toBeNull();
    expect(seen.other).toBeNull();
    expect(seen.wide).toBe("owner_present:codex used by the owner 20 min ago on mac");
  });

  it("[sma:k_we_branch] a closed phase leaves a marker branch: phase/<id>, or milestone/<slug> of the roadmap section its row sits under", async () => {
    const seen = await observe.k_we_branch();
    expect(seen.milestone).toEqual(["git branch -f milestone/v1 HEAD", ["marker branch milestone/v1 at the accepted main"]]);
    expect(seen.phase).toEqual(["git branch -f phase/<id> HEAD", ["marker branch phase/<id> at the accepted main"]]);
  });

  it("[sma:k_we_discover] the plan inventory: waves sorted, the pieces of each wave in plan order, the ready list earliest wave first", async () => {
    const seen = await observe.k_we_discover();
    expect(seen.waves).toEqual([1, 2]);
    expect(seen.perWave).toEqual([["a", "d"], ["b", "c"]]);
    expect(seen.ready).toEqual(["a", "d", "b", "c"]);
  });

  it("[sma:k_we_wavetable] the wave table goes into the book once, as the wave's pieces are issued: a row per piece with its task and promise, a pipe in a promise cannot break the table", async () => {
    const seen = await observe.k_we_wavetable();
    expect(seen.table).toEqual(["wave 1:", "| piece | task | promise |", "|---|---|---|", "| p1 | task_1 | then-p1 |", "| p2 | — | a / b |"]);
    expect(seen.journal).toEqual([["wave 1:", "| piece | task | promise |", "|---|---|---|", "| p1 | p1 | then-p1 |", "| p2 | p2 | a / b |"]]);
  });

  it("[sma:k_we_contract] the drawing's contract is mandatory: without UI-SPEC.md the drawing is refused, the executors' context lists the drawing, and a screen piece's plan names it (a backend piece's does not)", async () => {
    const seen = await observe.k_we_contract();
    expect(seen.noContract).toBe(MISSING_CONTRACT);
    expect(seen.execution).toEqual([".agents/phases/ph_sma/design/UI-SPEC.md", ".agents/phases/ph_sma/PLAN.md"]);
    expect(seen.screen).toBe("   the screens follow the phase drawing: .agents/phases/ph_sma/design/UI-SPEC.md");
    expect(seen.backend).toBe(false);
  });

  it("[sma:k_we_animator] pieces whose promise or title is about motion (English or Russian) get the animator's rules; a typo fix and the word «unanimated» do not", async () => {
    const seen = await observe.k_we_animator();
    expect(seen.rows).toEqual(["m", "r"]);
    expect(seen.decision).toEqual(["m"]);
  });

  it("[sma:k_we_animator_inline] a motion piece carries the animator's law and the frequent-action rule inline, only where phase.piece_notes is on", async () => {
    const seen = await observe.k_we_animator_inline();
    expect(seen.on).toBe(`Motion (the animator's law): ${ANIMATOR_LAW}; an action the person performs many times in a session (typing, row hover, list moves) is not animated`);
    expect(seen.onPlain).toBeNull();
    expect(seen.off).toBeNull();
  });

  it("[sma:k_we_crossai] delegating a running plan to another AI: the named provider and model are kept for the next writer, the old writer is stopped", async () => {
    const seen = await observe.k_we_crossai();
    expect(seen.named).toEqual({ ok: true, taskId: "T1", runId: "run1", oldThreadId: "thr_w", oldAttemptNo: 1, providerId: "codex", model: "gpt-x" });
    expect(seen.request).toEqual({ reason: "let codex do this one", selection: { providerId: "codex", model: "gpt-x" } });
    expect(seen.stops).toEqual(["thr_w"]);
    expect(seen.state).toBe("cancel_requested");
  });
});
