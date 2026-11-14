// Region 0 · Phase graph — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, wfRun, wfStep } from "./types";

export default {
  n19: { trace: wfStep("lp.plan", "plan_critic") },
  n21: { trace: wfStep("lp.analyze", "gather") },
  n22: { trace: wfStep("lp.plan", "plan") },
  n40: { trace: wfRun("impeccable-build") },
  n121: { trace: wfRun("retrospective") },
} satisfies RegionEvidence;
