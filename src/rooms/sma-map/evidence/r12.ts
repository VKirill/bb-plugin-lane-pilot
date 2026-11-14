// Region 12 · Supervisor — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
import { type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

export default {
  n1002: { reach: seedEntry("the owner runs the command") },
  n1004: { voidReview: voidStays("постоянного процесса-бегуна под пользователем работника нет: каждая проверка запускается от него разово через sudo -n -u (asWorker), перезапускать нечего") },
  n1005: { reach: seedEntry("the owner runs the command"), voidReview: voidIsHave("назначение обёртки старта (поднять сервер, дождаться ответа, не запускать второй, журнал по дням) выполняет сторож хаба: lift через systemd/launchd, ожидание двери, замок одного экземпляра, строки журнала по дням") },
  n1007: { voidReview: voidStays("Postgres нет, выбирать между двумя сценариями его запуска нечем") },
  n1010: { voidReview: voidIsHave("подъём при входе с ограничением рестартов: юнит сторожа (systemd/launchd) с задержкой и капом рестартов; для Windows — задача schtasks ONLOGON в docs/watchdog.md") },
  n1012: { reach: seedEntry("the owner runs the command") },
  n1016: { voidReview: voidIsHave("руководство по постановке подъёма под планировщик есть: docs/watchdog.md (Linux, Mac и раздел Windows с schtasks ONLOGON), на русском") },
  n1022: { reach: seedEntry("the owner runs the command"), voidReview: voidIsHave("готовность базы — настоящий запрос (db_ready в сторожe), базу плагина создаёт и мигрирует BB при первом обращении") },
  n1025: { reach: seedEntry("the owner runs the command"), voidReview: voidStays("SQLite хранит текст в кодировке, выбранной при создании (BB создаёт UTF-8), старой очереди в другой кодировке нет — переносить нечего") },
  n1026: { voidReview: voidStays("защищает только перенос n1025: файл базы плагина нигде не подменяется, отказывать нечему") },
  n1027: { reach: seedEntry("the owner runs the command") },
  n1031: { reach: seedEntry("the owner runs the command") },
  n1033: { voidReview: voidIsHave("подъём сторожа при входе без прав администратора: user-юнит systemd/LaunchAgent; для Windows — ярлык в shell:startup (путь даёт сама Windows) в docs/watchdog.md") },
} satisfies RegionEvidence;
