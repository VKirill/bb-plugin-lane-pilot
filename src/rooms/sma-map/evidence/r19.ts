// Region 19 · Install, update, remove — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

export default {
  n1464: { reach: seedEntry("the owner runs the command") },
  n1467: { reach: seedEntry("the owner runs the command") },
  n1473: { voidReview: voidIsHave("после удаления плагина его графы, роли и навыки уходят вместе с управляемым артефактом BB, данные плагина удаляет ядро; остатки старого Claude Lane снимает removeClaudeLaneLeftovers") },
  n1474: { reach: seedEntry("the owner runs the command") },
  n1475: { voidReview: voidStays("плагин ставится один раз в BB, не в проект; хуки пишутся в папку сессии, выбора «проект/глобально» у установки нет") },
  n1477: { voidReview: voidIsHave("движок (графы, роли, шаблоны, навыки) ставит BB целиком одним управляемым артефактом задачей установки плагина") },
  n1478: { voidReview: voidIsHave("команды хуков указывают в существующее место: хуки пишутся из сборки в папку сессии с абсолютным путём и привязкой к CLAUDE_PROJECT_DIR") },
  n1482: { voidReview: voidIsHave("курируемый список входов: роутер предлагает только published/tested и не internal графы, остальные — подграфы") },
  n1483: { voidReview: voidIsHave("графы доступны человеку и PM без тонких SKILL.md: навыки плагина отдаются через корни навыков BB, графы запускаются lane_pilot_route / lane_pilot_run_workflow") },
  n1484: { voidReview: voidStays("навык на каждый граф не пишется, поэтому второй копии графа, которую надо держать пустой, нет; источник — сам workflows/*.json") },
  n1485: { voidReview: voidStays("команд чужого каркаса /gsd-* в Lane Pilot не было, старых фаз под эти имена нет — мост не нужен") },
  n1491: { voidReview: voidStays("сессии Lane Pilot идут внутри BB через Agent SDK, который статусную строку не рисует; терминальный Claude Code Lane Pilot не запускает — ставить сегмент некуда (сам сегмент — n1410, глагол statusline)") },
  n1501: { voidReview: voidIsHave("состояние времени выполнения (фазы, задачи, попытки, квитанции, заявки) лежит в базе плагина data.db на хабе, а не в папке проекта") },
  n1503: { voidReview: voidStays("statusLine плагин не устанавливает (см. n1491), единственная правка — чистильщик старой строки (n1411); второй реализации для согласования нет") },
  n1506: { reach: seedEntry("the owner runs the command") },
  n1511: { reach: seedEntry("the owner runs the command") },
  n1788: { reach: seedEntry("the owner runs the command") },
  n1789: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
