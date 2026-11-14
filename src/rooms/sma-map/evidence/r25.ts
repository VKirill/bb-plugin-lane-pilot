// Region 25 · Receipts and evidence — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { distort, drill, seedEntry, type RegionEvidence } from "./types";

export default {
  n1680: { reach: seedEntry("the owner runs the command") },
  n1681: { reach: seedEntry("the owner runs the command") },
  n1682: { reach: seedEntry("the owner runs the command") },
  n1683: { reach: seedEntry("the owner runs the command") },
  n1684: { reach: seedEntry("the owner runs the command") },
  n1685: { reach: seedEntry("the owner runs the command") },
  n1686: { reach: seedEntry("the owner runs the command") },
  n1687: { reach: seedEntry("the owner runs the command") },
  n1688: { reach: seedEntry("the owner runs the command") },
  n1689: { reach: seedEntry("the owner runs the command") },
  n1690: { reach: seedEntry("the owner runs the command") },
  // The task manifest is the evidence passport: every row carries its sha256 and producer (docs/task-folder.md).
  n1691: { reach: seedEntry("the owner runs the command"), mutation: distort("src/rooms/storage/task-manifest.ts", "plugin_version: row.plugin_version,\n      sha256: row.sha256,", "plugin_version: row.plugin_version,\n      sha256: row.path,"), trace: drill("task_home") },
  n1692: { reach: seedEntry("the owner runs the command") },
  n1693: { reach: seedEntry("the owner runs the command") },
  n1694: { reach: seedEntry("the owner runs the command") },
  n1695: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
