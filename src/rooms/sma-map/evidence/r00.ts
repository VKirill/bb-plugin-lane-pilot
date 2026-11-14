// Region 0 · Phase graph — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, entry, flip, part, type RegionEvidence, rows, wfRun, wfStep, wrongTarget, drill } from "./types";

const TASK_MANIFEST = "src/rooms/storage/task-manifest.ts";
// Batch b (n30 … n58, n1768: the plan hand-in, the drawing stage, the start of the execution): tests/sma/four-proofs-r00-b.test.ts, observations in
// tests/sma/r00-world-b.ts, scene scripts/lp_drill/scenes/sma_r00_b.py (reached through sma_r00.py).
const GATES = "src/rooms/phase/logic/gates.ts";
const DESIGN = "src/rooms/phase/logic/design.ts";
const WORDS = "src/rooms/phase/server/driver-methods-words.ts";
const ADMISSION = "src/rooms/phase/server/driver-methods-admission.ts";
const DRAWING = "src/rooms/phase/server/driver-methods-design.ts";
const STEPS = "src/rooms/phase/server/driver-steps.ts";
const AUTO = "src/rooms/phase/server/auto-stages.ts";

export default {
  n19: { trace: wfStep("lp.plan", "plan_critic") },
  n21: { trace: wfStep("lp.analyze", "gather") },
  n22: { trace: wfStep("lp.plan", "plan") },
  n30: { mutation: distort(WORDS, "blocking: input.blocking, askedAt: now() }]", "blocking: !input.blocking, askedAt: now() }]"), trace: part({ kind: "question" }) },
  n31: { mutation: flip(GATES, 'if (!plan.objective?.trim()) why.push("the plan names no objective', 'if (plan.objective?.trim()) why.push("the plan names no objective'), trace: part({ section: "plan", kind: "admitted" }) },
  n32: { mutation: distort(ADMISSION, "task: { ...item.task, id: item.id } })));", "task: { ...item.task, id: item.task.id ?? item.id } })));"), reach: entry("the PM hands in the pieces of a plan for a phase at planning"), trace: part({ section: "plan", kind: "submitted" }) },
  n33: { mutation: flip(GATES, 'if (wordAsked(record, "planning") && wordOf(record, "planning")?.decision !== "yes") why.push', 'if (wordAsked(record, "planning") && wordOf(record, "planning")?.decision === "yes") why.push'), trace: part({ kind: "word_planning" }) },
  n34: { mutation: flip(AUTO, 'if (phase.stage === "design" && !r.design?.drawing && !tried("draw")', 'if (phase.stage === "design" && r.design?.drawing && !tried("draw")'), trace: wfRun("lp.draw") },
  n35: { mutation: flip(DRAWING, 'if (phase.stage !== "design") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not design`);', 'if (phase.stage === "design") throw new PhaseRefusal(`phase ${phase.id} is at ${phase.stage}, not design`);'), reach: entry("the PM or the draw stage reports a drawing for a phase at design"), trace: part({ section: "design", kind: "drawing" }) },
  n36: { mutation: distort(DESIGN, '(mode === "system" || mode === "mixed" ? DRAWING_SYSTEM_SECTIONS : [])', '(mode === "system" ? DRAWING_SYSTEM_SECTIONS : [])'), trace: drill("sma_r00") },
  n37: { mutation: distort(DESIGN, "const UI_PATH = /\\.(tsx|jsx|vue|svelte|css|scss|html)$|", "const UI_PATH = /\\.(jsx|vue|svelte|css|scss|html)$|"), trace: drill("sma_r00") },
  n38: { mutation: flip(DESIGN, 'return ui.length ? { decision: "needed"', 'return !ui.length ? { decision: "needed"'), trace: drill("sma_r00") },
  n39: { mutation: distort(AUTO, "folder: planningText(phaseFolder(phase.id), planningHome), material:", "folder: phaseFolder(phase.id), material:"), reach: entry("the phase driver's pass finds a phase at design with no drawing"), trace: wfRun("lp.draw") },
  n40: { mutation: flip(DRAWING, 'if (wordAsked(record, "design") && check.why.length === 1 && check.why[0]!.includes("owner\'s word")) return mustGet(phase.id);', 'if (wordAsked(record, "design") && check.why.length !== 1 && check.why[0]!.includes("owner\'s word")) return mustGet(phase.id);'), trace: part({ kind: "word_design" }) },
  n41: { mutation: flip(DRAWING, 'const outside = input.paths.filter((path) => !path.startsWith(folder) || path.includes(".."));', 'const outside = input.paths.filter((path) => !path.startsWith(folder) && path.includes(".."));'), trace: part({ section: "design", kind: "drawing" }) },
  n42: { mutation: distort(AUTO, 'await deps.api.drawing({ phaseId: phase.id, paths, designer: "lp.draw: specialist design-lead",', 'await deps.api.drawing({ phaseId: phase.id, paths, designer: "lp.draw: specialist design-critic",'), trace: wfStep("lp.draw", "draw") },
  n43: { mutation: distort(AUTO, 'reviewer: "lp.draw: plan-critic", ...(form ? { critique: form } : {}), by });', 'reviewer: "lp.draw: specialist design-lead", ...(form ? { critique: form } : {}), by });'), trace: wfStep("lp.draw", "check") },
  n44: { mutation: flip(DESIGN, 'if (!drawing.reviewer) why.push("the drawing is not reviewed by a separate role");', 'if (drawing.reviewer) why.push("the drawing is not reviewed by a separate role");'), reach: entry("a drawing is reported to the phase at design with its designer and reviewer"), trace: drill("sma_r00") },
  n45: { mutation: flip(DRAWING, "if (drawn.sha256 !== phase.record.design?.drawing?.sha256 && record.words)", "if (drawn.sha256 === phase.record.design?.drawing?.sha256 && record.words)"), trace: part({ section: "design", kind: "archived" }) },
  n46: { mutation: flip(DESIGN, "if (drawing.feasible === undefined) why.push(", "if (drawing.feasible !== undefined) why.push("), trace: drill("sma_r00") },
  n47: { mutation: flip(DRAWING, '${input.feasible ? "feasible" : `contradiction: ${input.contradiction ?? "?"}`}', '${!input.feasible ? "feasible" : `contradiction: ${input.contradiction ?? "?"}`}'), trace: part({ section: "design", kind: "drawing" }) },
  n48: { mutation: flip(DESIGN, 'if (wordAsked(record, "design")) {', 'if (!wordAsked(record, "design")) {'), trace: drill("sma_r00") },
  n49: { mutation: distort(DESIGN, 'why.push(...openQuestions(record, "design").map(', 'why.push(...openQuestions(record, "planning").map('), reach: entry("a drawing is reported to the phase at design"), trace: drill("sma_r00") },
  n50: { mutation: flip(WORDS, 'wordAsked(phase.record, "design") && input.key !== drawingSha)', 'wordAsked(phase.record, "design") && input.key === drawingSha)'), trace: part({ kind: "word_design" }) },
  n51: { mutation: distort(DRAWING, "record.design = { ...record.design!, confirmedAt: now() };", "record.design = { ...record.design!, confirmedAt: phase.createdAt };"), trace: drill("sma_r00") },
  n52: { mutation: wrongTarget(DRAWING, 'return returnTo({ phaseId: phase.id, to: "planning", note: `the drawing contradicts', 'return returnTo({ phaseId: phase.id, to: "discussion", note: `the drawing contradicts'), trace: part({ section: "decisions", kind: "return" }) },
  n53: { mutation: flip(STEPS, 'if (current.stage === "execution") {\n      current = await issue(current);', 'if (current.stage !== "execution") {\n      current = await issue(current);'), trace: part({ section: "execution", kind: "issued" }) },
  n54: { mutation: flip(STEPS, 'if (phase.record.plan?.sha !== phase.record.plan?.admittedSha) throw new PhaseRefusal("the plan changed since it was checked: return the phase to planning");', 'if (phase.record.plan?.sha === phase.record.plan?.admittedSha) throw new PhaseRefusal("the plan changed since it was checked: return the phase to planning");'), reach: entry("the phase driver's pass finds a phase at execution with an admitted plan"), trace: drill("sma_r00") },
  n55: { mutation: flip(DESIGN, 'if (design.decision === "not_needed") return { ok: true };', 'if (design.decision !== "not_needed") return { ok: true };'), reach: entry("a plan is admitted or a drawing is reported, and the phase is ready to leave for the execution"), trace: drill("sma_r00") },
  n56: { mutation: distort(STEPS, "const firstTask = Object.values(execution.issued)[0];", "const firstTask = Object.values(execution.issued).at(-1);"), trace: part({ section: "execution", kind: "candidate" }) },
  n57: { mutation: distort(STEPS, 'if (typeof reply.runId === "string") runId = reply.runId;', 'if (typeof reply.runId === "string") runId = phase.runId ?? reply.runId;'), trace: rows("lane_pilot_phase", "updated_at", "stage='execution'") },
  n58: { mutation: wrongTarget(STEPS, "execution.issued[item.id] = taskId;", "execution.issued[item.id] = item.id;"), trace: part({ section: "execution", kind: "issued" }) },
  // The task of a phase names the phase as its parent in its manifest (docs/task-folder.md, T5).
  n67: { mutation: distort(TASK_MANIFEST, '{ kind: "phase", id: home.phase_id,', '{ kind: "phase", id: home.run_id,'), trace: rows("lane_pilot_task_home", "created_at", "phase_id IS NOT NULL") },
  n121: { trace: wfRun("retrospective") },
  // A {task_id, kind} resolves to one file; two current files of one kind are ambiguous and refused (T2).
  n132: { mutation: flip(TASK_MANIFEST, "if (ends.length !== 1) return null;", "if (ends.length < 1) return null;"), reach: entry("a main-path stage resolves a task's file by {task_id, kind}") },
  n1768: { mutation: distort("src/rooms/design-eval/logic.ts", "const all = byWidth.flatMap((row) => row.criteria.map((c) => c.score));", "const all = byWidth.flatMap((row) => row.criteria.slice(1).map((c) => c.score));"), reach: entry("the drawing checker's scores and remarks of a drawing are measured and journaled (lp.draw, lp-design-eval)"), trace: drill("sma_r00") },
} satisfies RegionEvidence;
