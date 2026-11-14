// Region 27 · Shipping and honest numbers — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { seedEntry, type RegionEvidence } from "./types";

export default {
  n1733: { reach: seedEntry("the owner runs the command") },
  n1734: { reach: seedEntry("the owner runs the command") },
  n1735: { reach: seedEntry("the owner runs the command") },
  n1736: { reach: seedEntry("the owner runs the command") },
  n1737: { reach: seedEntry("the owner runs the command") },
  n1738: { reach: seedEntry("the owner runs the command") },
  n1739: { reach: seedEntry("the owner runs the command") },
  n1740: { reach: seedEntry("the owner runs the command") },
  n1741: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
