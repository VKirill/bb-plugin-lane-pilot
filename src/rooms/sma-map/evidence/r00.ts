// Region 0 · Phase graph — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, entry, flip, type RegionEvidence, rows, wfRun, wfStep } from "./types";

const TASK_MANIFEST = "src/rooms/storage/task-manifest.ts";

export default {
  n19: { trace: wfStep("lp.plan", "plan_critic") },
  n21: { trace: wfStep("lp.analyze", "gather") },
  n22: { trace: wfStep("lp.plan", "plan") },
  n40: { trace: wfRun("impeccable-build") },
  // The task of a phase names the phase as its parent in its manifest (docs/task-folder.md, T5).
  n67: { mutation: distort(TASK_MANIFEST, '{ kind: "phase", id: home.phase_id,', '{ kind: "phase", id: home.run_id,'), trace: rows("lane_pilot_task_home", "created_at", "phase_id IS NOT NULL") },
  n121: { trace: wfRun("retrospective") },
  // A {task_id, kind} resolves to one file; two current files of one kind are ambiguous and refused (T2).
  n132: { mutation: flip(TASK_MANIFEST, "if (ends.length !== 1) return null;", "if (ends.length < 1) return null;"), reach: entry("a main-path stage resolves a task's file by {task_id, kind}") },
} satisfies RegionEvidence;
