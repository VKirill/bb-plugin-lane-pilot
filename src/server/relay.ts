import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ServerContext } from "./context";

/**
 * Lane Pilot's relay: agents ask other threads, answer back and set themselves reminders, and the plugin server
 * wakes them, so a blocked agent does not wait for the owner. The server runs all the time; agents only get
 * messages. A reminder fires when it is due, or earlier when the thread it watches finishes its turn.
 */

export type RelayAsk = {
  kind:"ask"; id:string; projectId:string; fromThreadId:string; toThreadId:string; question:string;
  createdAt:number; answeredAt:number|null;
};
export type RelayReminder = {
  kind:"remind"; id:string; projectId:string; threadId:string; note:string; dueAt:number;
  watchThreadId:string|null; createdAt:number; firedAt:number|null; firedBy:"time"|"watch"|null;
};
export type RelayItem = RelayAsk | RelayReminder;

/** Guards against two agents talking in circles or an agent snoozing for ever. */
export const RELAY_LIMITS = { asksPerPairPerHour:6, openRemindersPerThread:10, remindersPerThreadPerDay:30, keepMs:7 * 86_400_000 };

export type RelayDeps = {
  load():Promise<RelayItem[]>;
  save(items:RelayItem[]):Promise<void>;
  send(threadId:string, text:string):Promise<void>;
  /**
   * The thread has finished its work: not running a turn, nothing queued for it (a queued question waits for
   * its turn), and no background command or agent still at work (a turn can end while `sleep` or a build runs on).
   */
  settled(threadId:string):Promise<boolean>;
  /** The thread's last answer, used when an asked thread finishes without lane_pilot_reply. */
  output(threadId:string):Promise<string>;
  now():number;
  log(message:string):void;
};

const id = (prefix:string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export function createRelay(deps:RelayDeps) {
  let chain:Promise<unknown> = Promise.resolve();
  /** One read-modify-write at a time: tools, events and the sweep all touch the same list. */
  function update<T>(work:(items:RelayItem[]) => Promise<T> | T):Promise<T> {
    const next = chain.then(async () => {
      const items = await deps.load();
      const result = await work(items);
      const cutoff = deps.now() - RELAY_LIMITS.keepMs;
      await deps.save(items.filter((item) => item.createdAt > cutoff || (item.kind === "remind" ? !item.firedAt : !item.answeredAt)));
      return result;
    });
    chain = next.catch(() => undefined);
    return next;
  }

  async function ask(input:{projectId:string; fromThreadId:string; toThreadId:string; question:string}) {
    if (input.fromThreadId === input.toThreadId) throw new Error("a thread cannot ask itself");
    return update(async (items) => {
      const hourAgo = deps.now() - 3_600_000;
      const recent = items.filter((item) => item.kind === "ask" && item.createdAt > hourAgo
        && [item.fromThreadId, item.toThreadId].sort().join() === [input.fromThreadId, input.toThreadId].sort().join());
      if (recent.length >= RELAY_LIMITS.asksPerPairPerHour) {
        throw new Error(`relay limit: ${RELAY_LIMITS.asksPerPairPerHour} questions an hour between these two threads; set a reminder or escalate to the owner`);
      }
      const item:RelayAsk = { kind:"ask", id:id("ask"), ...input, createdAt:deps.now(), answeredAt:null };
      await deps.send(input.toThreadId, [
        `Вопрос от @thread:${input.fromThreadId} (Lane Pilot, ${item.id}):`,
        "",
        input.question,
        "",
        `Ответь коротко инструментом lane_pilot_reply с askId "${item.id}": что ты делаешь, что держишь и когда освободишь. Свою работу не бросай.`,
        "If you cannot call that tool, end your turn with the answer; it is passed back.",
      ].join("\n"));
      items.push(item);
      return item;
    });
  }

  async function reply(input:{askId:string; fromThreadId:string; answer:string}) {
    return update(async (items) => {
      const item = items.find((row):row is RelayAsk => row.kind === "ask" && row.id === input.askId);
      if (!item) throw new Error(`no question ${input.askId}`);
      if (item.toThreadId !== input.fromThreadId) throw new Error("only the asked thread can answer");
      if (item.answeredAt) return item;
      await deps.send(item.fromThreadId, `Ответ от @thread:${item.toThreadId} на ${item.id}:\n\n${input.answer}`);
      item.answeredAt = deps.now();
      return item;
    });
  }

  async function remind(input:{projectId:string; threadId:string; note:string; inMinutes:number; watchThreadId?:string|null}) {
    return update((items) => {
      const mine = items.filter((row):row is RelayReminder => row.kind === "remind" && row.threadId === input.threadId);
      if (mine.filter((row) => !row.firedAt).length >= RELAY_LIMITS.openRemindersPerThread) {
        throw new Error(`relay limit: ${RELAY_LIMITS.openRemindersPerThread} open reminders; cancel one first`);
      }
      if (mine.filter((row) => row.createdAt > deps.now() - 86_400_000).length >= RELAY_LIMITS.remindersPerThreadPerDay) {
        throw new Error(`relay limit: ${RELAY_LIMITS.remindersPerThreadPerDay} reminders a day; escalate to the owner`);
      }
      const item:RelayReminder = { kind:"remind", id:id("rem"), projectId:input.projectId, threadId:input.threadId, note:input.note,
        dueAt:deps.now() + input.inMinutes * 60_000, watchThreadId:input.watchThreadId ?? null, createdAt:deps.now(), firedAt:null, firedBy:null };
      items.push(item);
      return item;
    });
  }

  async function cancel(input:{threadId:string; reminderId:string}) {
    return update((items) => {
      const item = items.find((row):row is RelayReminder => row.kind === "remind" && row.id === input.reminderId && row.threadId === input.threadId);
      if (!item || item.firedAt) return false;
      item.firedAt = deps.now();
      return true;
    });
  }

  async function fire(item:RelayReminder, by:"time"|"watch") {
    const why = by === "watch" ? `тред @thread:${item.watchThreadId} закончил ход` : "пришло время";
    await deps.send(item.threadId, `Напоминание Lane Pilot (${item.id}, ${why}):\n\n${item.note}\n\nПроверь, можно ли продолжить. Если всё ещё ждёшь, поставь новое напоминание через lane_pilot_remind с большим интервалом.`);
    item.firedAt = deps.now();
    item.firedBy = by;
  }

  /** A watched or asked thread finished its turn: wake whoever waits on it, pass its answer back if it gave none. */
  async function threadSettled(threadId:string) {
    return update(async (items) => {
      const waiting = items.some((row) => (row.kind === "remind" && !row.firedAt && row.watchThreadId === threadId)
        || (row.kind === "ask" && !row.answeredAt && row.toThreadId === threadId));
      if (!waiting || !await deps.settled(threadId).catch(() => false)) return 0;
      let woken = 0;
      for (const item of items) {
        if (item.kind === "remind" && !item.firedAt && item.watchThreadId === threadId) { await fire(item, "watch"); woken++; }
        if (item.kind === "ask" && !item.answeredAt && item.toThreadId === threadId) {
          const text = (await deps.output(threadId).catch(() => "")).trim().slice(-4000);
          await deps.send(item.fromThreadId, `@thread:${threadId} закончил ход, не ответив на ${item.id}. Его последнее сообщение:\n\n${text || "(пусто)"}`);
          item.answeredAt = deps.now();
          woken++;
        }
      }
      return woken;
    });
  }

  /** Fires due reminders and catches settled threads whose event was missed (a reload, a dropped stream). */
  async function sweep() {
    const watched = new Set<string>();
    const due = await update(async (items) => {
      let fired = 0;
      for (const item of items) {
        if (item.kind !== "remind" || item.firedAt) continue;
        if (item.dueAt <= deps.now()) { await fire(item, "time"); fired++; }
        else if (item.watchThreadId) watched.add(item.watchThreadId);
      }
      for (const item of items) if (item.kind === "ask" && !item.answeredAt) watched.add(item.toThreadId);
      return fired;
    });
    let settled = 0;
    for (const threadId of watched) settled += await threadSettled(threadId);
    return { fired:due, settled };
  }

  async function list(threadId:string) {
    const items = await deps.load();
    return items.filter((item) => item.kind === "remind" ? item.threadId === threadId
      : item.fromThreadId === threadId || item.toThreadId === threadId);
  }

  /** Thread ids the relay waits on; events of other threads are ignored without a read. */
  async function watchedThreads():Promise<Set<string>> {
    const items = await deps.load();
    return new Set(items.flatMap((item) => item.kind === "remind" ? (!item.firedAt && item.watchThreadId ? [item.watchThreadId] : [])
      : !item.answeredAt ? [item.toThreadId] : []));
  }

  return { ask, reply, remind, cancel, threadSettled, sweep, list, watchedThreads };
}

export type Relay = ReturnType<typeof createRelay>;

const KEY = "relay:items";

const relays = new WeakMap<object, Relay>();
/** Background commands per thread, from the last thread:changed event; threads.get does not report them. */
const backgroundCommands = new Map<string, number>();

/** The plugin's one relay over BB storage and threads; every caller shares it, so writes stay in one queue. */
export function relayFor(ctx:ServerContext):Relay {
  const { bb } = ctx;
  const existing = relays.get(bb);
  if (existing) return existing;
  const relay = createRelay({
    load:async () => { const value = await bb.storage.kv.get(KEY); return Array.isArray(value) ? value as RelayItem[] : []; },
    save:async (items) => { await bb.storage.kv.set(KEY, items as never); },
    send:async (threadId, text) => {
      await bb.sdk.threads.send({ threadId, mode:"queue-if-active", input:[{ type:"text", text, mentions:[] }] } as never);
    },
    settled:async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId }) as {
        status?:string; queuedMessageCount?:number; activeBackgroundAgentCount?:number;
      };
      const commands = backgroundCommands.get(threadId) ?? 0;
      return ["idle", "error", "stopped"].includes(thread.status ?? "") && !thread.queuedMessageCount
        && !thread.activeBackgroundAgentCount && commands === 0;
    },
    output:async (threadId) => {
      const result = await bb.sdk.threads.output({ threadId }) as { output?:unknown; text?:unknown };
      const value = result.output ?? result.text;
      return typeof value === "string" ? value : JSON.stringify(value ?? "");
    },
    now:() => Date.now(),
    log:ctx.log,
  });
  relays.set(bb, relay);
  return relay;
}

/** Wires the relay to BB: realtime events, a sweep service and the agent tools. */
export function mountRelay(ctx:ServerContext):Relay {
  const { bb } = ctx;
  const sdk = bb.sdk as unknown as {
    subscribe?:(args:{ event:"thread:changed"; callback:(event:{ id?:string; metadata?:{ statusChange?:{ activity?:{ activeBackgroundCommandCount?:number } } } }) => void }) => () => void;
  };
  const relay = relayFor(ctx);

  // Event first: a watched thread that settles wakes its waiters at once. The sweep below catches what events miss.
  let watched = new Set<string>();
  const refreshWatched = () => relay.watchedThreads().then((ids) => { watched = ids; }).catch(() => undefined);
  void refreshWatched();
  // Without realtime (an older BB, a test host) the sweep alone wakes waiters, within 30 seconds.
  let unsubscribe:(() => void) | undefined;
  try { unsubscribe = sdk.subscribe?.({ event:"thread:changed", callback:(event) => {
    if (!event.id || !watched.has(event.id) || ctx.isDisposed()) return;
    const commands = event.metadata?.statusChange?.activity?.activeBackgroundCommandCount;
    if (typeof commands === "number") backgroundCommands.set(event.id, commands);
    void relay.threadSettled(event.id).then((woken) => {
      if (woken) { ctx.log(`relay: ${event.id} settled, woke ${woken}`); void refreshWatched(); }
    }).catch((cause) => ctx.log(`relay event failed: ${cause instanceof Error ? cause.message : String(cause)}`));
  } }); } catch (cause) { ctx.log(`relay: no thread events, sweep only: ${cause instanceof Error ? cause.message : String(cause)}`); }
  if (unsubscribe) bb.onDispose(unsubscribe);
  bb.background.service("relay-sweep", { start:async (signal) => {
    while (!signal.aborted) {
      const result = await relay.sweep().catch((cause) => { ctx.log(`relay sweep failed: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      if (result && (result.fired || result.settled)) ctx.log(`relay: fired ${result.fired}, settled ${result.settled}`);
      await refreshWatched();
      await new Promise((wake) => { const timer = setTimeout(wake, 30_000); signal.addEventListener("abort", () => { clearTimeout(timer); wake(null); }, { once:true }); });
    }
  } });

  const refreshAfter = <T>(result:T) => { void refreshWatched(); return result; };

  bb.agents.registerTool({
    name:"lane_pilot_ask",
    description:"Ask another BB thread a question (who holds a block, when it frees, how something works). The answer comes back into this chat as a message.",
    instructions:[
      "Use when you wait on another thread: the holder of a blocked task (blockedBy.holderThreadId), a writer, a specialist.",
      "The question is queued into that thread without interrupting its work. Its answer, or its last message if it ends the turn without answering, arrives in this chat.",
      "Then set a reminder with lane_pilot_remind (watchThreadId = that thread) and end your turn; do not ask the owner to tell you when it is free.",
      `At most ${RELAY_LIMITS.asksPerPairPerHour} questions an hour between two threads.`,
    ].join("\n"),
    parameters:z.object({ threadId:z.string().min(1), question:z.string().trim().min(1).max(4000) }).strict(),
    execute:async (params, context) => JSON.stringify(refreshAfter(await relay.ask({
      projectId:context.projectId, fromThreadId:context.threadId, toThreadId:params.threadId, question:params.question,
    })), null, 2),
  });

  bb.agents.registerTool({
    name:"lane_pilot_reply",
    description:"Answer a question another thread asked you through Lane Pilot (askId from the question).",
    instructions:"Use only for a question that reached this thread with an askId. Answer briefly and concretely, then continue your own work.",
    parameters:z.object({ askId:z.string().min(1), answer:z.string().trim().min(1).max(8000) }).strict(),
    execute:async (params, context) => JSON.stringify(refreshAfter(await relay.reply({ askId:params.askId, fromThreadId:context.threadId, answer:params.answer })), null, 2),
  });

  bb.agents.registerTool({
    name:"lane_pilot_remind",
    description:"Set yourself a reminder: Lane Pilot writes into this chat after the given minutes, or earlier when a watched thread finishes its turn.",
    instructions:[
      "Use instead of waiting for the owner whenever work is blocked on time or on another thread. Then end your turn; the reminder wakes you.",
      "Back off: 5, then 10, then 20 minutes for the same block; after three reminders without progress, tell the owner what you tried and what to decide.",
      "Pass watchThreadId to be woken as soon as that thread settles (for example blockedBy.holderThreadId).",
    ].join("\n"),
    parameters:z.object({
      inMinutes:z.number().int().min(1).max(24 * 60),
      note:z.string().trim().min(1).max(2000),
      watchThreadId:z.string().min(1).optional(),
    }).strict(),
    execute:async (params, context) => JSON.stringify(refreshAfter(await relay.remind({
      projectId:context.projectId, threadId:context.threadId, note:params.note, inMinutes:params.inMinutes, watchThreadId:params.watchThreadId,
    })), null, 2),
  });

  bb.agents.registerTool({
    name:"lane_pilot_relay_list",
    description:"List this chat's reminders and the questions it asked or was asked, with their states.",
    instructions:"Use to see what you are waiting for. Cancel a reminder you no longer need with cancelReminderId.",
    parameters:z.object({ cancelReminderId:z.string().min(1).optional() }).strict(),
    execute:async (params, context) => {
      const canceled = params.cancelReminderId ? await relay.cancel({ threadId:context.threadId, reminderId:params.cancelReminderId }) : undefined;
      return JSON.stringify({ ...(canceled === undefined ? {} : { canceled }), items:await relay.list(context.threadId) }, null, 2);
    },
  });

  return relay;
}
