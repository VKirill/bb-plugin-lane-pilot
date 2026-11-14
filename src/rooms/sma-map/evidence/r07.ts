// Region 7 · Providers, models, accounts — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Batch b (n626 .. n656, 30 nodes; n628 is void): the same scene proves the nodes with no row of their own; the node ids n626 .. n656 are listed in the scene.
// Batch a (n596 .. n625): the nodes without a hub row of their own are proved by the region scene scripts/lp_drill/scenes/sma_r07.py; the capability
// nodes (n601, n607, n609) by the rows of the capability table. Core-resident, nothing to mutate here: n596, n597, n598, n612, n615, n616
// (their proof anchors are `core:` paths in bb-core).
import { distort, drill, entry, flip, rows, seedEntry, skipWrite, voidIsHave, voidStays, wrongTarget, type RegionEvidence } from "./types";

const HOLD = "src/rooms/writer/server/writer-hold.ts";
const WORKER = "src/rooms/verification/worker-user.ts";
const LOGIC = "src/rooms/capability/logic.ts";
const MODELS = "packages/models/src/role-models.ts";
const HOST = "src/rooms/native-agent/native-claude-host.ts";
const MONEY = "src/rooms/money/server.ts";
const PROBE = "src/rooms/native-agent/server/helper-probe.ts";

export default {
  n599: { mutation: flip("src/rooms/stability/server/worktree-janitor.ts", "return strictProjects.get(task.projectId) ? task.keys : [];", "return strictProjects.get(task.projectId) ? [] : task.keys;"), reach: entry("the hourly janitor sweep finds a task that ended a day ago in a project with worker.strict_user on", { "worker.strict_user": "on" }), trace: drill("sma_r07") },
  n600: { mutation: distort("src/rooms/host-worker/handlers/machine.ts", 'leanCodexConfig(disableCodexMemories(base), input.profile ?? "code")', 'leanCodexConfig(disableCodexMemories(base), input.profile ?? "open")'), trace: drill("sma_r07") },
  n601: { mutation: flip(LOGIC, "if (!version) continue;\n    if (CAPABILITIES.some(", "if (version) continue;\n    if (CAPABILITIES.some("), trace: rows("lane_pilot_capability", "at", "state IN ('supported','not_supported')") },
  n602: { mutation: flip("src/rooms/stability/server/canary.ts", "if (!entry.projectIds.includes(chain.projectId)) entry.projectIds.push(chain.projectId);", "if (entry.projectIds.includes(chain.projectId)) entry.projectIds.push(chain.projectId);"), trace: drill("sma_r07") },
  n603: { mutation: flip(HOLD, '&& row.state === "open");', '&& row.state !== "open");'), trace: drill("sma_r07") },
  n604: { mutation: flip("src/rooms/writer/server/verify.ts", 'String(checkSettings[SETTING_WORKER_STRICT_USER] ?? "off")==="on" ?', 'String(checkSettings[SETTING_WORKER_STRICT_USER] ?? "off")!=="on" ?'), trace: drill("sma_r07"),
    voidReview: voidIsHave("список строгих работников — проектная настройка worker.strict_user (+ worker.user): при on проверки идут от отдельного пользователя через sudo -n -u") },
  n605: { mutation: flip(WORKER, "return { ok: reachable.length === 0, reachable };", "return { ok: reachable.length !== 0, reachable };"), reach: seedEntry("the owner runs the command"), trace: drill("sma_r07") },
  n606: { mutation: distort(WORKER, 'args: ["-n", "-u", user, ...(keep.length', 'args: ["-u", user, "-n", ...(keep.length'), trace: drill("sma_r07") },
  n607: { mutation: flip(LOGIC, "if (result.answered === true || /helper_probe_", "if (result.answered === false || /helper_probe_"), reach: entry("the hourly capability sweep or the documentary gate runs a probe and reads its answer"), trace: rows("lane_pilot_capability", "at", "state IN ('supported','not_supported') AND capability = 'answers'") },
  n608: { mutation: wrongTarget(WORKER, '{ program: "/bin/chmod", args: ["-R", "+a", `user:${owner} allow ${rights}`, dir] },', '{ program: "/bin/chmod", args: ["-R", "+a", `user:${user} allow ${rights}`, dir] },'), trace: drill("sma_r07") },
  n609: { mutation: distort("src/rooms/native-agent/server/helper-probe.ts", 'workspace: { type: "unmanaged", path: config.writerWorkspacePath } },\n        pluginMetadata', 'workspace: { type: "unmanaged", path: config.pmWorkspacePath } },\n        pluginMetadata'), trace: rows("lane_pilot_capability", "at", "capability = 'answers' AND state = 'supported'") },
  n610: { mutation: flip("packages/kit/src/spawn-async.ts", "if(options.group) { groupSignal(", "if(!options.group) { groupSignal("), trace: drill("sma_r07"),
    voidReview: voidIsHave("все процессы проверки, включая осиротевшие фоновые, умирают с ней: spawnAsync group:true убивает группу процессов по таймауту и переполнению вывода (macOS/Linux)") },
  n611: { mutation: distort("packages/models/src/providers.ts", "supportsHookSettings: true, publishesUsageWindows: true }", "supportsHookSettings: true, publishesUsageWindows: false }"), reach: entry("a writer or a helper starts on the Claude Code provider"), trace: drill("sma_r07") },
  n613: { mutation: flip("src/rooms/money/logic.ts", 'PAID_PROVIDERS.has(providerId) || providerId.startsWith("api-")', 'PAID_PROVIDERS.has(providerId) && providerId.startsWith("api-")'), trace: drill("sma_r07") },
  n614: { mutation: wrongTarget(MODELS, "ROLE_TABLE.find((item) => item.id === rowId) ?? ROLE_TABLE[0]!;\n  const option", "ROLE_TABLE.find((item) => item.id !== rowId) ?? ROLE_TABLE[0]!;\n  const option"), reach: entry("a role asks for its built-in model (no owner row, no stage selection)"), trace: drill("sma_r07") },
  n617: { mutation: distort(HOLD, "writer_provider_unavailable:core_unsupported:${input.providerId}", "writer_provider_unavailable:core_unsupported:${input.model}"), trace: drill("sma_r07") },
  n618: { mutation: flip("src/rooms/critique/critic-pair.ts", "return offered(peer.providerId, peer.model) ? { pair: peer, changed: true }", "return !offered(peer.providerId, peer.model) ? { pair: peer, changed: true }"), reach: entry("a code critic is chosen for a finished task"), trace: drill("sma_r07") },
  n619: { mutation: distort(HOST, "a[k][ev]=list(a[k].get(ev,[]))+list(lst)", "a[k][ev]=list(lst)+list(a[k].get(ev,[]))"), trace: drill("sma_r07") },
  n620: { mutation: flip("src/rooms/secrets/server/secrets.ts", 'if (record.kind === "login" && record.access) {', 'if (record.kind !== "secret" && record.access) {'), reach: entry("a task names a catalog secret for its check"), trace: drill("sma_r07") },
  n621: { mutation: skipWrite("lane-stack/hooks/guard_shell.py", "answer.write_text(json.dumps(verdict))"), reach: seedEntry("a Claude Code session event fires the hook"), trace: drill("sma_r07") },
  n622: { mutation: distort("src/rooms/session-hooks/logic.ts", "asks: input.asks.slice(-5)", "asks: input.asks.slice(0, 5)"), reach: seedEntry("a Claude Code session event fires the hook"), trace: drill("sma_r07") },
  n623: { mutation: flip(HOST, "if not os.path.exists(_p): _why=", "if os.path.exists(_p): _why="), trace: drill("sma_r07") },
  n624: { mutation: distort(MODELS, '{ id: "pm-reader", default: { model: "claude-haiku-5-5", effort: "low",', '{ id: "pm-reader", default: { model: "claude-haiku-5-5", effort: "medium",'), trace: drill("sma_r07") },
  n625: { mutation: flip("src/rooms/writer/server/spawn.ts", "if (got.providerId && got.providerId !== selectedProviderId) {", "if (got.providerId && got.providerId === selectedProviderId) {"), trace: drill("sma_r07") },
  n626: { mutation: distort("src/rooms/writer/argv-builder.ts", '"--dangerously-bypass-approvals-and-sandbox", "--yolo"];', '"--dangerously-bypass-approvals-and-sandbox"];'), reach: entry("a writer or a helper launch assembles the lane CLI's argv"), trace: drill("sma_r07") },
  n627: { mutation: wrongTarget("src/rooms/contracts/helper-context.ts", "const profile = ROLE_PROFILES[role] ?? CUSTOM_SPECIALIST_PROFILE;\n  const base = group", "const profile = CUSTOM_SPECIALIST_PROFILE;\n  const base = group"), reach: entry("a helper starts in a role (a stage's agent, a critic, a specialist of the owner)"), trace: drill("sma_r07") },
  n628: { voidReview: voidStays("из пула воркеров задача роль не выбирает; писатель один (writer.provider/model) с цепочкой запасных, навыки задаёт правило по заявленным навыкам задачи и папке проекта") },
  n629: { mutation: flip("src/rooms/owner-presence/logic.ts", "now - mark.at > windowMs", "now - mark.at < windowMs"), reach: entry("the owner types a message in a thread of his own and a writer is about to start on that provider"), trace: drill("sma_r07") },
  n630: { mutation: flip(HOLD, "if (mark && now - mark.at <= PRESENCE_WINDOW_MS) {", "if (mark && now - mark.at > PRESENCE_WINDOW_MS) {"), reach: entry("a writer attempt asks the chain for a free member while the owner works in one of its providers"), trace: drill("sma_r07") },
  n631: { mutation: distort(HOLD, "wakeAt: timed.length ? Math.min(...timed) : null", "wakeAt: timed.length ? Math.max(...timed) : null"), trace: drill("sma_r07") },
  n632: { mutation: flip(HOLD, "  if (spent) {\n    const reset", "  if (!spent) {\n    const reset"), trace: drill("sma_r07") },
  n633: { mutation: flip(HOLD, "&& free && isPaid(free.member.providerId)) {", "&& free && !isPaid(free.member.providerId)) {"), trace: drill("sma_r07") },
  n634: { mutation: distort(MONEY, "return moneyHold(providerId, status().monthUsd, moneyCapFrom(settings()), taskUsd);", "return moneyHold(providerId, 0, moneyCapFrom(settings()), taskUsd);"), reach: entry("a writer attempt asks the money of the hub whether a paid member of its chain may start"), trace: drill("sma_r07") },
  n635: { mutation: wrongTarget(MONEY, 'const cap = capOf(settings()["money.monthly_cap_usd"]);', 'const cap = capOf(settings()["money.silent_estimate_tokens"]);'), trace: drill("sma_r07") },
  n636: { mutation: flip("src/rooms/money/logic.ts", "return Number.isFinite(cap) && cap > 0 ? cap : null;", "return Number.isFinite(cap) && cap >= 0 ? cap : null;"), trace: drill("sma_r07") },
  n637: { mutation: distort("src/rooms/cockpit/ui/screens-day.tsx", '"unlimited" : Number(cap), expectedVersion', '"unlimited" : Number(cap) * 100, expectedVersion'), trace: drill("sma_r07") },
  n638: { mutation: flip("src/rooms/money/logic.ts", "if (monthUsd >= cap) return", "if (monthUsd > cap) return"), trace: drill("sma_r07") },
  n639: { mutation: flip("src/rooms/money/logic.ts", 'return cap === null && switchOn(settings, "money.cap_unset_zero") ? 0 : cap;', 'return cap === null && !switchOn(settings, "money.cap_unset_zero") ? 0 : cap;'), trace: drill("sma_r07") },
  n640: { mutation: flip(HOLD, "const money = !isPaid(input.providerId) ? null : await", "const money = isPaid(input.providerId) ? null : await"), trace: drill("sma_r07") },
  n641: { mutation: distort(MONEY, "return price ? appetiteTokens * price.outputPerM / 1_000_000 : 0;", "return price ? appetiteTokens * price.inputPerM / 1_000_000 : 0;"), reach: entry("a paid-lane writer with a task appetite is about to start"), trace: drill("sma_r07") },
  n642: { mutation: flip("src/rooms/money/logic.ts", "if (!isPaid(providerId)) return null;\n  const list", "if (isPaid(providerId)) return null;\n  const list"), trace: drill("sma_r07") },
  n643: { mutation: flip("src/rooms/money/logic.ts", "if (row.day.startsWith(month)) {", "if (!row.day.startsWith(month)) {"), trace: drill("sma_r07") },
  n644: { mutation: distort("src/rooms/money/logic.ts", "byProvider[row.providerId] = (byProvider[row.providerId] ?? 0) + usd; }", "byProvider[row.providerId] = usd; }"), reach: entry("the money screen or a paid member's hold reads the spend book"), trace: drill("sma_r07") },
  n645: { mutation: distort(MONEY, "usd += tokens * (price.inputPerM + price.outputPerM) / 2 / 1_000_000;", "usd += tokens * (price.inputPerM + price.outputPerM) / 4 / 1_000_000;"), reach: entry("a paid-lane attempt ended without usage events and the spend book is read"), trace: drill("sma_r07") },
  n646: { mutation: distort("src/rooms/money/logic.ts", "Array.from({ length: 14 }, (_, index) => new Date(now - (13 - index)", "Array.from({ length: 13 }, (_, index) => new Date(now - (13 - index)"), reach: entry("the money screen is opened"), trace: drill("sma_r07") },
  n647: { mutation: wrongTarget("src/rooms/capability/server/capability.ts", "SANDBOX_PROJECT_ID, runId, item.providerId, item.model, capability)", "SANDBOX_PROJECT_ID, runId, item.providerId, item.providerId, capability)"), trace: drill("sma_r07") },
  n648: { mutation: flip("src/rooms/capability/server/capability.ts", 'return value !== "observe" && value !== "off";', 'return value === "observe" || value === "off";'), reach: entry("a documentary stage is about to spawn on a provider"), trace: drill("sma_r07") },
  n649: { mutation: wrongTarget(LOGIC, "provider.pluginId ? version.get(provider.pluginId) ?? null : null", "provider.pluginId ? version.get(provider.id) ?? null : null"), reach: entry("the hourly capability sweep or the documentary gate reads the installed adapters"), trace: drill("sma_r07") },
  n650: { mutation: distort(LOGIC, '"documentary.hooks", "documentary.session_end"];', '"documentary.hooks"];'), trace: drill("sma_r07") },
  n651: { mutation: flip(PROBE, 'return toolCallsText(Array.isArray(listed) ? listed : []).includes("lane-pilot status") ?', 'return !toolCallsText(Array.isArray(listed) ? listed : []).includes("lane-pilot status") ?'), trace: drill("sma_r07") },
  n652: { mutation: flip(PROBE, 'typeof output === "string" && /RESUMED/.test(output)', 'typeof output === "string" && !/RESUMED/.test(output)'), trace: drill("sma_r07") },
  n653: { mutation: flip(PROBE, "if (!confirm.stopped) return", "if (confirm.stopped) return"), trace: drill("sma_r07") },
  n654: { mutation: flip(PROBE, "&& !/(^|\\/)\\.lp-probe-/.test(path));", "&& /(^|\\/)\\.lp-probe-/.test(path));"), trace: drill("sma_r07") },
  n655: { mutation: distort("src/rooms/writer/progress-journal.ts", 'type !== "commandExecution") continue;', 'type !== "commandExecutionX") continue;'), trace: drill("sma_r07") },
  n656: { mutation: flip("src/rooms/design-eval/logic.ts", 'sa.score > sb.score ? "a" : "b"', 'sa.score < sb.score ? "a" : "b"'), reach: entry("a design-lead result or a skill change is compared as a pair"), trace: drill("sma_r07"),
    voidReview: voidIsHave("пару дизайнов судит независимый измеритель по рубрике (overflow, contrast, targets, …) без участия автора; выбор пары — design-pair-answer PM") },
  n657: { mutation: flip("src/rooms/design-eval/logic.ts", "return Math.min(r.width, r.height) < 44;", "return Math.min(r.width, r.height) > 44;"), trace: drill("sma_r07") },
  n658: { mutation: wrongTarget("src/rooms/writer/server/spawn-brief.ts", "parentPmThreadId:input.pmThreadId,", "parentPmThreadId:input.attemptId,"), trace: drill("sma_r07") },
  n659: { mutation: distort("src/rooms/native-agent/claude-guard-launch.ts", "`--max-turns ${Math.floor(input.maxTurns)}`", "`--max-turns ${Math.ceil(input.maxTurns)}`"), trace: drill("sma_r07") },
  n661: { mutation: distort("src/rooms/writer/argv-builder.ts", "else argv.push(token, value);", 'else argv.push(token, ...value.split(" "));'), reach: entry("a writer or a helper launch builds the lane CLI's argv from its required flags and settings"), trace: drill("sma_r07") },
  n662: { mutation: distort("src/rooms/platform/server/tool-result.ts", '"< /outside_data>"', '"</ outside_data>"'), reach: entry("a person's words or a tool's output are put into a prompt or a tool result"), trace: drill("sma_r07") },
  n663: { mutation: flip("src/rooms/writer/server/writer-task.ts", '...(previousAttempt ? [{ tag: "previous_attempt"', '...(!previousAttempt ? [{ tag: "previous_attempt"'), trace: drill("sma_r07") },
  n664: { mutation: distort("packages/harness-core/src/trajectory.ts", "if (tool) tools.set(tool, (tools.get(tool) ?? 0) + 1);", "if (tool) tools.set(tool, (tools.get(tool) ?? 0) + 2);"), reach: entry("a writer attempt ends and its thread's events are told in words for the next attempt and the progress file"), trace: drill("sma_r07") },
  n665: { mutation: flip("src/rooms/writer/server/start-writer-holds.ts", "if (walk.allUnsupported) {", "if (!walk.allUnsupported) {"), trace: drill("sma_r07") },
  n666: { mutation: distort("src/rooms/contracts/failure-class.ts", "export const SESSION_MAX_TURNS = 5;", "export const SESSION_MAX_TURNS = 6;"), trace: drill("sma_r07") },
  n667: { mutation: distort("src/rooms/usage/server/provider-usage.ts", "const worst = spent.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));", "const worst = spent.reduce((a, b) => (b.usedPercent < a.usedPercent ? b : a));"), reach: entry("a writer attempt asks the chain for a free member and the provider has a usage source"), trace: drill("sma_r07") },
  n668: { mutation: flip("src/rooms/stability/server/rate-limit-watch.ts", 'if (rl?.kind !== "subscription-window" ||', 'if (rl?.kind === "subscription-window" ||'), trace: drill("sma_r07") },
  n669: { mutation: distort("src/rooms/usage/server/provider-usage.ts", "new Date(Math.max(...resets)).toISOString()", "new Date(Math.min(...resets)).toISOString()"), reach: entry("an account window is spent and the chain holds the provider until its reset"), trace: drill("sma_r07") },
  n670: { mutation: flip("src/rooms/host-worker/handlers/machine.ts", 'if (typeof value?.utilization === "number") windows[key]', 'if (typeof value?.utilization !== "number") windows[key]'), trace: drill("sma_r07") },
  n671: { mutation: distort("src/rooms/usage/server/provider-usage.ts", 'window.kind === "five-hour" ? "five_hour" : window.kind === "weekly" ? "seven_day"', 'window.kind === "five-hour" ? "seven_day" : window.kind === "weekly" ? "five_hour"'), reach: entry("the money screen, the accounts board or a paid member's hold reads the account's windows"), trace: drill("sma_r07") },
  n672: { mutation: flip("src/rooms/usage/server/provider-usage.ts", "if (input.threshold <= 0) return null;\n  const serving", "if (input.threshold < 0) return null;\n  const serving"), reach: entry("a writer choice asks the provider's account window before it picks a member"), trace: drill("sma_r07") },
} satisfies RegionEvidence;
