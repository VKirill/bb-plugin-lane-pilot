// Region 22 · The project planning folder, batch a: the phase documents (docs/sma-evidence.md). Pure functions of the phase stages: what each
// document is made from and what the stage reads before it starts. Each test checks the produced text / list / refusal, not a call.
import { describe, expect, it } from "vitest";
import type { PhaseRecord, PlanItem, TaskFact } from "../../src/rooms/phase/logic";
import { designGate } from "../../src/rooms/phase/logic/design";
import {
  ambiguityScore, conclusionText, coverageGaps, designPoints, markRoadmap, markUatLine, nextRoadmapRow, planText, roadmapNumberingGaps, specText, stageInit,
  templateFill, threatGap, uatState, uatText, uiContractGap, validationGaps,
} from "../../src/rooms/phase/stages";

const rec = (over: Partial<PhaseRecord> = {}): PhaseRecord => over as PhaseRecord;
const item = (id: string, wave: number, then: string, task: Record<string, unknown> = {}, covers?: string[]): PlanItem => ({
  id, title: `piece ${id}`, wave, promise: { given: "a sheet", when: "it is summed", then },
  task: { owns_paths: [`src/${id}.ts`], verification: [{ command: `npx vitest run tests/${id}.test.ts` }], ...task }, ...(covers ? { covers } : {}),
});
const phase = (record: Partial<PhaseRecord> = {}, stage: "discussion" | "planning" | "design" | "execution" | "verification" | "acceptance" | "lessons" = "planning") =>
  ({ id: "ph_a1", title: "Sums", goal: "sums skip empty cells", stage, record: rec(record) });
const FOLDER = ".agents/phases/ph_a1";

describe("[region 22] what each stage reads before it starts", () => {
  it("[sma:k_pl_reqs] the discussion starts from the roadmap and REQUIREMENTS.md; the plan must cover every requirement id the context names", () => {
    expect(stageInit(phase({}, "discussion"))).toEqual([".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md", `${FOLDER}/DISCUSSION.md`]);
    const record = rec({ context: { docs: [], sha: "s", signedAt: 1, requirements: ["R1", "R2"], decisions: ["D1"] }, plan: { items: [item("p1", 1, "x", {}, ["R1", "D1"])] } as never });
    expect(coverageGaps(record)).toEqual(["requirements no piece covers: R2 (name them in a piece's covers, or defer them in CONTEXT.md and sign again)"]);
    expect(coverageGaps(rec({ ...record, plan: { items: [item("p1", 1, "x", {}, ["R1", "R2", "D1"])] } as never }))).toEqual([]);
  });

  it("[sma:k_pl_disclog] the discussion log lives beside the phase's own folder: DISCUSSION.md of THIS phase, last in the discussion's reading list", () => {
    expect(stageInit(phase({}, "discussion")).at(-1)).toBe(`${FOLDER}/DISCUSSION.md`);
    expect(stageInit({ ...phase({}, "discussion"), id: "ph_zz9" }).at(-1)).toBe(".agents/phases/ph_zz9/DISCUSSION.md");
    // At the lessons stage the reading list is the book, not the discussion log.
    expect(stageInit(phase({}, "lessons"))).toEqual([`${FOLDER}/BOOK.md`]);
  });

  it("[sma:k_pl_context] the planner reads the signed context documents first, before SPEC, RESEARCH and PATTERNS", () => {
    const record = { context: { docs: [{ path: `${FOLDER}/CONTEXT.md`, sha256: "a", bytes: 1 }, { path: `${FOLDER}/DISCUSSION.md`, sha256: "b", bytes: 1 }], sha: "s", signedAt: 1 } };
    const reading = stageInit(phase(record, "planning"));
    expect(reading).toEqual([`${FOLDER}/CONTEXT.md`, `${FOLDER}/DISCUSSION.md`, `${FOLDER}/SPEC.md`, `${FOLDER}/RESEARCH.md`, `${FOLDER}/PATTERNS.md`]);
    expect(reading[0]).toBe(`${FOLDER}/CONTEXT.md`);
    // The designer reads the same context before PLAN.md and the shared DESIGN.md.
    expect(stageInit(phase(record, "design"))).toEqual([`${FOLDER}/CONTEXT.md`, `${FOLDER}/DISCUSSION.md`, `${FOLDER}/SPEC.md`, `${FOLDER}/PLAN.md`, "DESIGN.md"]);
  });

  it("[sma:k_pl_research] RESEARCH.md is read at planning, after the spec and before the patterns; a stage with no research step does not list it", () => {
    const planning = stageInit(phase({}, "planning"));
    expect(planning).toEqual([`${FOLDER}/SPEC.md`, `${FOLDER}/RESEARCH.md`, `${FOLDER}/PATTERNS.md`]);
    expect(planning.indexOf(`${FOLDER}/RESEARCH.md`)).toBe(planning.indexOf(`${FOLDER}/SPEC.md`) + 1);
    expect(stageInit(phase({}, "execution")).some((path) => path.endsWith("RESEARCH.md"))).toBe(false);
  });

  it("[sma:k_pl_patterns] PATTERNS.md (the closest code analogs) is the last thing the planner reads, in the phase's own folder", () => {
    expect(stageInit(phase({}, "planning")).at(-1)).toBe(`${FOLDER}/PATTERNS.md`);
    expect(stageInit({ ...phase({}, "planning"), id: "ph_zz9" }).at(-1)).toBe(".agents/phases/ph_zz9/PATTERNS.md");
    expect(stageInit(phase({}, "verification")).some((path) => path.endsWith("PATTERNS.md"))).toBe(false);
  });
});

describe("[region 22] the phase documents the machine writes", () => {
  const two = [item("p1", 1, "totals skip empty cells", { owns_paths: ["src/sum.ts", "src/cells.ts"] }, ["R1"]), item("p2", 2, "the footer shows the total", { verification: [] })];

  it("[sma:k_pl_plan] PLAN.md lists the waves, every piece's promise, owned paths, checks and coverage", () => {
    const text = planText({ ...phase({ plan: { items: two, objective: "empty cells", budget: "2 days" } as never }), id: "ph_a1" });
    expect(text.split("\n")).toEqual([
      "# Plan — phase ph_a1: Sums", "Goal: sums skip empty cells", "Objective: empty cells", "Budget: 2 days", "## Waves",
      "### Wave 1",
      "- p1: given a sheet; when it is summed; then totals skip empty cells",
      "  owns: src/sum.ts, src/cells.ts",
      "  checks: npx vitest run tests/p1.test.ts",
      "  covers: R1",
      "### Wave 2",
      "- p2: given a sheet; when it is summed; then the footer shows the total",
      "  owns: src/p2.ts",
      "  checks: —",
    ]);
  });

  it("[sma:k_pl_summary] SUMMARY.md names each piece with its task and state, the verdicts, the acceptance marks, the returns and the lessons", () => {
    const record = { plan: { items: two } as never, verification: { verdict: { state: "passed", detail: "all green" }, model: { state: "met", by: "auditor" } } as never,
      acceptance: { lines: [{ id: "uat", ok: true, detail: "" }, { id: "regression", ok: false, detail: "" }] } as never, lessons: { needed: true, why: "w", analysis: "check each promise" } as never };
    const facts = new Map<string, TaskFact>([["p1", { taskId: "t_1", state: "accepted" } as TaskFact]]);
    const text = conclusionText(phase(record), [{ kind: "return", text: "back to planning once" }, { kind: "note", text: "not a return" }], facts);
    expect(text.split("\n")).toEqual([
      "# Summary — phase ph_a1: Sums", "", "Goal: sums skip empty cells", "", "## What was built", "",
      "- p1 (task t_1, accepted): totals skip empty cells", "- p2 (task —, not issued): the footer shows the total", "",
      "## How it was verified", "", "- blind verdict: passed (all green)", "- goal audit: met by auditor", "- acceptance: ✓ uat, ✗ regression", "",
      "## Returns", "", "- back to planning once", "", "## Lessons", "", "check each promise", "",
    ]);
    expect(conclusionText(phase({}), [], new Map()).split("\n")).toContain("- none");
  });

  it("[sma:k_pl_verification] VERIFICATION.md gives each piece its latest check result, or «not issued»", () => {
    const facts = new Map<string, TaskFact>([["p1", { taskId: "t_1", state: "accepted", verification: "failed" } as TaskFact]]);
    const text = templateFill("VERIFICATION", phase({ plan: { items: two } as never }), facts);
    expect(text.split("\n")).toEqual([
      "# Verification — phase ph_a1: Sums", "", "Goal: sums skip empty cells", "",
      "- p1 (failed): `npx vitest run tests/p1.test.ts` — then totals skip empty cells",
      "- p2 (not issued): no checks — then the footer shows the total", "",
    ]);
    expect(templateFill("VERIFICATION", phase({ plan: { items: two } as never }), new Map([["p1", { taskId: "t", state: "accepted", verification: null } as unknown as TaskFact]])).split("\n")[4]).toContain("- p1 (accepted):");
  });

  it("[sma:k_pl_spec] SPEC.md carries the goal, requirements, locked decisions, appetite and no-gos; the ambiguity line appears only with the gate on", () => {
    const base = { context: { docs: [], sha: "s", signedAt: 1, requirements: ["R1"], decisions: ["D1", "D2"], appetite: "one day", noGos: ["no new screens"] } };
    const questions = [{ id: "q1", stage: "planning", text: "t", blocking: true, askedAt: 1 }, { id: "q2", stage: "planning", text: "t", blocking: true, askedAt: 1, answer: "yes" }, { id: "q3", stage: "planning", text: "t", blocking: false, askedAt: 1 }, { id: "q4", stage: "design", text: "t", blocking: true, askedAt: 1 }];
    const off = specText(phase({ ...base, questions } as never));
    expect(off.split("\n")).toEqual(["# Spec — phase ph_a1: Sums", "", "Goal: sums skip empty cells", "", "## Requirements", "- R1", "", "## Locked decisions", "- D1", "- D2", "", "## Appetite", "one day", "", "## No-gos", "- no new screens", ""]);
    // open planning blocking questions: 1 of (2 blocking + 2 decisions) = 0.25
    expect(ambiguityScore(rec({ ...base, questions } as never))).toBe(0.25);
    const on = specText(phase({ ...base, questions, ambiguityGate: true } as never));
    expect(on.split("\n").slice(3, 6)).toEqual(["", "Ambiguity: 0.25", ""]);
    expect(specText(phase({})).split("\n")).toContain("- none named");
  });

  it("[sma:k_pl_uat] UAT.md has one line per promise; an answer marks only its own line; the state counts passed, failed and open", () => {
    const record = { plan: { items: two } as never, uat: { lines: [{ n: 1, pieceId: "p1", state: "passed", note: "fine" }] } as never };
    const text = uatText(phase(record));
    expect(text.split("\n").filter((line) => line.startsWith("- ["))).toEqual([
      "- [x] 1. p1: given a sheet, when it is summed, then totals skip empty cells — fine",
      "- [ ] 2. p2: given a sheet, when it is summed, then the footer shows the total",
    ]);
    const marked = markUatLine(text, 2, false, "  footer  missing ")!;
    expect(marked.split("\n").filter((line) => line.startsWith("- [")).at(-1)).toBe("- [!] 2. p2: given a sheet, when it is summed, then the footer shows the total — footer missing");
    expect(marked.split("\n").filter((line) => line.startsWith("- [")).at(0)).toBe("- [x] 1. p1: given a sheet, when it is summed, then totals skip empty cells — fine");
    expect(markUatLine(text, 7, true)).toBeNull();
    const passed = markUatLine(text, 2, true)!;
    expect(uatState(passed)).toMatchObject({ lines: 2, passed: 2, failed: [], open: [] });
    expect(uatState(marked)).toMatchObject({ lines: 2, passed: 1 });
    expect(uatState(marked).failed).toHaveLength(1);
    expect(uatState(text).open).toHaveLength(1);
  });
});

describe("[region 22] the design, security and validation documents", () => {
  const drawn = (over: Record<string, unknown> = {}, requirements: string[] = []) => rec({ design: { decision: "needed", why: "w", requirements, drawing: { paths: [`${FOLDER}/design/UI-SPEC.md`], sha256: "h", designer: "design-lead", reviewer: "critic", feasible: true, ...over } } as never });

  it("[sma:k_pl_design] the design gate opens only for a reviewed, feasible drawing with a contract; a self-review, a contradiction or no drawing is refused with the reason", () => {
    expect(designGate(rec({ design: { decision: "not_needed", why: "no screens" } as never }))).toEqual({ ok: true });
    expect(designGate(rec({}))).toMatchObject({ ok: false, why: ["the design decision is not made"] });
    expect(designGate(drawn())).toEqual({ ok: true });
    expect(designGate(drawn({ reviewer: "design-lead" }))).toMatchObject({ ok: false, why: ["the reviewer of the drawing is its designer: it must be a separate role"] });
    expect(designGate(drawn({ reviewer: undefined }))).toMatchObject({ ok: false, why: ["the drawing is not reviewed by a separate role"] });
    expect(designGate(drawn({ feasible: false, contradiction: "needs a new table" }))).toMatchObject({ ok: false, why: ["the drawing contradicts the plan: needs a new table — return the phase to planning"] });
    expect(designGate(drawn({ paths: [] }))).toMatchObject({ ok: false });
  });

  it("[sma:k_pl_uispec] the drawing needs UI-SPEC.md among its paths and one heading per required section; its checklist items become the contract points", () => {
    expect(uiContractGap(drawn({ paths: [`${FOLDER}/design/home.html`] }))).toBe("the drawing has no contract: add UI-SPEC.md with the checkable points (screens, states, breakpoints) to the drawing's paths");
    const complete = "# UI\n## Actions\n## Screens and states\n## Texts\n## Heuristics\n## Accessibility\n";
    expect(uiContractGap(drawn({}, ["actions", "screens_states", "texts", "heuristics", "accessibility"]), complete)).toBeNull();
    expect(uiContractGap(drawn({}, ["actions", "accessibility"]), "# UI\n## Actions\n")).toBe("the drawing's contract misses required section(s): accessibility — UI-SPEC.md needs one heading per required section");
    expect(uiContractGap(rec({ design: { decision: "not_needed", why: "w" } as never }))).toBeNull();
    const points = designPoints("# UI-SPEC\n- [ ] the empty state shows a hint\n- [x] the total is bold\n- a plain bullet is prose\n- [ ] the empty state shows a hint\n");
    expect(points.total).toBe(2);
    expect(points.points.map((point) => point.text)).toEqual(["the empty state shows a hint", "the total is bold"]);
    expect(points.points[0]!.id).toMatch(/^design_[0-9a-f]{8}$/);
  });

  it("[sma:k_pl_security] a security risk other than «none» needs SECURITY.md among the signed documents; «none» in either language needs nothing", () => {
    const withRisk = (security: string | undefined, docs: string[] = []) => rec({ context: { docs: docs.map((path) => ({ path, sha256: "a", bytes: 1 })), sha: "s", signedAt: 1, ...(security === undefined ? {} : { risks: { security } }) } });
    expect(threatGap(withRisk("none"))).toBeNull();
    expect(threatGap(withRisk("Нет"))).toBeNull();
    expect(threatGap(withRisk(undefined))).toBeNull();
    expect(threatGap(withRisk("  "))).toBeNull();
    expect(threatGap(withRisk("token leaks into the log"))).toBe("the security risk «token leaks into the log» needs a threat model: write the phase's SECURITY.md (lane-plan template fill SECURITY --phase …) and sign it with the context");
    expect(threatGap(withRisk("token leaks into the log", [`${FOLDER}/SECURITY.md`]))).toBeNull();
    expect(threatGap(withRisk("nothing but a leak", []))).not.toBeNull();
  });

  it("[sma:k_pl_validation] a piece whose every check only tests that a file exists proves nothing; one clause that reads the file is enough; visible work owes a live check", () => {
    const only = item("p1", 1, "x", { verification: [{ command: "test -f src/a.ts" }, { command: "ls src" }] });
    const reads = item("p2", 1, "x", { verification: [{ command: "test -f a.md && test \"$(head -n 1 a.md)\" = '# a'" }] });
    const real = item("p3", 1, "x", { verification: [{ command: "npx vitest run tests/a.test.ts" }] });
    expect(validationGaps([only, reads, real])).toEqual(["p1: every check only tests that a file exists — add one that would fail without the work (VALIDATION.md)"]);
    const screen = item("p4", 1, "x", { owns_paths: ["src/ui/home.tsx"] });
    expect(validationGaps([screen])).toEqual([]);
    expect(validationGaps([screen], false)).toEqual(["p4: visible work owes a live check — name qa_cases and a qa_url to run them on (this project has browser_qa.enabled on; switch it off for work no browser can check)"]);
    expect(validationGaps([{ ...screen, task: { ...screen.task, qa_cases: ["opens"], qa_url: "http://localhost:3000" } }], false)).toEqual([]);
  });
});

describe("[region 22] the roadmap", () => {
  const ROADMAP = ["# Roadmap", "", "## Milestone one", "", "- [x] 1 Setup — base", "- [ ] 2 Sums — skip empty cells", "- [ ] 3 Footer", "", "## Backlog", "", "- [ ] 999.1 Someday", ""].join("\n");

  it("[sma:k_pl_roadmap] closing a phase ticks only its own row; the next phase is the first open row and never a parked 999.N one; skipped numbers are named", () => {
    const closed = markRoadmap(ROADMAP, "2");
    expect(closed.split("\n").filter((line) => line.startsWith("- ["))).toEqual(["- [x] 1 Setup — base", "- [x] 2 Sums — skip empty cells", "- [ ] 3 Footer", "- [ ] 999.1 Someday"]);
    expect(markRoadmap(ROADMAP, "9")).toBe(ROADMAP);
    expect(nextRoadmapRow(closed)).toEqual({ n: "3", name: "Footer", goal: "" });
    expect(nextRoadmapRow(markRoadmap(closed, "3"))).toBeNull();
    expect(roadmapNumberingGaps("- [ ] 1 a\n- [ ] 3 b\n- [ ] 3 c\n")).toEqual(["skipped roadmap row(s) between 1 and 3", "duplicate roadmap row 3"]);
  });
});
