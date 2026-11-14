// Region 21 · sma-tools: project queries — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, seedEntry, voidStays } from "./types";

export default {
  n1560: { reach: seedEntry("the owner runs the command") },
  n1562: { voidReview: voidStays("удобство разбора команды sma-tools («state.update» и «state update»); глаголы Lane Pilot — одно слово, шаги графа — типизированные действия, сопоставлять нечего") },
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
  n1578: { reach: seedEntry("the owner runs the command"), voidReview: voidStays("крючки отрисовки обслуживали убранный цикл (2026-10-30); точки расширения Lane Pilot — фиксированные шаги графа вроде lp.after-accept, правятся в самом графе") },
  n1581: { voidReview: voidStays("это самоописание SMA для её реестра возможностей, загрузчика здесь нет; Lane Pilot описывают созданный атлас и манифест плагина") },
  n1582: { reach: seedEntry("the owner runs the command") },
  n1583: { reach: seedEntry("the owner runs the command") },
  n1584: { reach: seedEntry("the owner runs the command") },
  n1585: { reach: seedEntry("the owner runs the command") },
  n1586: { reach: seedEntry("the owner runs the command") },
  n1588: { reach: seedEntry("the owner runs the command") },
  n1589: { voidReview: voidStays("единственный вызывающий — старый update.md, который SMA сама не подключила (n1788 upstream); обновление плагина ведут задачи установки BB") },
} satisfies RegionEvidence;
