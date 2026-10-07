import { latestTaskAttemptState } from "../database";
import { taskFamily } from "../failure-class";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ServerContext } from "./context";
import { sendServiceMessage } from "./service-message";
import { registerObservedTool } from "./tool-result";

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
  watchThreadId:string|null; createdAt:number; firedAt:number|null; firedBy:"time"|"watch"|"answered"|"tasks"|"canceled"|null;
  /** Lane Pilot tasks the reminder waits for: it fires when every one has finished, instead of polling by time. */
  taskIds?:string[];
  /**
   * The reminder's time is kept by BB's own message queue: this is the queued row (`threads.send` with `sendAt`), shown
   * as a card in the chat and surviving a reload. An early wake (a watched thread, finished tasks), a cancel or an answer
   * deletes the row first. Absent: the sweep sends the reminder when it is due, as before.
   */
  queuedMessageId?:string|null;
};
export type RelayItem = RelayAsk | RelayReminder;

/** Guards against two agents talking in circles or an agent snoozing for ever. */
// A PM watching a day-long run sets a reminder per batch; 30 a day ran out on SelfyStudio (2026-10-04).
export const RELAY_LIMITS = { asksPerPairPerHour:6, openRemindersPerThread:20, remindersPerThreadPerDay:150, keepMs:7 * 86_400_000 };

export type RelayDeps = {
  load():Promise<RelayItem[]>;
  save(items:RelayItem[]):Promise<void>;
  /** `senderThreadId`: the thread the message comes from, so the receiver sees who wrote it. */
  send(threadId:string, text:string, senderThreadId?:string):Promise<void>;
  /**
   * The thread has finished its work: not running a turn, nothing queued for it (a queued question waits for
   * its turn), and no background command or agent still at work (a turn can end while `sleep` or a build runs on).
   */
  settled(threadId:string):Promise<boolean>;
  /** The thread's last answer, used when an asked thread finishes without lane_pilot_reply. */
  output(threadId:string):Promise<string>;
  /** The latest attempt state of each task in the project; null when it has none. */
  taskStates(projectId:string, taskIds:string[]):Promise<Record<string, string|null>>;
  /** Returns the newest taskId and its state in the same task family (e.g. redispatch <id>.2), if any newer exists. */
  latestFamilyMember?(projectId:string, taskId:string):Promise<{ taskId:string; state:string|null } | null>;
  now():number;
  log(message:string):void;
  /** Puts the text into BB's queue for `sendAt`; the queued row's id, or null when it could not be queued (the sweep then sends). */
  scheduleQueued?(threadId:string, text:string, sendAt:number):Promise<string | null>;
  /** Deletes a queued row. `gone`: it is not there (already sent, or deleted by the owner); `failed`: unknown. */
  dropQueued?(threadId:string, queuedMessageId:string):Promise<"deleted" | "gone" | "failed">;
  /** Whether the row still waits in the queue; `unknown` when BB could not say. */
  queuedState?(threadId:string, queuedMessageId:string):Promise<"waiting" | "gone" | "unknown">;
};

/** A task is finished when its latest attempt is accepted (merged), blocked after its retries, or canceled. */
const TASK_DONE = new Set(["accepted", "blocked", "canceled"]);

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

  /**
   * The thread a reminder waited on has answered: the reminder would only arrive after the answer and read as
   * stale («это напоминание устарело»), so it is closed without a message.
   */
  async function closeAnsweredWaits(items:RelayItem[], askerId:string, answeredBy:string) {
    for (const item of items) {
      if (item.kind === "remind" && !item.firedAt && item.threadId === askerId && item.watchThreadId === answeredBy) {
        item.firedAt = deps.now();
        item.firedBy = "answered";
        await dropQueuedRow(item);
      }
    }
  }

  /** Takes a reminder's row out of BB's queue; true when the row is not there any more (it was already sent or deleted). */
  async function dropQueuedRow(item:RelayReminder):Promise<boolean> {
    if (!item.queuedMessageId || !deps.dropQueued) return false;
    const dropped = await deps.dropQueued(item.threadId, item.queuedMessageId).catch(() => "failed" as const);
    if (dropped === "failed") deps.log(`relay: could not delete the queued reminder ${item.queuedMessageId} of ${item.id}`);
    return dropped === "gone";
  }

  async function ask(input:{projectId:string; fromThreadId:string; toThreadId:string; question:string}):Promise<RelayAsk & { alreadyWaiting?:true }> {
    if (input.fromThreadId === input.toThreadId) throw new Error("a thread cannot ask itself");
    return update(async (items) => {
      // Asking again while the first question waits in that thread's queue only queues a stale copy behind it.
      const open = items.find((item):item is RelayAsk => item.kind === "ask" && !item.answeredAt
        && item.fromThreadId === input.fromThreadId && item.toThreadId === input.toThreadId);
      if (open) return { ...open, alreadyWaiting:true as const };
      const hourAgo = deps.now() - 3_600_000;
      const recent = items.filter((item) => item.kind === "ask" && item.createdAt > hourAgo
        && [item.fromThreadId, item.toThreadId].sort().join() === [input.fromThreadId, input.toThreadId].sort().join());
      if (recent.length >= RELAY_LIMITS.asksPerPairPerHour) {
        throw new Error(`relay limit: ${RELAY_LIMITS.asksPerPairPerHour} questions an hour between these two threads; set a reminder or escalate to the owner`);
      }
      const item:RelayAsk = { kind:"ask", id:id("ask"), ...input, createdAt:deps.now(), answeredAt:null };
      await deps.send(input.toThreadId, [
        `Lane Pilot: question from @thread:${input.fromThreadId} (${item.id}):`,
        "",
        input.question,
        "",
        `Answer briefly with the lane_pilot_reply tool using askId "${item.id}": what you are doing, what you are holding and when it frees. Keep working on your task.`,
        "If you cannot call that tool, end your turn with the answer; it is passed back.",
      ].join("\n"), input.fromThreadId);
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
      await deps.send(item.fromThreadId, `Lane Pilot: reply from @thread:${item.toThreadId} to ${item.id}:\n\n${input.answer}`, item.toThreadId);
      item.answeredAt = deps.now();
      await closeAnsweredWaits(items, item.fromThreadId, item.toThreadId);
      return item;
    });
  }

  async function remind(input:{projectId:string; threadId:string; note:string; inMinutes:number; watchThreadId?:string|null; taskIds?:string[]}) {
    return update(async (items) => {
      const mine = items.filter((row):row is RelayReminder => row.kind === "remind" && row.threadId === input.threadId);
      if (mine.filter((row) => !row.firedAt).length >= RELAY_LIMITS.openRemindersPerThread) {
        throw new Error(`relay limit: ${RELAY_LIMITS.openRemindersPerThread} open reminders; cancel one first`);
      }
      if (mine.filter((row) => row.createdAt > deps.now() - 86_400_000).length >= RELAY_LIMITS.remindersPerThreadPerDay) {
        throw new Error(`relay limit: ${RELAY_LIMITS.remindersPerThreadPerDay} reminders a day; escalate to the owner`);
      }
      const item:RelayReminder = { kind:"remind", id:id("rem"), projectId:input.projectId, threadId:input.threadId, note:input.note,
        dueAt:deps.now() + input.inMinutes * 60_000, watchThreadId:input.watchThreadId ?? null, createdAt:deps.now(), firedAt:null, firedBy:null,
        ...(input.taskIds?.length ? { taskIds:[...new Set(input.taskIds)] } : {}) };
      // BB's queue keeps the time: the reminder is a card in the chat, due at `dueAt`, and survives a reload of this plugin.
      if (deps.scheduleQueued) {
        item.queuedMessageId = await deps.scheduleQueued(item.threadId, reminderText(item, "time"), item.dueAt)
          .catch((cause:unknown) => { deps.log(`relay: could not queue reminder ${item.id}, the sweep will send it: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      }
      items.push(item);
      return item;
    });
  }

  async function cancel(input:{threadId:string; reminderId:string}) {
    return update(async (items) => {
      const item = items.find((row):row is RelayReminder => row.kind === "remind" && row.id === input.reminderId && row.threadId === input.threadId);
      if (!item || item.firedAt) return false;
      item.firedAt = deps.now();
      await dropQueuedRow(item);
      return true;
    });
  }

  const reminderText = (item:RelayReminder, by:"time"|"watch"|"tasks", states?:Record<string, string|null>) => {
    const why = by === "watch" ? `thread @thread:${item.watchThreadId} finished its turn`
      : by === "tasks" ? `tasks completed: ${Object.entries(states ?? {}).map(([task, state]) => `${task} — ${state}`).join(", ")}`
      : "time reached";
    return `Lane Pilot: reminder (${item.id}, ${why}):\n\n${item.note}\n\nCheck if you can continue. If you are still waiting, set a new reminder with lane_pilot_remind with a larger interval.`;
  };

  async function fire(item:RelayReminder, by:"time"|"watch"|"tasks", states?:Record<string, string|null>) {
    // An early wake takes the queued time-reminder out first. If the row is already gone, BB sent it at the due time (or the
    // owner deleted it): a second reminder now would only be stale.
    if (by !== "time" && await dropQueuedRow(item)) {
      item.firedAt = deps.now();
      item.firedBy = "time";
      return;
    }
    await deps.send(item.threadId, reminderText(item, by, states), by === "watch" ? item.watchThreadId ?? undefined : undefined);
    item.firedAt = deps.now();
    item.firedBy = by;
  }

  /** BB announced a row of its queue: our reminder was sent at its time, or the owner deleted it from the card. */
  async function queueEvent(kind:"message.dispatched" | "message.cancelled", queuedMessageId:string) {
    return update((items) => {
      const item = items.find((row):row is RelayReminder => row.kind === "remind" && !row.firedAt && row.queuedMessageId === queuedMessageId);
      if (!item) return false;
      item.firedAt = deps.now();
      item.firedBy = kind === "message.dispatched" ? "time" : "canceled";
      return true;
    });
  }

  /** A watched or asked thread finished its turn: wake whoever waits on it, pass its answer back if it gave none. */
  async function threadSettled(threadId:string) {
    return update(async (items) => {
      const waiting = items.some((row) => (row.kind === "remind" && !row.firedAt && row.watchThreadId === threadId)
        || (row.kind === "ask" && !row.answeredAt && row.toThreadId === threadId));
      if (!waiting || !await deps.settled(threadId).catch(() => false)) return 0;
      let woken = 0;
      // Answers first: whoever gets one now does not also need the reminder that waited on this thread.
      for (const item of items) {
        if (item.kind === "ask" && !item.answeredAt && item.toThreadId === threadId) {
          const text = (await deps.output(threadId).catch(() => "")).trim().slice(-4000);
          await deps.send(item.fromThreadId, `Lane Pilot: @thread:${threadId} finished its turn without answering ${item.id}. Its last message:\n\n${text || "(empty)"}`, threadId);
          item.answeredAt = deps.now();
          await closeAnsweredWaits(items, item.fromThreadId, threadId);
          woken++;
        }
      }
      for (const item of items) {
        if (item.kind === "remind" && !item.firedAt && item.watchThreadId === threadId) { await fire(item, "watch"); woken++; }
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
        if (item.taskIds?.length) {
          // Check for redispatch and retarget tasks if a newer family member exists
          if (deps.latestFamilyMember) {
            const updatedTaskIds = new Set<string>();
            for (const task of item.taskIds) {
              const newer = await deps.latestFamilyMember(item.projectId, task).catch(() => null);
              if (newer && newer.taskId !== task) {
                updatedTaskIds.add(newer.taskId);
              } else {
                updatedTaskIds.add(task);
              }
            }
            item.taskIds = [...updatedTaskIds];
          }

          const states = await deps.taskStates(item.projectId, item.taskIds).catch(() => ({} as Record<string, string|null>));

          // Drop canceled tasks from item.taskIds
          item.taskIds = item.taskIds.filter((task) => states[task] !== "canceled");

          // A reminder left with no taskIds and no watchThreadId closes silently, without waking anyone
          if (item.taskIds.length === 0 && !item.watchThreadId) {
            item.firedAt = deps.now();
            item.firedBy = "tasks";
            await dropQueuedRow(item);
            continue;
          }

          if (item.taskIds.length > 0 && item.taskIds.every((task) => TASK_DONE.has(states[task] ?? ""))) {
            await fire(item, "tasks", states);
            fired++;
            continue;
          }
        }
        if (item.dueAt <= deps.now()) {
          if (item.queuedMessageId && deps.queuedState) {
            // BB sends it at its time. A row that is gone was sent, or deleted by the owner (the event may have been
            // lost to a reload): either way nothing more to send. If BB cannot say, the next sweep asks again.
            const queued = await deps.queuedState(item.threadId, item.queuedMessageId).catch(() => "unknown" as const);
            if (queued === "gone") { item.firedAt = deps.now(); item.firedBy = "time"; }
            continue;
          }
          await fire(item, "time"); fired++;
        }
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

  return { ask, reply, remind, cancel, threadSettled, sweep, list, watchedThreads, queueEvent };
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
    send:async (threadId, text, senderThreadId) => {
      await sendServiceMessage(bb, { threadId, text, senderThreadId });
    },
    settled:async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId }) as {
        status?:string; queuedMessageCount?:number; activeBackgroundAgentCount?:number; environmentId?:string|null;
      };
      // threads.get has no background command count; the thread list of its environment does.
      type Listed = { id:string; activity?:{ activeBackgroundCommandCount?:number } };
      const listed = thread.environmentId
        ? await (bb.sdk.threads.list({ environmentId:thread.environmentId, includeHidden:true } as never) as Promise<unknown>).catch(() => null)
        : null;
      const row = Array.isArray(listed) ? (listed as Listed[]).find((item) => item.id === threadId) : undefined;
      const commands = row?.activity?.activeBackgroundCommandCount ?? backgroundCommands.get(threadId) ?? 0;
      return ["idle", "error", "stopped"].includes(thread.status ?? "") && !thread.queuedMessageCount
        && !thread.activeBackgroundAgentCount && commands === 0;
    },
    taskStates:async (projectId, taskIds) => Object.fromEntries(taskIds.map((task) => [task, latestTaskAttemptState(ctx.db, projectId, task)])),
    latestFamilyMember:async (projectId, taskId) => {
      const family = taskFamily(taskId);
      const rows = ctx.db.prepare(`SELECT a.task_id, a.state FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
        WHERE r.project_id=? ORDER BY a.created_at DESC, a.attempt_no DESC`).all(projectId) as Array<{ task_id:string; state:string }>;
      const member = rows.find((row) => taskFamily(row.task_id) === family);
      return member ? { taskId:member.task_id, state:member.state } : null;
    },
    output:async (threadId) => {
      const result = await bb.sdk.threads.output({ threadId }) as { output?:unknown; text?:unknown };
      const value = result.output ?? result.text;
      return typeof value === "string" ? value : JSON.stringify(value ?? "");
    },
    // The time of a reminder is kept by BB's own queue (threads.send with sendAt, threads.queuedMessages): a card in the chat that
    // survives a reload. LANE_PILOT_NATIVE_REMINDERS=0 goes back to the sweep sending it when due.
    ...(process.env.LANE_PILOT_NATIVE_REMINDERS === "0" ? {} : {
      scheduleQueued:async (threadId:string, text:string, sendAt:number) => {
        const sent = await bb.sdk.threads.send({ threadId, mode:"queue-if-active", sendAt, input:[{ type:"text", text, mentions:[] }] } as never);
        // Anything but a queued row means BB took no `sendAt`: it cannot be undone, so say so loudly and let the sweep carry on.
        if (sent.delivery !== "queued") { ctx.log(`relay: BB sent a reminder at once instead of queueing it for ${new Date(sendAt).toISOString()}`); return null; }
        return sent.queuedMessage.id;
      },
      dropQueued:async (threadId:string, queuedMessageId:string) => {
        try { await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId }); return "deleted" as const; }
        // 404: not there (sent or deleted). 409: BB has taken it for dispatch this moment. Neither is a row to wait for.
        catch (cause) { return /\b(404|409)\b|not found/i.test(cause instanceof Error ? cause.message : String(cause)) ? "gone" as const : "failed" as const; }
      },
      queuedState:async (threadId:string, queuedMessageId:string) => {
        try {
          const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
          return rows.some((row) => row.id === queuedMessageId) ? "waiting" as const : "gone" as const;
        } catch (cause) { return /\b404\b|not found/i.test(cause instanceof Error ? cause.message : String(cause)) ? "gone" as const : "unknown" as const; }
      },
    }),
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

  registerObservedTool(bb.agents, {
    name:"lane_pilot_ask",
    description:"Ask another BB thread a question (who holds a block, when it frees, how something works). The answer comes back into this chat as a message.",
    instructions:[
      "Use when you wait on another thread: the holder of a blocked task (blockedBy.holderThreadId), a writer, a specialist.",
      "The question is queued into that thread without interrupting its work. Its answer, or its last message if it ends the turn without answering, arrives in this chat.",
      "Then set a reminder with lane_pilot_remind (watchThreadId = that thread) and end your turn; do not ask the owner to tell you when it is free.",
      "If the result has alreadyWaiting, your earlier question is still queued there: do not ask again, the answer comes when that thread finishes its turn. A reminder watching that thread closes itself once it answers.",
      `At most ${RELAY_LIMITS.asksPerPairPerHour} questions an hour between two threads.`,
    ].join("\n"),
    parameters:z.object({ threadId:z.string().min(1), question:z.string().trim().min(1).max(4000) }).strict(),
    execute:async (params, context) => JSON.stringify(refreshAfter(await relay.ask({
      projectId:context.projectId, fromThreadId:context.threadId, toThreadId:params.threadId, question:params.question,
    })), null, 2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_reply",
    description:"Answer a question another thread asked you through Lane Pilot (askId from the question).",
    instructions:"Use only for a question that reached this thread with an askId. Answer briefly and concretely, then continue your own work.",
    parameters:z.object({ askId:z.string().min(1), answer:z.string().trim().min(1).max(8000) }).strict(),
    execute:async (params, context) => JSON.stringify(refreshAfter(await relay.reply({ askId:params.askId, fromThreadId:context.threadId, answer:params.answer })), null, 2),
  });

  registerObservedTool(bb.agents, {
    name:"lane_pilot_remind",
    description:"Set yourself a reminder: Lane Pilot writes into this chat after the given minutes, or earlier when a watched thread finishes its turn.",
    instructions:[
      "Use instead of waiting for the owner whenever work is blocked on time or on another thread. Then end your turn; the reminder wakes you.",
      "Back off: 5, then 10, then 20 minutes for the same block; after three reminders without progress, tell the owner what you tried and what to decide.",
      "Pass watchThreadId to be woken as soon as that thread settles (for example blockedBy.holderThreadId).",
      "Waiting for your own tasks to be accepted or blocked (\"when X is merged, ship\")? Pass taskIds: you are woken the moment all of them finish, with their states, so you never poll and never get a stale reminder. inMinutes is then only the fallback.",
    ].join("\n"),
    parameters:z.object({
      inMinutes:z.number().int().min(1).max(24 * 60),
      note:z.string().trim().min(1).max(2000),
      watchThreadId:z.string().min(1).optional(),
      taskIds:z.array(z.string().min(1)).max(20).optional(),
    }).strict(),
    execute:async (params, context) => JSON.stringify(refreshAfter(await relay.remind({
      projectId:context.projectId, threadId:context.threadId, note:params.note, inMinutes:params.inMinutes, watchThreadId:params.watchThreadId,
      taskIds:params.taskIds,
    })), null, 2),
  });

  registerObservedTool(bb.agents, {
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
