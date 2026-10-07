import { describe, expect, it } from "vitest";
import { finding, firstInput, modeOf, out, pathOf, task } from "./chain-helpers";
import { runSim } from "./chain-harness";

/** Built-in chains that start from an idea or a spec: grill-driven, brainstorm-driven, roadmap-driven, blueprint-driven, impeccable-build. */

describe("grill-driven", () => {
  const input = { goal: "Move sessions from SQLite to Postgres", plan_text: "1) dual-write 2) backfill 3) switch reads", quality_mode: "full" };
  const grilled = { open: ["backfill window"], locked: ["dual-write first"], deferred: [], risk_register: [{ risk: "lock contention" }] };
  const base = () => ({ "grill-plan": grilled, "lp.brainstorm": { status: "ok" }, "lp.plan": { status: "ok", tasks: [task("g1")] }, "lp.build": { status: "done", merged_commits: ["g1"] }, "lp.close": { status: "closed" } });

  it("the spec's case: grill, the owner answers the open question, brainstorm, plan, build, close", async () => {
    const r = await runSim("grill-driven", { input, stubs: base(), humans: { ask_open: { answer_kind: "answered", answer: "weekends" } } });
    expect(pathOf(r)).toBe("grill ask_open brainstorm plan build close done");
    expect(out(r)).toMatchObject({ status: "done", locked: ["dual-write first"], risk_register: [{ risk: "lock contention" }], merged_commits: ["g1"] });
    // The depth of the interrogation and the brainstorm roles follow the quality mode; the brainstorm gets the grill report.
    expect(firstInput(r, "grill")).toMatchObject({ depth: "deep", plan: input.plan_text });
    expect(firstInput(r, "brainstorm").roles).toHaveLength(5);
    expect(firstInput(r, "brainstorm").upstream).toMatchObject({ locked: ["dual-write first"] });
  });

  it("nothing open: the owner is not asked; standard and quick use fewer roles", async () => {
    const standard = await runSim("grill-driven", { input: { ...input, quality_mode: "standard" }, stubs: { ...base(), "grill-plan": { ...grilled, open: [] } } });
    expect(standard.skipped).toEqual(["ask_open"]);
    expect(firstInput(standard, "grill").depth).toBe("standard");
    expect(firstInput(standard, "brainstorm").roles).toEqual(["product-manager", "system-architect", "test-strategist"]);
    const quick = await runSim("grill-driven", { input: { ...input, quality_mode: "quick" }, stubs: base() });
    expect(firstInput(quick, "grill").depth).toBe("shallow");
    expect(firstInput(quick, "brainstorm").roles).toEqual(["product-manager", "system-architect"]);
  });

  it("an owner who aborts, or a brainstorm that fails, blocks with the grill result kept", async () => {
    const abort = await runSim("grill-driven", { input, stubs: base(), humans: { ask_open: { answer_kind: "abort" } } });
    expect(pathOf(abort)).toBe("grill ask_open blocked");
    expect(out(abort)).toMatchObject({ status: "blocked", locked: ["dual-write first"] });
    expect(pathOf(await runSim("grill-driven", { input, stubs: { ...base(), "lp.brainstorm": { status: "failed" } } }))).toBe("grill ask_open brainstorm blocked");
  });

  it("a partly failed build replans once and builds again; a second partial result is partial", async () => {
    const r = await runSim("grill-driven", { input, stubs: { ...base(), "lp.build": [{ status: "partial", merged_commits: ["g1"], failed_findings: [finding("high")] }, { status: "done", merged_commits: ["g2"] }], replan: { status: "ok", tasks: [task("g2")] } } });
    expect(pathOf(r)).toBe("grill ask_open brainstorm plan build replan build close done");
    expect(firstInput(r, "replan")).toMatchObject({ mode: "gaps", gaps: [expect.objectContaining({ severity: "high" })] });
    const again = await runSim("grill-driven", { input, stubs: { ...base(), "lp.build": { status: "partial", merged_commits: ["g1"] }, replan: { status: "ok" } } });
    expect(pathOf(again)).toBe("grill ask_open brainstorm plan build replan build partial");
  });
});

describe("brainstorm-driven", () => {
  const input = { goal: "Reminders service: users get a push before a booking", research: false, quality_mode: "standard" };
  const base = () => ({ "lp.brainstorm": { status: "ok", guidance: "G", features: [{ id: "F-001" }, { id: "F-002" }] }, "lp.plan": { status: "ok", tasks: [task("b1")] }, "lp.build": { status: "done", merged_commits: ["b1"] }, "lp.close": { status: "closed" } });

  it("the spec's case: research skipped, brainstorm, plan, build, close", async () => {
    const r = await runSim("brainstorm-driven", { input, stubs: base() });
    expect(pathOf(r)).toBe("research brainstorm plan build close done");
    expect(r.skipped).toEqual(["research"]);
    expect(out(r)).toMatchObject({ status: "done", guidance: "G", features: [{ id: "F-001" }, { id: "F-002" }], merged_commits: ["b1"] });
    expect(firstInput(r, "brainstorm").roles).toEqual(["product-manager", "system-architect", "ux-expert"]);
  });

  it("with research the tavily specialist runs first and its report goes into the brainstorm", async () => {
    const r = await runSim("brainstorm-driven", { input: { ...input, research: true }, stubs: { ...base(), research: { report: "market facts", sources: [{ url: "https://a.example" }] } } });
    expect(r.skipped).toEqual([]);
    expect(firstInput(r, "brainstorm")).toMatchObject({ research: "market facts" });
  });

  it("a failed brainstorm is blocked; a partial build replans once", async () => {
    expect(pathOf(await runSim("brainstorm-driven", { input, stubs: { ...base(), "lp.brainstorm": { status: "failed" } } }))).toBe("research brainstorm blocked");
    const r = await runSim("brainstorm-driven", { input, stubs: { ...base(), "lp.build": [{ status: "partial", merged_commits: ["b1"] }, { status: "done", merged_commits: ["b2"] }], replan: { status: "ok" } } });
    expect(pathOf(r)).toBe("research brainstorm plan build replan build close done");
  });
});

describe("roadmap-driven", () => {
  const input = { goal: "Account area", requirements: "Account area + billing: login, profile, plans, invoices", mode: "auto" };
  const sessions = [{ id: "s1", intent: "login and profile", depends_on: [] }, { id: "s2", intent: "plans and invoices", depends_on: ["s1"] }];
  const base = () => ({ roadmap: { sessions, session_count: 2, mode: "progressive", requirement_map: { R1: "s1", R2: "s2" } }, "analyze-plan-execute": { status: "done", merged_commits: ["x"] }, "lp.close": { status: "closed" }, "lp.analyze": { scope_verdict: "medium" } });

  it("the spec's case: roadmap, approval, one analyze-plan-execute run per session in dependency order, close", async () => {
    const r = await runSim("roadmap-driven", { input, stubs: base(), humans: { approve: { answer_kind: "approve" } } });
    expect(pathOf(r)).toBe("probe analyze roadmap validate approve sessions close done");
    expect(out(r)).toMatchObject({ status: "done", sessions_total: 2, sessions_done: ["s1", "s2"], sessions_blocked: [], roadmap_path: "roadmap.md" });
    // Each session starts its own run with its intent and the quality mode of the roadmap.
    expect(r.called("sessions:child").map((call) => call.input)).toEqual([expect.objectContaining({ goal: "login and profile", quality_mode: "standard" }), expect.objectContaining({ goal: "plans and invoices" })]);
    const starts = r.db.prepare("SELECT step_key, started_at, ended_at FROM lane_pilot_wf_step WHERE run_id=? AND node_id='sessions:child' ORDER BY rowid").all(r.summary.runId) as Array<{ started_at: number; ended_at: number }>;
    expect(starts[1]!.started_at).toBeGreaterThanOrEqual(starts[0]!.ended_at);
  });

  it("a roadmap that does not validate goes back to the planner up to 3 times, then is blocked", async () => {
    const bad = { ...base(), validate: { ok: false, errors: ["cycle"], cycles: ["s1>s2>s1"] } };
    const r = await runSim("roadmap-driven", { input, stubs: bad });
    expect(pathOf(r)).toBe("probe analyze roadmap validate roadmap validate roadmap validate blocked");
    expect(out(r)).toMatchObject({ status: "blocked" });
  });

  it("the owner can ask for changes (the planner revises in the same session) or abort", async () => {
    const modify = await runSim("roadmap-driven", { input, stubs: base(), humans: { approve: [{ answer_kind: "modify", answer: "merge s2 into s1" }, { answer_kind: "approve" }] } });
    expect(pathOf(modify)).toBe("probe analyze roadmap validate approve roadmap validate approve sessions close done");
    expect(pathOf(await runSim("roadmap-driven", { input, stubs: base(), humans: { approve: { answer_kind: "abort" } } }))).toBe("probe analyze roadmap validate approve blocked");
  });

  it("a session that does not finish blocks the sessions that depend on it, and the roadmap is partial", async () => {
    const stubs = () => ({ ...base(), "analyze-plan-execute": (ctx: { input: { with: Record<string, unknown> } }) => (ctx.input.with.goal === "login and profile" ? { status: "partial", merged_commits: [] } : { status: "done", merged_commits: ["y"] }) as never });
    const r = await runSim("roadmap-driven", { input, stubs: stubs() });
    // A session that ends partial is a result, not an engine failure: the dependent one still runs, and the roadmap is partial.
    expect(out(r)).toMatchObject({ status: "partial", sessions_done: ["s2"], sessions_blocked: ["s1"] });
  });

  it("a session whose run crashes blocks its dependents (on_child_fail) and the rest goes on", async () => {
    const crash = ((ctx: { input: { with: Record<string, unknown> } }) => { if (ctx.input.with.goal === "login and profile") throw new Error("session run died"); return { status: "done", merged_commits: ["y"] }; }) as never;
    const three = [...sessions, { id: "s3", intent: "reports", depends_on: [] }];
    const r = await runSim("roadmap-driven", { input, stubs: { ...base(), roadmap: { sessions: three, session_count: 3, requirement_map: {} }, "analyze-plan-execute": crash } });
    expect(r.summary.status).toBe("succeeded");
    expect(out(r)).toMatchObject({ status: "partial", sessions_done: ["s3"], sessions_blocked: ["s1", "s2"] });
  });

  it("no session finished: blocked", async () => {
    const r = await runSim("roadmap-driven", { input, stubs: { ...base(), "analyze-plan-execute": { status: "blocked", merged_commits: [] } } });
    expect(pathOf(r)).toBe("probe analyze roadmap validate approve sessions blocked");
  });
});

describe("blueprint-driven", () => {
  const input = { goal: "Integration hub", idea: "Integration hub: connectors for CRM and email with retry and audit log", depth: "light" };
  const base = () => ({ brief: { term_count: 6 }, prd: { has_moscow: true, req_count: 5 }, epics: { epic_count: 3, uncovered_reqs: [], epics: [{ id: "E1" }] }, commit_spec: { state: "accepted" },
    "lp.plan": { status: "ok", tasks: [task("p1")] }, "lp.build": { status: "done", merged_commits: ["p1"] }, "lp.close": { status: "closed" } });

  it("the spec's case: a failed readiness check sends the weak phase back once, then the spec is committed and built", async () => {
    const r = await runSim("blueprint-driven", { input, stubs: { ...base(), readiness: [{ score: 55, verdict: "fail", fix_phases: ["prd"] }, { score: 86, verdict: "pass" }] } });
    expect(pathOf(r)).toBe("discovery brief prd architecture epics readiness autofix readiness commit_spec plan build close done");
    expect(out(r)).toMatchObject({ status: "done", readiness_score: 86, epics: [{ id: "E1" }], merged_commits: ["p1"] });
  });

  it("thin terms or a missing MoSCoW table send the phase back once in the same session", async () => {
    const r = await runSim("blueprint-driven", { input, stubs: { ...base(), brief: [{ term_count: 2 }, { term_count: 6 }], prd: [{ has_moscow: false }, { has_moscow: true }], readiness: { score: 90, verdict: "pass" } } });
    expect(pathOf(r)).toBe("discovery brief brief prd prd architecture epics readiness commit_spec plan build close done");
  });

  it("a borderline readiness asks the owner: go, fix once, or stop", async () => {
    const stubs = () => ({ ...base(), readiness: { score: 74, verdict: "review" } });
    expect(pathOf(await runSim("blueprint-driven", { input, stubs: stubs(), humans: { ack: { answer_kind: "go" } } }))).toBe("discovery brief prd architecture epics readiness ack commit_spec plan build close done");
    expect(pathOf(await runSim("blueprint-driven", { input, stubs: stubs(), humans: { ack: [{ answer_kind: "fix" }, { answer_kind: "abort" }] } }))).toBe("discovery brief prd architecture epics readiness ack autofix readiness blocked");
  });

  it("a spec that keeps failing is blocked after two repairs", async () => {
    const r = await runSim("blueprint-driven", { input, stubs: { ...base(), readiness: { score: 40, verdict: "fail" } } });
    expect(pathOf(r)).toBe("discovery brief prd architecture epics readiness autofix readiness autofix readiness blocked");
    expect(out(r)).toMatchObject({ status: "blocked", readiness_score: 40 });
  });

  it("a spec the code task could not commit is blocked; a plan or build that fails leaves it partial", async () => {
    const pass = { readiness: { score: 90, verdict: "pass" } };
    expect(pathOf(await runSim("blueprint-driven", { input, stubs: { ...base(), ...pass, commit_spec: { state: "failed" } } }))).toBe("discovery brief prd architecture epics readiness commit_spec blocked");
    expect(pathOf(await runSim("blueprint-driven", { input, stubs: { ...base(), ...pass, "lp.plan": { status: "failed" } } }))).toBe("discovery brief prd architecture epics readiness commit_spec plan partial");
    expect(pathOf(await runSim("blueprint-driven", { input, stubs: { ...base(), ...pass, "lp.build": { status: "partial", merged_commits: ["p1"] } } }))).toBe("discovery brief prd architecture epics readiness commit_spec plan build close partial");
  });
});

describe("impeccable-build", () => {
  const input = { goal: "Pricing page with three plans and a FAQ", quality_mode: "full" };
  const base = () => ({ brief: { open_questions: [], has_design_md: false }, pack: { token_count: 24, pack_path: "docs/DESIGN.md" }, "lp.plan": { status: "ok", has_ui: true, tasks: [task("u1")] }, "lp.build": { status: "done", merged_commits: ["u1"] },
    finish_review: { disposition: "ship", score: 33, p0_count: 0 }, document: { state: "accepted" }, "lp.close": { status: "closed" } });

  it("the spec's case: a browser check that fails sends the page back once, then review, DESIGN.md and close", async () => {
    const r = await runSim("impeccable-build", { input, stubs: { ...base(), qa: [{ status: "rework", findings: [finding("high", { file: "src/pricing.tsx", line: 55 })] }, { status: "pass" }] } });
    expect(pathOf(r)).toBe("brief ask_direction pack plan build qa fix_plan fix_build qa finish_review document close done");
    expect(out(r)).toMatchObject({ status: "done", disposition: "ship", design_score: 33, design_md: "docs/DESIGN.md" });
    expect(String((firstInput(r, "plan").extra_rules as string[]).join(" "))).toContain("vertical slices");
  });

  it("open design questions go to the owner before the pack is made", async () => {
    const r = await runSim("impeccable-build", { input, stubs: { ...base(), brief: { open_questions: ["dark theme?"] }, qa: { status: "pass" } }, humans: { ask_direction: { answer_kind: "answered", answer: "yes, dark" } } });
    expect(r.skipped).not.toContain("ask_direction");
  });

  it("the browser check runs in every mode; quick has no finishing review", async () => {
    const r = await runSim("impeccable-build", { input: { ...input, quality_mode: "quick" }, stubs: { ...base(), qa: { status: "pass" } } });
    expect(modeOf(r)).toBe("quick");
    expect(pathOf(r)).toBe("brief ask_direction pack plan build qa finish_review document close done");
    expect(r.skipped).toEqual(expect.arrayContaining(["finish_review"]));
    expect(r.called("qa")).toHaveLength(1);
  });

  it("a review that wants a fix sends the page back once; rebuild or recapture ends partial", async () => {
    const fix = await runSim("impeccable-build", { input, stubs: { ...base(), qa: { status: "pass" }, finish_review: [{ disposition: "fix", score: 20, findings: [finding("high")] }, { disposition: "ship", score: 31 }] } });
    expect(pathOf(fix)).toBe("brief ask_direction pack plan build qa finish_review fix_plan fix_build qa finish_review document close done");
    const rebuild = await runSim("impeccable-build", { input, stubs: { ...base(), qa: { status: "pass" }, finish_review: { disposition: "rebuild", score: 10 } } });
    expect(pathOf(rebuild)).toBe("brief ask_direction pack plan build qa finish_review partial");
    expect(out(rebuild)).toMatchObject({ status: "partial", disposition: "rebuild", design_score: 10 });
  });

  it("a build that merged nothing or a plan that failed is blocked", async () => {
    expect(pathOf(await runSim("impeccable-build", { input, stubs: { ...base(), "lp.plan": { status: "failed" } } }))).toBe("brief ask_direction pack plan blocked");
    expect(pathOf(await runSim("impeccable-build", { input, stubs: { ...base(), "lp.build": { status: "blocked", merged_commits: [] } } }))).toBe("brief ask_direction pack plan build blocked");
  });
});
