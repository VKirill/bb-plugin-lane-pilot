// Region 5 · Daemon life — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Batch a (n440–n471): one mutation per node; the trace of each is its own prove() line in scripts/lp_drill/scenes/sma_r05.py (no row is written to the
// hub database by these nodes). The cards describe the old daemon process; each node is proved by the part of Lane Pilot that serves it now.
// n469 (the window link) and n470 (the start failure text) are core-resident: their proof anchors are in bb-core, there is nothing here to mutate.
import { distort, drill, entry, flip, skipWrite, type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

const SERVER = "server.ts";
const OUTAGE = "src/rooms/outage/server/outage.ts";
const DATABASE = "src/rooms/storage/database.ts";
const CANARY = "src/rooms/stability/server/canary.ts";
const RECONCILE = "src/rooms/stability/server/reconcile.ts";

export default {
  n440: { mutation: distort(SERVER, 'bb.log.info("Lane Pilot PM-to-writer pipeline loaded");', 'bb.log.info("Lane Pilot PM-to-writer pipeline loading");'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r05") },
  n441: { mutation: flip(OUTAGE, "Math.abs(stop.at - outage.fromAt) < 10 * 60_000 ?", "Math.abs(stop.at - outage.fromAt) > 10 * 60_000 ?"), trace: drill("sma_r05") },
  n442: { mutation: skipWrite(SERVER, "registerCli(ctx, services, lanePilotMigrations);"), trace: drill("sma_r05") },
  n443: { mutation: distort("src/rooms/tasks/run-policy.ts", 'provider:configuredPool(settings["ops.pool_size"],"ops.pool_size",15),', 'provider:configuredPool(settings["ops.pool_size"],"ops.pool_size",14),'), trace: drill("sma_r05"), voidReview: voidIsHave("назначение «процесс живёт на одной копии настроек» выполняет снимок run_policy_json при создании прогона: правка настроек посреди прогона его не меняет") },
  n444: { mutation: distort(CANARY, "const VERSION: string = packageJson.version;", "const VERSION: string = `${packageJson.version}-x`;"), trace: drill("sma_r05") },
  n445: { mutation: flip(DATABASE, "if (options.validateSetting) settingValidators.set(db, options.validateSetting);", "if (!options.validateSetting) settingValidators.set(db, options.validateSetting as never);"), trace: drill("sma_r05") },
  n446: { mutation: flip("src/rooms/storage/attempts-store/lifecycle.ts", 'AND task_id=? ORDER BY attempt_no")', 'AND task_id=? ORDER BY attempt_no DESC")'), trace: drill("sma_r05") },
  n447: { mutation: skipWrite("src/rooms/storage/tasks-store.ts", 'db.prepare("INSERT INTO lane_pilot_task_transition(task_id,field,reason,at) VALUES(?,?,?,?)").run(taskId, field, reason, Date.now());'), trace: drill("sma_r05") },
  n448: { mutation: distort("src/rooms/relay/server/outbound.ts", "version += 1;", "version += 2;"), trace: drill("sma_r05") },
  n449: { mutation: flip("src/rooms/runs/server/task-board.ts", "return items.sort((a, b) => b.updatedAt - a.updatedAt);", "return items.sort((a, b) => a.updatedAt - b.updatedAt);"), trace: drill("sma_r05") },
  n450: { mutation: skipWrite("src/rooms/core/server/rpc.ts", "...canaryRpc(services.canary),"), trace: drill("sma_r05") },
  n451: { mutation: flip("src/rooms/platform/server/tick-deps.ts", "services[name] === undefined || services[name] === null", "services[name] === undefined && services[name] === null"), trace: drill("sma_r05") },
  n452: { mutation: distort("src/rooms/platform/server/schedules.ts", 'isolated: true, timeoutMs: options.timeoutMs, overlap: "skip"', 'isolated: true, timeoutMs: options.timeoutMs, overlap: "queue"'), trace: drill("sma_r05"), voidReview: voidIsHave("тик заменяют расписания плагина в планировщике ядра BB (изолированный проход, пропуск при незавершённом предыдущем) плюс события") },
  n453: { mutation: skipWrite(SERVER, 'await step("canary start", () => services.canary.noteStart());'), trace: drill("sma_r05") },
  n454: { mutation: distort(DATABASE, "bb.storage.migrate(db, [...options.migrations]);", "bb.storage.migrate(db, [...options.migrations].slice(0, -1));"), trace: drill("sma_r05") },
  n455: { mutation: flip(DATABASE, 'db.pragma("foreign_keys = ON");', 'db.pragma("foreign_keys = OFF");'), trace: drill("sma_r05") },
  n456: { mutation: skipWrite(SERVER, "registerRpc(ctx, services, rpcContract);"), trace: drill("sma_r05") },
  n457: { mutation: distort(OUTAGE, "pid: process.pid, node: process.version", "pid: process.pid + 1, node: process.version"), trace: drill("sma_r05") },
  n459: { mutation: distort("src/rooms/stability/server/stability.ts", "fault («${open.fingerprint}»)", "fault («${open.version}»)"), trace: drill("sma_r05") },
  n460: { mutation: flip(RECONCILE, "if (again.resumed) {", "if (!again.resumed) {"), trace: drill("sma_r05") },
  n461: { mutation: flip("src/rooms/runs/server/run-finish.ts", 'if (saved.status === "failed") { bb.log.warn(', 'if (saved.status !== "failed") { bb.log.warn('), trace: drill("sma_r05") },
  n462: { mutation: flip(RECONCILE, "Date.now() - (attemptUpdatedAt(db, row.id) ?? 0) < RECHECK_AFTER_MS", "Date.now() - (attemptUpdatedAt(db, row.id) ?? 0) > RECHECK_AFTER_MS"), trace: drill("sma_r05") },
  n463: { mutation: flip(SERVER, 'if (!skipScans) await step("worktree sweep", sweepEnvironments);', 'if (skipScans) await step("worktree sweep", sweepEnvironments);'), trace: drill("sma_r05") },
  n464: { voidReview: voidStays("в Lane Pilot нет процессного «текущего проекта»: каждый RPC и проход несут projectId и читают базу, переставлять наблюдение при выборе проекта не на что") },
  n465: { mutation: flip("src/rooms/storage/settings-store.ts", "projectId === GLOBAL_SETTINGS_PROJECT_ID ? [] :", "projectId !== GLOBAL_SETTINGS_PROJECT_ID ? [] :"), trace: drill("sma_r05"), voidReview: voidIsHave("назначение «изменения настроек и памяти проекта подхватываются без перезапуска» выполняет чтение строк базы при каждом обращении (одна дверь записи), наблюдатель файлов не нужен") },
  n466: { mutation: flip("src/rooms/runs/conveyor.ts", "return state.on ? null :", "return !state.on ? null :"), trace: drill("sma_r05") },
  n467: { mutation: flip(CANARY, "readiness && ready ? pool.blocked.length === 0 : pool.works", "readiness && ready ? pool.blocked.length >= 0 : pool.works"), trace: drill("sma_r05") },
  n468: { mutation: distort(CANARY, "{ key, projectIds: [], reason: held.hold.reason }", "{ key, projectIds: [], reason: key }"), trace: drill("sma_r05") },
  n470: { voidReview: voidIsHave("сбой старта плагина ядро BB переводит в runtime status error с текстом причины (виден в BB); сетевой БД и строки подключения нет, SQLite открывает BB; готовность базы проверяет сторож (db_ready)") },
  n471: { mutation: distort(OUTAGE, 'reason: "the plugin was reloaded (a deploy or a settings change)"', 'reason: "the plugin was restarted"'), reach: entry("BB reloads or stops the plugin: a deploy, a settings change, the machine shutting down"), trace: drill("sma_r05") },
  n478: { voidReview: voidIsHave("заводские умолчания без файла настроек: модель по умолчанию на каждую роль, конвейер выключен, платный лимит ноль, дверь только локально; аккаунты и провайдеры — у BB") },
  n485: { voidReview: voidStays("настроек «только после перезапуска» нет (n484: все применяются сразу), значение в базе и рабочее значение не могут разойтись — показывать нечего") },
  n487: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
