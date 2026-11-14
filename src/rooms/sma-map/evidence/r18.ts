// Region 18 · Claude Code session hooks — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

export default {
  n1403: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1404: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1405: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1410: { voidReview: voidIsHave("сегмент строки состояния — чистая функция над кешем окон подписки (usageSegment), печатается глаголом bb lane-pilot statusline <host>; claim/коллизии в него не входят") },
  n1411: { voidReview: voidIsHave("строка человека не заменяется: чистильщик снимает только statusLine старого lane-statusline и восстанавливает сохранённую строку человека байт в байт; чужую строку не трогает") },
  n1413: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1414: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1429: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1430: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1431: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1432: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1433: { voidReview: voidIsHave("PreToolUse Task/Agent проверяет снимок окон подписки (поток spend) в том же процессе до сборки пакета; сверх порога, заданного человеком, порождение отклоняется") },
  n1434: { voidReview: voidIsHave("пакет субагента собирается из правил, заявок и уроков (subagent-pack); упавший глагол пакета оставляет прежний пакет репозитория и заявок, отказ updatedInput падает в additionalContext с записью деградации") },
  n1442: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1443: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1444: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1445: { reach: seedEntry("a Claude Code session event fires the hook"), voidReview: voidStays("обёртки совместимости для старых имён команд не нужны: хуки пишутся заново на каждую сессию из сборки, старых установок с этими именами не бывает") },
  n1451: { voidReview: voidIsHave("ступень каждого правила (note/warning/soft-deny…) хранится и двигается по доказательствам (ruleTier, ruleLadderStep) — это и есть оверлей ступеней, без отдельного файла") },
  n1457: { voidReview: voidIsHave("чужие касания видны: старт сессии получает заявки других окон (session-brief foreign), отпечаток работы окна сверяется с задачами и заявками, пересечение owns_paths заставляет ждать") },
  n1787: { reach: seedEntry("a Claude Code session event fires the hook") },
} satisfies RegionEvidence;
