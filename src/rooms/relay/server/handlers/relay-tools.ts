import { z } from "zod";
import type { PrepareRecipient } from "../../../contracts";
import { registerObservedTool, type ServerContext } from "../../../platform/server";
import { RELAY_LIMITS, TASK_NOTICE } from "../../models/relay";
import type { Relay } from "../services/relay";
import { relayFor, setBackgroundCommandCount } from "../services/relay-runtime";
import { attachRelayDeadlines } from "./relay-deadlines";

/** Wires the relay to BB: realtime events, deadline-driven batching and the agent tools. */
export function mountRelay(ctx: ServerContext, prepareRecipient?: PrepareRecipient): Relay {
  const { bb } = ctx;
  const relay = relayFor(ctx);
  const { refreshAfter } = attachRelayDeadlines(ctx, relay, TASK_NOTICE.settleMs, (threadId, count) => {
    setBackgroundCommandCount(threadId, count);
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_ask",
    description: "Ask another BB thread a question (who holds a block, when it frees, how something works). The answer comes back into this chat as a message.",
    instructions: [
      "Use when you wait on another thread: the holder of a blocked task (blockedBy.holderThreadId), a writer, a specialist.",
      "The question is queued into that thread without interrupting its work. Its answer, or its last message if it ends the turn without answering, arrives in this chat.",
      "An active Pilot asking an unopened (>5h) or cache-expired chat opens a replacement in the same project/section; use the returned toThreadId. Freshness is checked before sending, never for replies.",
      "Then end your turn; do not ask the owner to tell you when it is free.",
      "If the result has alreadyWaiting, your earlier question is still queued there: do not ask again, the answer comes when that thread finishes its turn.",
      `At most ${RELAY_LIMITS.asksPerPairPerHour} questions an hour between two threads.`,
    ].join("\n"),
    parameters: z.object({ threadId: z.string().min(1), question: z.string().trim().min(1).max(4000) }).strict(),
    execute: async (params, context) => JSON.stringify(refreshAfter(await relay.ask({
      projectId: context.projectId, fromThreadId: context.threadId, toThreadId: params.threadId, question: params.question,
    }, prepareRecipient)), null, 2),
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_reply",
    description: "Answer a question another thread asked you through Lane Pilot (askId from the question).",
    instructions: "Use only for a question that reached this thread with an askId. Answer briefly and concretely, then continue your own work.",
    parameters: z.object({ askId: z.string().min(1), answer: z.string().trim().min(1).max(8000) }).strict(),
    execute: async (params, context) => JSON.stringify(refreshAfter(await relay.reply({ askId: params.askId, fromThreadId: context.threadId, answer: params.answer })), null, 2),
  });

  registerObservedTool(bb.agents, {
    name: "lane_pilot_relay_list",
    description: "List this chat's reminders and the questions it asked or was asked, with their states.",
    instructions: "Use to see what you are waiting for. Cancel a reminder you no longer need with cancelReminderId.",
    parameters: z.object({ cancelReminderId: z.string().min(1).optional() }).strict(),
    execute: async (params, context) => {
      const canceled = params.cancelReminderId ? await relay.cancel({ threadId: context.threadId, reminderId: params.cancelReminderId }) : undefined;
      return JSON.stringify({ ...(canceled === undefined ? {} : { canceled }), items: await relay.list(context.threadId) }, null, 2);
    },
  });

  return relay;
}
