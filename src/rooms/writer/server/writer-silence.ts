import { listThreadEventsRaw } from "@lane-pilot/thread-observe";
import { pluginStopped } from "../../contracts/errors";
import { sendServiceMessage } from "../../relay/server";

/** A writer thread that is active with no event for this long is nudged (setting writer.silence_nudge_min). */
export const DEFAULT_SILENCE_NUDGE_MIN = 20;
/** Nudges a silent writer gets before its attempt ends. */
export const MAX_WRITER_NUDGES = 2;
/** A silent OpenCode writer's session is checked for a provider limit after this much silence, well before its nudges. */
export const LIMIT_PROBE_MIN = 3;
/** A writer whose model sent nothing at all this long after its last input is held by a silent provider limit (Devin answers empty after 60 s). */
export const NO_ANSWER_MIN = 5;
/** How long a provider that answered nothing is skipped before one trial task tries it again. */
export const NO_ANSWER_HOLD_MS = 20 * 60_000;
/** A writer's turn ceiling without a setting (SMA m_cfg_max_turns): completed tool calls of one attempt after which it ends (setting writer.max_turns, 1-500). */
export const WRITER_MAX_TURNS = 80;

function eventType(event:unknown):string {
  const value = event && typeof event === "object" ? Reflect.get(event, "type") : undefined;
  return typeof value === "string" ? value : "";
}

/** Time of the writer's last input (turn start, prompt or nudge) when no model output came after it; null once the model answered. */
export function unansweredSince(events:unknown[]):number | null {
  let input = 0;
  let output = 0;
  for (const event of events) {
    const type = eventType(event);
    const at = eventTime(event) ?? 0;
    if (type === "turn/started" || type === "turn/input/accepted") input = Math.max(input, at);
    else if (type.startsWith("item/")) output = Math.max(output, at);
  }
  return input > 0 && output < input ? input : null;
}

/**
 * Count and time of the nudges of one attempt; `ended` tells its watcher to fail the attempt. An attempt that ended for a
 * provider limit carries its `reason` (writer_provider_limit: …) and the reset time `until` when the error named one.
 */
export type WriterNudge = { count:number; at:number; ended?:boolean; reason?:string; until?:number };

/** A provider limit the writer host's OpenCode service showed for the writer's session (host-worker/opencode-limit.ts). */
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

/** Attempts whose owner-form probe is currently failing: the failure is logged once per streak, not every sweep. */
const ownerProbeFailing = new Set<string>();

export async function loadWriterNudge(kv:Kv, attemptId:string):Promise<WriterNudge | null> {
  const value = await kv.get(key(attemptId));
  return value && typeof value === "object" && typeof (value as WriterNudge).count === "number" ? value as WriterNudge : null;
}

/** Nudges sent to the attempts of a run, for the wait receipt. */
export async function countRunNudges(kv:Kv, attemptIds:string[]):Promise<number> {
  const rows = await Promise.all(attemptIds.map((attemptId) => loadWriterNudge(kv, attemptId)));
  return rows.reduce((sum, row) => sum + (row?.count ?? 0), 0);
}

/** How a running writer's recent frames read: its turn closed, it loops one call with nothing written, or it moves. */
export type WriterFrame = "closed" | "spinning" | "progressing";

/** The same call this many times in a row, with nothing else between, reads as a loop: a check rerun three times is ordinary work. */
export const SPIN_REPEATS = 6;
/** A spinning writer hears about it at most this often, and is ended only when it loops again this long after its last nudge. */
export const SPIN_NUDGE_GAP_MS = 10 * 60_000;

/** Command/tool-call signature of one finished item, "" for a file change, null for anything else (a message, an unfinished item). */
function callSignatureOf(event: unknown): string | null {
  // One call is several events (started, updated, completed): only the completed one counts, or one command would read as three.
  if (eventType(event) !== "item/completed") return null;
  const item = event && typeof event === "object" ? (event as { data?: { item?: Record<string, unknown> } }).data?.item : undefined;
  if (!item) return null;
  const type = String(item.type ?? "");
  if (type !== "toolCall" && type !== "commandExecution") return type === "fileChange" ? "" : null;
  const call = String(item.command ?? item.name ?? "") || JSON.stringify(item.input ?? item.arguments ?? "");
  return `${String(item.tool ?? item.name ?? type)}:${call.slice(0, 300)}`;
}

/**
 * The call a spinning writer keeps repeating (for the nudge text and the end reason), null when it does not spin: the newest
 * SPIN_REPEATS finished calls after `since` are one and the same call with no file change and no other call between them.
 * Events come newest first, as listThreadEventsRaw returns them.
 */
export function repeatedCallOf(events: unknown[], since = 0): string | null {
  let first: string | null = null;
  let run = 0;
  for (const event of events) {
    if ((eventTime(event) ?? Infinity) <= since) break;
    const signature = callSignatureOf(event);
    if (signature === null) continue;
    if (signature === "" || (first !== null && signature !== first)) break;
    first = signature;
    run += 1;
    if (run >= SPIN_REPEATS) return first;
  }
  return null;
}

/**
 * The stall frame of a writer's last events (newest first, as listThreadEventsRaw returns them): closed when the turn
 * completed, spinning when the newest SPIN_REPEATS calls are one call with no file change between, progressing otherwise.
 */
export function writerFrame(events: unknown[]): WriterFrame {
  // Either edge may be the newest event (the sweep reads desc, tests may pass asc): a completed turn ends the frame.
  const ends = [events[0], events[events.length - 1]];
  if (ends.some((event) => eventType(event) === "turn/completed" || eventType(event) === "turn/failed")) return "closed";
  return repeatedCallOf(events) ? "spinning" : "progressing";
}

export type SilenceDeps = {
  bb:{ sdk:{ threads:{ send(args:never):Promise<unknown>; events:{ list(args:never):Promise<unknown> } } }; storage:{ kv:Kv } };
  openAttempts:() => SilenceAttempt[];
  getThread:(threadId:string) => Promise<unknown>;
  /** Minutes of silence after which the project's writers are nudged. */
  silenceMinutes:(projectId:string, runId:string) => number;
  isDisposed:() => boolean;
  /**
   * Asks the writer host's OpenCode service about the writer's session since `sinceMs`: a provider limit, or null (none, or no
   * answer). Only opencode2 writers get one; without it a silent writer is nudged as before.
   */
  limitProbe?:(attempt:SilenceAttempt, sessionId:string, sinceMs:number) => Promise<OpenCodeLimit | null>;
  /** True while this thread (the writer's, or its PM chat) waits for the owner's answer: a silent writer is not a stuck one then. */
  waitingForOwner?:(threadId:string) => Promise<boolean>;
  /** Completed tool calls of one attempt after which it ends (writer.max_turns; WRITER_MAX_TURNS when the dep is absent). */
  maxTurns?:(projectId:string, runId:string) => number;
  /** Completed tool calls of one attempt after which it ends (writer.max_turns; WRITER_MAX_TURNS when the dep is absent). */
  maxTurns?:(projectId:string, runId:string) => number;
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
      const listed = await listThreadEventsRaw(bb as never, { threadId:attempt.thread_id, order:"desc", limit:"200" });
      if (!listed.ok) continue;
      // The worker's turn ceiling (SMA m_cfg_max_turns): a session is a BB thread, so Lane Pilot counts the
      // writer's steps from its events itself. Past the ceiling the attempt ends like any timeout.
      const ceiling = Math.max(1, Math.min(500, Math.trunc(deps.maxTurns?.(attempt.project_id, attempt.run_id) ?? WRITER_MAX_TURNS)));
      const turns = listed.events.filter((event) => { const signature = callSignatureOf(event); return signature !== null && signature !== ""; }).length;
      if (turns > ceiling) {
        const reason = `turn ceiling ${ceiling} reached`;
        await bb.storage.kv.set(key(attempt.id), { count:record?.count ?? 0, at:now, ended:true, reason } as never);
        deps.log(`Lane Pilot ended ${attempt.task_id} (${attempt.id}): ${reason} (${turns} completed calls)`);
        done.push({ attemptId:attempt.id, action:"ended", count:record?.count ?? 0 });
        continue;
      }
      const last = Math.max(0, ...listed.events.map(eventTime).filter((time):time is number => time !== null));
      if (!last) continue;
      // A nudge is an event of its own, and a writer that ignores it is silent from the nudge on.
      const silentMs = now - Math.max(last, record?.at ?? 0);
      // An active writer can still be stuck: one call looping with no file change is a stall, not silence (sma as_stagnation).
      // Only calls made after the last nudge count, and no sooner than SPIN_NUDGE_GAP_MS after it: a writer that was told and
      // changed course is left alone, and one long wait polled with the same command is not ended within minutes.
      const spinCall = now - (record?.at ?? 0) >= SPIN_NUDGE_GAP_MS ? repeatedCallOf(listed.events, record?.at ?? 0) : null;
      if (!spinCall && silentMs < Math.min(limitMs, LIMIT_PROBE_MIN * 60_000)) continue;
      // A form open for the owner (on the writer's thread, or the PM's question that its answer may hang on) is a wait, not silence.
      // A probe that throws is unknown, not "no form": skip this writer this sweep, and log the failure once per streak.
      let ownerFormOpen = false;
      try {
        ownerFormOpen = await (deps.waitingForOwner?.(attempt.thread_id) ?? Promise.resolve(false));
        if (!ownerFormOpen && attempt.pm_thread_id) ownerFormOpen = await (deps.waitingForOwner?.(attempt.pm_thread_id) ?? Promise.resolve(false));
      } catch (cause) {
        if (!ownerProbeFailing.has(attempt.id)) {
          ownerProbeFailing.add(attempt.id);
          deps.log(`Lane Pilot owner-form probe of ${attempt.id} failed: ${cause instanceof Error ? cause.message : String(cause)}; the writer is skipped this sweep`);
        }
        continue;
      }
      ownerProbeFailing.delete(attempt.id);
      if (ownerFormOpen) continue;
      const count = record?.count ?? 0;
      if (spinCall) {
        if (count >= MAX_WRITER_NUDGES) {
          const reason = `no progress: spinning on ${spinCall.slice(0, 120)}`;
          await bb.storage.kv.set(key(attempt.id), { count, at:now, ended:true, reason } as never);
          deps.log(`Lane Pilot ended ${attempt.task_id} (${attempt.id}): ${reason}`);
          done.push({ attemptId:attempt.id, action:"ended", count });
          continue;
        }
        const text = `Lane Pilot: you are repeating ${spinCall.slice(0, 200)} with no file change. Stop the loop; try another way or say what blocks you.`;
        await sendServiceMessage(bb, { threadId:attempt.thread_id, mode:"steer-if-active", text, senderThreadId:attempt.pm_thread_id });
        await bb.storage.kv.set(key(attempt.id), { count:count + 1, at:now } as never);
        deps.log(`Lane Pilot nudged the writer of ${attempt.task_id} (${attempt.id}): spinning on ${spinCall.slice(0, 120)}, nudge ${count + 1} of ${MAX_WRITER_NUDGES}`);
        done.push({ attemptId:attempt.id, action:"nudged", count:count + 1 });
        continue;
      }
      const minutes = Math.round((now - last) / 60_000);
      // A silent writer whose session names a provider limit ends now, uncharged, and its breaker holds to the reset time: no nudge.
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
      // The model sent no word since its last input: a provider that holds requests silently (Devin's free SWE-2 answers empty
      // after 60 s and its CLI then waits forever). A nudge would hang the same way, so the next model in the chain takes the task.
      const asked = unansweredSince(listed.events);
      if (asked !== null && now - asked >= NO_ANSWER_MIN * 60_000) {
        const reason = `writer_provider_limit: the model sent no answer for ${Math.round((now - asked) / 60_000)} min after its prompt (a silent provider limit)`;
        await bb.storage.kv.set(key(attempt.id), { count, at:now, ended:true, reason, until:now + NO_ANSWER_HOLD_MS } as never);
        deps.log(`Lane Pilot ended ${attempt.task_id} (${attempt.id}): ${reason}`);
        done.push({ attemptId:attempt.id, action:"ended", count });
        continue;
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
