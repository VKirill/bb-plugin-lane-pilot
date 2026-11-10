import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  acceptanceLines, planGate, planSignature,
  type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";
import {
  ANIMATOR_LAW, ambiguityScore, designPoints, markUatLine, nextRoadmapRow, parkRoadmapRow,
  roadmapAnalysis, roadmapSection, specText, stateText, parseState, templateFill, planText,
  threatClosureGaps, uatText, motionRows, piecePlan,
} from "../../src/rooms/phase/stages";
import { laneSessionOverlayPrompt } from "../../src/rooms/native-agent/native-agent-overlay";
import { createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import { sha256Hex } from "@lane-pilot/kit";

const phase = (record: PhaseRecord, stage: Phase["stage"] = "planning", over: Partial<Phase> = {}): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0, ...over,
});
const item = (id: string, over: Partial<PlanItem> = {}): PlanItem => ({
  id, title: id, wave: 1, promise: { given: "g", when: "w", then: `then-${id}` },
  task: { id, project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: [`acc-${id}`] }, ...over,
});
const fact = (taskId: string, over: Partial<TaskFact> = {}): TaskFact => ({ taskId, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "passed", qaPlanned: true, ...over });
const SHA = "a".repeat(64);
const ctxReady = () => ({ docs: [], sha: "ctx", signedAt: 1, legacy: true });
const planRec = (items: PlanItem[], over: Partial<NonNullable<PhaseRecord["plan"]>> = {}): NonNullable<PhaseRecord["plan"]> => ({
  items, contextSha: "ctx", sha: planSignature(items, "ctx"), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } },
  objective: "o", premortem: ["a", "b", "c"], ...over });

function driver() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const writes: Array<{ path: string; content: string }> = [];
  const commits: Array<{ paths: string[]; message: string }> = [];
  const hostCalls: string[] = [];
  const texts = new Map<string, string>();
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    hostCalls.push(method);
    if (method === "writePhaseBook") return { status: "applied", writes: (input.edits as Array<{ path: string; content: string }>).map((edit) => { writes.push(edit); texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    if (method === "gitCommitDocs") { commits.push({ paths: input.paths as string[], message: input.message as string }); return { commit: "c".repeat(40) }; }
    if (method === "runCommand") return { exitCode: 0, stdout: `${SHA}\n`, stderr: "" };
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo' WHERE id='run1'").run();
  const phases = createPhaseDriver(createCore(bb, db), {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { if (texts.has(i.path)) { const c = texts.get(i.path)!; return { content: c, sha256: sha256Hex(c), sizeBytes: c.length }; } throw new Error("no file"); },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services).phases;
  return { phases, db, writes, commits, hostCalls, texts };
}

const openLegacy = (d: ReturnType<typeof driver>, record: Partial<PhaseRecord> = {}) => {
  insertPhase(d.db, { id: "ph_sma", projectId: "projA", pmThreadId: "t", title: "Sum", goal: "sums", runId: "run1", at: 1 });
  savePhase(d.db, "ph_sma", { stage: "planning", record: { context: ctxReady(), ...record }, at: 1 });
  return "ph_sma";
};

describe("parity d5-phase-2", () => {
  it("[sma:d_phase_uat] markUatLine turns line 2 of a UAT.md into [x] or [!] with a note, leaves the other lines byte-equal, and refuses a number outside the lines; uat_line writes it through writeDocs", async () => {
    const p = phase({ plan: planRec([item("a"), item("b")]), uat: { path: ".agents/phases/ph_sma/UAT.md", sha256: "x", at: 0, lines: [{ n: 1, pieceId: "a", state: "open" }, { n: 2, pieceId: "b", state: "open" }] } });
    const text = uatText(p);
    const marked = markUatLine(text, 2, false, "crashes")!;
    const rows = marked.split("\n");
    const before = text.split("\n");
    expect(rows.length).toBe(before.length);
    expect(rows.filter((row, i) => row !== before[i])).toHaveLength(1);
    expect(marked).toContain("- [!] 2. b:");
    expect(marked).toContain("— crashes");
    expect(markUatLine(text, 9, true)).toBeNull();
    expect(markUatLine(text, 1, true)).toContain("- [x] 1. a:");
    const d = driver();
    const id = openLegacy(d, { uat: { path: ".agents/phases/ph_sma/UAT.md", sha256: "s", at: 0, lines: [{ n: 1, pieceId: "a", state: "open" }] } });
    d.texts.set(".agents/phases/ph_sma/UAT.md", "- [ ] 1. a: given g\n");
    await d.phases.uatLine({ phaseId: id, line: 1, result: "fail", note: "bad", by: "owner" });
    expect(d.writes.some((w) => w.path === ".agents/phases/ph_sma/UAT.md" && w.content.includes("- [!] 1. a: given g — bad"))).toBe(true);
  });

  it("[sma:k_we_animator_inline] a motion piece's plan carries the animator law and a plain piece's does not", () => {
    const motion = item("m", { promise: { given: "g", when: "w", then: "the card fades in with a 200 ms transition" } });
    const plain = item("t", { promise: { given: "g", when: "w", then: "fix the typo" } });
    expect(piecePlan(phase({}), motion)).toContain(ANIMATOR_LAW);
    expect(piecePlan(phase({}), plain)).not.toContain(ANIMATOR_LAW);
    expect(motionRows([motion, plain])).toEqual(["m"]);
  });

  it("[sma:k_c_backlog] an item goes into the roadmap's parking lot under the next 999.N, and the machine never opens 999.* by itself", () => {
    const roadmap = "# Roadmap\n\n- [ ] 1.2 A — ga\n- [x] 1.1 B\n\n## Backlog\n\n- [ ] 999.2 old — g\n";
    const parked = parkRoadmapRow(roadmap, "new idea", "goal");
    expect(parked.n).toBe("999.3");
    expect(parked.text).toContain("- [ ] 999.3 new idea — goal");
    const fresh = parkRoadmapRow("# Roadmap\n\n- [ ] 1.1 A — g\n", "x", "");
    expect(fresh.n).toBe("999.1");
    expect(fresh.text).toContain("## Backlog");
    expect(nextRoadmapRow(roadmap)).toMatchObject({ n: "1.2" });
    expect(nextRoadmapRow("# R\n\n## Backlog\n\n- [ ] 999.1 only — g\n")).toBeNull();
  });

  it("[sma:k_wv_design] every contract point is an acceptance line: three checkable points, two judged met, one not; a phase without a drawing has none", () => {
    const spec = "# UI-SPEC\n\n## Screens\n\n- [ ] Play button opens the lobby\n- settings tab lists audio\n\n## Texts\n\n- error text names the fix\n";
    const points = designPoints(spec);
    expect(points).toHaveLength(3);
    expect(points.every((point) => point.id.startsWith("design_"))).toBe(true);
    const judged = points.map((point, i) => ({ ...point, met: i < 2, evidence: i < 2 ? "seen" : undefined }));
    const p = phase({ plan: planRec([item("a")]), verification: { points: judged, verdict: { state: "passed", detail: "ok", mainSha: null, at: 0, inputSha: "i" }, model: { state: "met", by: "m", summary: "s", at: 0 } }, acceptance: undefined, ownerWords: false });
    const lines = acceptanceLines(p, new Map([["a", fact("a")]]), { mainSha: null, openDeferrals: 0, book: undefined });
    const extra = lines.filter((line) => line.id.startsWith("design_"));
    expect(extra).toHaveLength(3);
    expect(extra.filter((line) => line.ok)).toHaveLength(2);
    expect(lines.findIndex((line) => line.id === "result_useful")).toBeLessThan(lines.findIndex((line) => line.id.startsWith("design_")));
    expect(acceptanceLines(phase({ plan: planRec([item("a")]) }), new Map([["a", fact("a")]]), { mainSha: null, openDeferrals: 0 }).filter((line) => line.id.startsWith("design_"))).toHaveLength(0);
  });

  it("[sma:k_wp_commit] an admitted plan writes PLAN.md and commits it; with phase.commit_docs off the file is written and gitCommitDocs is not called", async () => {
    const d = driver();
    const id = openLegacy(d, { plan: planRec([item("p1")]), ownerWords: true });
    await d.phases.word({ phaseId: id, turn: "planning", decision: "yes", text: "yes", by: "owner via screen" });
    const planWrite = d.writes.find((w) => w.path.endsWith("/PLAN.md"));
    expect(planWrite?.content).toContain("p1");
    expect(planWrite?.content).toContain("then-p1");
    expect(d.commits.some((c) => c.paths.some((p) => p.endsWith("/PLAN.md")))).toBe(true);
    const d2 = driver();
    const id2 = openLegacy(d2, { plan: planRec([item("p1")]), ownerWords: true, commitDocs: false });
    await d2.phases.word({ phaseId: id2, turn: "planning", decision: "yes", text: "yes", by: "owner via screen" });
    expect(d2.writes.some((w) => w.path.endsWith("/PLAN.md"))).toBe(true);
    expect(d2.commits).toHaveLength(0);
  });

  it("[sma:k_t_roadmap] roadmapAnalysis flags a ticked row with no SUMMARY.md and a phase folder with no row, and roadmapSection returns only the requested row's block", () => {
    const roadmap = "- [x] 1.1 Done — g\n  - note a\n  - note b\n- [ ] 1.2 Open — g\n- [ ] 2.1 Later — g\n";
    expect(roadmapSection(roadmap, "1.1")).toBe("- [x] 1.1 Done — g\n  - note a\n  - note b");
    expect(roadmapSection(roadmap, "9.9")).toBeNull();
    const a = roadmapAnalysis(roadmap, [
      { id: "ph_a", row: "1.1", hasSummary: false },
      { id: "ph_b", row: "1.2", hasSummary: true },
      { id: "ph_c", hasSummary: false },
    ]);
    expect(a.tickedWithoutSummary[0]).toContain("ph_a");
    expect(a.foldersWithoutRow).toEqual(["ph_c"]);
    expect(a.next?.n).toBe("1.2");
  });

  it("[sma:k_t_template] templateFill PLAN names every piece with its wave and promise, and VERIFICATION marks a piece whose latest fact failed", () => {
    const items = [item("p1"), item("p2", { wave: 2 })];
    const p = phase({ plan: planRec(items) });
    const plan = templateFill("PLAN", p, new Map());
    expect(plan).toContain("Wave 2");
    expect(plan).toContain("then-p2");
    expect(planText(p)).toContain("p1");
    const ver = templateFill("VERIFICATION", p, new Map([["p1", fact("p1")], ["p2", fact("p2", { verification: "failed" })]]));
    expect(ver).toContain("p2 (failed)");
    expect(ver).toContain("`npm test`");
  });

  it("[sma:k_pl_security] a SECURITY.md row citing a missing line keeps verification from passing, and the same row citing a real line lets it pass", () => {
    const doc = "# Threat model\n\n## Threats\n\n- token leak — mitigated by redact: src/secret.ts:42\n- injection — mitigated: src/safe.ts:10\n";
    const gaps = threatClosureGaps(doc, (path, line) => path === "src/safe.ts" && line <= 20);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("src/secret.ts:42");
    expect(threatClosureGaps(doc, () => true)).toHaveLength(0);
    expect(threatClosureGaps("# Threat model\n\n## Threats\n\n- undocumented threat\n", () => true)[0]).toContain("file:line");
  });

  it("[sma:k_ag_animator] ANIMATOR_LAW and the animator session text both say an action the person repeats often gets no animation", () => {
    for (const words of ["typing", "row hover", "list moves"]) expect(ANIMATOR_LAW).toContain(words);
    expect(ANIMATOR_LAW).toContain("not animated");
    const overlay = laneSessionOverlayPrompt("animator")!;
    expect(overlay).toContain("performs many times in a session");
    expect(overlay).toContain("not animated");
  });

  it("[sma:k_pl_state] after a move to planning STATE.md carries stage planning, the context decisions and one blocker line per open owner item, and text outside the managed sections survives", async () => {
    const d = driver();
    d.texts.set(".agents/planning/STATE.md", "# State\n\n## Position\n\nold\n\n## Custom\n\nkeep me\n");
    d.texts.set(".agents/phases/ph_sma/CONTEXT.md", "ctx body");
    const id = openLegacy(d);
    savePhase(d.db, id, { stage: "discussion", at: 1, record: { context: undefined, questions: [{ id: "q1", stage: "discussion", text: "which cache", blocking: true, askedAt: 0 }] } });
    await d.phases.context({ phaseId: id, docs: [".agents/phases/ph_sma/CONTEXT.md"], risks: { value: "v", usability: "u", feasibility: "f", viability: "vi" }, appetite: "a", noGos: ["none"], decisions: ["D1"], requirements: ["R1"], by: "pm" });
    await d.phases.stateDone();
    const state = d.texts.get(".agents/planning/STATE.md")!;
    expect(state).toContain('stage: "planning"');
    expect(state).toContain("locked D1");
    expect(state).toContain("question q1: which cache");
    expect(state).toContain("keep me");
    const parsed = parseState(state);
    expect(parsed.marks.stage).toBe("planning");
    expect(parsed.sections.Decisions).toContain("locked D1");
  });

  it("[sma:k_t_state] state --decision and --blocker append one line each to STATE.md without touching other sections, and a plain state prints position, decisions, blockers and session lines", async () => {
    const d = driver();
    d.texts.set(".agents/planning/STATE.md", stateText(null, { phase: "1.1", stage: "execution" }, { Position: ["phase 1.1"], Decisions: ["locked D1"], Blockers: ["b0"], Session: ["pm t"] }));
    const id = openLegacy(d);
    const read = await d.phases.state({ phaseId: id });
    expect(read.sections.Position).toContain("phase 1.1");
    expect(read.sections.Decisions).toContain("locked D1");
    expect(read.sections.Blockers).toContain("b0");
    expect(read.sections.Session).toContain("pm t");
    const edited = await d.phases.state({ phaseId: id, decision: "locked D2", blocker: "waits on api" });
    expect(edited.sections.Decisions).toEqual(["locked D1", "locked D2"]);
    expect(edited.sections.Blockers).toEqual(["b0", "waits on api"]);
    expect(edited.sections.Session).toEqual(["pm t"]);
    expect(edited.marks.phase).toBe("1.1");
  });

  it("[sma:k_d_tpl_predictions] a piece with forecast files 3, first try and risk high gives a plan with its Predictions and Risk lines; a piece without forecast prints no Predictions line", () => {
    const withF = item("f", { task: { ...item("f").task, forecast: { files: 3, checks_pass_first_try: true }, risk: "high" } });
    const plan = piecePlan(phase({}), withF);
    expect(plan).toContain("Predictions: files 3, first try");
    expect(plan).toContain("Risk: high");
    expect(piecePlan(phase({}), item("n"))).not.toContain("Predictions:");
  });

  it("[sma:k_pl_spec] a context with 3 open questions and 1 locked decision scores 0.75, SPEC.md carries that score, and answering all questions scores 0", () => {
    const q = (n: number, answered = false) => ({ id: `q${n}`, stage: "discussion" as const, text: `q${n}`, blocking: false, askedAt: 0, ...(answered ? { answer: "a" } : {}) });
    const record: PhaseRecord = { context: { ...ctxReady(), decisions: ["D1"], requirements: ["R1"], appetite: "a", noGos: ["none"] }, questions: [q(1), q(2), q(3)] };
    expect(ambiguityScore(record)).toBe(0.75);
    const text = specText(phase(record));
    expect(text).toContain("Ambiguity: 0.75");
    expect(text).toContain("R1");
    expect(ambiguityScore({ ...record, questions: [q(1, true), q(2, true), q(3, true)] })).toBe(0);
  });

  it("[sma:k_pl_spec] the plan gate refuses above 0.5 until the questions are answered", () => {
    const record: PhaseRecord = { context: ctxReady(), questions: [
      { id: "q1", stage: "discussion", text: "a", blocking: false, askedAt: 0 },
      { id: "q2", stage: "discussion", text: "b", blocking: false, askedAt: 0 },
      { id: "q3", stage: "discussion", text: "c", blocking: false, askedAt: 0 },
    ], plan: planRec([item("p1")]) };
    const check = planGate(record);
    expect(check.ok).toBe(false);
    expect((check as { why: string[] }).why.some((w) => w.includes("ambiguity"))).toBe(true);
  });

  it("[sma:k_c_import] plan-import chains grill-plan, an owner resolve (skipped with no conflicts), a planner that emits pieces, and the conflicts", async () => {
    const wf = (await import("../../workflows/plan-import.json")).default;
    expect(wf.id).toBe("plan-import");
    const nodes = wf.nodes.map((n: { id: string }) => n.id);
    expect(nodes).toEqual(["grill", "resolve", "pieces", "emit"]);
    expect(wf.nodes[0]).toMatchObject({ type: "subworkflow", workflow: "grill-plan" });
    expect(wf.nodes[1]).toMatchObject({ type: "human", skip_when: "grill.open.length == 0 && grill.risk_register.length == 0" });
    expect(wf.nodes[2].prompt ?? "").toContain("lane_pilot_phase");
    expect((wf.nodes[3].map as Record<string,string>)?.pieces).toBe("{{pieces.pieces}}");
  });

  it("[sma:k_wp_state] issuing wave 2 of a phase with an existing STATE.md writes header keys phase, stage execution and wave 2 and keeps the body", async () => {
    const d = driver();
    d.texts.set(".agents/planning/STATE.md", "# State\n\nbody line\n");
    const items = [item("p2", { wave: 2 })];
    const id = openLegacy(d, {
      plan: { ...planRec(items), admittedSha: planSignature(items, "ctx"), admittedAt: 0 },
      execution: { issued: {}, issuedSha: {} },
      waveReview: false, ownerWords: false,
    });
    const { getPhase } = await import("../../src/rooms/phase/store");
    savePhase(d.db, id, { stage: "execution", at: 1 });
    await d.phases.drive(getPhase(d.db, id)!);
    const state = d.texts.get(".agents/planning/STATE.md")!;
    expect(state).toContain('stage: "execution"');
    expect(state).toContain('wave: "2"');
    expect(state).toContain('planned: "true"');
    expect(state).toContain("body line");
  });
});
