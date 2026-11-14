// Region 0 · Phase graph — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, drill, entry, flip, part, type RegionEvidence, rows, wfRun, wfStep, wrongTarget } from "./types";

const TASK_MANIFEST = "src/rooms/storage/task-manifest.ts";
// Batch a (n0 … n29, the discussion and the plan admission): tests/sma/four-proofs-r00-a.test.ts, observations in tests/sma/r00-world-a.ts, scene
// scripts/lp_drill/scenes/sma_r00_a.py. Batch b (n30 … n58, n1768: the plan hand-in, the drawing stage, the start of the execution):
// tests/sma/four-proofs-r00-b.test.ts, observations in tests/sma/r00-world-b.ts, scene scripts/lp_drill/scenes/sma_r00_b.py. Both are reached through sma_r00.py.
const GATES = "src/rooms/phase/logic/gates.ts";
const RECORD = "src/rooms/phase/logic/record.ts";
const DESIGN = "src/rooms/phase/logic/design.ts";
const WORDS = "src/rooms/phase/server/driver-methods-words.ts";
const ADMISSION = "src/rooms/phase/server/driver-methods-admission.ts";
const CONTROL = "src/rooms/phase/server/driver-methods-control.ts";
const DRAWING = "src/rooms/phase/server/driver-methods-design.ts";
const STEPS = "src/rooms/phase/server/driver-steps.ts";
const AUTO = "src/rooms/phase/server/auto-stages.ts";
const SCENE = "sma_r00";
// The switches the phase driver copies into the record when a phase opens: each turns a sub-step of a later stage on, never the opening itself.
const OPEN_SWITCHES = {
  "phase.ambiguity_gate": "copied into the record at opening, read by the plan gate later", "phase.commit_docs": "copied into the record at opening, read when documents are written",
  "phase.design_points": "copied into the record at opening, read at the design stage", "phase.diagnose": "copied into the record at opening, read after a failed verdict",
  "phase.doc_files": "copied into the record at opening, read when SPEC.md and PLAN.md are written", "phase.draw_material": "copied into the record at opening, read at the design stage",
  "phase.gray_areas": "copied into the record at opening, read by the analysis", "phase.pattern_map": "copied into the record at opening, read by the plan run",
  "phase.piece_notes": "copied into the record at opening, read when pieces are issued", "phase.plan_bounce": "copied into the record at opening, read at plan admission",
  "phase.research": "copied into the record at opening, read by the plan run", "phase.threat_closure": "copied into the record at opening, read by the plan gate",
  "phase.validation": "copied into the record at opening, read by the plan run",
} as const;

export default {
  n0: { mutation: distort(ADMISSION, "`phase opened: ${input.title}${wordTurns.mode", "`phase opened: ${input.goal}${wordTurns.mode"), reach: { ...entry("the PM opens a phase for a goal"), notGatedBy: OPEN_SWITCHES }, trace: [part({ section: "goal", kind: "opened" }), drill(SCENE)] },
  n1: { mutation: distort("src/rooms/phase/logic/next-action.ts", 'rubricLine("discussion")}${check.ok ? "" : `\\nOpen: ${check.why.join("; ")}`}', 'rubricLine("discussion")}${check.ok ? "" : `\\nOpen: ${check.why.join(", ")}`}'), trace: drill(SCENE) },
  n2: { mutation: distort(ADMISSION, ".filter(Boolean).slice(0, 30);", ".filter(Boolean).slice(1, 30);"), trace: drill(SCENE) },
  n3: { mutation: flip(GATES, 'if (!record.context?.appetite?.trim()) why.push("no appetite', 'if (record.context?.appetite?.trim()) why.push("no appetite'), trace: drill(SCENE) },
  n4: { mutation: distort(RECORD, 'export const RISK_KINDS = ["value", "usability", "feasibility", "viability"] as const;', 'export const RISK_KINDS = ["value", "usability", "viability", "feasibility"] as const;'), trace: drill(SCENE) },
  n5: { mutation: flip(GATES, "if (unnamed.length) why.push(", "if (unnamed.length > 1) why.push("), trace: drill(SCENE) },
  n6: { mutation: flip(GATES, 'for (const key of ["given", "when", "then"] as const) if (!item.promise[key]?.trim())', 'for (const key of ["given", "when", "then"] as const) if (item.promise[key]?.trim())'), trace: drill(SCENE) },
  n7: { mutation: distort("src/rooms/phase/server/auto-stages.ts", "const path = `${phaseFolder(phase.id)}/CONTEXT.md`;", "const path = `${phaseFolder(phase.id)}/CONTEXT.txt`;"), trace: drill(SCENE) },
  n8: { mutation: wrongTarget("src/rooms/phase/server/driver-docs.ts", "expectedSha256: current === null ? null : sha256Hex(current), content: file.content", "expectedSha256: current === null ? null : sha256Hex(file.content), content: file.content"), trace: drill(SCENE) },
  n9: { mutation: flip(GATES, "for (const doc of docs) if (doc.bytes === 0)", "for (const doc of docs) if (doc.bytes === 1)"), trace: drill(SCENE) },
  n10: { mutation: flip(CONTROL, 'if (!["discussion", "planning"].includes(phase.stage)) throw new PhaseRefusal("the goal is revised', 'if (["discussion", "planning"].includes(phase.stage)) throw new PhaseRefusal("the goal is revised'), reach: entry("the PM or the owner revises the phase goal while it is in discussion or planning"), trace: [part({ section: "goal", kind: "revised" }), drill(SCENE)] },
  n11: { mutation: flip(ADMISSION, "if (file.sha256 !== doc.sha256) {", "if (file.sha256 === doc.sha256) {"), reach: entry("a plan check is reported for a phase whose plan stands on signed documents"), trace: [part({ section: "discussion", kind: "context_changed" }), drill(SCENE)] },
  n12: { mutation: flip(ADMISSION, 'if (wordAsked(record, "context")) {', 'if (!wordAsked(record, "context")) {'), trace: [part({ section: "discussion", kind: "awaits_signature" }), drill(SCENE)] },
  n13: { mutation: distort(ADMISSION, "`context signed ${record.context!.sha.slice(0, 12)}:", "`context signed ${record.context!.sha.slice(1, 13)}:"), trace: [part({ section: "discussion", kind: "signed" }), drill(SCENE)] },
  n14: { mutation: distort("src/rooms/phase/store.ts", "const seq = (last?.seq ?? 0) + 1;", "const seq = (last?.seq ?? 0) + 2;"), trace: [part({ section: "discussion", kind: "signed" }), drill(SCENE)] },
  n15: { mutation: distort(ADMISSION, 'move(phase, "planning", record, "the context documents exist, none is empty, and they are signed");', 'move(phase, "design", record, "the context documents exist, none is empty, and they are signed");'), trace: drill(SCENE) },
  n16: { mutation: flip(GATES, 'if (!docs.length) why.push("no context documents', 'if (docs.length) why.push("no context documents'), reach: entry("the PM or the machine reports the discussion's documents with the context call"), trace: drill(SCENE) },
  n17: { mutation: flip(GATES, "|| plan.contextSha !== record.context.sha)", "|| plan.contextSha === record.context.sha)"), trace: [part({ section: "plan", kind: "admitted" }), drill(SCENE)] },
  n18: { mutation: distort(ADMISSION, "legacy: true };", "legacy: false };"), reach: { ...entry("a plan written before the phase existed is opened as a legacy phase"), notGatedBy: OPEN_SWITCHES }, trace: drill(SCENE) },
  n19: { mutation: flip("workflows/lp.plan.json", '"default": true,\n      "note": "the daemon\'s answer to «research if needed»', '"default": false,\n      "note": "the daemon\'s answer to «research if needed»'), trace: [wfStep("lp.plan", "plan_critic"), drill(SCENE)] },
  n20: { mutation: wrongTarget(GATES, "plan.contextSha !== record.context.sha", "plan.contextSha !== record.context.docs[0]?.sha256"), trace: drill(SCENE) },
  n21: { mutation: flip("workflows/lp.analyze.json", "assess.confidence < 60 && !assess.stalled", "assess.confidence > 60 && !assess.stalled"), trace: [wfStep("lp.analyze", "gather"), drill(SCENE)] },
  n22: { mutation: distort("workflows/lp.plan.json", "plan_critic.status == 'rework' && visits('plan_critic') < 3", "plan_critic.status == 'rework' && visits('plan_critic') < 1"), trace: [wfStep("lp.plan", "plan"), drill(SCENE)] },
  n23: { mutation: flip(GATES, "else if (!plan.critique.independence?.ok) why.push(", "else if (plan.critique.independence?.ok) why.push("), trace: [part({ section: "plan", kind: "checked" }), drill(SCENE)] },
  n24: { mutation: flip(RECORD, "if (critic.startedAt! < plannedUntil)", "if (critic.startedAt! > plannedUntil)"), reach: entry("a plan check is reported with the workflow run of its critic"), trace: drill(SCENE) },
  n25: { mutation: flip(RECORD, "if (after.length) return", "if (!after.length) return"), trace: drill(SCENE) },
  n26: { mutation: flip(GATES, "if (risks.length < 3 || risks.length > 5) why.push", "if (risks.length < 3 || risks.length > 6) why.push"), reach: entry("a plan is submitted to the phase and its gate is read"), trace: drill(SCENE) },
  n27: { mutation: flip(GATES, "else if (dep !== item.id && other.wave >= item.wave)", "else if (dep !== item.id && other.wave > item.wave)"), reach: entry("a plan is submitted to the phase and its gate is read"), trace: drill(SCENE) },
  n28: { mutation: flip(GATES, "if (!owns.length) why.push(", "if (owns.length) why.push("), reach: entry("a plan is submitted to the phase and its gate is read"), trace: drill(SCENE) },
  n29: { mutation: flip(GATES, "if (plan.sha !== planSignature(items, plan.contextSha)) why.push(", "if (plan.sha === planSignature(items, plan.contextSha)) why.push("), trace: drill(SCENE) },
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
