// Region 6 · Conversation and intake — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Batch a (n530-n558 less the core-resident n529, n531-n533, n540, n546, n549 and the open n557): the checks, the facts and the intake read no hub
// row of their own, so their trace is the node's prove() line in scripts/lp_drill/scenes/sma_r06.py (the probe runs the worlds of tests/sma/r06-world.ts).
import { distort, drill, entry, flip, skipWrite, voidIsHave, wrongTarget, type RegionEvidence } from "./types";

const RAILS = "src/rooms/tasks/rails.ts";
const TOOLS = "src/rooms/tasks/server/conversation-tools.ts";
const INTAKE = "src/rooms/phase/intake.ts";
const LIVE = "src/rooms/runs/server/thread-live.ts";

export default {
  n530: { mutation: flip(INTAKE, "MACHINE_TEXT.some((pattern) => pattern.test(text))", "!MACHINE_TEXT.some((pattern) => pattern.test(text))"), trace: drill("sma_r06") },
  n534: { mutation: distort(RAILS, 'return "browser";', 'return "full";'), trace: drill("sma_r06") },
  n535: { mutation: distort(RAILS, 'return "full";', 'return "quick";'), trace: drill("sma_r06"), voidReview: voidIsHave("три рецепта проверки quick/full/browser выбираются по всему запросу, ни один байт запроса не становится командой (текущий ours-текст устарел)") },
  n536: { mutation: flip(TOOLS, "if (stored && (live ||", "if (stored && !(live ||"), trace: drill("sma_r06") },
  n537: { mutation: distort("src/rooms/verification/sandbox.ts", 'args.push("--ro-bind",guardPath,guardPath)', 'args.push("--bind",guardPath,guardPath)'), trace: drill("sma_r06") },
  n538: { mutation: flip(TOOLS, "const fails = rootsChanged && input.throwaway === true;", "const fails = rootsChanged && input.throwaway !== true;"), reach: entry("the owner asks in the chat to run the project's tests (a «проверь …» request, lane_pilot_check run)"), trace: drill("sma_r06") },
  n539: { mutation: flip(TOOLS, "receipt.stoppedCommand = stopped ? current : null;", "receipt.stoppedCommand = stopped ? null : current;"), trace: drill("sma_r06") },
  n541: { mutation: distort("src/rooms/core/server/lifecycle-events.ts", 'extra.onQueued!("message.dispatched", valueAt(payload, "entry"))', 'extra.onQueued!("message.cancelled", valueAt(payload, "entry"))'), reach: entry("the owner sends a message in a BB chat (BB dispatches it from the thread's queue)"), trace: drill("sma_r06") },
  n542: { mutation: flip(INTAKE, 'clean.endsWith("?")', 'clean.endsWith("!")'), trace: drill("sma_r06") },
  n543: { mutation: flip(LIVE, 'item.kind === "task" && (!focus ||', 'item.kind !== "task" && (!focus ||'), trace: drill("sma_r06") },
  n544: { mutation: distort("src/rooms/phase/logic/next-action.ts", "stage 1, discussion. Goal:", "stage 1, planning. Goal:"), trace: drill("sma_r06") },
  n545: { mutation: flip(LIVE, 'role = writer ? "writer" : "helper";', 'role = writer ? "helper" : "writer";'), reach: entry("a person opens the Lane Pilot info panel of a chat, or the sidebar draws a conversation's live dot"), trace: drill("sma_r06") },
  n547: { mutation: skipWrite("src/rooms/runs/server/cancel.ts", "await bb.sdk.threads.stop({ threadId: attempt.thread_id });"), trace: drill("sma_r06") },
  n548: { mutation: flip("src/rooms/phase/server/intake.ts", "if (result.started) await bb.storage.kv.set(slot,", "if (!result.started) await bb.storage.kv.set(slot,"), trace: drill("sma_r06") },
  n550: { mutation: distort(RAILS, 'return "failure";', 'return "history";'), trace: drill("sma_r06") },
  n551: { mutation: flip(RAILS, "words.length > 0 && words.every(", "words.length > 0 && words.some("), trace: drill("sma_r06") },
  n552: { mutation: flip("src/rooms/phase/server/tool.ts", "if (context.threadId !== own) throw", "if (context.threadId === own) throw"), trace: drill("sma_r06") },
  n553: { mutation: distort(TOOLS, "class: failureClass(row.state, row.reason)", 'class: "free"'), trace: drill("sma_r06") },
  n554: { mutation: distort(TOOLS, "byModel: rows,", "byModel: rows.slice(1),"), trace: drill("sma_r06") },
  n555: { mutation: distort(TOOLS, "?? 0) + 1;", "?? 0) + 2;"), trace: drill("sma_r06") },
  n556: { mutation: distort(TOOLS, 'states: ["accepted","blocked","canceled"], limit: 15', 'states: ["accepted","canceled"], limit: 15'), trace: drill("sma_r06") },
  n558: { mutation: distort("src/rooms/phase/logic/signatures.ts", "canonical({ contextSha, items })", "canonical({ items })"), trace: drill("sma_r06") },
  n559: { mutation: distort("src/rooms/phase/server/intake.ts", "return { started: true, via: known.via, id: known.id };", "return { started: true, via: known.via, id: `${known.id}~` };"), reach: entry("the owner answers «да» to a proposal in the PM chat (the lead road: lead:<road> key)"), trace: drill("sma_r06") },
  // The worked example of a proof in the core (docs/sma-evidence.md «Proofs in a sibling repository»): the [sma:m_ce_recover] test is in
  // bb-core on sma/core-proofs; its trace stays open (the hub would have to see a turn cut off by a dropped stream and retried).
  n560: { mutation: flip("core:plugins/provider-retry/src/retry-policy.ts", "if (!isUnavailableFailure(failure))", "if (isUnavailableFailure(failure))") },
  n561: { mutation: flip("src/rooms/native-agent/ui/composer-boundary.tsx", 'if (role !== "pm") return null;', 'if (role === "pm") return null;'), reach: entry("a person opens a PM chat: the line draws under its input"), trace: drill("sma_r06") },
  n562: { mutation: distort("src/rooms/tasks/server/contract-lint.ts", 'code:"output_unowned"', 'code:"output_owned"'), trace: drill("sma_r06") },
  n563: { mutation: wrongTarget("src/rooms/usage/server/token-usage.ts", ".run(thread.id, thread.projectId, cursor.last_provider || thread.providerId, cursor.last_seq,", ".run(thread.projectId, thread.projectId, cursor.last_provider || thread.providerId, cursor.last_seq,"), trace: drill("sma_r06") },
  n565: { mutation: distort("src/rooms/native-agent/server/activation.ts", "const spawnProviderId = native?.providerId ?? config.pmProviderId;", "const spawnProviderId = native?.providerId ?? config.writerProviderId;"), trace: drill("sma_r06") },
  n566: { mutation: flip("src/rooms/native-agent/server/activation.ts", 'if (valueAt(sourceMetadata, "role") === "writer") {', 'if (valueAt(sourceMetadata, "role") !== "writer") {'), trace: drill("sma_r06") },
  n567: { mutation: distort("src/rooms/stability/server/pm-turn-watch.ts", "maxTurns: limits.maxTurns > 0 ? limits.maxTurns : 0", "maxTurns: limits.maxTurns > 0 ? limits.maxTurns + 1 : 0"), trace: drill("sma_r06") },
  n568: { mutation: distort("src/rooms/learning/pm-rules.ts", '${task.taskId} ${task.state ?? "?"}', '${task.state ?? "?"} ${task.taskId}'), trace: drill("sma_r06") },
  n569: { mutation: flip("src/rooms/writer/server/dispatch.ts", 'rel.startsWith("..")', 'rel.startsWith("../..")'), trace: drill("sma_r06") },
  n570: { mutation: distort(TOOLS, 'listRunTaskSummaries(db, runId ?? "")', 'listRunTaskSummaries(db, "")'), trace: drill("sma_r06") },
  n571: { mutation: flip("src/rooms/native-agent/server/activation.ts", "...mainAgentBinding,", "...(native ? mainAgentBinding : {}),"), trace: drill("sma_r06") },
  n574: { mutation: distort("src/rooms/stability/server/pm-turn-watch.ts", "limits.turnLimitMin * 60_000", "limits.turnLimitMin * 30_000"), trace: drill("sma_r06") },
  n575: { mutation: distort("src/rooms/usage/server/token-usage.ts", 'model: model || "unknown",', 'model: "unknown",'), reach: entry("a PM turn ends and the usage sync runs (the periodic token sync over the thread events)"), trace: drill("sma_r06") },
  n576: { mutation: flip("src/rooms/backlog/server/scanner.ts", "const fetched = freshened.exitCode === 0;", "const fetched = freshened.exitCode !== 0;"), trace: drill("sma_r06") },
  n577: { mutation: flip("src/rooms/backlog/logic.ts", "output.split(`${BACKLOG_MARK} `).slice(1)", "output.split(`${BACKLOG_MARK} `).slice(0)"), trace: drill("sma_r06") },
  n578: { mutation: flip("src/rooms/backlog/logic.ts", "item.estimate <= MAX_ESTIMATE && item.dependsOn.every((id) => done.has(id))", "item.estimate < MAX_ESTIMATE && item.dependsOn.every((id) => done.has(id))"), trace: drill("sma_r06") },
  n579: { mutation: flip("src/rooms/backlog/logic.ts", "needsEstimate: ready.filter((item) => item.estimate === null),", "needsEstimate: ready.filter((item) => item.estimate !== null),"), trace: drill("sma_r06") },
  n580: { mutation: flip("src/rooms/backlog/logic.ts", "item.estimate !== null && item.estimate > MAX_ESTIMATE),", "item.estimate !== null && item.estimate >= MAX_ESTIMATE),"), trace: drill("sma_r06") },
  n581: { mutation: flip("src/rooms/backlog/logic.ts", "item.dependsOn.some((id) => !done.has(id))", "item.dependsOn.some((id) => done.has(id))"), trace: drill("sma_r06") },
  n582: { mutation: distort("src/rooms/backlog/logic.ts", "оценка ${item.estimate}, приоритет", "оценка ${item.priority}, приоритет"), trace: drill("sma_r06") },
  n583: { mutation: flip("src/rooms/backlog/logic.ts", "(PRIORITY[a.priority] ?? 1) - (PRIORITY[b.priority] ?? 1)", "(PRIORITY[b.priority] ?? 1) - (PRIORITY[a.priority] ?? 1)"), trace: drill("sma_r06") },
  n584: { mutation: flip("src/rooms/backlog/server/scanner.ts", "now - scannedAt < scanMinutesOf(db, projectId) * 60_000", "now - scannedAt > scanMinutesOf(db, projectId) * 60_000"), reach: entry("the clock: the backlog tick wakes every five minutes and each active project's own interval decides"), trace: drill("sma_r06") },
  n585: { mutation: wrongTarget("src/rooms/backlog/server/scanner.ts", "basePath: (await homeOf(projectId, config as never)) ?? config.writerWorkspacePath, command: backlogReadCommand, timeoutSec: 30 }, { hostId: config.hostId, timeoutMs: 60_000 })\n      .catch((cause: unknown)", "basePath: config.writerWorkspacePath, command: backlogReadCommand, timeoutSec: 30 }, { hostId: config.hostId, timeoutMs: 60_000 })\n      .catch((cause: unknown)"), reach: entry("the backlog tick or the owner's «выдать» reads the project's todo items"), trace: drill("sma_r06") },
  n586: { mutation: distort("src/rooms/host-worker/handlers/machine.ts", 'lines[at[0]!] = "status: done";', 'lines[at[0]!] = "status: closed";'), trace: drill("sma_r06") },
  n587: { mutation: distort("src/rooms/phase/server/driver-methods-words.ts", "`${input.questionId}: ${input.answer}`", "`${input.questionId}: ${input.answer.toUpperCase()}`"), trace: drill("sma_r06") },
  n588: { mutation: distort("src/rooms/writer/server/task-home.ts", '"A: open — the writer is parked here"', '"A: open — the writer is idle"'), trace: drill("sma_r06") },
  n589: { mutation: distort("src/rooms/relay/owner-ask.ts", "kind: request.kind,", 'kind: request.kind === "pause" ? "budget" : request.kind,'), reach: entry("a PM, a gate or the phase driver puts a question to the owner (lane_pilot_ask_owner)"), trace: drill("sma_r06") },
  n590: { mutation: flip("src/rooms/tools/server/tools.ts", "if (secretShaped(params.answer))", "if (!secretShaped(params.answer))"), reach: entry("the PM relays the owner's answer to a parked writer (lane_pilot_answer_writer)"), trace: drill("sma_r06") },
  n591: { mutation: flip("src/rooms/relay/owner-ask.ts", "allowText: options.length ? !OPTIONS_ONLY_ASK_KINDS.has(request.kind) : true,", "allowText: options.length ? OPTIONS_ONLY_ASK_KINDS.has(request.kind) : true,"), reach: entry("a PM, a gate or the phase driver puts a question to the owner (lane_pilot_ask_owner)"), trace: drill("sma_r06") },
  n592: { mutation: distort("src/rooms/cockpit/ui/screens-work.tsx", '[...title].slice(0, TITLE_MAX).join("")', '[...title].slice(0, TITLE_MAX + 20).join("")'), trace: drill("sma_r06") },
  n593: { mutation: distort("workflows/lp.clarify.json", '"role": "analyst",', '"role": "writer",'), trace: drill("sma_r06") },
  n594: { mutation: flip("src/rooms/backlog/logic.ts", ".filter((stem) => stems.has(stem)).length >= 2)", ".filter((stem) => stems.has(stem)).length >= 3)"), trace: drill("sma_r06") },
  n595: { mutation: distort("src/rooms/phase/logic/gates.ts", "computed[item.id] ?? 0", "computed[item.id] ?? 1"), trace: drill("sma_r06") },
} satisfies RegionEvidence;
