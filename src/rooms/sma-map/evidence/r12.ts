// Region 12 · Supervisor — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The supervisor's nodes write no hub row: the drills judge scenes, the watchdog and its startup entries are shell, the guides are text. Their trace is
// their own prove() line in the region scene scripts/lp_drill/scenes/sma_r12.py (it runs the real scene code, the real watchdog script and the guide).
import { distort, drill, entry, flip, skipWrite, type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

const WATCH = "scripts/hub-watchdog.sh";
const DOCS = "docs/watchdog.md";
const WRITERS = "scripts/lp_drill/scenes/writers.py";
const WORKER = "src/rooms/verification/worker-user.ts";
const PRESENCE = "src/rooms/owner-presence/logic.ts";
const DRILL = "the owner or the deploy runs the drill (lp-drill.sh, a suite or --scenario)";
const ENTRY_INSTALL = "the owner installs the watchdog (hub-watchdog.sh install or print-unit)";
const ENTRY_GUIDE = "the owner follows docs/watchdog.md to put the watchdog under the machine's scheduler";

export default {
  n994: { mutation: flip(WRITERS, "bool(checks) and all(", "bool(checks) or all("), reach: entry(DRILL), trace: drill("sma_r12") },
  n995: { mutation: flip(WRITERS, 'if answer["state"] != "accepted":', 'if answer["state"] == "accepted":'), reach: entry(`${DRILL} with --series`), trace: drill("sma_r12") },
  n996: { mutation: flip("scripts/lp_drill/scenes/owner.py", 'if red_row["state"] == "accepted":', 'if red_row["state"] != "accepted":'), reach: entry(DRILL), trace: drill("sma_r12") },
  n997: { mutation: flip("scripts/lp_drill/scenes/revert.py", 'r.get("kind") == "revert" and r.get("state") == "merged"', 'r.get("kind") == "revert" and r.get("state") != "merged"'), reach: entry(DRILL), trace: drill("sma_r12") },
  n998: { mutation: flip("scripts/lp_drill/scenes/skills.py", "if before.get(path) != after.get(path)]", "if before.get(path) == after.get(path)]"), reach: entry(DRILL), trace: drill("sma_r12") },
  n999: { mutation: flip("scripts/lp_drill/scenes/hub_outage.py", 'if named != "lp-drill-door":', 'if named == "lp-drill-door":'), reach: entry(`${DRILL} (the live pass: --scenario outage_live with LP_DRILL_WATCHDOG_LIVE=1)`), trace: drill("sma_r12") },
  n1000: { mutation: flip(WRITERS, 'accepted = all(t["state"] == "accepted" for t in tasks)', 'accepted = any(t["state"] == "accepted" for t in tasks)'), reach: entry(DRILL), trace: drill("sma_r12") },
  n1001: { mutation: distort(WATCH, 'record "lift" "try $try, killing pid ${pid:-none}"', 'record "lift" "try $try, killing pid none"'), reach: entry(`${DRILL} (the watchdog scenes)`), trace: drill("sma_r12") },
  n1002: { mutation: distort(WORKER, "d:u:${owner}:rwX`, dir] }];", 'd:u:${owner}:rwX`, join(dir, "..")] }];'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r12") },
  n1003: { mutation: distort(WORKER, "JSON.stringify({ at: Date.now(), user, owner, path: dir })", "JSON.stringify({ at: Date.now(), user, owner, path: user })"), reach: entry("a check runs as the separate worker user (worker.strict_user) and its run folder is granted"), trace: drill("sma_r12") },
  n1004: { voidReview: voidStays("постоянного процесса-бегуна под пользователем работника нет: каждая проверка запускается от него разово через sudo -n -u (asWorker), перезапускать нечего") },
  n1005: { mutation: distort(WATCH, 'echo "launchctl kickstart -k gui/$(id -u)/$SERVICE";', 'echo "launchctl kickstart gui/$(id -u)/$SERVICE";'), reach: seedEntry("the owner runs the command"), voidReview: voidIsHave("назначение обёртки старта (поднять сервер, дождаться ответа, не запускать второй, журнал по дням) выполняет сторож хаба: lift через systemd/launchd, ожидание двери, замок одного экземпляра, строки журнала по дням"), trace: drill("sma_r12") },
  n1006: { mutation: distort(WATCH, 'record "lift_skipped" "the door already answers"', 'record "lift" "the door already answers"'), reach: entry("the owner runs the lift verb (hub-watchdog.sh lift) while the door answers"), trace: drill("sma_r12") },
  n1007: { voidReview: voidStays("Postgres нет, выбирать между двумя сценариями его запуска нечем") },
  n1008: { mutation: skipWrite(WATCH, '{ echo "missing: $db"; status=1; continue; }', '{ echo "missing: $db"; continue; }'), trace: drill("sma_r12") },
  n1009: { mutation: distort(WATCH, "ExecStart=/bin/bash $self run\nRestart=always\nRestartSec=30\n\n[Install]\nWantedBy=multi-user.target", "ExecStart=/bin/bash $self status\nRestart=always\nRestartSec=30\n\n[Install]\nWantedBy=multi-user.target"), reach: entry(ENTRY_INSTALL), trace: drill("sma_r12") },
  n1010: { mutation: skipWrite(WATCH, "Description=Lane Pilot hub watchdog (user)\n$(restart_cap_lines)\n", "Description=Lane Pilot hub watchdog (user)\n"), reach: entry(ENTRY_INSTALL), voidReview: voidIsHave("подъём при входе с ограничением рестартов: юнит сторожа (systemd/launchd) с задержкой и капом рестартов; для Windows — задача schtasks ONLOGON в docs/watchdog.md"), trace: drill("sma_r12") },
  n1011: { mutation: flip(WATCH, "<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>", "<key>RunAtLoad</key><true/><key>KeepAlive</key><false/>"), reach: entry(ENTRY_INSTALL), trace: drill("sma_r12") },
  n1012: { mutation: distort(DOCS, "ярлык в `shell:startup`", "ярлык в `shell:sendto`"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r12") },
  n1013: { mutation: distort(WATCH, 'count[(datetime.date.fromtimestamp(int(row["at"])).isoformat(), row["event"])] += 1', 'count[(datetime.date.fromtimestamp(int(row["at"])).isoformat(), row["event"])] += 2'), trace: drill("sma_r12") },
  n1014: { mutation: distort(WATCH, "<key>StandardOutPath</key><string>$STATE_DIR/hub-watchdog.log</string>", "<key>StandardOutPath</key><string>$STATE_DIR/elsewhere.log</string>"), trace: drill("sma_r12") },
  n1015: { mutation: distort(WATCH, 'echo "FAIL: $1"; fails=$((fails + 1)); fi; }', 'echo "FAIL: $1"; fails=$((fails + 2)); fi; }'), reach: entry("the owner installs the watchdog on a Mac (install ends with the selfcheck) or runs the selfcheck verb"), trace: drill("sma_r12") },
  n1016: { mutation: distort(DOCS, "/SC ONLOGON", "/SC DAILY"), reach: entry(ENTRY_GUIDE), voidReview: voidIsHave("руководство по постановке подъёма под планировщик есть: docs/watchdog.md (Linux, Mac и раздел Windows с schtasks ONLOGON), на русском"), trace: drill("sma_r12") },
  n1017: { mutation: distort(DOCS, "pro.vechkasov.lp-hub-watchdog.plist", "pro.vechkasov.lp-watchdog.plist"), reach: entry(ENTRY_GUIDE), trace: drill("sma_r12") },
  n1018: { mutation: flip(WATCH, '[ "$day" = "$(date +%F)" ] && return 0', '[ "$day" != "$(date +%F)" ] && return 0'), trace: drill("sma_r12") },
  n1019: { mutation: flip("scripts/lp-drill.py", 'if not (state / "outages-2023-11-15.jsonl").exists():', 'if (state / "outages-2023-11-15.jsonl").exists():'), reach: entry(`${DRILL} (--scenario watchdog)`), trace: drill("sma_r12") },
  n1020: { mutation: flip(PRESENCE, "kept.some((row) => row.threadId === mark.threadId && row.day === day)", "kept.some((row) => row.threadId === mark.threadId || row.day === day)"), trace: drill("sma_r12") },
  n1021: { mutation: flip(PRESENCE, "rows.filter((row) => row.day >= since)", "rows.filter((row) => row.day <= since)"), reach: entry("the owner reads the health report (its section «Work outside the daemon (7 days)»)"), trace: drill("sma_r12") },
  n1022: { mutation: flip(WATCH, '[ "$enc" = "UTF-8" ]', '[ "$enc" != "UTF-8" ]'), reach: seedEntry("the owner runs the command"), voidReview: voidIsHave("готовность базы — настоящий запрос (db_ready в сторожe), базу плагина создаёт и мигрирует BB при первом обращении"), trace: drill("sma_r12") },
  n1023: { mutation: flip(WATCH, '[ "$check" = "ok" ]', '[ "$check" != "ok" ]'), trace: drill("sma_r12") },
  n1024: { mutation: skipWrite("src/rooms/storage/database.ts", "bb.storage.migrate(db, [...options.migrations]);"), trace: drill("sma_r12") },
  n1025: { reach: seedEntry("the owner runs the command"), voidReview: voidStays("SQLite хранит текст в кодировке, выбранной при создании (BB создаёт UTF-8), старой очереди в другой кодировке нет — переносить нечего") },
  n1026: { voidReview: voidStays("защищает только перенос n1025: файл базы плагина нигде не подменяется, отказывать нечему") },
  n1027: { mutation: distort(WATCH, 'selfcheck" >&2; exit 2 ;;', 'selfcheck" >&2; exit 1 ;;'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r12") },
  n1028: { mutation: distort(WATCH, "printf 'StartLimitIntervalSec=3600\\nStartLimitBurst=%s\\n'", "printf 'StartLimitIntervalSec=3601\\nStartLimitBurst=%s\\n'"), trace: drill("sma_r12") },
  n1029: { mutation: distort(WATCH, 'flock -n 9 || { echo "another watchdog runs (lock $LOCK)";', 'flock -n 9 || { echo "another watchdog ran (lock $LOCK)";'), trace: drill("sma_r12") },
  n1030: { mutation: flip(WATCH, '[ "$(lifts_in_window)" -ge "$MAX_LIFTS_IN_WINDOW" ]', '[ "$(lifts_in_window)" -gt "$MAX_LIFTS_IN_WINDOW" ]'), reach: entry("the watchdog loop or the owner lifts a hung hub (hub-watchdog.sh lift) after earlier lifts in the same hour"), trace: drill("sma_r12") },
  n1031: { mutation: distort(WATCH, "no administrator rights (sudo -n refused): installing a user service instead", "no administrator rights (sudo refused): installing a user service instead"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r12") },
  n1032: { mutation: distort(WATCH, 'echo "@reboot /bin/bash $self run >>', 'echo "@reboot /bin/bash $self status >>'), trace: drill("sma_r12") },
  n1033: { mutation: distort(DOCS, "с той же командой.", "с другой командой."), trace: drill("sma_r12"), voidReview: voidIsHave("подъём сторожа при входе без прав администратора: user-юнит systemd/LaunchAgent; для Windows — ярлык в shell:startup (путь даёт сама Windows) в docs/watchdog.md") },
  n1034: { mutation: distort(WATCH, "<key>LP_WATCH_FIRST_SEC</key><string>120</string>", "<key>LP_WATCH_FIRST_SEC</key><string>12</string>"), trace: drill("sma_r12") },
  n1035: { mutation: distort(WATCH, 'print_unit mac "$self" > "$plist"', 'print_unit user "$self" > "$plist"'), reach: entry("the owner installs the watchdog on a Mac (hub-watchdog.sh install writes the LaunchAgent)"), trace: drill("sma_r12") },
} satisfies RegionEvidence;
