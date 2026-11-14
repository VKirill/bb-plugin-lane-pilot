// Region 19 · Install, update, remove — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Installs, updates and removals happen on machines and write no hub row: a node's trace is its own prove() line in the region scene
// scripts/lp_drill/scenes/sma_r19.py, which runs the real install / remove code against a temp home folder (sma_r19_probe.ts).
// Nodes anchored in bb-core (n1474, n1477, n1483, n1495, n1496) are core-resident: the mutation is on Lane Pilot's own half of the behaviour.
import { distort, drill, entry, flip, type RegionEvidence, seedEntry, skipWrite, voidIsHave, voidStays, wrongTarget } from "./types";

const LEFT = "src/rooms/native-install/claude-lane-leftovers.ts";
const OWNED = "src/rooms/native-install/native-install-owned.ts";
const BOOT = "src/rooms/native-install/native-install-bootstrap.ts";
const GUARD = "src/rooms/native-install/guard-apply.ts";
const HOOKS = "src/rooms/native-agent/native-session-hooks.ts";

export default {
  n1464: { mutation: skipWrite(LEFT, "if (settingsChanged) await writeText(settingsPath, settings.text);"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r19") },
  n1465: { mutation: distort(LEFT, "codex: codex.removed, moved: moves, backupDir: null };", "codex: codex.removed, moved: [], backupDir: null };"), trace: drill("sma_r19") },
  n1466: { mutation: flip(LEFT, "const apply = input.apply === true;", "const apply = input.apply !== true;"), trace: drill("sma_r19") },
  n1467: { mutation: flip("src/rooms/tools/server/cli-host.ts", 'apply: args.includes("--apply"),', 'apply: !args.includes("--apply"),'), reach: seedEntry("the owner runs the command"), trace: drill("sma_r19") },
  n1468: { mutation: flip(LEFT, 'name.startsWith("lane-")', 'name.startsWith("lane_")'), trace: drill("sma_r19") },
  n1469: { mutation: wrongTarget(LEFT, 'const hooks = join(home, ".agents/hooks");', 'const hooks = join(home, ".agents/memory");'), reach: entry("the owner removes the old Claude Lane leftovers (bb lane-pilot remove-claude-lane-leftovers --apply, or the remove_claude_lane_leftovers RPC)"), trace: drill("sma_r19") },
  n1470: { mutation: distort(OWNED, "current.slice(0, start) + current.slice(finish + end.length + 1)", "current.slice(0, start) + current.slice(finish + end.length)"), trace: drill("sma_r19") },
  n1471: { mutation: wrongTarget(LEFT, "kept.push({ ...row, hooks: nested });", "kept.push(group);"), trace: drill("sma_r19") },
  n1472: { mutation: distort(LEFT, 'modify(next, ["statusLine"], saved ?? undefined, edit)', 'modify(next, ["statusLine"], undefined, edit)'), trace: drill("sma_r19") },
  n1473: { mutation: flip("src/rooms/native-install/native-install-lifecycle.ts", 'if (ctx.action === "remove") await ctx.kv.delete(key);', 'if (ctx.action !== "remove") await ctx.kv.delete(key);'), reach: entry("the owner removes the plugin in BB: the plugin lifecycle remove runs on every registered machine"), trace: drill("sma_r19"), voidReview: voidIsHave("после удаления плагина его графы, роли и навыки уходят вместе с управляемым артефактом BB, данные плагина удаляет ядро; остатки старого Claude Lane снимает removeClaudeLaneLeftovers") },
  n1474: { mutation: skipWrite(BOOT, "await cp(source, dest);"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r19") },
  n1475: { voidReview: voidStays("плагин ставится один раз в BB, не в проект; хуки пишутся в папку сессии, выбора «проект/глобально» у установки нет") },
  n1476: { mutation: flip(OWNED, "if (info?.isSymbolicLink()) throw new Error(`Managed install parent is a symlink: ${parent}`);", "if (!info?.isSymbolicLink()) throw new Error(`Managed install parent is a symlink: ${parent}`);"), trace: drill("sma_r19") },
  n1477: { mutation: flip(BOOT, "if (!await exists(ownedPmGuardPath(home))) return null;", "if (await exists(ownedPmGuardPath(home))) return null;"), trace: drill("sma_r19"), voidReview: voidIsHave("движок (графы, роли, шаблоны, навыки) ставит BB целиком одним управляемым артефактом задачей установки плагина") },
  n1478: { mutation: skipWrite(HOOKS, "next = next.split(path).join(copied);"), trace: drill("sma_r19"), voidReview: voidIsHave("команды хуков указывают в существующее место: хуки пишутся из сборки в папку сессии с абсолютным путём и привязкой к CLAUDE_PROJECT_DIR") },
  n1479: { mutation: wrongTarget(HOOKS, "python3 ${shellQuote(inject)} -- python3 ${shellQuote(guard)}`;", "python3 ${shellQuote(inject)} -- python3 ${shellQuote(guard + \".missing\")}`;"), trace: drill("sma_r19") },
  n1480: { mutation: distort("src/rooms/native-agent/native-agent-definition.ts", "prompt: input.compiled.prompt,", "prompt: input.compiled.description,"), trace: drill("sma_r19") },
  n1481: { mutation: distort("src/rooms/native-agent/employee-lessons.ts", 'lines.map((line) => `- ${line}`).join("\\n")}', 'lines.slice(0, 1).map((line) => `- ${line}`).join("\\n")}'), trace: drill("sma_r19") },
  n1482: { mutation: flip("packages/workflow-engine/src/router.ts", "&& !workflow.internal && !workflow.startedBy;", "&& workflow.internal && !workflow.startedBy;"), trace: drill("sma_r19"), voidReview: voidIsHave("курируемый список входов: роутер предлагает только published/tested и не internal графы, остальные — подграфы") },
  n1483: { mutation: flip("src/rooms/workflow/server/workflow-tools.ts", "if (workflow.internal) return refused(", "if (!workflow.internal) return refused("), trace: drill("sma_r19"), voidReview: voidIsHave("графы доступны человеку и PM без тонких SKILL.md: навыки плагина отдаются через корни навыков BB, графы запускаются lane_pilot_route / lane_pilot_run_workflow") },
  n1484: { voidReview: voidStays("навык на каждый граф не пишется, поэтому второй копии графа, которую надо держать пустой, нет; источник — сам workflows/*.json") },
  n1485: { voidReview: voidStays("команд чужого каркаса /gsd-* в Lane Pilot не было, старых фаз под эти имена нет — мост не нужен") },
  n1486: { mutation: distort(HOOKS, '"PreCompact", "SubagentStop", "PostToolUse", "SessionEnd"];', '"PreCompact", "PostToolUse", "SessionEnd"];'), trace: drill("sma_r19") },
  n1487: { mutation: distort(GUARD, "return `python3 '${path", "return `python '${path"), reach: entry("Lane Pilot provisions a PM workspace: the install applies the guard hook to its .claude/settings.json"), trace: drill("sma_r19") },
  n1488: { mutation: flip(GUARD, 'if (!tree || errors.length > 0 || tree.type !== "object")', 'if (!tree || errors.length < 0 || tree.type !== "object")'), trace: drill("sma_r19") },
  n1489: { mutation: flip(GUARD, 'modify(raw, ["hooks", "PreToolUse", -1], entry, {', 'modify(raw, ["hooks", "PreToolUse", 0], entry, {'), trace: drill("sma_r19") },
  n1490: { mutation: flip(GUARD, "const last = hits.at(-1);", "const last = hits.at(0);"), trace: drill("sma_r19") },
  n1491: { voidReview: voidStays("сессии Lane Pilot идут внутри BB через Agent SDK, который статусную строку не рисует; терминальный Claude Code Lane Pilot не запускает — ставить сегмент некуда (сам сегмент — n1410, глагол statusline)") },
  n1492: { mutation: flip("src/rooms/verification/git-integrate/task-folder.ts", 'grep -qxF -- "$l" "$f" 2>/dev/null && continue', 'grep -qxF -- "$l" "$f" 2>/dev/null || continue'), trace: drill("sma_r19") },
  n1493: { mutation: distort("src/rooms/migrations.ts", "fts5(id UNINDEXED, project_id UNINDEXED, content, concepts)", "fts5(id UNINDEXED, project_id UNINDEXED, content)"), trace: drill("sma_r19") },
  n1494: { mutation: flip("src/rooms/learning/pm-rules.ts", 'rule.audience !== "writer"', 'rule.audience === "writer"'), trace: drill("sma_r19") },
  n1495: { mutation: skipWrite("src/rooms/native-install/server/rpc/stack.ts", 'const receipt = { schemaVersion: 1, action: "install", status: "ok", native: result };\n      saveProjectSetting(db, projectId, SETTING_INSTALL_LAST_RECEIPT, JSON.stringify(receipt));', 'const receipt = { schemaVersion: 1, action: "install", status: "ok", native: result };'), trace: drill("sma_r19"), voidReview: voidIsHave("итог установки BB показывает в экране плагина по каждой задаче; по машинам наша установка сообщает статус или ошибку") },
  n1496: { mutation: skipWrite(LEFT, "if (await present(checkout)) paths.push(checkout);"), trace: drill("sma_r19") },
  n1497: { mutation: distort(HOOKS, "await writeFile(temp, NATIVE_HOOK_SOURCES[name], { mode: 0o644 });", 'await writeFile(temp, NATIVE_HOOK_SOURCES["guard_shell.py"], { mode: 0o644 });'), trace: drill("sma_r19") },
  n1498: { mutation: distort("src/rooms/native-agent/native-agent-definition.ts", "description: input.compiled.description,", "description: input.compiled.prompt,"), trace: drill("sma_r19") },
  // n1499, n1506, n1507 and n1510 - n1514 are core-resident (bb-core owns the skill roots, the update check, the version report, the git range, the registry and the local source): no mutation here.
  n1500: { mutation: wrongTarget(HOOKS, 'const settingsPath = join(input.destDir, "settings.json");', 'const settingsPath = join(cwd ? join(cwd, ".claude") : input.destDir, "settings.json");'), trace: drill("sma_r19") },
  // n1501 stays have: the state lives in the plugin's data.db (the migrate call makes the tables), never in the project folder.
  n1501: { mutation: skipWrite("src/rooms/storage/database.ts", "bb.storage.migrate(db, [...options.migrations]);"), trace: drill("sma_r19"), voidReview: voidIsHave("состояние времени выполнения (фазы, задачи, попытки, квитанции, заявки) лежит в базе плагина data.db на хабе, а не в папке проекта") },
  n1502: { mutation: distort("src/rooms/learning/pm-rules.ts", "lines.push(`- ${rule.rule}`);", "lines.push(`- ${rule.rule.slice(0, 12)}`);"), trace: drill("sma_r19") },
  n1503: { voidReview: voidStays("statusLine плагин не устанавливает (см. n1491), единственная правка — чистильщик старой строки (n1411); второй реализации для согласования нет") },
  n1504: { mutation: distort("src/rooms/migrations.ts", "kind TEXT NOT NULL CHECK(kind IN ('core','note')),", "kind TEXT NOT NULL CHECK(kind IN ('core','notes')),"), trace: drill("sma_r19") },
  n1505: { mutation: distort("src/rooms/learning/pm-rules.ts", "return pmRulesBlock(chosen, budget).text.trim() || null;", "return pmRulesBlock(chosen.slice(0, 1), budget).text.trim() || null;"), trace: drill("sma_r19") },
  n1506: { reach: seedEntry("the owner runs the command") },
  n1508: { mutation: flip("src/rooms/native-install/server/rpc/stack.ts", 'if (!confirmExternalOps) return { schemaVersion:1, action:"install"', 'if (confirmExternalOps) return { schemaVersion:1, action:"install"'), trace: drill("sma_r19") },
  n1509: { mutation: wrongTarget("src/rooms/native-install/server/rpc/stack.ts", "const result = await nativeInstaller.install(config.hostId);", "const result = await nativeInstaller.install(`${config.hostId}-x`);"), trace: drill("sma_r19") },
  n1510: { reach: entry("BB checks an installed plugin that came from a git source for newer tags (the periodic update check); no switch of ours") },
  n1511: { reach: seedEntry("the owner runs the command") },
  n1515: { mutation: flip(BOOT, "if (!await exists(dest)) {", "if (await exists(dest)) {"), reach: entry("BB updates the plugin or the owner presses install: the per-machine installer re-runs over a home that already has the owner's files"), trace: drill("sma_r19") },
  n1516: { mutation: flip(GUARD, "existingGuardHits(parsed, commandFor(guardPath)).length === 1;", "existingGuardHits(parsed, commandFor(guardPath)).length >= 1;"), trace: drill("sma_r19") },
  n1788: { reach: seedEntry("the owner runs the command") },
  n1789: { reach: seedEntry("the owner runs the command") },
} satisfies RegionEvidence;
