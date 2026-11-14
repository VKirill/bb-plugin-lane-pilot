// Region 11 · The forge — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, voidIsHave } from "./types";

export default {

  n984: { voidReview: voidIsHave("кузница держит типизированные черновики: skill, role (=agent), workflow; вид «connection» сознательно не делается — подключения добавляет человек в BB/Env Catalog (секреты)") },
} satisfies RegionEvidence;
