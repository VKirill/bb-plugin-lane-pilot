// Region 3 · Worker — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, voidIsHave, wfStep } from "./types";

export default {
  n399: { voidReview: voidIsHave("строгий работник получает права (ACL) только на папку своей попытки и temp задачи, git доверяет только этому checkout; дерево работника — своя worktree lane/<попытка>, не рабочая копия человека") },
  n407: { trace: wfStep("lp.plan", "plan_critic") },
} satisfies RegionEvidence;
