// Region 7 · Providers, models, accounts — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Batch a (n596 .. n625): the nodes without a hub row of their own are proved by the region scene scripts/lp_drill/scenes/sma_r07.py; the capability
// nodes (n601, n607, n609) by the rows of the capability table. Core-resident, nothing to mutate here: n596, n597, n598, n612, n615, n616
// (their proof anchors are `core:` paths in bb-core).
import { distort, drill, entry, flip, rows, seedEntry, skipWrite, voidIsHave, voidStays, wrongTarget, type RegionEvidence } from "./types";

const HOLD = "src/rooms/writer/server/writer-hold.ts";
const WORKER = "src/rooms/verification/worker-user.ts";
const LOGIC = "src/rooms/capability/logic.ts";
const MODELS = "packages/models/src/role-models.ts";
const HOST = "src/rooms/native-agent/native-claude-host.ts";

export default {
  n599: { mutation: flip("src/rooms/stability/server/worktree-janitor.ts", "return strictProjects.get(task.projectId) ? task.keys : [];", "return strictProjects.get(task.projectId) ? [] : task.keys;"), reach: entry("the hourly janitor sweep finds a task that ended a day ago in a project with worker.strict_user on"), trace: drill("sma_r07") },
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
  n628: { voidReview: voidStays("из пула воркеров задача роль не выбирает; писатель один (writer.provider/model) с цепочкой запасных, навыки задаёт правило по заявленным навыкам задачи и папке проекта") },
  n656: { voidReview: voidIsHave("пару дизайнов судит независимый измеритель по рубрике (overflow, contrast, targets, …) без участия автора; выбор пары — design-pair-answer PM") },
} satisfies RegionEvidence;
