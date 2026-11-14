// Region 22 · The project. planning folder — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, wfRun, wfStep } from "./types";

export default {
  n1590: { trace: wfStep("project-start", "recap") },
  n1605: { trace: wfRun("lp.review") },
  n1610: { trace: wfRun("validate-phase") },
  n1611: { trace: wfRun("ui-audit") },
  n1615: { trace: wfStep("project-start", "research") },
  n1617: { trace: wfStep("debug", "session") },
  n1621: { trace: wfStep("milestone-close", "snapshot") },
  n1624: { trace: wfStep("project-start", "profile_write") },
} satisfies RegionEvidence;
