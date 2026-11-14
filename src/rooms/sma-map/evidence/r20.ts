// Region 20 · Terminal coordination — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

export default {
  n1517: { reach: seedEntry("the owner runs the command") },
  n1518: { reach: seedEntry("the owner runs the command"), voidReview: voidIsHave("аренда окна продлевается сама: каждое сообщение владельца в папке проекта продлевает аренду чата на 6 ч, заявка — повторной заявкой; window status перечисляет живые") },
  n1519: { reach: seedEntry("the owner runs the command") },
  n1520: { reach: seedEntry("the owner runs the command") },
  n1521: { reach: seedEntry("the owner runs the command"), voidReview: voidStays("нумерованных артефактов нет: миграции — позиции в массиве под замком хешей, версия — одно поле; выдавать номер нечего (защита от гонки — n1537)") },
  n1522: { reach: seedEntry("the owner runs the command"), voidReview: voidStays("журнала выданных номеров нет, потому что номеров не выдают (n1521); пропуски и повторы ловят замок миграций и проверка публикации") },
  n1523: { reach: seedEntry("the owner runs the command") },
  n1524: { reach: seedEntry("the owner runs the command") },
  n1525: { reach: seedEntry("the owner runs the command") },
  n1526: { reach: seedEntry("the owner runs the command"), voidReview: voidIsHave("глагол `phase state` пишет позицию, решения и блокеры одной строкой в собственный блок STATE.md, не трогая текст человека") },
  n1527: { reach: seedEntry("the owner runs the command") },
  n1528: { reach: seedEntry("the owner runs the command") },
  n1529: { reach: seedEntry("the owner runs the command"), voidReview: voidIsHave("статус наружу по явному списку полей: вебхук events.webhook_url получает события (owner.waiting, конец задачи) ровно с девятью несекретными полями; владельца вне экрана будит пуш") },
  n1530: { reach: seedEntry("the owner runs the command") },
  n1531: { reach: seedEntry("the owner runs the command") },
  n1532: { reach: seedEntry("the owner runs the command") },
  n1533: { reach: seedEntry("the owner runs the command") },
  n1537: { voidReview: voidIsHave("гонку номеров снимает замок миграций (каждый оператор на своём индексе, новый только в конец с хешем), пушить исполнители не могут, владелец пушит один через lp-ship") },
  n1538: { voidReview: voidIsHave("назначение «журнал заявок нельзя подделать окном» выполняет хранение заявок в kv плагина на хабе вне дерева чатов; отпустить или поменять чужую заявку нельзя (not_holder)") },
  n1545: { voidReview: voidIsHave("оспариваемые зоны STATE.md пишет только блок команды: смена стадии переписывает свой блок, ручной текст сохраняется байт в байт") },
  n1548: { voidReview: voidIsHave("полезная нагрузка наружу собирается только по явному списку ключей: taskEventBody берёт девять полей EVENT_FIELDS, лишнее отбрасывает и обрезает значения") },
  n1550: { voidReview: voidIsHave("строка запроса не становится учётными данными, кроме одного обмена: одноразовый код сопряжения BB меняется на сессионный cookie владельца, окна Lane Pilot открываются внутри неё") },
  n1558: { voidReview: voidIsHave("след окна (основа, изменённые файлы, исход) пишется одной записью при отпуске заявки — это и есть попытки окна человека") },
} satisfies RegionEvidence;
