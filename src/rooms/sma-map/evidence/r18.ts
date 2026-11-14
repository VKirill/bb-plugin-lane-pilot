// Region 18 · Claude Code session hooks — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// The hooks are programs a Claude Code session runs, and they write no row to the hub database: a node's trace is its own prove()
// line in the region scene scripts/lp_drill/scenes/sma_r18.py, which runs the real hook program (src/rooms/session-hooks/cli.ts) on real hook inputs.
import { distort, drill, entry, flip, type RegionEvidence, seedEntry, voidIsHave, voidStays, wrongTarget } from "./types";

const LOGIC = "src/rooms/session-hooks/logic.ts";
const CLI = "src/rooms/session-hooks/cli.ts";
const FIRES = "a Claude Code session of a Lane Pilot role fires the hook event";

export default {
  n1402: { mutation: flip(LOGIC, "catch { /* the exit is always zero */ }", "catch { run(); /* the exit is always zero */ }"), reach: entry(FIRES), trace: drill("sma_r18") },
  n1403: { mutation: flip("src/rooms/runs/server/task-reconcile.ts", ".filter((row) => !services.activeWriterTasks.has(`${row.run_id}:${row.task_id}`))", ".filter((row) => services.activeWriterTasks.has(`${row.run_id}:${row.task_id}`))"), reach: entry("the periodic task reconcile pass runs (every minute, no one asks)"), trace: drill("sma_r18") },
  n1404: { mutation: flip("src/rooms/contracts/ownership.ts", "|| !task.owns_paths.some((pattern) => matches(pattern, path))) unowned.push(rawPath);", "|| task.owns_paths.some((pattern) => matches(pattern, path))) unowned.push(rawPath);"), reach: entry("a writer attempt is checked at the work boundary (barrier or final gate)"), trace: drill("sma_r18") },
  n1405: { mutation: flip("src/rooms/stability/server/rate-limit-watch.ts", 'if (rl?.kind !== "subscription-window" ||', 'if (rl?.kind === "subscription-window" ||'), reach: entry("a provider reports a subscription-window limit event on any thread"), trace: drill("sma_r18") },
  n1406: { mutation: distort("src/rooms/verification/git-ownership.ts", "`${mergeBase.stdout.trim()}...${headSha}`", "`${headSha}...${headSha}`"), trace: drill("sma_r18") },
  n1407: { mutation: flip("src/rooms/storage/attempts-store/project-reads.ts", "'cancel_requested') AND updated_at < ?`)", "'cancel_requested') AND updated_at > ?`)"), trace: drill("sma_r18") },
  n1408: { mutation: flip("src/rooms/stability/server/worktree-janitor.ts", "if (await ownerAlive(ctx, row, now)) continue;", "if (!(await ownerAlive(ctx, row, now))) continue;"), trace: drill("sma_r18") },
  n1409: { mutation: distort(LOGIC, 'files.slice(0, 20).join(", ") || "nothing"', 'files.slice(1, 20).join(", ") || "nothing"'), trace: drill("sma_r18") },
  n1410: { mutation: distort("src/rooms/usage/statusline-segment.ts", '.join(" - ")}`;', '.join(" / ")}`;'), trace: drill("sma_r18"), voidReview: voidIsHave("сегмент строки состояния — чистая функция над кешем окон подписки (usageSegment), печатается глаголом bb lane-pilot statusline <host>; claim/коллизии в него не входят") },
  n1411: { mutation: flip("src/rooms/native-install/claude-lane-leftovers.ts", "&& !commandPointsAt((options.saved as { command: string }).command, home, STATUSLINE_SUFFIX) ? options.saved : null;", "&& commandPointsAt((options.saved as { command: string }).command, home, STATUSLINE_SUFFIX) ? options.saved : null;"), reach: entry("the owner runs the Claude Lane leftovers removal (bb lane-pilot remove-claude-lane --apply)"), trace: drill("sma_r18"), voidReview: voidIsHave("строка человека не заменяется: чистильщик снимает только statusLine старого lane-statusline и восстанавливает сохранённую строку человека байт в байт; чужую строку не трогает") },
  n1413: { mutation: flip(LOGIC, "input.lastModel !== input.model", "input.lastModel === input.model"), reach: entry(FIRES), trace: drill("sma_r18") },
  n1414: { mutation: distort(LOGIC, "!given.has(String(hit.id))).slice(0, 3);", "!given.has(String(hit.id))).slice(0, 1);"), reach: entry(FIRES), trace: drill("sma_r18") },
  n1416: { mutation: flip("src/rooms/forecast/logic.ts", "rows.filter((row) => row.model === model)", "rows.filter((row) => row.model !== model)"), trace: drill("sma_r18") },
  n1417: { mutation: flip(LOGIC, 'if (input.merge) parts.push("a merge into main is running");', 'if (!input.merge) parts.push("a merge into main is running");'), trace: drill("sma_r18") },
  n1418: { mutation: wrongTarget("src/rooms/learning/pm-rules.ts", "const block = pmRulesBlock(pmRulesOf(db, projectId, chain), budgetTokens);", "const block = pmRulesBlock(pmRulesOf(db, projectId, []), budgetTokens);"), trace: drill("sma_r18") },
  n1419: { mutation: flip("src/rooms/forecast/server/report.ts", ".filter((area) => area.tasks < 3 || area.firstTryHit < 0.5)", ".filter((area) => area.tasks > 3 || area.firstTryHit < 0.5)"), trace: drill("sma_r18") },
  n1420: { mutation: flip("src/rooms/policy/protections.ts", "if (!disarm || disarm.until > now || disarm.until < since) continue;", "if (!disarm || disarm.until < now || disarm.until < since) continue;"), trace: drill("sma_r18") },
  n1421: { mutation: distort("src/rooms/tools/server/self-improve.ts", "    entry.count += 1;", "    entry.count += 2;"), trace: drill("sma_r18") },
  n1422: { mutation: flip(LOGIC, 'lines > 170 ? " — near the limit: merge or trim entries" : ""', 'lines > 190 ? " — near the limit: merge or trim entries" : ""'), trace: drill("sma_r18") },
  n1423: { mutation: flip(LOGIC, "if (input.capsule && input.capsuleFirst) parts.push(capsuleRestored(input.capsule));", "if (input.capsule && !input.capsuleFirst) parts.push(capsuleRestored(input.capsule));"), trace: drill("sma_r18") },
  n1424: { mutation: flip(LOGIC, "if (!text && !extra) return null;", "if (!text || !extra) return null;"), trace: drill("sma_r18") },
  n1425: { mutation: flip("packages/memory-core/src/store.ts", "concepts.join(\" \"));\n  if (trigramReady(db)) db", "concepts.join(\" \"));\n  if (!trigramReady(db)) db"), trace: drill("sma_r18") },
  n1426: { mutation: wrongTarget(CLI, '"--query", query]', '"--query", promptText]'), trace: drill("sma_r18") },
  n1427: { mutation: flip(LOGIC, "hit.id && !given.has(String(hit.id))", "hit.id && given.has(String(hit.id))"), trace: drill("sma_r18") },
  n1428: { mutation: distort(LOGIC, '.replace(/\\s+/g, " ").slice(0, 120);', '.replace(/\\s+/g, " ").slice(0, 0);'), trace: drill("sma_r18") },
  n1429: { mutation: distort(LOGIC, "const lessons = (input.lessons ?? []).filter(Boolean).map((lesson) => lesson.slice(0, 200)).slice(0, 5);", "const lessons = (input.lessons ?? []).filter(Boolean).map((lesson) => lesson.slice(0, 200)).slice(0, 0);"), reach: entry(FIRES), trace: drill("sma_r18") },
  n1430: { mutation: wrongTarget(LOGIC, "files: input.files.slice(0, 30),", "files: input.claims.slice(0, 30),"), reach: entry(FIRES), trace: drill("sma_r18") },
  n1431: { mutation: flip(LOGIC, "!changed.has(path) && !input.exists(path)", "!changed.has(path) && input.exists(path)"), reach: entry(FIRES), trace: drill("sma_r18") },
  n1432: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1433: { voidReview: voidIsHave("PreToolUse Task/Agent проверяет снимок окон подписки (поток spend) в том же процессе до сборки пакета; сверх порога, заданного человеком, порождение отклоняется") },
  n1434: { voidReview: voidIsHave("пакет субагента собирается из правил, заявок и уроков (subagent-pack); упавший глагол пакета оставляет прежний пакет репозитория и заявок, отказ updatedInput падает в additionalContext с записью деградации") },
  n1442: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1443: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1444: { reach: seedEntry("a Claude Code session event fires the hook") },
  n1445: { reach: seedEntry("a Claude Code session event fires the hook"), voidReview: voidStays("обёртки совместимости для старых имён команд не нужны: хуки пишутся заново на каждую сессию из сборки, старых установок с этими именами не бывает") },
  n1451: { voidReview: voidIsHave("ступень каждого правила (note/warning/soft-deny…) хранится и двигается по доказательствам (ruleTier, ruleLadderStep) — это и есть оверлей ступеней, без отдельного файла") },
  n1457: { voidReview: voidIsHave("чужие касания видны: старт сессии получает заявки других окон (session-brief foreign), отпечаток работы окна сверяется с задачами и заявками, пересечение owns_paths заставляет ждать") },
  n1787: { reach: seedEntry("a Claude Code session event fires the hook") },
} satisfies RegionEvidence;
