import { randomUUID } from "node:crypto";
import type { ManualMode, PrepareRecipient } from "../../../contracts";
import { ToolError } from "../../../contracts/server";
import type { TaskOutcome } from "../../../storage";
import {
  DUPLICATE_REMINDER_MS,
  RELAY_LIMITS,
  TASK_DONE,
  boundItemsSize,
  isOpen,
  reminderText,
  type RelayAsk,
  type RelayItem,
  type RelayReminder,
} from "../../models/relay";
import { sendPendingTaskNotices } from "./task-notices";

/**
 * Lane Pilot's relay: agents ask other threads and answer back; the plugin server also wakes a PM with internal
 * reminders (a merge-block holder, an owner-requested date), so a blocked agent does not wait for the owner.
 * The server runs all the time; agents only get messages. A reminder fires when it is due, or earlier when the
 * thread it watches finishes its turn.
 */

export type RelayDeps = {
  load(): Promise<RelayItem[]>;
  save(items: RelayItem[]): Promise<void>;
  /** `senderThreadId`: the thread the message comes from, so the receiver sees who wrote it. */
  send(threadId: string, text: string, senderThreadId?: string): Promise<void>;
  /**
   * The thread has finished its work: not running a turn, nothing queued for it (a queued question waits for
   * its turn), and no background command or agent still at work (a turn can end while `sleep` or a build runs on).
   */
  settled(threadId: string): Promise<boolean>;
  /** The thread's last answer, used when an asked thread finishes without lane_pilot_reply. */
  output(threadId: string): Promise<string>;
  /** The thread is in a turn (or waits on an approval): a message sent now would arrive behind it, with the text it was written with. */
  busy?(threadId: string): Promise<boolean>;
  /** The latest attempt state of each task in the project; null when it has none. */
  taskStates(projectId: string, taskIds: string[]): Promise<Record<string, string | null>>;
  /** Returns the newest taskId and its state in the same task family (e.g. redispatch <id>.2), if any newer exists. */
  latestFamilyMember?(projectId: string, taskId: string): Promise<{ taskId: string; state: string | null } | null>;
  /**
   * Task results not yet told to their PM (src/rooms/storage listUnreportedTaskOutcomes). Absent: only reminders tell a PM
   * that its tasks ended, as before 0.1.232.
   */
  taskOutcomes?(): Promise<TaskOutcome[]>;
  /** The PM's tasks still at work (queued, being spawned, running, being canceled) — a bare id, or a wait row
   * `{taskId, reason}` when the task is parked on a reason (quarantine, a held provider, a paused run). */
  tasksAtWork?(pmThreadId: string): Promise<Array<string | { taskId: string; reason: string | null }>>;
  /** Lane Pilot's own commit after these accepted tasks (project life) is still on its way to main: the PM would push before it. */
  bookkeeping?(rows: TaskOutcome[]): Promise<boolean>;
  /** Lane Pilot already told the PM this outcome in a message of its own (a writer's question, a task not started). */
  toldDirectly?(row: TaskOutcome): boolean;
  markReported?(rows: TaskOutcome[]): Promise<void>;
  /** Lines about the overdue and open deferrals of a project, added to the task-result message (SMA rule 6: read them before you promise a date). */
  deferralLines?(projectId: string): string[];
  /** The integration gate's verdict for an accepted task's merge commit (lane_pilot_gate_run), appended to its line. */
  gateLine?(row: TaskOutcome): Promise<string | null>;
  /** Whether BB SDK natively delivers `childThreadId`'s turn completions and replies to `parentThreadId` (parentNotifications != none, not a quiet helper). */
  nativelyNotifiesParent?(childThreadId: string, parentThreadId: string): Promise<boolean>;
  now(): number;
  log(message: string): void;
  /** Puts the text into BB's queue for `sendAt`; the queued row's id, or null when it could not be queued (the sweep then sends). */
  scheduleQueued?(threadId: string, text: string, sendAt: number): Promise<string | null>;
  /** Deletes a queued row. `gone`: it is not there (already sent, or deleted by the owner); `failed`: unknown. */
  dropQueued?(threadId: string, queuedMessageId: string): Promise<"deleted" | "gone" | "failed">;
  /** Whether the row still waits in the queue; `unknown` when BB could not say. */
  queuedState?(threadId: string, queuedMessageId: string): Promise<"waiting" | "gone" | "unknown">;
  /** «Ручной режим»: skips queueing new reminders and firing sweeps/settle wakes while manual. */
  manualMode?: Pick<ManualMode, "on">;
};

const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 16)}`;

export function createRelay(deps: RelayDeps) {
  let chain: Promise<unknown> = Promise.resolve();
  /** One read-modify-write at a time: tools, events and the sweep all touch the same list. */
  function update<T>(work: (items: RelayItem[]) => Promise<T> | T): Promise<T> {
    const next = chain.then(async () => {
      const items = await deps.load();
      const result = await work(items);
      const cutoff = deps.now() - RELAY_LIMITS.keepMs;
      const filtered = items.filter((item) => item.createdAt > cutoff || isOpen(item));
      const bounded = boundItemsSize(filtered, RELAY_LIMITS.maxStoredBytes);
      await deps.save(bounded);
      return result;
    });
    chain = next.catch(() => undefined);
    return next;
  }

  /**
   * The thread a reminder waited on has answered: the reminder would only arrive after the answer and read as
   * stale («это напоминание устарело»), so it is closed without a message.
   */
  async function closeAnsweredWaits(items: RelayItem[], askerId: string, answeredBy: string) {
    for (const item of items) {
      if (item.kind === "remind" && !item.firedAt && item.threadId === askerId && item.watchThreadId === answeredBy) {
        item.firedAt = deps.now();
        item.firedBy = "answered";
        await dropQueuedRow(item);
      }
    }
  }

  /** Takes a reminder's row out of BB's queue; true when the row is not there any more (it was already sent or deleted). */
  async function dropQueuedRow(item: RelayReminder): Promise<boolean> {
    if (!item.queuedMessageId || !deps.dropQueued) return false;
    const dropped = await deps.dropQueued(item.threadId, item.queuedMessageId).catch(() => "failed" as const);
    if (dropped === "failed") deps.log(`relay: could not delete the queued reminder ${item.queuedMessageId} of ${item.id}`);
    return dropped === "gone";
  }

  async function ask(input: { projectId: string; fromThreadId: string; toThreadId: string; question: string }, prepareRecipient?: PrepareRecipient): Promise<RelayAsk & { alreadyWaiting?: true }> {
    if (input.fromThreadId === input.toThreadId) throw new Error("a thread cannot ask itself");
    return update(async (items) => {
      // Asking again while the first question waits in that thread's queue only queues a stale copy behind it.
      const open = items.find((item): item is RelayAsk => item.kind === "ask" && !item.answeredAt
        && item.fromThreadId === input.fromThreadId && (item.toThreadId === input.toThreadId || item.requestedThreadId === input.toThreadId));
      if (open) return { ...open, alreadyWaiting: true as const };
      const hourAgo = deps.now() - 3_600_000;
      const recent = items.filter((item) => item.kind === "ask" && item.createdAt > hourAgo
        && [item.fromThreadId, item.requestedThreadId ?? item.toThreadId].sort().join() === [input.fromThreadId, input.toThreadId].sort().join());
      if (recent.length >= RELAY_LIMITS.asksPerPairPerHour) {
        throw new Error(`relay limit: ${RELAY_LIMITS.asksPerPairPerHour} questions an hour between these two threads; escalate to the owner`);
      }
      const toThreadId = prepareRecipient ? await prepareRecipient(input) : input.toThreadId;
      const item: RelayAsk = { kind: "ask", id: id("ask"), ...input, toThreadId, ...(toThreadId !== input.toThreadId ? { requestedThreadId: input.toThreadId } : {}), createdAt: deps.now(), answeredAt: null };
      if (prepareRecipient) {
        item.deliveryUnknown = true;
        await deps.save(boundItemsSize([...items, item], RELAY_LIMITS.maxStoredBytes));
      }
      const nativeParent = await deps.nativelyNotifiesParent?.(toThreadId, input.fromThreadId).catch(() => false) ?? false;
      try {
        await deps.send(toThreadId, [
          ...(nativeParent ? [] : [`Lane Pilot: question from @thread:${input.fromThreadId} (${item.id}):`]),
          ...(toThreadId !== input.toThreadId ? [`Fresh chat replacing @thread:${input.toThreadId}; consult its history if needed.`] : []),
          ...(nativeParent && toThreadId === input.toThreadId ? [] : [""]),
          input.question,
          ...(nativeParent ? [] : [
            "",
            `Answer briefly with the lane_pilot_relay tool, action \`reply\`, using askId "${item.id}": what you are doing, what you are holding and when it frees. Keep working on your task.`,
            "If you cannot call that tool, end your turn with the answer; it is passed back.",
          ]),
        ].join("\n"), input.fromThreadId);
      } catch (cause) {
        if (!prepareRecipient) throw cause;
        throw new ToolError(`question ${item.id} delivery to @thread:${toThreadId} is unconfirmed: ${cause instanceof Error ? cause.message : String(cause)}`, {
          code: "relay_delivery_unknown", retryable: false, sideEffects: "unknown", next: "Inspect the recipient and question; do not resend or create another child.",
        });
      }
      delete item.deliveryUnknown;
      if (nativeParent) {
        item.answeredAt = deps.now();
        await closeAnsweredWaits(items, input.fromThreadId, toThreadId);
        items.push(item);
        return { ...item, nativeParentDelivery: true as const };
      }
      items.push(item);
      return item;
    });
  }

  async function reply(input: { askId: string; fromThreadId: string; answer: string }) {
    return update(async (items) => {
      const item = items.find((row): row is RelayAsk => row.kind === "ask" && row.id === input.askId);
      if (!item) throw new Error(`no question ${input.askId}`);
      if (item.toThreadId !== input.fromThreadId) throw new Error("only the asked thread can answer");
      if (item.answeredAt) return item;
      const nativeParent = await deps.nativelyNotifiesParent?.(item.toThreadId, item.fromThreadId).catch(() => false) ?? false;
      if (!nativeParent) await deps.send(item.fromThreadId, `Lane Pilot: reply from @thread:${item.toThreadId} to ${item.id}:\n\n${input.answer}`, item.toThreadId);
      item.answeredAt = deps.now();
      delete item.deliveryUnknown;
      await closeAnsweredWaits(items, item.fromThreadId, item.toThreadId);
      return nativeParent ? { ...item, nativeParentDelivery: true as const } : item;
    });
  }

  async function remind(input: { projectId: string; threadId: string; note: string; inMinutes: number; watchThreadId?: string | null; taskIds?: string[]; ownerDate?: boolean }) {
    if (deps.manualMode?.on()) {
      deps.log(`relay: reminder skipped for ${input.threadId} (manual mode)`);
      const now = deps.now();
      return { kind: "remind", id: id("rem"), projectId: input.projectId, threadId: input.threadId, note: input.note, dueAt: now + input.inMinutes * 60_000, watchThreadId: input.watchThreadId ?? null, createdAt: now, firedAt: now, firedBy: "canceled" } satisfies RelayReminder;
    }
    return update(async (items) => {
      const mine = items.filter((row): row is RelayReminder => row.kind === "remind" && row.threadId === input.threadId);
      if (mine.filter((row) => !row.firedAt).length >= RELAY_LIMITS.openRemindersPerThread) {
        throw new Error(`relay limit: ${RELAY_LIMITS.openRemindersPerThread} open reminders; cancel one first`);
      }
      if (mine.filter((row) => row.createdAt > deps.now() - 86_400_000).length >= RELAY_LIMITS.remindersPerThreadPerDay) {
        throw new Error(`relay limit: ${RELAY_LIMITS.remindersPerThreadPerDay} reminders a day; escalate to the owner`);
      }
      // The same reminder set twice (a retried call, a PM that forgot it already did): the open one is returned, no second card in the chat.
      const dueAt = deps.now() + input.inMinutes * 60_000;
      const sameTasks = (row: RelayReminder) => [...(row.taskIds ?? [])].sort().join() === [...new Set(input.taskIds ?? [])].sort().join();
      const twin = mine.find((row) => !row.firedAt && row.note.trim().toLowerCase() === input.note.trim().toLowerCase() && (row.watchThreadId ?? null) === (input.watchThreadId ?? null)
        && sameTasks(row) && Math.abs(row.dueAt - dueAt) <= DUPLICATE_REMINDER_MS);
      if (twin) return twin;
      const timeOnly = !input.watchThreadId && !input.taskIds?.length && !input.ownerDate;
      if (timeOnly && input.inMinutes > RELAY_LIMITS.timeOnlyMaxMinutes) {
        throw new Error("relay limit: a wait longer than 2 hours on nothing Lane Pilot can see — tell the owner what you wait for and end the turn, or use lane_pilot_schedule for a recurring check.");
      }
      let chainDepth: number | undefined;
      if (timeOnly) {
        const prev = mine.filter((row) => row.firedBy === "time" && row.firedAt && !row.watchThreadId && !row.taskIds?.length && !row.ownerDate)
          .reduce<RelayReminder | undefined>((latest, row) => !latest || row.firedAt! > latest.firedAt! ? row : latest, undefined);
        chainDepth = prev && deps.now() - prev.firedAt! <= RELAY_LIMITS.chainWindowMs ? (prev.chainDepth ?? 1) + 1 : 1;
        if (chainDepth > RELAY_LIMITS.chainMax) {
          throw new Error("relay limit: three reminders in a row without progress — tell the owner what you tried and what to decide.");
        }
      }
      const item: RelayReminder = {
        kind: "remind",
        id: id("rem"),
        projectId: input.projectId,
        threadId: input.threadId,
        note: input.note,
        dueAt,
        watchThreadId: input.watchThreadId ?? null,
        createdAt: deps.now(),
        firedAt: null,
        firedBy: null,
        ...(input.taskIds?.length ? { taskIds: [...new Set(input.taskIds)] } : {}),
        ...(chainDepth ? { chainDepth } : {}),
        ...(input.ownerDate ? { ownerDate: true as const } : {}),
      };
      // BB's queue keeps the time: the reminder is a card in the chat, due at `dueAt`, and survives a reload of this plugin.
      if (deps.scheduleQueued) {
        item.queuedMessageId = await deps.scheduleQueued(item.threadId, reminderText(item, "time"), item.dueAt)
          .catch((cause: unknown) => { deps.log(`relay: could not queue reminder ${item.id}, the sweep will send it: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
      }
      items.push(item);
      return item;
    });
  }

  async function cancel(input: { threadId: string; reminderId: string }) {
    return update(async (items) => {
      const item = items.find((row): row is RelayReminder => row.kind === "remind" && row.id === input.reminderId && row.threadId === input.threadId);
      if (!item || item.firedAt) return false;
      item.firedAt = deps.now();
      await dropQueuedRow(item);
      return true;
    });
  }

  /**
   * A reminder on tasks quotes their states, and the state must hold when the PM reads it. It is read again just before the
   * send (the PM may have answered a blocked writer since the sweep looked: the task is running again), and not sent while
   * the PM's thread is in a turn: the text would wait in BB's queue behind that turn and arrive stale (live 2026-10-09: «blocked»
   * eight seconds after the answer). Either way the reminder stays open and the next sweep decides again.
   */
  async function liveTaskStates(item: RelayReminder): Promise<Record<string, string | null> | null> {
    const ids = item.taskIds ?? [];
    // An unreadable check is not a pass: busy() failing skips like the sweep's busy guard, and a failed
    // re-read must not fire on the last snapshot — both return null so the next sweep decides again.
    if (await deps.busy?.(item.threadId).catch((cause: unknown) => { deps.log(`relay: busy check unreadable, reminder skipped: ${cause instanceof Error ? cause.message : String(cause)}`); return true; })) return null;
    const live = await deps.taskStates(item.projectId, ids).catch((cause: unknown) => { deps.log(`relay: task states unreadable, reminder skipped: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
    if (!live || !ids.every((task) => TASK_DONE.has(live[task] ?? ""))) return null;
    return live;
  }

  /**
   * Sends, or says the thread is archived: nobody reads an archived chat and BB answers 409 to every try. The wait that sends there
   * closes; before, it threw out of the whole update and was tried again on every event (hub, 2026-10-31: «relay event failed: HTTP
   * 409: Thread is archived», a self-repair opened for it).
   */
  async function deliver(threadId: string, text: string, from?: string): Promise<boolean> {
    try { await deps.send(threadId, text, from); return true; }
    catch (cause) {
      if (!/archived/i.test(cause instanceof Error ? cause.message : String(cause))) throw cause;
      deps.log(`relay: ${threadId} is archived; its wait is closed undelivered`);
      return false;
    }
  }

  async function fire(item: RelayReminder, by: "time" | "watch" | "tasks", states?: Record<string, string | null>): Promise<boolean> {
    if (by === "tasks") {
      const live = await liveTaskStates(item);
      if (!live) return false;
      states = live;
    }
    // An early wake takes the queued time-reminder out first. If the row is already gone, BB sent it at the due time (or the
    // owner deleted it): a second reminder now would only be stale.
    if (by !== "time" && await dropQueuedRow(item)) {
      item.firedAt = deps.now();
      item.firedBy = "time";
      return true;
    }
    const sent = await deliver(item.threadId, reminderText(item, by, states), by === "watch" ? item.watchThreadId ?? undefined : undefined);
    item.firedAt = deps.now();
    item.firedBy = sent ? by : "canceled";
    return true;
  }

  /** BB announced a row of its queue: our reminder was sent at its time, or the owner deleted it from the card. */
  async function queueEvent(kind: "message.dispatched" | "message.cancelled", queuedMessageId: string) {
    return update((items) => {
      const item = items.find((row): row is RelayReminder => row.kind === "remind" && !row.firedAt && row.queuedMessageId === queuedMessageId);
      if (!item) return false;
      item.firedAt = deps.now();
      item.firedBy = kind === "message.dispatched" ? "time" : "canceled";
      return true;
    });
  }

  /** A watched or asked thread finished its turn: wake whoever waits on it, pass its answer back if it gave none. */
  async function threadSettled(threadId: string) {
    if (deps.manualMode?.on()) {
      deps.log(`relay: threadSettled skipped for ${threadId} (manual mode)`);
      return 0;
    }
    return update(async (items) => {
      const waiting = items.some((row) => (row.kind === "remind" && !row.firedAt && row.watchThreadId === threadId)
        || (row.kind === "ask" && !row.answeredAt && !row.deliveryUnknown && row.toThreadId === threadId));
      if (!waiting || !await deps.settled(threadId).catch((cause: unknown) => { deps.log(`relay: settled check unreadable, wake skipped: ${cause instanceof Error ? cause.message : String(cause)}`); return false; })) return 0;
      let woken = 0;
      // Answers first: whoever gets one now does not also need the reminder that waited on this thread.
      for (const item of items) {
        if (item.kind === "ask" && !item.answeredAt && !item.deliveryUnknown && item.toThreadId === threadId) {
          const nativeParent = await deps.nativelyNotifiesParent?.(threadId, item.fromThreadId).catch(() => false) ?? false;
          if (!nativeParent) {
            const text = (await deps.output(threadId).catch((cause: unknown) => { deps.log(`relay: thread output unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return ""; })).trim().slice(-4000);
            await deliver(item.fromThreadId, `Lane Pilot: @thread:${threadId} finished its turn without answering ${item.id}. Its last message:\n\n${text || "(empty)"}`, threadId);
            woken++;
          }
          item.answeredAt = deps.now();
          await closeAnsweredWaits(items, item.fromThreadId, threadId);
        }
      }
      for (const item of items) {
        if (item.kind === "remind" && !item.firedAt && item.watchThreadId === threadId) {
          if (await deps.nativelyNotifiesParent?.(threadId, item.threadId).catch(() => false)) {
            await dropQueuedRow(item); item.firedAt = deps.now(); item.firedBy = "answered";
          } else { await fire(item, "watch"); woken++; }
        }
      }
      return woken;
    });
  }

  /** Fires due reminders and catches settled threads whose event was missed (a reload, a dropped stream). */
  async function sweep() {
    if (deps.manualMode?.on()) {
      deps.log("relay: sweep skipped (manual mode)");
      return { fired: 0, settled: 0 };
    }
    const watched = new Set<string>();
    const due = await update(async (items) => {
      let fired = await sendPendingTaskNotices(deps, items, dropQueuedRow);
      for (const item of items) {
        if (item.kind !== "remind" || item.firedAt) continue;
        if (item.taskIds?.length) {
          // Check for redispatch and retarget tasks if a newer family member exists
          if (deps.latestFamilyMember) {
            const updatedTaskIds = new Set<string>();
            for (const task of item.taskIds) {
              const newer = await deps.latestFamilyMember(item.projectId, task).catch((cause: unknown) => { deps.log(`relay: family lookup unreadable for ${task}: ${cause instanceof Error ? cause.message : String(cause)}`); return null; });
              if (newer && newer.taskId !== task) {
                updatedTaskIds.add(newer.taskId);
              } else {
                updatedTaskIds.add(task);
              }
            }
            item.taskIds = [...updatedTaskIds];
          }

          const states = await deps.taskStates(item.projectId, item.taskIds).catch((cause: unknown) => { deps.log(`relay: task states unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return {} as Record<string, string | null>; });

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
            // Not sent when the state no longer holds or the PM is in a turn: the reminder stays open (and its time still counts below).
            if (await fire(item, "tasks", states)) {
              // The reminder quoted these results: the PM is not told them a second time.
              const told = new Set(item.taskIds);
              const rows = (await deps.taskOutcomes?.().catch((cause: unknown) => { deps.log(`relay: task outcomes unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return [] as TaskOutcome[]; }) ?? []).filter((row) => row.pmThreadId === item.threadId && told.has(row.taskId));
              if (rows.length) await deps.markReported?.(rows);
              fired++; continue;
            }
          }
        }
        if (item.dueAt <= deps.now()) {
          if (item.queuedMessageId && deps.queuedState) {
            // BB sends it at its time. A row that is gone was sent, or deleted by the owner (the event may have been
            // lost to a reload): either way nothing more to send. If BB cannot say, the next sweep asks again.
            const queued = await deps.queuedState(item.threadId, item.queuedMessageId).catch((cause: unknown) => { deps.log(`relay: queued state unreadable, asked again next sweep: ${cause instanceof Error ? cause.message : String(cause)}`); return "unknown" as const; });
            if (queued === "gone") { item.firedAt = deps.now(); item.firedBy = "time"; }
            continue;
          }
          await fire(item, "time"); fired++;
        } else if (item.watchThreadId) watched.add(item.watchThreadId);
      }
      for (const item of items) if (item.kind === "ask" && !item.answeredAt && !item.deliveryUnknown) watched.add(item.toThreadId);
      return fired;
    });
    let settled = 0;
    for (const threadId of watched) settled += await threadSettled(threadId);
    return { fired: due, settled };
  }

  async function list(threadId: string) {
    const items = await deps.load();
    return items.filter((item) => item.kind === "remind" ? item.threadId === threadId
      : item.fromThreadId === threadId || item.toThreadId === threadId);
  }

  /** Thread ids the relay waits on; events of other threads are ignored without a read. */
  async function watchedThreads(): Promise<Set<string>> {
    const items = await deps.load();
    return new Set(items.flatMap((item) => item.kind === "remind" ? (!item.firedAt && item.watchThreadId ? [item.watchThreadId] : [])
      : !item.answeredAt && !item.deliveryUnknown ? [item.toThreadId] : []));
  }

  async function nextDeadline(): Promise<number | null> {
    const items = await deps.load();
    let nearest: number | null = null;
    for (const item of items) if (item.kind === "remind" && !item.firedAt && typeof item.dueAt === "number") nearest = nearest === null ? item.dueAt : Math.min(nearest, item.dueAt);
    return nearest;
  }

  return { ask, reply, remind, cancel, threadSettled, sweep, list, watchedThreads, queueEvent, nextDeadline };
}

export type Relay = ReturnType<typeof createRelay>;
