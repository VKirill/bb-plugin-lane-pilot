import { TERMINAL_ATTEMPT_STATES } from "@lane-pilot/contracts";

export type RelayAsk = {
  kind: "ask";
  id: string;
  projectId: string;
  fromThreadId: string;
  toThreadId: string;
  question: string;
  createdAt: number;
  answeredAt: number | null;
  requestedThreadId?: string;
  /** Persisted before sending. A lost acknowledgement must not trigger a duplicate question or a bootstrap-output answer. */
  deliveryUnknown?: true;
};

export type RelayReminder = {
  kind: "remind";
  id: string;
  projectId: string;
  threadId: string;
  note: string;
  dueAt: number;
  watchThreadId: string | null;
  createdAt: number;
  firedAt: number | null;
  firedBy: "time" | "watch" | "answered" | "tasks" | "canceled" | null;
  /** Lane Pilot tasks the reminder waits for: it fires when every one has finished, instead of polling by time. */
  taskIds?: string[];
  /**
   * The reminder's time is kept by BB's own message queue: this is the queued row (`threads.send` with `sendAt`), shown
   * as a card in the chat and surviving a reload. An early wake (a watched thread, finished tasks), a cancel or an answer
   * deletes the row first. Absent: the sweep sends the reminder when it is due, as before.
   */
  queuedMessageId?: string | null;
  /** Consecutive time-only reminders of this thread; 1 is a new chain. */
  chainDepth?: number;
  /**
   * A date the owner named himself (learning: «remind me on Monday»), set by the plugin server, not by an agent: it may be days
   * away, so the 2-hour cap and the chain of time-only reminders, which stop a PM snoozing, do not apply to it.
   */
  ownerDate?: true;
};

export type RelayItem = RelayAsk | RelayReminder;

/** Two reminders with the same note, watch and tasks due this close together are one. */
export const DUPLICATE_REMINDER_MS = 60_000;
/** Guards against two agents talking in circles or an agent snoozing for ever. */
// A PM watching a day-long run sets a reminder per batch; 30 a day ran out on SelfyStudio (2026-10-04).
export const RELAY_LIMITS = { asksPerPairPerHour: 6, openRemindersPerThread: 20, remindersPerThreadPerDay: 150, keepMs: 7 * 86_400_000, maxStoredBytes: 200_000, timeOnlyMaxMinutes: 120, chainWindowMs: 15 * 60_000, chainMax: 2 };

/** A task is finished when its latest attempt is accepted (merged), blocked after its retries, or canceled. */
export const TASK_DONE = new Set<string>(TERMINAL_ATTEMPT_STATES);

/**
 * When Lane Pilot tells a PM its task results (one message for all of them, so one turn instead of a reminder each):
 * a blocked task needs the PM, so it goes once no other result came in the last minute (at most 5 minutes after it);
 * accepted ones go once none of the PM's tasks is still at work, or after 30 minutes of a long queue.
 * Canceled-only batches are marked reported with no message (the PM canceled them itself); a mixed batch sums them as a count.
 * Results older than a day were never deliverable (the PM thread is gone): they are dropped.
 */
export const TASK_NOTICE = { settleMs: 60_000, urgentMaxMs: 5 * 60_000, quietMs: 30_000, maxWaitMs: 30 * 60_000, dropAfterMs: 86_400_000, bookkeepingMaxMs: 10 * 60_000 };

export function isOpen(item: RelayItem): boolean {
  return item.kind === "remind" ? !item.firedAt : !item.answeredAt;
}

export function truncateItemText(item: RelayItem, maxLen: number): void {
  if (item.kind === "remind" && item.note.length > maxLen) item.note = `${item.note.slice(0, maxLen)}…`;
  else if (item.kind === "ask" && item.question.length > maxLen) item.question = `${item.question.slice(0, maxLen)}…`;
}

const utf8Bytes = (text: string) => new TextEncoder().encode(text).length;

export function boundItemsSize(items: RelayItem[], maxBytes: number): RelayItem[] {
  let kept = [...items];
  if (utf8Bytes(JSON.stringify(kept)) <= maxBytes) return kept;

  // 1. Drop finished items first, oldest createdAt first
  const finished = kept
    .filter((item) => !isOpen(item))
    .sort((a, b) => a.createdAt - b.createdAt);

  const dropSet = new Set<RelayItem>();
  // Binary search to find how many finished items to drop efficiently
  let low = 1;
  let high = finished.length;
  let dropCount = finished.length;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const testDrop = new Set(finished.slice(0, mid));
    const candidate = kept.filter((it) => !testDrop.has(it));
    if (utf8Bytes(JSON.stringify(candidate)) <= maxBytes) {
      dropCount = mid;
      high = mid - 1; // Try dropping fewer
    } else {
      low = mid + 1; // Need to drop more
    }
  }

  for (let i = 0; i < dropCount; i++) {
    dropSet.add(finished[i]!);
  }
  kept = kept.filter((it) => !dropSet.has(it));

  // 2. If still over budget, truncate long text fields of remaining items with «…»
  if (utf8Bytes(JSON.stringify(kept)) > maxBytes) {
    for (const maxLen of [200, 80, 20, 0]) {
      for (const item of kept) {
        truncateItemText(item, maxLen);
      }
      if (utf8Bytes(JSON.stringify(kept)) <= maxBytes) break;
    }
  }

  return kept;
}

export function reminderText(item: RelayReminder, by: "time" | "watch" | "tasks", states?: Record<string, string | null>): string {
  const why = by === "watch" ? `thread @thread:${item.watchThreadId} finished its turn`
    : by === "tasks" ? `tasks completed: ${Object.entries(states ?? {}).map(([task, state]) => `${task} — ${state}`).join(", ")}`
    : "time reached";
  return `Lane Pilot: reminder (${item.id}, ${why}):\n\n${item.note}\n\nCheck if you can continue.`;
}

export const relayClock = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`;
