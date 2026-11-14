// Region 5 · Daemon life — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { seedEntry, type RegionEvidence } from "./types";

export default {
  n440: { reach: seedEntry("the owner runs the command") },
  n487: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
