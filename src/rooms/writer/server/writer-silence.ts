import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { pluginStopped } from "../../runs/server";
import { sendServiceMessage } from "../../relay/server";

/** A writer thread that is active with no event for this long is nudged (setting writer.silence_nudge_min). */
export const DEFAULT_SILENCE_NUDGE_MIN = 20;
/** Nudges a silent writer gets before its attempt ends. */
export const MAX_WRITER_NUDGES = 2;
/** A silent OpenCode writer is asked about its provider's log after this much silence, well before its nudges. */
export const LIMIT_PROBE_MIN = 3;

/**
 * Count and time of the nudges of one attempt; `ended` tells its watcher to fail the attempt. An attempt that ended for a
 * provider limit carries its `reason` (writer_provider_limit: …) and the reset time `until` when the log named one.
 */
export type WriterNudge = { count:number; at:number; ended?:boolean; reason?:string; until?:number };

/** A provider limit the writer host's OpenCode log showed for the writer's session (host-worker/opencode-limit-log.ts). */
export type OpenCodeLimit = { providerId:string | null; model:string | null; resetAt:number | null; reason:string | null };

export type SilenceAttempt = { id:string; run_id:string; task_id:string; thread_id:string | null; state:string; project_id:string; pm_thread_id?:string | null };

/** The OpenCode session a writer thread's events name (`providerThreadId`), or null before its first turn. */
export function openCodeSessionOf(events:unknown[]):string | null {
  for (const event of events) {
    const found = /"providerThreadId":"(ses_[A-Za-z0-9]{1,80})"/.exec(JSON.stringify(event) ?? "");
    if (found) return found[1]!;
  }
  return null;
}

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
  openAttempts:() => SilenceAttempt[];
  getThread:(threadId:string) => Promise<unknown>;
  /** Minutes of silence after which the project's writers are nudged. */
  silenceMinutes:(projectId:string, runId:string) => number;
  isDisposed:() => boolean;
  /**
   * Asks the writer host's OpenCode log about the writer's session since `sinceMs`: a provider limit, or null (none, or no
   * answer). Only acp-opencode writers get one; without it a silent writer is nudged as before.
   */
  limitProbe?:(attempt:SilenceAttempt, sessionId:string, sinceMs:number) => Promise<OpenCodeLimit | null>;
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
      const silentMs = now - Math.max(last, record?.at ?? 0);
      if (silentMs < Math.min(limitMs, LIMIT_PROBE_MIN * 60_000)) continue;
      // A form open for the owner (on the writer's thread, or the PM's question that its answer may hang on) is a wait, not silence.
      if (await deps.waitingForOwner?.(attempt.thread_id).catch(() => false)) continue;
      if (attempt.pm_thread_id && await deps.waitingForOwner?.(attempt.pm_thread_id).catch(() => false)) continue;
      const count = record?.count ?? 0;
      const minutes = Math.round((now - last) / 60_000);
      // A silent writer whose provider's log names a limit ends now, uncharged, and its breaker holds to the reset time: no nudge.
      // A probe that fails or finds none leaves the nudges as they were.
      if (deps.limitProbe && silentMs >= LIMIT_PROBE_MIN * 60_000) {
        const session = openCodeSessionOf(listed.events);
        const limit = session ? await deps.limitProbe(attempt, session, last).catch((cause) => {
          deps.log(`Lane Pilot provider limit check of ${attempt.id} skipped: ${cause instanceof Error ? cause.message : String(cause)}`);
          return null;
        }) : null;
        if (limit) {
          const reason = `writer_provider_limit: ${limit.model ?? "model unknown"}${limit.resetAt ? `, resets ${new Date(limit.resetAt).toISOString()}` : ", reset time unknown"}`;
          await bb.storage.kv.set(key(attempt.id), { count, at:now, ended:true, reason, ...(limit.resetAt ? { until:limit.resetAt } : {}) } as never);
          deps.log(`Lane Pilot ended ${attempt.task_id} (${attempt.id}): its writer's provider hit a limit after ${minutes} min of silence: ${reason}`);
          done.push({ attemptId:attempt.id, action:"ended", count });
          continue;
        }
      }
      if (silentMs < limitMs) continue;
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
