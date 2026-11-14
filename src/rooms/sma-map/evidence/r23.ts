// Region 23 · Templates, references, contexts — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, voidIsHave, voidStays, wfRun, wfStep } from "./types";

export default {
  n1625: { voidReview: voidStays("имён /gsd-* в Lane Pilot не было, старых фаз для моста нет; флаг установщика ушёл вместе с Claude Lane") },
  n1626: { voidReview: voidStays("меню стилей обсуждения (batch, auto, power…) ничего не охраняет; у фазы одна рубрика обсуждения (n1307)") },
  n1627: { voidReview: voidIsHave("ворота дрейфа и после слияния: исполнитель в своей worktree, слияние отказывает BASE_MOVED, если main сдвинулся мимо проверенного пакета; проверка после слияния в verification/finish") },
  n1628: { voidReview: voidStays("уровни подробности справки — выбор стиля; справка CLI одна и перечисляет все глаголы с примером (n1248)") },
  n1631: { trace: wfRun("lp.plan") },
  n1632: { voidReview: voidIsHave("способ мышления по ролям задают методы ролей: планировщик, аналитик, критик плана и кода, научная отладка, аудитор") },
  n1633: { trace: wfRun("web-research") },
  n1636: { voidReview: voidIsHave("вертикальный срез и нарезка историй: граф mvp-phase режет историю на куски плана с проверкой, lp.plan — на задачи с одним исходом") },
  n1640: { trace: wfRun("debug") },
  n1641: { trace: wfStep("lp.plan", "strategy") },
  n1645: { voidReview: voidIsHave("схема профиля (стек, тесты, выпуск, стиль работы) и порядок онбординга — шаги project-start, пишущие профиль") },
  n1647: { voidReview: voidStays("выбор из трёх форм SUMMARY.md ничего не охраняет; пишется одна короткая форма (templateFill, n1574)") },
  n1648: { voidReview: voidStays("шаблоны project-onboard убраны 2026-10-30, страницы по коду пишет ночной граф docs; читателя фиксированных семи форм карты кода нет") },
  n1649: { voidReview: voidStays("шаблоны форм исследования убраны 2026-10-30; анализ пишет lp.analyze, а стек, возможности и подводные камни отдельной формой не держатся") },
  n1652: { trace: wfStep("milestone-close", "record") },
} satisfies RegionEvidence;
