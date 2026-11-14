// Region 23 · Templates, references, contexts — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, wfRun, wfStep } from "./types";

export default {
  n1631: { trace: wfRun("lp.plan") },
  n1633: { trace: wfRun("web-research") },
  n1640: { trace: wfRun("debug") },
  n1641: { trace: wfStep("lp.plan", "strategy") },
  n1652: { trace: wfStep("milestone-close", "record") },
} satisfies RegionEvidence;
