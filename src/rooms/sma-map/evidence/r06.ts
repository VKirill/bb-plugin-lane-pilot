// Region 6 · Conversation and intake — per-node evidence of the four proofs (docs/sma-evidence.md).
// One line per node, sorted by node number; a batch agent edits only its nodes' lines. Lines with seedEntry or a lone
// wfRun/wfStep trace were derived mechanically by scripts/sma-seed-evidence.ts (2026-11-14), not authored.
// Batch a (n530-n558 less the core-resident n529, n531-n533, n540, n546, n549 and the open n557): the checks, the facts and the intake read no hub
// row of their own, so their trace is the node's prove() line in scripts/lp_drill/scenes/sma_r06.py (the probe runs the worlds of tests/sma/r06-world.ts).
import { distort, drill, entry, flip, skipWrite, voidIsHave, wfRun, type RegionEvidence } from "./types";

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
  // The worked example of a proof in the core (docs/sma-evidence.md «Proofs in a sibling repository»): the [sma:m_ce_recover] test is in
  // bb-core on sma/core-proofs; its trace stays open (the hub would have to see a turn cut off by a dropped stream and retried).
  n560: { mutation: flip("core:plugins/provider-retry/src/retry-policy.ts", "if (!isUnavailableFailure(failure))", "if (isUnavailableFailure(failure))") },
  n593: { trace: wfRun("lp.brainstorm") },
} satisfies RegionEvidence;
