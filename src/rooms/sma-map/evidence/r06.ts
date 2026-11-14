// Region 6 · Conversation and intake — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, voidIsHave, wfRun } from "./types";

export default {
  n535: { voidReview: voidIsHave("три рецепта проверки quick/full/browser выбираются по всему запросу, ни один байт запроса не становится командой (текущий ours-текст устарел)") },
  n593: { trace: wfRun("lp.brainstorm") },
} satisfies RegionEvidence;
