import { describe, expect, it } from "vitest";
import { firstInput, modeOf, out, pathOf, task } from "./chain-helpers";
import { runSim } from "./chain-harness";

/** debug, companion and milestone-close. */

describe("debug", () => {
  const symptom = "CSV import crashes with 'Cannot read properties of undefined (reading split)' on files with an empty last line; started after v2.3";
  const found = { status: "confirmed", confidence: 82, pressure_pass: true, contradictions: 0, affected_files: ["src/import/csv.ts:48"], refuted: 1, root_cause: "last empty line yields undefined row", fix_direction: "skip empty trailing rows in parseCsv", mechanism: "split on undefined" };

  it("the spec's case: a long symptom is not asked again, the cause is found and confirmed by a second debugger", async () => {
    const r = await runSim("debug", { input: { symptom, scope: "src/import" }, mode: "full", stubs: { investigate: found, verify_cause: { confirmed: true } } });
    expect(pathOf(r)).toBe("ask_symptoms investigate verify_cause confirmed");
    expect(r.skipped).toEqual(["ask_symptoms"]);
    expect(out(r)).toMatchObject({ status: "confirmed", root_cause: "last empty line yields undefined row", confidence: 82, affected_files: ["src/import/csv.ts:48"] });
    // The debugger works on the symptom without editing: no repository file is a deliverable of this chain.
    expect(r.workflow.nodes.find((node) => node.id === "investigate")).toMatchObject({ role: "debugger" });
  });

  it("a short symptom is asked about first; the second opinion exists only in full mode", async () => {
    const r = await runSim("debug", { input: { symptom: "it crashes" }, stubs: { investigate: found }, humans: { ask_symptoms: { answer_kind: "answered", answer: symptom } } });
    expect(pathOf(r)).toBe("ask_symptoms investigate verify_cause confirmed");
    expect(r.skipped).toEqual(["verify_cause"]);
  });

  it("a second debugger that does not agree sends the first one back, in the same session", async () => {
    const r = await runSim("debug", { input: { symptom }, mode: "full", stubs: { investigate: found, verify_cause: [{ confirmed: false, objections: ["row 2 also fails"] }, { confirmed: true }] } });
    expect(pathOf(r)).toBe("ask_symptoms investigate verify_cause investigate verify_cause confirmed");
  });

  it("auto_fix proposes analyze-plan-execute with the diagnosis instead of confirming", async () => {
    const r = await runSim("debug", { input: { symptom, auto_fix: true }, stubs: { investigate: found, verify_cause: { confirmed: true } } });
    expect(pathOf(r)).toBe("ask_symptoms investigate verify_cause propose_fix proposed");
    expect(out(r)).toMatchObject({ status: "proposed" });
    const step = r.db.prepare("SELECT receipt_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id='propose_fix'").get(r.summary.runId) as { receipt_json: string };
    expect(JSON.parse(step.receipt_json).detail).toMatchObject({ proposed: "analyze-plan-execute", inputs: { goal: "skip empty trailing rows in parseCsv" } });
  });

  it("a weak finding is looked at once more; an inconclusive one with 3 refuted hypotheses asks the owner for more", async () => {
    const weak = await runSim("debug", { input: { symptom }, stubs: { investigate: [{ ...found, confidence: 20 }, found], verify_cause: { confirmed: true } } });
    expect(pathOf(weak)).toBe("ask_symptoms investigate investigate verify_cause confirmed");
    const stuck = { status: "inconclusive", refuted: 4, confidence: 10, affected_files: [] };
    const more = await runSim("debug", { input: { symptom }, stubs: { investigate: [stuck, { ...found }], verify_cause: { confirmed: true } }, humans: { ask_more: { answer_kind: "provide", answer: "happens with CRLF" } } });
    expect(pathOf(more)).toBe("ask_symptoms investigate ask_more investigate verify_cause confirmed");
    const stop = await runSim("debug", { input: { symptom }, stubs: { investigate: stuck }, humans: { ask_more: { answer_kind: "stop" } } });
    expect(pathOf(stop)).toBe("ask_symptoms investigate ask_more inconclusive");
    expect(out(stop)).toMatchObject({ status: "inconclusive" });
  });

  it("a partial result is returned as partial; from_failures takes the failures of another chain without asking", async () => {
    const partial = await runSim("debug", { input: { symptom }, stubs: { investigate: { status: "partial", root_cause: "maybe the parser", confidence: 50 } } });
    expect(pathOf(partial)).toBe("ask_symptoms investigate partial");
    const fromFailures = await runSim("debug", { input: { symptom: [{ file: "a.ts", severity: "high", evidence: "x" }], mode: "from_failures" }, stubs: { investigate: found, verify_cause: { confirmed: true } } });
    expect(fromFailures.skipped).toEqual(["ask_symptoms", "verify_cause"]);
    expect(out(fromFailures)).toMatchObject({ status: "confirmed" });
  });
});

describe("companion", () => {
  const input = { goal: "Add the dist folder to .gitignore", scope: ".gitignore" };
  const checked = { passes: true, concrete: true, bounded: true, single_concern: true, reason: "one line in one file", contract: task("c1") };

  it("the spec's case: a small concrete task goes straight to one quick code task", async () => {
    const r = await runSim("companion", { input, stubs: { self_check: checked, task: { state: "accepted", merge_commit: "c0ffee1", files: [".gitignore"] } } });
    expect(pathOf(r)).toBe("self_check task done");
    expect(out(r)).toMatchObject({ status: "done", merge_commit: "c0ffee1", files: [".gitignore"], summary: "one line in one file" });
    expect(modeOf(r)).toBe("quick");
  });

  it("a task that is not concrete, bounded and single-purpose is sent to analyze-plan-execute instead", async () => {
    const r = await runSim("companion", { input, stubs: { self_check: { ...checked, passes: false, bounded: false, reason: "touches three modules" } } });
    expect(pathOf(r)).toBe("self_check reroute rerouted");
    expect(out(r)).toMatchObject({ status: "rerouted", proposed_workflow: "analyze-plan-execute", summary: "touches three modules" });
  });

  it("a task the writer could not accept is blocked; the mode is quick whatever is asked", async () => {
    const r = await runSim("companion", { input, mode: "full", stubs: { self_check: checked, task: { state: "failed" } } });
    expect(pathOf(r)).toBe("self_check task blocked");
    expect(modeOf(r)).toBe("quick");
    expect(firstInput(r, "self_check")).toBeDefined();
  });
});

describe("milestone-close", () => {
  const input = { goals: [{ id: "g1", done_when: "export button works", evidence: "test export.spec passes" }], goal: "Stats export" };
  const ready = { open_tasks: 0, unmerged: 0, gate_ok: true, running_attempts: 0, merged_commits: ["m1", "m2"] };

  it("the spec's case: status, retro, close, the owner defers the knowledge candidates, archive", async () => {
    const r = await runSim("milestone-close", { input, stubs: { "lp.run_status": ready, "lp.close": { status: "closed", staged: 2, report_path: "reports/r1.md" } }, humans: { approve_knowledge: { answer_kind: "deferred", approved_ids: [] } } });
    expect(pathOf(r)).toBe("status retro close approve_knowledge archive closed");
    expect(out(r)).toMatchObject({ status: "closed", candidates_staged: 2, candidates_approved: 0, deferred: true, report_path: "reports/r1.md" });
    expect(firstInput(r, "close")).toMatchObject({ merged_commits: ["m1", "m2"] });
  });

  it("approved candidates are counted; with nothing staged the owner is not asked", async () => {
    const approved = await runSim("milestone-close", { input, stubs: { "lp.run_status": ready, "lp.close": { status: "closed", staged: 2 } }, humans: { approve_knowledge: { answer_kind: "approved", approved_ids: ["k1", "k2"] } } });
    expect(out(approved)).toMatchObject({ candidates_approved: 2, deferred: false });
    const none = await runSim("milestone-close", { input, stubs: { "lp.run_status": ready, "lp.close": { status: "closed", staged: 0 } } });
    expect(none.skipped).toEqual(["approve_knowledge"]);
  });

  it("open work asks the owner: closing anyway goes on, anything else is not_ready; quick has no retrospective", async () => {
    const open = { ...ready, open_tasks: 2 };
    const anyway = await runSim("milestone-close", { input, mode: "quick", stubs: { "lp.run_status": open, "lp.close": { status: "closed", staged: 0 } }, humans: { ask_finish: { answer_kind: "close_anyway" } } });
    expect(pathOf(anyway)).toBe("status ask_finish retro close approve_knowledge archive closed");
    expect(anyway.skipped).toEqual(expect.arrayContaining(["retro"]));
    const stop = await runSim("milestone-close", { input, stubs: { "lp.run_status": { ...ready, gate_ok: false } }, humans: { ask_finish: { answer_kind: "finish_first" } } });
    expect(pathOf(stop)).toBe("status ask_finish not_ready");
    expect(out(stop)).toMatchObject({ status: "not_ready" });
  });

  it("a close that halts (intent drift refused) archives nothing", async () => {
    const r = await runSim("milestone-close", { input, stubs: { "lp.run_status": ready, "lp.close": { status: "halted", report_path: "reports/h.md" } } });
    expect(pathOf(r)).toBe("status retro close halted");
    expect(out(r)).toMatchObject({ status: "halted" });
  });
});
