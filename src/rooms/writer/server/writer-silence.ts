import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { pluginStopped } from "../../runs/server";
import { sendServiceMessage } from "../../relay/server";

/** A writer thread that is active with no event for this long is nudged (setting writer.silence_nudge_min). */
export const DEFAULT_SILENCE_NUDGE_MIN = 20;
/** Nudges a silent writer gets before its attempt ends. */
export const MAX_WRITER_NUDGES = 2;

/** Count and time of the nudges of one attempt; `ended` tells its watcher to fail the attempt. */
export type WriterNudge = { count:number; at:number; ended?:boolean };

type Kv = { get(key:string):Promise<unknown>; set(key:string, value:never):Promise<unknown> };
const key = (attemptId:string) => `writer-nudge:${attemptId}`;

export async function loadWriterNudge(kv:Kv, attemptId:string):Promise<WriterNudge | null> {
  const value = await kv.get(key(attemptId)).catch(() => null);
  return value && typeof value === "object" && typeof (value as WriterNudge).count === "number" ? value as WriterNudge : null;
}

/** Nudges sent to the attempts of a run, for the wait receipt. */
export async function countRunNudges(kv:Kv, attemptIds:string[]):Promise<number> {
  const rows = await Promise.all(attemptIds.map((attemptId) => loadWriterNudge(kv, attemptId)));
  return rows.reduce((sum, row) => sum + (row?.count ?? 0), 0);
}

export type SilenceDeps = {
  bb:{ sdk:{ threads:{ send(args:never):Promise<unknown>; events:{ list(args:never):Promise<unknown> } } }; storage:{ kv:Kv } };
  openAttempts:() => Array<{ id:string; run_id:string; task_id:string; thread_id:string | null; state:string; project_id:string; pm_thread_id?:string | null }>;
  getThread:(threadId:string) => Promise<unknown>;
  /** Minutes of silence after which the project's writers are nudged. */
  silenceMinutes:(projectId:string, runId:string) => number;
  isDisposed:() => boolean;
  /** True while this thread (the writer's, or its PM chat) waits for the owner's answer: a silent writer is not a stuck one then. */
  waitingForOwner?:(threadId:string) => Promise<boolean>;
  /** The schedule run's signal: the sweep stops between attempts when the core aborts the run. */
  signal?:AbortSignal;
  log:(line:string) => void;
};

function eventTime(event:unknown):number | null {
  const value = event && typeof event === "object" ? Reflect.get(event, "createdAt") : undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A writer whose turn stays open with nothing happening (a pending read for 40 minutes, twice) is told to go on; the
 * third silence ends its attempt, which the writer's watcher reads from the stored record. Only running attempts are
 * looked at, each through its own thread's last events — never a scan of the project's threads.
 */
export async function sweepWriterSilence(deps:SilenceDeps, now = Date.now()):Promise<Array<{ attemptId:string; action:"nudged" | "ended"; count:number }>> {
  const done:Array<{ attemptId:string; action:"nudged" | "ended"; count:number }> = [];
  const { bb } = deps;
  for (const attempt of deps.openAttempts()) {
    if (deps.isDisposed() || deps.signal?.aborted) break;
    if (attempt.state !== "running" || !attempt.thread_id) continue;
    try {
      const limitMs = Math.max(1, deps.silenceMinutes(attempt.project_id, attempt.run_id)) * 60_000;
      const record = await loadWriterNudge(bb.storage.kv, attempt.id);
      if (record?.ended) continue;
      const thread = await deps.getThread(attempt.thread_id);
      if ((thread && typeof thread === "object" ? Reflect.get(thread, "status") : null) !== "active") continue;
      const listed = await listThreadEventsRaw(bb as never, { threadId:attempt.thread_id, order:"desc", limit:"50" });
      if (!listed.ok) continue;
      const last = Math.max(0, ...listed.events.map(eventTime).filter((time):time is number => time !== null));
      if (!last) continue;
      // A nudge is an event of its own, and a writer that ignores it is silent from the nudge on.
      if (now - Math.max(last, record?.at ?? 0) < limitMs) continue;
      // A form open for the owner (on the writer's thread, or the PM's question that its answer may hang on) is a wait, not silence.
      if (await deps.waitingForOwner?.(attempt.thread_id).catch(() => false)) continue;
      if (attempt.pm_thread_id && await deps.waitingForOwner?.(attempt.pm_thread_id).catch(() => false)) continue;
      const count = record?.count ?? 0;
      const minutes = Math.round((now - last) / 60_000);
      if (count >= MAX_WRITER_NUDGES) {
        await bb.storage.kv.set(key(attempt.id), { count, at:now, ended:true } as never);
        deps.log(`Lane Pilot ended ${attempt.task_id} (${attempt.id}): its writer stayed silent for ${minutes} min after ${count} nudges`);
        done.push({ attemptId:attempt.id, action:"ended", count });
        continue;
      }
      const text = `Lane Pilot: no activity for ${minutes} min. Continue; if a command hangs, stop it and go on; finish with your summary.`;
      await sendServiceMessage(bb, { threadId:attempt.thread_id, mode:"steer-if-active", text, senderThreadId:attempt.pm_thread_id });
      await bb.storage.kv.set(key(attempt.id), { count:count + 1, at:now } as never);
      deps.log(`Lane Pilot nudged the writer of ${attempt.task_id} (${attempt.id}): no activity for ${minutes} min, nudge ${count + 1} of ${MAX_WRITER_NUDGES}`);
      done.push({ attemptId:attempt.id, action:"nudged", count:count + 1 });
    } catch (cause) {
      if (pluginStopped(cause)) break;
      deps.log(`Lane Pilot writer silence check of ${attempt.id} skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return done;
}
