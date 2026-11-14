// Region 0 · Phase graph — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, drill, entry, flip, part, type RegionEvidence, rows, wfRun, wfStep, wrongTarget } from "./types";

const TASK_MANIFEST = "src/rooms/storage/task-manifest.ts";
// Batch a (n0 … n29, the discussion and the plan admission): tests/sma/four-proofs-r00-a.test.ts, observations in tests/sma/r00-world-a.ts, scene
// scripts/lp_drill/scenes/sma_r00_a.py (imported by sma_r00.py).
const GATES = "src/rooms/phase/logic/gates.ts";
const RECORD = "src/rooms/phase/logic/record.ts";
const ADMISSION = "src/rooms/phase/server/driver-methods-admission.ts";
const CONTROL = "src/rooms/phase/server/driver-methods-control.ts";
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
  n1: { mutation: distort("src/rooms/phase/logic/next-action.ts", 'rubricLine("discussion")}${check.ok ? "" : `\nOpen: ${check.why.join("; ")}`}', 'rubricLine("discussion")}${check.ok ? "" : `\nOpen: ${check.why.join(", ")}`}'), trace: drill(SCENE) },
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
  n40: { trace: wfRun("impeccable-build") },
  // The task of a phase names the phase as its parent in its manifest (docs/task-folder.md, T5).
  n67: { mutation: distort(TASK_MANIFEST, '{ kind: "phase", id: home.phase_id,', '{ kind: "phase", id: home.run_id,'), trace: rows("lane_pilot_task_home", "created_at", "phase_id IS NOT NULL") },
  n121: { trace: wfRun("retrospective") },
  // A {task_id, kind} resolves to one file; two current files of one kind are ambiguous and refused (T2).
  n132: { mutation: flip(TASK_MANIFEST, "if (ends.length !== 1) return null;", "if (ends.length < 1) return null;"), reach: entry("a main-path stage resolves a task's file by {task_id, kind}") },
} satisfies RegionEvidence;
