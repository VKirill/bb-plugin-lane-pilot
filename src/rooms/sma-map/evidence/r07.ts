// Region 7 · Providers, models, accounts — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

export default {
  n604: { voidReview: voidIsHave("список строгих работников — проектная настройка worker.strict_user (+ worker.user): при on проверки идут от отдельного пользователя через sudo -n -u") },
  n605: { reach: seedEntry("the owner runs the command") },
  n610: { voidReview: voidIsHave("все процессы проверки, включая осиротевшие фоновые, умирают с ней: spawnAsync group:true убивает группу процессов по таймауту и переполнению вывода (macOS/Linux)") },
  n621: { reach: seedEntry("a Claude Code session event fires the hook") },
  n622: { reach: seedEntry("a Claude Code session event fires the hook") },
  n628: { voidReview: voidStays("из пула воркеров задача роль не выбирает; писатель один (writer.provider/model) с цепочкой запасных, навыки задаёт правило по заявленным навыкам задачи и папке проекта") },
  n656: { voidReview: voidIsHave("пару дизайнов судит независимый измеритель по рубрике (overflow, contrast, targets, …) без участия автора; выбор пары — design-pair-answer PM") },
} satisfies RegionEvidence;
