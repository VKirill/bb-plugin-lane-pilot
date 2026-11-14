// Region 16 (slash commands and workflows), batch f, first half: the phase list commands, the settings commands and the profile / discussion / spec / ui / ai / mvp commands (n1298 … n1314).
// Every test runs the real code of the node through tests/sma/r16-world-f.ts (the same observations the scene scripts/lp_drill/scenes/sma_r16_f.py proves) and checks the result the card
// names: what the phase list holds after the command, what a refused command leaves untouched, what the settings resolve to, the path a graph takes and what it emits.
import { describe, expect, it } from "vitest";
import { observeF } from "./r16-world-f";

describe("the phase list (n1298 … n1301)", () => {
  it("[sma:k_c_addphase] a new phase is a record of its own at the end of the book: its own id, its folder, its roadmap row, at discussion and active; the earlier phase is not touched", async () => {
    const seen = await observeF.k_c_addphase();
    expect(seen.ids).toEqual([true, true, true]);
    expect(seen.row).toEqual({ stage: "discussion", state: "active", title: "Export", goal: "export the stats as CSV", projectId: "projA", pmThreadId: "thr_pm", run: "run1", roadmapRow: "2" });
    expect(seen.folder).toBe(".agents/phases/<id>");
    expect(seen.book).toEqual(["goal", "opened", true]);
    expect(seen.byRow).toBe(true);
    expect(seen.live).toEqual(["Export", "Hud"]);
  });

  it("[sma:k_c_insertphase] an urgent phase takes a decimal row between two phases at any moment: the phases around it keep their id, row, stage and goal, and every row still names its own phase", async () => {
    const seen = await observeF.k_c_insertphase();
    expect(seen.before).toEqual([{ stage: "planning", state: "active", title: "Login", goal: "the login page", row: "1" }, { stage: "discussion", state: "active", title: "Billing", goal: "the billing page", row: "2" }]);
    expect(seen.unchanged).toBe(true);
    expect(seen.urgent).toEqual({ stage: "discussion", state: "active", title: "Hotfix", goal: "stop the double charge", row: "1.1" });
    expect(seen.distinct).toBe(3);
    expect(seen.resolved).toEqual(["Login", "Hotfix", "Billing"]);
  });

  it("[sma:k_c_removephase] a future phase is removed by closing it with the words why: the record and its book stay as history, the other phases are not touched; without words nothing changes", async () => {
    const seen = await observeF.k_c_removephase();
    expect(seen.noWords).toBe("closing in words carries the words: why the phase ends here");
    expect(seen.blank).toBe("closing in words carries the words: why the phase ends here");
    expect(seen.kept).toEqual(["discussion", "active"]);
    expect(seen.closed).toEqual({ stage: "closed", state: "closed", closing: { by: "owner", words: "dropped: the owner moved the hud to next quarter" }, title: "Hud" });
    expect(seen.book).toEqual(["owner: dropped: the owner moved the hud to next quarter"]);
    expect(seen.live).toEqual(["Stats"]);
    expect(seen.resume).toBe("phase <id> is closed: open a new phase for new work");
    expect(seen.other).toEqual({ stage: "discussion", state: "active", title: "Stats", goal: "the stats page", row: "4" });
  });

  it("[sma:k_c_editphase] the goal is edited where the phase stands (id, title and row stay), each edit is counted and booked; a phase past planning or closed refuses it and keeps its goal", async () => {
    const seen = await observeF.k_c_editphase();
    expect(seen.same).toBe(true);
    expect(seen.first).toEqual({ goal: "a hud with a CSV export", title: "Hud", stage: "discussion", revisions: 1 });
    expect(seen.second).toEqual({ goal: "a hud with a PDF export", revisions: 2 });
    expect(seen.roadmapRow).toBe("5");
    expect(seen.book).toEqual(["a hud with a CSV export — the owner added the export", "a hud with a PDF export — the owner changed his mind"]);
    expect(seen.running).toBe("the goal is revised in discussion or planning: return the phase there first");
    expect(seen.goalAfterRefusal).toBe("a hud with a PDF export");
    expect(seen.closed).toBe("the goal is revised in discussion or planning: return the phase there first");
  });
});

describe("settings (n1302 … n1304)", () => {
  it("[sma:k_c_settings] the hub's row, the project's row over it and a section's row over both decide each setting; a project with no row of its own reads the hub's; a value that is not JSON stays text", async () => {
    const seen = await observeF.k_c_settings();
    expect(seen.project).toEqual({ "plan_critique.enabled": false, quality_mode: "full", "specialist.enabled": true, note: "plain words" });
    expect(seen.section).toEqual({ "plan_critique.enabled": true, quality_mode: "standard", "specialist.enabled": true, note: "plain words" });
    expect(seen.other).toEqual({ "plan_critique.enabled": false, quality_mode: "quick", "specialist.enabled": true });
    expect(seen.hub).toEqual(seen.other);
  });

  it("[sma:k_c_settingsadv] the power knobs sit in rows that stay in the page and are hidden until «Advanced» is shown; the plan bounce is one such switch, set per project", () => {
    const seen = observeF.k_c_settingsadv();
    expect(seen.shown).toEqual({ hidden: false, keepsRow: true, testId: true });
    expect(seen.hidden).toEqual({ hidden: true, keepsRow: true, testId: true });
    expect(seen.planBounce).toEqual(["project", "on|off"]);
  });

  it("[sma:k_c_settingsint] the search key and the external reviewer: the search specialist carries Env Catalog and the tavily skill, the reviewer has no Env Catalog until the owner grants it", () => {
    const seen = observeF.k_c_settingsint();
    expect(seen.tavily).toEqual({ bbPlugins: ["env-catalog"], skills: ["env-catalog", "tavily"], mcpServers: [] });
    expect(seen.reviewer).toEqual({ before: false, granted: true, source: "owner" });
    expect(seen.designer).toEqual(["env-catalog", "project-design", "modern-web-guidance"]);
  });
});

describe("the profile, discussion and spec commands (n1306 … n1314)", () => {
  it("[sma:k_c_profileuser] consent comes first: sessions or a questionnaire lead to the card, a questionnaire nobody answers and a refusal end cancelled with no record written", async () => {
    const seen = await observeF.k_c_profileuser();
    const card = "Kirill: a marketer who writes code";
    expect(seen.sessions).toEqual(["consent sessions card done", { status: "done", card }, 0, 0]);
    expect(seen.form).toEqual(["consent interview record card done", { status: "done", card }, 0, 1]);
    expect(seen.silent).toEqual(["consent interview cancelled", { status: "cancelled", card: "" }, 0]);
    expect(seen.cancel).toEqual(["consent cancelled", { status: "cancelled", card: "" }, 0]);
    expect(seen.none).toEqual(["consent cancelled", "cancelled"]);
  });

  it("[sma:k_c_discuss] the discussion ends in a signed CONTEXT: the gate names what is missing, one thing at a time, and passes a complete context", () => {
    const seen = observeF.k_c_discuss();
    expect(seen.none).toEqual([
      "no context documents: write the discussion (decisions, FAQ, ADR) to files in the project and name them",
      "risks not named: value, usability, feasibility, viability (name each, «none» is an answer)",
      "no appetite: say how much this phase may take before any solution (time or size)",
      "no-gos not named: what this phase will not do («none» is an answer)",
    ]);
    expect(seen.empty).toEqual(["e.md is empty"]);
    expect(seen.changed).toEqual(["the context signature does not match its documents"]);
    expect(seen.risks).toEqual(["risks not named: usability, feasibility, viability (name each, «none» is an answer)"]);
    expect(seen.bare).toEqual(["no appetite: say how much this phase may take before any solution (time or size)", "no-gos not named: what this phase will not do («none» is an answer)"]);
    expect(seen.legacy).toEqual([]);
    expect(seen.complete).toEqual([]);
    expect(seen.ok).toBe(true);
  });

  it("[sma:k_c_discuss_assume] decisions come from the code with evidence: a walk with a question that cites no file:line goes round once more, what the code cannot answer is open and the run ends open", async () => {
    const seen = await observeF.k_c_discuss_assume();
    expect(seen.anchored).toEqual(["walk synth open", {
      status: "open", locked: ["GET only"], open: ["invalidation on write"], deferred: ["ttl per route"], risk_register: [{ risk: "stale reads", severity: "high", file_line: "src/cache.ts:12" }], terminology: [{ term: "hit" }], branches_walked: 5,
    }]);
    expect(seen.unanchored).toEqual(["walk walk synth open", 2, 6]);
    expect(seen.never).toEqual(["walk walk synth open", 2]);
    expect(seen.clear).toEqual(["walk synth done", "done", ["GET only"]]);
    expect(seen.prompt).toBe(true);
  });

  it("[sma:k_c_discuss_power] every open question goes into the file at once, one line each (seven in the file, five asked in chat), and the one the owner left for later is marked", async () => {
    const seen = await observeF.k_c_discuss_power();
    expect(seen.listed).toEqual([1, 2, 3, 4, 5, 6, 7].map((n) => `- q${n}: which way for area ${n}?${n === 7 ? " — deferred by the owner" : ""}`));
    expect(seen.returned).toBe(7);
    expect(seen.askedInChat).toBe(5);
    expect(seen.inFile).toBe(7);
  });

  it("[sma:k_c_listassume] the phase's assumptions are listed with their evidence and confidence before planning, and nothing is written or asked", async () => {
    const seen = await observeF.k_c_listassume();
    expect(seen.path).toBe("assumptions goal_check done");
    expect(seen.out).toEqual({ status: "done", assumptions: [{ statement: "users table exists", evidence: "db.ts:4", confidence: 80 }, { statement: "tokens expire in a day", evidence: "none", confidence: 30 }] });
    expect(seen.asked).toBe(1);
    expect(seen.writes).toBe(0);
  });

  it("[sma:k_c_spec] the spec is scored for ambiguity: above 0.2 a person answers (three scores at most), at 0.2 or below SPEC.md is written; a spec written under doubt ends low_confidence", async () => {
    const seen = await observeF.k_c_spec();
    expect(seen.asked).toEqual(["score ask score spec done", { status: "done", spec_path: ".agents/phases/ph_a/SPEC.md", ambiguity: 0.15 }]);
    expect(seen.clear).toBe("score spec done");
    expect(seen.edge).toEqual(["score spec done", "done"]);
    expect(seen.doubt).toEqual(["score ask score ask score spec low_confidence", { status: "low_confidence", spec_path: ".agents/phases/ph_a/SPEC.md", ambiguity: 0.6 }]);
    expect(seen.role).toBe("planner");
  });

  it("[sma:k_c_uiphase] the drawing and its checker go round until the checker passes; the result names the contract paths, feasibility, the contradiction and the last verdict", async () => {
    const seen = await observeF.k_c_uiphase();
    const paths = [".agents/phases/ph_a/design/UI-SPEC.md", ".agents/phases/ph_a/design/stats.html"];
    expect(seen.loop).toEqual(["draw check draw check done", { paths, feasible: true, contradiction: "", verdict: "pass", scores: { hierarchy: 4 }, notes: "states drawn" }]);
    expect(seen.draws).toBe(2);
    expect(seen.once).toEqual(["draw check done", { paths, feasible: true, contradiction: "", verdict: "pass", scores: { hierarchy: 5 }, notes: "ok" }]);
    expect(seen.role).toBe("plan-critic");
  });

  it("[sma:k_c_aiphase] four roles write the AI-SPEC in order and a check gate stands before done: gaps send the spec back once, a spec still short is blocked", async () => {
    const seen = await observeF.k_c_aiphase();
    expect(seen.clean).toEqual(["select research eval_plan spec check done", { status: "done", framework: "langchain", spec_path: "x/AI-SPEC.md" }]);
    expect(seen.rework).toEqual(["select research eval_plan spec check spec check done", "done", 2]);
    expect(seen.blocked).toEqual(["select research eval_plan spec check spec check blocked", { status: "blocked", framework: "langchain", spec_path: "x/AI-SPEC.md" }]);
    expect(seen.roles).toEqual(["analyst", "specialist:tavily", "planner", "planner", "auditor"]);
  });

  it("[sma:k_c_mvp] a story names who, what and why with an MVP cut; the splitting check sends a story that is not vertical back once and a second rework goes on to planning", async () => {
    const seen = await observeF.k_c_mvp();
    expect(seen.once).toEqual(["story split_check story split_check goal_check done", { status: "done", who: "the owner", what: "sees the stats", why: "to decide", slice: "one report page", outOfScope: ["pdf"], goal: "export stats" }]);
    expect(seen.clean).toBe("story split_check goal_check done");
    expect(seen.stuck).toEqual(["story split_check story split_check goal_check done", 2]);
  });
});
