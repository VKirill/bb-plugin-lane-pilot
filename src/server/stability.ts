import packageJson from "../../package.json";
import { PARKED_CLASSES, failureClass, failureFingerprint, isWaitingSecret, type FailureClass } from "../failure-class";
import { allowedSecretNames, secretProblem, waitingSecretNote, WAITING_SECRET_PREFIX } from "./secrets";
import { createAttempt, getAttempt, getRun, getRunSettingsScopes, loadProjectSettings } from "../database";
import { id } from "./values";
import { reopenWriterStages } from "./stage-records";
import { isRunHalted } from "./runs-halt";
import type { ServerCore } from "./core";
import type { Services } from "./services";

const VERSION: string = packageJson.version;
export const PARKED_KEY = "stability:parked";
export const BREAKERS_KEY = "stability:breakers";
export const DRILL_KEY = "stability:drill";
/** The version of a task parked at start-up that no build is known for (an attempt from before harness_version): it restarts at once. */
const ADOPTED_VERSION = "before-adoption";
export type DrillOutcome = { at:number; version:string; checks:Array<{ name:string; ok:boolean; detail:string | null }> };
/** Same harness fingerprint this many times in the window opens the project's breaker (Mergify pause, circuit breaker). */
const BREAKER_THRESHOLD = 3;
const BREAKER_WINDOW_MS = 15 * 60_000;
/** An open breaker lets one task through after this long, to see whether the fault is gone (half-open). */
const BREAKER_PROBE_MS = 30 * 60_000;
/** Redrives per project per sweep, so a fixed fault does not restart a whole batch at once (SQS redrive velocity). */
const REDRIVE_PER_SWEEP = 3;
const INFRA_BACKOFF_MS = 10 * 60_000;
const INFRA_REDRIVE_LIMIT = 3;
/** A task parked for a secret is dropped from the sweep after this long; the PM sends it again. */
const SECRET_PARK_MS = 24 * 3600_000;
// Writers wait while a machine has less than 15 GB or 5 % of its disk free, whichever is SMALLER: a large disk needs no 5 % (23 GB
// of a 460 GB Mac mini held every writer at 16 GB free, 2026-10-08), a small one never has 15 GB to spare. Never below 3 GB.
const DISK_MIN_FREE_BYTES = 15 * 2 ** 30;
const DISK_MIN_FREE_SHARE = 0.05;
const DISK_FLOOR_BYTES = 3 * 2 ** 30;

export type ParkedTask = {
  projectId:string; runId:string; taskId:string; pmThreadId:string; klass:FailureClass;
  reason:string; fingerprint:string; version:string; at:number; redrives:number;
  /** When the failed attempt started; a sibling dispatched after it took the task over. */
  since?:number;
};

export { taskStem } from "../task-stem";
import { taskStem } from "../task-stem";

type Breaker = { fingerprint:string; openedAt:number; version:string; probing:boolean };

/**
 * Keeps a fault of Lane Pilot or of the machine from costing tasks: the task is parked instead of left blocked and
 * restarts by itself from its writer stage once a newer Lane Pilot runs (harness) or after a backoff (infra), and a
 * project whose tasks keep failing on the same fault stops starting writers until it is fixed.
 */
export function createStability(ctx:ServerCore, services:Services) {
  const { bb, db } = ctx;
  const recent = new Map<string, Array<{ fingerprint:string; at:number }>>();
  const breakers = new Map<string, Breaker>();
  const pendingNotes = new Map<string, string[]>();
  let flushTimer:ReturnType<typeof setTimeout> | null = null;

  /** Written at every change of a breaker, so a reload keeps the project's wait (and the self-repair watcher reads it). */
  function persistBreakers() {
    void bb.storage.kv.set(BREAKERS_KEY, Object.fromEntries(breakers)).catch(() => undefined);
  }

  /**
   * Reads the breakers back at start-up: a reload used to close every open breaker, and the next tasks started writers
   * into the same fault until three of them failed again. A breaker of another version is not restored (a fix shipped).
   */
  async function restoreBreakers():Promise<string[]> {
    const stored = await bb.storage.kv.get(BREAKERS_KEY).catch(() => null);
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
    const restored:string[] = [];
    for (const [projectId, row] of Object.entries(stored as Record<string, Partial<Breaker>>)) {
      if (!row || typeof row.fingerprint !== "string" || typeof row.openedAt !== "number" || row.version !== VERSION || breakers.has(projectId)) continue;
      breakers.set(projectId, { fingerprint:row.fingerprint, openedAt:row.openedAt, version:row.version, probing:Boolean(row.probing) });
      restored.push(projectId);
    }
    if (Object.keys(stored as object).length !== breakers.size) persistBreakers();
    if (restored.length) bb.log.info(`Lane Pilot restored the open breaker of ${restored.join(", ")} after a reload`);
    return restored;
  }

  async function loadParked():Promise<ParkedTask[]> {
    const stored = await bb.storage.kv.get(PARKED_KEY).catch(() => null);
    return Array.isArray(stored) ? stored as ParkedTask[] : [];
  }
  async function saveParked(list:ParkedTask[]) { await bb.storage.kv.set(PARKED_KEY, list); }

  /** Tells each PM once a minute at most, in one message, which of its tasks were parked or restarted. */
  function notePm(pmThreadId:string, line:string) {
    if (!pmThreadId) return;
    pendingNotes.set(pmThreadId, [...(pendingNotes.get(pmThreadId) ?? []), line]);
    flushTimer ??= setTimeout(() => {
      flushTimer = null;
      for (const [threadId, lines] of pendingNotes) {
        pendingNotes.delete(threadId);
        const text = `Lane Pilot (no action needed, do not redispatch these):\n${lines.map((line) => `- ${line}`).join("\n")}`;
        void bb.sdk.threads.send({ threadId, mode:"queue-if-active", input:[{ type:"text", text, mentions:[] }] } as never)
          .catch((cause) => ctx.log(`Lane Pilot could not tell ${threadId} about parked tasks: ${cause instanceof Error ? cause.message : String(cause)}`));
      }
    }, 60_000);
  }

  function noteHarnessFailure(projectId:string, fingerprint:string, now:number) {
    const list = (recent.get(projectId) ?? []).filter((row) => now - row.at < BREAKER_WINDOW_MS);
    list.push({ fingerprint, at:now });
    recent.set(projectId, list);
    const open = breakers.get(projectId);
    if (open && open.fingerprint === fingerprint) { open.openedAt = now; open.probing = false; persistBreakers(); return; }
    if (list.filter((row) => row.fingerprint === fingerprint).length >= BREAKER_THRESHOLD) {
      breakers.set(projectId, { fingerprint, openedAt:now, version:VERSION, probing:false });
      // Kept for the self-repair watcher (a breaker open for long means the fix has not shipped) and read back at start-up.
      persistBreakers();
      bb.log.warn(`Lane Pilot breaker open for ${projectId}: ${BREAKER_THRESHOLD} tasks failed on «${fingerprint}»; new writers wait`);
    }
  }

  /**
   * Called once a task's writer loop ends without acceptance. Lane Pilot's own fault or the machine's parks the task;
   * returns whether it did.
   */
  async function onTaskFailed(input:{ projectId:string; runId:string; taskId:string; pmThreadId:string; state:string; reason:string }, now = Date.now()):Promise<boolean> {
    if (input.reason.startsWith("run_budget_exceeded:")) return false;
    const klass = failureClass(input.state, input.reason);
    const waitingSecret = isWaitingSecret(input.reason);
    if (!(PARKED_CLASSES.has(klass) || waitingSecret) || await isRunHalted(bb.storage.kv as never, input.runId)) return false;
    const fingerprint = failureFingerprint(input.reason);
    if (klass === "harness") noteHarnessFailure(input.projectId, fingerprint, now);
    const list = await loadParked();
    const previous = list.find((row) => row.runId === input.runId && row.taskId === input.taskId);
    const entry:ParkedTask = { projectId:input.projectId, runId:input.runId, taskId:input.taskId, pmThreadId:input.pmThreadId, klass,
      reason:input.reason.slice(0, 400), fingerprint, version:VERSION, at:now, since:previous?.since, redrives:previous?.redrives ?? 0 };
    await saveParked([...list.filter((row) => row !== previous), entry]);
    bb.log.info(`Lane Pilot parked ${input.taskId} (${klass}: ${fingerprint})`);
    if (waitingSecret) notePm(input.pmThreadId, `${input.taskId} waits for a secret its checks need (${input.reason.slice(0, 160)}); call env_request for it, or ask the owner to allow it in secrets.allow. It restarts by itself once the access is in place, no attempt is spent.`);
    else notePm(input.pmThreadId, `${input.taskId} hit ${klass === "harness" ? "a Lane Pilot fault" : "a machine fault"} (${input.reason.slice(0, 160)}); it is parked and restarts by itself ${klass === "harness" ? "once the fix ships" : "after a short wait"}.`);
    return true;
  }

  /** Whether a writer of this project may start now; an open breaker holds it until the fault is fixed. */
  function breakerHolds(projectId:string, now = Date.now()):string | null {
    const open = breakers.get(projectId);
    if (!open) return null;
    if (open.version !== VERSION) { breakers.delete(projectId); persistBreakers(); return null; }
    if (!open.probing && now - open.openedAt >= BREAKER_PROBE_MS) { open.probing = true; persistBreakers(); return null; }
    return `several tasks failed on one Lane Pilot fault («${open.fingerprint}»), waiting for its fix`;
  }

  /**
   * Somebody already took the task over: a later attempt of it, a sibling dispatch (`<id>.2`, `<id>-r4`) started after
   * the failed attempt, or a sibling accepted at any time. Restarting then would redo work already in main.
   */
  function superseded(row:ParkedTask):boolean {
    const stem = taskStem(row.taskId);
    const since = row.since ?? row.at;
    const rows = db.prepare(`SELECT a.task_id, a.state, a.created_at FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
      WHERE r.project_id=? AND (a.task_id=? OR a.task_id LIKE ? ESCAPE '\\')`).all(row.projectId, stem, `${stem.replace(/[\\%_]/g, "\\$&")}%`) as
      Array<{ task_id:string; state:string; created_at:number }>;
    return rows.some((other) => taskStem(other.task_id) === stem && (
      (other.task_id !== row.taskId && (other.state === "accepted" || other.created_at > since))
      || (other.task_id === row.taskId && other.state === "accepted")
      || (other.task_id === row.taskId && other.created_at > row.at)));
  }

  /** A task parked for a secret is due once Env Catalog has every name in its reason and the owner allows it. */
  async function secretsReady(row:ParkedTask):Promise<boolean> {
    // The names run up to the first space (`A,B,net:host`); after 12 hours the reason continues with «: not provided…».
    const names = row.reason.slice(WAITING_SECRET_PREFIX.length).split(/\s/)[0]!.replace(/:$/, "").split(",").filter(Boolean);
    const settings = loadProjectSettings(db, row.projectId, getRunSettingsScopes(db, row.runId));
    const gate = await ctx.secrets.check({ declared:names, allowed:allowedSecretNames(settings) }, { fresh:true });
    return !gate.unavailable && secretProblem(gate).length === 0;
  }

  function dueForRedrive(row:ParkedTask, now:number):boolean {
    if (row.klass === "harness") return row.version !== VERSION;
    return row.redrives < INFRA_REDRIVE_LIMIT && now - row.at >= INFRA_BACKOFF_MS * 2 ** row.redrives;
  }

  /** Restarts parked tasks whose fault is fixed (harness) or whose backoff is over (infra), a few per project per pass. */
  async function sweep(now = Date.now(), signal?:AbortSignal):Promise<string[]> {
    const list = await loadParked();
    if (!list.length) return [];
    const keep:ParkedTask[] = [];
    const started:string[] = [];
    const perProject = new Map<string, number>();
    for (const row of list) {
      // An aborted sweep keeps what it has not decided yet: the rows it did not reach are saved as they were.
      if (signal?.aborted) { keep.push(row); continue; }
      const run = getRun(db, row.runId);
      if (!run || run.closed_at || superseded(row) || services.activeWriterTasks.has(`${row.runId}:${row.taskId}`) || await isRunHalted(bb.storage.kv as never, row.runId)) continue;
      const count = perProject.get(row.projectId) ?? 0;
      // A task waiting for a secret is not a fault: no breaker, no backoff, only the secret itself.
      const waiting = isWaitingSecret(row.reason);
      if (waiting && now - row.at > SECRET_PARK_MS) {
        notePm(row.pmThreadId, `${row.taskId} waited ${SECRET_PARK_MS / 3600_000} hours for ${row.reason.slice(0, 120)} and is no longer restarted by itself; send it again once the access is in place.`);
        continue;
      }
      if (waiting ? !await secretsReady(row) : (!dueForRedrive(row, now) || count >= REDRIVE_PER_SWEEP || breakerHolds(row.projectId, now))) {
        if (row.klass === "infra" && row.redrives >= INFRA_REDRIVE_LIMIT) {
          notePm(row.pmThreadId, `${row.taskId} still fails on a machine fault after ${INFRA_REDRIVE_LIMIT} retries (${row.reason.slice(0, 160)}); redispatch it once the machine is fixed.`);
          continue;
        }
        keep.push(row);
        continue;
      }
      const attemptId = id("lpattempt");
      // The stages closed failed when the task stopped; without reopening them the restart died on «failed -> running».
      reopenWriterStages(db, row.runId, row.taskId, `restarting after ${row.klass} fault`);
      createAttempt(db, { id:attemptId, runId:row.runId, taskId:row.taskId });
      const attempt = getAttempt(db, attemptId);
      const ok = attempt ? await services.enqueueResumedWriter(row.projectId, attempt).catch(() => false) : false;
      if (!ok) { keep.push({ ...row, redrives:row.redrives + 1, at:now }); continue; }
      perProject.set(row.projectId, count + 1);
      started.push(row.taskId);
      notePm(row.pmThreadId, `${row.taskId} restarted from its writer stage (${waiting ? "its secret is in place" : row.klass === "harness" ? `Lane Pilot ${VERSION} fixed «${row.fingerprint}»` : "machine fault retry"}).`);
    }
    await saveParked(keep);
    if (started.length) bb.log.info(`Lane Pilot restarted ${started.length} parked task(s): ${started.join(", ")}`);
    return started;
  }

  /**
   * Whether the writer host has too little free disk for another worktree (≈2 GB each on SelfyStudio): a full OVH disk
   * stopped its BB host daemon on 2026-10-03. Null when there is room or the host cannot say.
   */
  async function diskHolds(hostId:string, path:string):Promise<string | null> {
    const free = await ctx.host.call("diskFree", { requestedHostId:hostId, path }, { hostId, timeoutMs:15_000 }).catch(() => null);
    if (!free || !free.totalBytes) return null;
    const low = free.freeBytes < Math.max(DISK_FLOOR_BYTES, Math.min(DISK_MIN_FREE_BYTES, free.totalBytes * DISK_MIN_FREE_SHARE));
    return low ? `only ${Math.round(free.freeBytes / 2 ** 30)} GB free on ${hostId}` : null;
  }

  /**
   * Tasks blocked in the last day by a Lane Pilot or machine fault before parking existed, or before the fault was
   * recognised as one, are parked once at start-up so they restart like any other (none of them is the task's fault).
   */
  async function adoptBlockedByFaults(now = Date.now()):Promise<string[]> {
    // By when the attempt started: a cleanup that touched an old attempt yesterday made a 2-day-old task look recent.
    const rows = db.prepare(`SELECT a.run_id, a.task_id, a.state, a.reason, a.created_at, a.updated_at, a.harness_version, r.project_id, r.pm_thread_id
      FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
      WHERE a.state='blocked' AND a.created_at>? AND r.closed_at IS NULL
        AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)`)
      .all(now - 24 * 3600_000) as Array<{ run_id:string; task_id:string; state:string; reason:string|null; created_at:number; updated_at:number; harness_version:string|null; project_id:string; pm_thread_id:string|null }>;
    const list = await loadParked();
    const adopted:string[] = [];
    for (const row of rows) {
      const klass = failureClass(row.state, row.reason);
      if (!PARKED_CLASSES.has(klass) || !row.pm_thread_id || list.some((entry) => entry.runId === row.run_id && entry.taskId === row.task_id)) continue;
      if (await isRunHalted(bb.storage.kv as never, row.run_id)) continue;
      // The build the attempt ran under (harness_version) is the build whose fault it is: the task restarts when another build
      // runs, not at once under the same one. A retry lost in a reload is no fault of the build, and an attempt from before the
      // column has no build to name: both restart at once.
      const ranUnder = /its retry was lost/i.test(row.reason ?? "") ? null : row.harness_version;
      const entry:ParkedTask = { projectId:row.project_id, runId:row.run_id, taskId:row.task_id, pmThreadId:row.pm_thread_id, klass,
        reason:(row.reason ?? "").slice(0, 400), fingerprint:failureFingerprint(row.reason), version:ranUnder ?? ADOPTED_VERSION, at:row.updated_at, since:row.created_at, redrives:0 };
      if (superseded(entry)) continue;
      list.push(entry);
      adopted.push(row.task_id);
    }
    if (adopted.length) {
      await saveParked(list);
      bb.log.info(`Lane Pilot parked ${adopted.length} task(s) blocked by a Lane Pilot or machine fault: ${adopted.join(", ")}`);
    }
    return adopted;
  }

  /**
   * The weekly fire drill on every machine that ran a writer this week: the recovery from a stale git lock and a merge
   * cut off midway must still work there. The outcome is kept for the self-repair watcher, which takes a failure on.
   */
  async function drill(now = Date.now(), signal?:AbortSignal):Promise<Record<string, DrillOutcome>> {
    const hosts = (db.prepare(`SELECT DISTINCT writer_host_id FROM lane_pilot_run WHERE writer_host_id IS NOT NULL AND created_at > ?`)
      .all(now - 7 * 86400_000) as Array<{ writer_host_id:string }>).map((row) => row.writer_host_id);
    const outcome:Record<string, DrillOutcome> = {};
    for (const hostId of hosts) {
      signal?.throwIfAborted();
      const ran = await ctx.host.call("stabilityDrill", { requestedHostId:hostId }, { hostId, timeoutMs:120_000 })
        .catch((cause:unknown) => ({ checks:[{ name:"drill ran", ok:false, detail:cause instanceof Error ? cause.message : String(cause) }] }));
      outcome[hostId] = { at:now, version:VERSION, checks:ran.checks };
    }
    await bb.storage.kv.set(DRILL_KEY, outcome);
    const failed = Object.entries(outcome).flatMap(([hostId, row]) => row.checks.filter((check) => !check.ok).map((check) => `${hostId}: ${check.name}`));
    bb.log.info(failed.length ? `Lane Pilot fire drill failed: ${failed.join("; ")}` : `Lane Pilot fire drill passed on ${hosts.length} machine(s)`);
    return outcome;
  }

  return { stability:{ drill, onTaskFailed, breakerHolds, diskHolds, sweep, loadParked, adoptBlockedByFaults, restoreBreakers } };
}
