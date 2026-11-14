// Region 5 · Daemon life — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

export default {
  n440: { reach: seedEntry("the owner runs the command") },
  n443: { voidReview: voidIsHave("назначение «процесс живёт на одной копии настроек» выполняет снимок run_policy_json при создании прогона: правка настроек посреди прогона его не меняет") },
  n452: { voidReview: voidIsHave("тик заменяют расписания плагина в планировщике ядра BB (изолированный проход, пропуск при незавершённом предыдущем) плюс события") },
  n464: { voidReview: voidStays("в Lane Pilot нет процессного «текущего проекта»: каждый RPC и проход несут projectId и читают базу, переставлять наблюдение при выборе проекта не на что") },
  n465: { voidReview: voidIsHave("назначение «изменения настроек и памяти проекта подхватываются без перезапуска» выполняет чтение строк базы при каждом обращении (одна дверь записи), наблюдатель файлов не нужен") },
  n470: { voidReview: voidIsHave("сбой старта плагина ядро BB переводит в runtime status error с текстом причины (виден в BB); сетевой БД и строки подключения нет, SQLite открывает BB; готовность базы проверяет сторож (db_ready)") },
  n478: { voidReview: voidIsHave("заводские умолчания без файла настроек: модель по умолчанию на каждую роль, конвейер выключен, платный лимит ноль, дверь только локально; аккаунты и провайдеры — у BB") },
  n485: { voidReview: voidStays("настроек «только после перезапуска» нет (n484: все применяются сразу), значение в базе и рабочее значение не могут разойтись — показывать нечего") },
  n487: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
