import { OWNER_ASK_RENDERER_ID, ownerAnswerText, ownerAskResponseSchema, ownerAskTitle, buildOwnerAskPayload, resolveOwnerResponse, type OwnerAskRequest, type OwnerChoice } from "../owner-ask";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export type OwnerAnswer =
  | { outcome: "answered"; choice: OwnerChoice; text: string; line: string }
  | { outcome: "cancelled"; reason: string }
  | { outcome: "unavailable"; reason: string };

type RequestInput = (request: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<
  { outcome: "submitted"; value: unknown } | { outcome: "cancelled"; reason: string }>;

/** A rejected request answers within this; a form BB accepted is still waiting for the owner after it. */
export const OWNER_ASK_OPEN_GRACE_MS = 400;
/** The form went away because Lane Pilot or the chat did; nobody is left to tell. */
const SILENT_CANCEL = new Set(["plugin-disposed", "server-restarted", "request-aborted", "thread-stopped", "thread-deleted"]);
/**
 * The form went away because Lane Pilot reloaded or BB restarted while the owner had not answered. The asker was told «the
 * answer will come to this chat», so the next instance says it is lost (audit 2026-10-08, B3). A stopped or deleted chat
 * has nobody to tell.
 */
const LOST_TO_RELOAD = new Set(["plugin-disposed", "server-restarted"]);
const PENDING_PREFIX = "owner-ask:pending:";
type PendingRecord = { threadId: string; question: string; source: string; at: number };
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Questions to the owner through BB's pending interactions: a form in the chat that also reaches the owner's phone
 * (the push-notifications plugin sends `interaction.pending`). A tool's call is answered at once with a waiting notice
 * and the owner's answer reaches the agent as a message; for a question raised by Lane Pilot itself (the integration
 * gate, a repair thread, a council) `askInBackground` delivers the answer as a message to the thread that was asked.
 * A plugin's form holds no turn and never blocks a send to the thread. A BB without `bb.ui.requestInput`, or a chat
 * that already has a form open, answers «unavailable» and the caller says it in text, as before.
 */
export function createOwnerAsk(bb: BbPluginApi, log: (message: string) => void) {
  const open = new Set<string>();
  const requestInput = (): RequestInput | null => {
    const ui = (bb as unknown as { ui?: { requestInput?: RequestInput } }).ui;
    return typeof ui?.requestInput === "function" ? ui.requestInput.bind(ui) : null;
  };

  async function run(threadId: string, request: OwnerAskRequest, options: { timeoutMs?: number; signal?: AbortSignal }): Promise<OwnerAnswer> {
    const ask = requestInput();
    if (!ask) return { outcome: "unavailable", reason: "this BB has no bb.ui.requestInput" };
    if (open.has(threadId)) return { outcome: "unavailable", reason: "a question to the owner is already open in this chat" };
    const payload = buildOwnerAskPayload(request);
    const title = ownerAskTitle(payload);
    open.add(threadId);
    // Kept until the form is settled: a reload leaves it here for the next instance to find.
    const recorded = Promise.resolve(bb.storage.kv.set(`${PENDING_PREFIX}${threadId}`, { threadId, question: clip(request.question, 300), source: request.source, at: Date.now() } satisfies PendingRecord as never)).catch(() => undefined);
    let lostToReload = false;
    try {
      const result = await ask({
        threadId,
        rendererId: OWNER_ASK_RENDERER_ID,
        title,
        payload,
        ...(options.timeoutMs ? { timeoutMs: Math.min(options.timeoutMs, 60 * 60_000) } : {}),
        presentation: { label: { pending: clip(`Question for you: ${title}`, 80), completed: "Answered" }, icon: { glyph: "MessageQuestion" } },
        // The transcript keeps the question and the answer as text; the form's own value is not stored.
        describeSubmission: (value: unknown) => {
          const parsed = ownerAskResponseSchema.safeParse(value);
          if (!parsed.success) return {};
          return { title: clip(`Answered: ${title}`, 120), detail: `**${payload.question}**\n\n${ownerAnswerText(resolveOwnerResponse(payload, parsed.data)) || "-"}` };
        },
      }, options.signal ? { signal: options.signal } : undefined);
      if (result.outcome === "cancelled") {
        lostToReload = LOST_TO_RELOAD.has(result.reason);
        return { outcome: "cancelled", reason: result.reason };
      }
      const parsed = ownerAskResponseSchema.safeParse(result.value);
      if (!parsed.success) return { outcome: "cancelled", reason: "unreadable_answer" };
      const answer = resolveOwnerResponse(payload, parsed.data);
      if (!answer.choice && !answer.text) return { outcome: "cancelled", reason: "empty_answer" };
      return { outcome: "answered", ...answer, line: ownerAnswerText(answer) };
    } catch (cause) {
      return { outcome: "unavailable", reason: cause instanceof Error ? cause.message : String(cause) };
    } finally {
      open.delete(threadId);
      await recorded;
      if (!lostToReload) await bb.storage.kv.delete(`${PENDING_PREFIX}${threadId}`).catch(() => undefined);
    }
  }

  /** Whether the owner has a question open in this chat (in this instance, or left by one a reload ended). */
  async function pending(threadId: string): Promise<boolean> {
    if (open.has(threadId)) return true;
    return Boolean(await bb.storage.kv.get(`${PENDING_PREFIX}${threadId}`).catch(() => null));
  }

  /**
   * At start: a question the previous instance had open is gone with its form. The chat that was told «the answer comes
   * here» is told it will not, and may ask again. Returns the chats told.
   */
  async function recoverLost(): Promise<string[]> {
    const told: string[] = [];
    for (const key of await bb.storage.kv.list(PENDING_PREFIX).catch(() => [] as string[])) {
      const record = await bb.storage.kv.get<PendingRecord>(key).catch(() => null);
      await bb.storage.kv.delete(key).catch(() => undefined);
      if (!record?.threadId || open.has(record.threadId)) continue;
      try {
        await sendToThread(record.threadId, `Lane Pilot: the owner's question «${clip(record.question.split("\n", 1)[0]!, 120)}» was lost when Lane Pilot reloaded before the owner answered, so no answer will come. If it still matters, ask it again.`);
        told.push(record.threadId);
        log(`owner question «${clip(record.question, 60)}» lost to a reload; ${record.threadId} told`);
      } catch (cause) { log(`owner question «${clip(record.question, 60)}» lost to a reload; ${record.threadId} not told: ${cause instanceof Error ? cause.message : String(cause)}`); }
    }
    return told;
  }

  /** Waits for the owner. Inside a tool's `execute` pass its `signal`: BB then hands the answer to the agent as a message. */
  function ask(threadId: string, request: OwnerAskRequest, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<OwnerAnswer> {
    return run(threadId, request, options);
  }

  /**
   * Opens the form and goes on. Resolves with whether BB showed it (false: say it in text instead); `onSettled` runs when
   * the owner answered, dismissed it or let it time out, not when the form was lost to a reload or a stopped chat.
   */
  async function askInBackground(threadId: string, request: OwnerAskRequest, onSettled: (answer: OwnerAnswer) => void | Promise<void>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
    const answer = run(threadId, request, options);
    void answer.then(async (result) => {
      if (result.outcome === "unavailable" || (result.outcome === "cancelled" && SILENT_CANCEL.has(result.reason))) return;
      try { await onSettled(result); } catch (cause) { log(`owner question «${clip(request.question, 60)}» not delivered: ${cause instanceof Error ? cause.message : String(cause)}`); }
    });
    return await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), OWNER_ASK_OPEN_GRACE_MS);
      timer.unref?.();
      void answer.then((result) => { clearTimeout(timer); resolve(result.outcome !== "unavailable"); });
    });
  }

  /** The owner's answer (or silence) as the message the asking thread receives. */
  function answerMessage(question: string, answer: OwnerAnswer, timeoutMs?: number): string {
    const what = `«${clip(question.trim().split("\n", 1)[0]!, 120)}»`;
    if (answer.outcome === "answered") return `Lane Pilot: the owner answered ${what}: ${answer.line}`;
    if (answer.outcome === "cancelled" && answer.reason === "timeout") return `Lane Pilot: the owner did not answer ${what}${timeoutMs ? ` within ${Math.round(timeoutMs / 60_000)} min` : ""}.`;
    return `Lane Pilot: the owner dismissed ${what} without answering.`;
  }

  async function sendToThread(threadId: string, text: string): Promise<void> {
    await bb.sdk.threads.send({ threadId, mode: "queue-if-active", input: [{ type: "text", text, mentions: [] }] } as never);
  }

  return { ask, askInBackground, answerMessage, sendToThread, pending, recoverLost, available: () => requestInput() !== null };
}

export type OwnerAsk = ReturnType<typeof createOwnerAsk>;

/** How many interactions (approvals, questions, forms) wait for the owner on this thread; 0 on a BB that cannot list them. */
export async function threadPendingInteractions(bb: BbPluginApi, threadId: string): Promise<number> {
  const area = (bb as unknown as { sdk?: { threads?: { interactions?: { list?: (args: { threadId: string }) => Promise<unknown> } } } }).sdk?.threads?.interactions;
  if (typeof area?.list !== "function") return 0;
  const rows = await area.list({ threadId }).catch(() => null);
  return Array.isArray(rows) ? rows.length : 0;
}
