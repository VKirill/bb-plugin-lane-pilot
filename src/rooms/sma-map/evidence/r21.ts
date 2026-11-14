// Region 21 · sma-tools: project queries — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { seedEntry, type RegionEvidence } from "./types";

export default {
  n1560: { reach: seedEntry("the owner runs the command") },
  n1563: { reach: seedEntry("the owner runs the command") },
  n1564: { reach: seedEntry("the owner runs the command") },
  n1565: { reach: seedEntry("the owner runs the command") },
  n1568: { reach: seedEntry("the owner runs the command") },
  n1569: { reach: seedEntry("the owner runs the command") },
  n1571: { reach: seedEntry("the owner runs the command") },
  n1572: { reach: seedEntry("the owner runs the command") },
  n1573: { reach: seedEntry("the owner runs the command") },
  n1574: { reach: seedEntry("the owner runs the command") },
  n1575: { reach: seedEntry("the owner runs the command") },
  n1577: { reach: seedEntry("the owner runs the command") },
  n1578: { reach: seedEntry("the owner runs the command") },
  n1582: { reach: seedEntry("the owner runs the command") },
  n1583: { reach: seedEntry("the owner runs the command") },
  n1584: { reach: seedEntry("the owner runs the command") },
  n1585: { reach: seedEntry("the owner runs the command") },
  n1586: { reach: seedEntry("the owner runs the command") },
  n1588: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
