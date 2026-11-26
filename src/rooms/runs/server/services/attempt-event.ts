import { randomUUID } from "node:crypto";
import { LP_EVENTS, type LpEventName } from "@lane-pilot/contracts";
import { insertInboxEvent, type WorkflowEngine } from "@lane-pilot/workflow-engine";
import type { LanePilotDatabase } from "../../../storage";

/** Records an event in the durable workflow inbox and wakes any matching waiting step immediately. */
export async function emitAttemptEvent(input: {
  db: LanePilotDatabase;
  engine?: Pick<WorkflowEngine, "wake" | "recheck"> | null;
  name: LpEventName;
  key: string;
  attemptId?: string | null;
  payload?: Record<string, unknown>;
  projectId?: string | null;
  now?: number;
  /** A failed wake rejects (the inbox row is already written) so the caller can log it; otherwise it counts as zero woken. */
  strict?: boolean;
}): Promise<number> {
  const payload = input.payload ?? {};
  const now = input.now ?? Date.now();
  const attemptKey = input.attemptId ?? undefined;
  let woke = 0;
  const dispatchKey = async (key: string, wakeAttemptKey?: string) => {
    const eventId = `evt_${randomUUID()}`;
    try {
      insertInboxEvent(input.db, {
        id: eventId,
        name: input.name,
        key,
        payload,
        createdAt: now,
      });
    } catch {
      // Non-fatal if the inbox table has not been created in a minimal unit DB without engine migrations.
    }
    const woken = input.engine?.wake(input.name, key, payload, { eventId, ...(wakeAttemptKey ? { attemptKey: wakeAttemptKey } : {}) });
    const count = await (input.strict ? woken : woken?.catch(() => 0));
    woke += count ?? 0;
  };
  await dispatchKey(input.key, attemptKey);
  if (input.name === LP_EVENTS.TASK_SETTLED && input.projectId && input.projectId !== input.key) {
    // Also notify project-level admission waiters without binding attemptKey (cross-attempt signal).
    await dispatchKey(input.projectId);
  }
  // A canceled attempt is not what the task's waiting writer step resolves on (its own spawn does that); the step reads the task's
  // newest attempt, so a canceled retry ends it here instead of at its 48-hour deadline.
  if (input.name === LP_EVENTS.TASK_SETTLED && payload.state === "canceled") {
    const rechecked = input.engine?.recheck("attempt", { taskId: input.key });
    woke += (await (input.strict ? rechecked : rechecked?.catch(() => 0))) ?? 0;
  }
  return woke;
}
