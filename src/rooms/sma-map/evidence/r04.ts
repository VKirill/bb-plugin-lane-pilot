// Region 4 · Daemon tick — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, voidIsHave } from "./types";

export default {

  n419: { voidReview: voidIsHave("после перезапуска попытки сверяет reconcile: running/spawn_* попытка без треда сверяется с BB (shouldReconcileAttemptThread → reconcileAttemptThread), очередь и журнал — одна SQLite, расхождения нет") },
  n436: { voidReview: voidIsHave("выдача = захват плюс удержания одним шагом: после ожидания места заново проверяются hold, пауза, конвейер, breaker; держимая задача не стартует") },
  n438: { voidReview: voidIsHave("попытку без процесса держит состояние spawn_requested (любой возраст держит worktree), зависший старт через 15 мин завершается writer_start_stalled") },
} satisfies RegionEvidence;
