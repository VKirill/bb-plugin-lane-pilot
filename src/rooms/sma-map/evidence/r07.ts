// Region 7 · Providers, models, accounts — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { seedEntry, type RegionEvidence } from "./types";

export default {
  n605: { reach: seedEntry("the owner runs the command") },
  n621: { reach: seedEntry("a Claude Code session event fires the hook") },
  n622: { reach: seedEntry("a Claude Code session event fires the hook") },
} satisfies RegionEvidence;
