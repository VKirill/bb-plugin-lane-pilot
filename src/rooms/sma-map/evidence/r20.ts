// Region 20 · Terminal coordination — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Where a node is a window (a lease and its claims live in the plugin's kv, git copies in temporary folders) it writes no row to the hub database:
// its trace is its own prove() line in scripts/lp_drill/scenes/sma_r20.py, two actors on one scratch state. Nodes that do write a row trace through it.
import { distort, drill, entry, flip, rows, skipWrite, wrongTarget, type RegionEvidence, seedEntry, voidIsHave, voidStays } from "./types";

const WINDOW = "src/rooms/verification/server/window.ts";
const GUESTS = "src/rooms/verification/server/checkout-guests.ts";
const MERGE = "src/rooms/verification/git-integrate/merge.ts";
const LIFE = "src/rooms/verification/git-integrate/worktree-lifecycle.ts";
const OUT = "src/rooms/relay/server/outbound.ts";
const ATOMIC = "src/rooms/platform/atomic-text.ts";
const SCENE = drill("sma_r20");

export default {
  n1517: { mutation: skipWrite(WINDOW, "for (const hit of collisions) lines.push(`  collision: ${hit.a} overlaps ${hit.b} (${hit.kind})`);"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1518: { mutation: distort(GUESTS, "const entry: Guest = { threadId, at: now,", "const entry: Guest = { threadId, at: previous?.at ?? now,"), reach: seedEntry("the owner runs the command"), trace: SCENE, voidReview: voidIsHave("аренда окна продлевается сама: каждое сообщение владельца в папке проекта продлевает аренду чата на 6 ч, заявка — повторной заявкой; window status перечисляет живые") },
  n1519: { mutation: flip(WINDOW, "if (!result.ok) return { exitCode: 1, stderr: result.why };", "if (result.ok) return { exitCode: 1, stderr: result.why };"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1520: { mutation: flip(WINDOW, "if (found.claim.threadId !== threadId) return {", "if (found.claim.threadId === threadId) return {"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1521: { reach: seedEntry("the owner runs the command"), voidReview: voidStays("нумерованных артефактов нет: миграции — позиции в массиве под замком хешей, версия — одно поле; выдавать номер нечего (защита от гонки — n1537)") },
  n1522: { reach: seedEntry("the owner runs the command"), voidReview: voidStays("журнала выданных номеров нет, потому что номеров не выдают (n1521); пропуски и повторы ловят замок миграций и проверка публикации") },
  n1523: { mutation: skipWrite(WINDOW, "await forceClearClaim(kv, { path: found.path, name });"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1524: { mutation: wrongTarget("src/rooms/relay/server/relay.ts", "await deps.send(input.toThreadId, [", "await deps.send(input.fromThreadId, ["), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1525: { mutation: flip("scripts/test-changed.mjs", "basename(test).includes(stem) || pattern.test(texts.get(test)));", "basename(test).includes(stem) && pattern.test(texts.get(test)));"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1526: { mutation: distort("src/rooms/phase/server/driver-methods-inspect.ts", "sections.Decisions = [...own.Decisions ?? [], `", "sections.Decisions = [`"), reach: seedEntry("the owner runs the command"), trace: SCENE, voidReview: voidIsHave("глагол `phase state` пишет позицию, решения и блокеры одной строкой в собственный блок STATE.md, не трогая текст человека") },
  n1527: { mutation: distort("src/rooms/phase/server/auto-stages.ts", '!tried("plan")) return { kind: "plan" };', '!tried("plan")) return { kind: "check" };'), reach: seedEntry("the owner runs the command"), trace: rows("lane_pilot_phase", "updated_at", "json_extract(record_json, '$.plan.sha') IS NOT NULL") },
  n1528: { mutation: flip("src/rooms/writer/server/writer-handoff.ts", "const gitStatus = ran && ran.exitCode === 0 ?", "const gitStatus = ran && ran.exitCode !== 0 ?"), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1529: { mutation: flip(OUT, "if (!/^https:\\/\\/[^\\s]+$/.test(url)) return false;", "if (!/^https?:\\/\\/[^\\s]+$/.test(url)) return false;"), reach: seedEntry("the owner runs the command"), trace: SCENE, voidReview: voidIsHave("статус наружу по явному списку полей: вебхук events.webhook_url получает события (owner.waiting, конец задачи) ровно с девятью несекретными полями; владельца вне экрана будит пуш") },
  n1530: { mutation: skipWrite(LIFE, 'if(input.taskId) await git(repoRoot,["config","--local",`branch.${branch}.laneTask`,input.taskId]);'), reach: seedEntry("the owner runs the command"), trace: rows("lane_pilot_worktree", "created_at", "owner_kind = 'attempt'") },
  n1531: { mutation: distort(MERGE, 'return {status:"conflict",commit:null,conflicts,reason:merged.reason.split("\\n").slice(-4).join("\\n")};', 'return {status:"conflict",commit:null,conflicts:[],reason:merged.reason.split("\\n").slice(-4).join("\\n")};'), reach: seedEntry("the owner runs the command"), trace: rows("lane_pilot_attempt_change", "recorded_at", "outcome = 'merged'") },
  n1532: { mutation: flip(MERGE, 'if(dirty.stdout.trim()) return fail("dirty",', 'if(!dirty.stdout.trim()) return fail("dirty",'), reach: seedEntry("the owner runs the command"), trace: SCENE },
  n1533: { reach: seedEntry("the owner runs the command") },
  n1534: { mutation: distort(WINDOW, "for (const guest of await listGuests(kv as never, path, now))", "for (const guest of await listGuests(kv as never, path))"), trace: SCENE },
  n1535: { mutation: flip(WINDOW, "const holder = live.find((row) => row.threadId !== input.threadId &&", "const holder = live.find((row) => row.threadId === input.threadId &&"), trace: SCENE },
  n1536: { mutation: flip(WINDOW, "if (ownsPathsOverlap([...list[i]!.globs], [...task.globs])) out.push", "if (!ownsPathsOverlap([...list[i]!.globs], [...task.globs])) out.push"), trace: SCENE },
  n1537: { mutation: distort("src/rooms/migrations.ts", "ADD COLUMN pass TEXT NOT NULL DEFAULT 'hourly'", "ADD COLUMN pass TEXT NOT NULL DEFAULT 'daily'"), trace: SCENE, voidReview: voidIsHave("гонку номеров снимает замок миграций (каждый оператор на своём индексе, новый только в конец с хешем), пушить исполнители не могут, владелец пушит один через lp-ship") },
  n1538: { mutation: flip(WINDOW, 'if (holder.threadId !== input.threadId) return { ok: false, code: "not_holder"', 'if (holder.threadId === input.threadId) return { ok: false, code: "not_holder"'), trace: SCENE, voidReview: voidIsHave("назначение «журнал заявок нельзя подделать окном» выполняет хранение заявок в kv плагина на хабе вне дерева чатов; отпустить или поменять чужую заявку нельзя (not_holder)") },
  n1539: { mutation: distort(WINDOW, "paths: status ? [...status].slice(0, 50) : []", "paths: status ? [...status].slice(0, 51) : []"), trace: SCENE },
  n1540: { mutation: flip(WINDOW, '{ name: "outcome", ok: outcome !== "abandoned", detail: outcome }', '{ name: "outcome", ok: outcome === "abandoned", detail: outcome }'), trace: SCENE },
  n1541: { mutation: distort(LIFE, "?head.stdout.trim():null};", "?head.stdout.trim().toUpperCase():null};"), trace: rows("lane_pilot_worktree", "created_at", "owner_kind = 'attempt'") },
  n1542: { mutation: flip(MERGE, '&&!(await git(input.worktreePath,["merge-base","--is-ancestor",before,target])).ok) return fail(', '&&(await git(input.worktreePath,["merge-base","--is-ancestor",before,target])).ok) return fail('), trace: SCENE },
  n1543: { mutation: flip("src/rooms/verification/server/integration-gate.ts", 'if (input.trigger === "drain") this.drainWaiting.set(key, input);', 'if (input.trigger !== "drain") this.drainWaiting.set(key, input);'), trace: rows("lane_pilot_gate_run", "updated_at", "state IN ('passed', 'failed')") },
  n1544: { mutation: skipWrite(MERGE, 'await git(input.worktreePath,["merge","--abort"]);'), trace: SCENE },
  n1545: { mutation: distort("src/rooms/phase/stages.ts", "`${existing}${eol}${eol}${block}`", "`${existing}${eol}${block}`"), trace: SCENE, voidReview: voidIsHave("оспариваемые зоны STATE.md пишет только блок команды: смена стадии переписывает свой блок, ручной текст сохраняется байт в байт") },
  n1546: { mutation: flip("src/rooms/storage/stages-store.ts", 'WHERE run_id=? AND task_id=? ORDER BY id")\n    .all(runId, taskId) as Array<{ stage_id: string; state: string; occurred_at: number }>;', 'WHERE run_id=? AND task_id=? ORDER BY id DESC")\n    .all(runId, taskId) as Array<{ stage_id: string; state: string; occurred_at: number }>;'), trace: rows("lane_pilot_stage_event", "occurred_at", "state = 'passed'") },
  n1547: { mutation: distort("src/rooms/session-hooks/logic.ts", "asks: input.asks.slice(-5).map", "asks: input.asks.slice(0, 5).map"), trace: SCENE },
  n1548: { mutation: distort(OUT, "String(value).slice(0, 200)", "String(value).slice(0, 201)"), trace: SCENE, voidReview: voidIsHave("полезная нагрузка наружу собирается только по явному списку ключей: taskEventBody берёт девять полей EVENT_FIELDS, лишнее отбрасывает и обрезает значения") },
  n1549: { mutation: distort(OUT, "projectId, at: input.at ?? Date.now() });", "projectId, at: Date.now() });"), trace: SCENE },
  n1550: { voidReview: voidIsHave("строка запроса не становится учётными данными, кроме одного обмена: одноразовый код сопряжения BB меняется на сессионный cookie владельца, окна Lane Pilot открываются внутри неё") },
  n1551: { mutation: distort("src/rooms/cockpit/server.ts", "    partial: failed,", "    partial: [] as string[],"), trace: SCENE },
  n1552: { mutation: flip("scripts/test-changed.mjs", "named.test(texts.get(test)));", "!named.test(texts.get(test)));"), trace: SCENE },
  n1553: { mutation: distort("src/rooms/critique/code-critique.ts", "sha256Hex(text).slice(0, 6)", "sha256Hex(text).slice(0, 5)"), trace: SCENE },
  n1554: { mutation: flip(ATOMIC, "if (attempt >= tries || !code", "if (attempt > tries || !code"), reach: entry("a page, a text or a machine job is written to disk through atomicText"), trace: SCENE },
  n1555: { mutation: distort(GUESTS, "previous?.providerId ? { providerId: previous.providerId } : {}", "previous?.providerId ? { providerId: opts.providerId } : {}"), trace: SCENE },
  n1556: { mutation: distort(WINDOW, '(input.description ?? "").slice(0, 300)', '(input.description ?? "").slice(0, 301)'), trace: SCENE },
  n1557: { mutation: flip("src/rooms/storage/stages-store.ts", 'FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? ORDER BY id")', 'FROM lane_pilot_gate_event WHERE run_id=? AND task_id=? ORDER BY id DESC")'), trace: rows("lane_pilot_gate_event", "occurred_at", "status IN ('passed', 'rejected')") },
  n1558: { mutation: distort(WINDOW, '{ name: "base", ok: true, detail: found.claim.base ?? "unknown" }', '{ name: "base", ok: true, detail: found.claim.base ?? "none" }'), trace: SCENE, voidReview: voidIsHave("след окна (основа, изменённые файлы, исход) пишется одной записью при отпуске заявки — это и есть попытки окна человека") },
  n1559: { mutation: distort("src/rooms/session-hooks/logic.ts", "files: input.files.slice(0, 30),", "files: input.files.slice(0, 31),"), trace: SCENE },
} satisfies RegionEvidence;
