// Region 12 · Supervisor — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { seedEntry, type RegionEvidence } from "./types";

export default {
  n1002: { reach: seedEntry("the owner runs the command") },
  n1005: { reach: seedEntry("the owner runs the command") },
  n1012: { reach: seedEntry("the owner runs the command") },
  n1022: { reach: seedEntry("the owner runs the command") },
  n1025: { reach: seedEntry("the owner runs the command") },
  n1027: { reach: seedEntry("the owner runs the command") },
  n1031: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
