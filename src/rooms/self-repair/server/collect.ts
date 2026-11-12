import { join } from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { orMiss, stringAt, isNotFound } from "@lane-pilot/kit";
import { taskFamily } from "@lane-pilot/contracts";
import { listOkTriageOrigins, listOrchestratorTriages } from "@lane-pilot/run-insights";
import { checksInFlight } from "../../runs";
import { failureClass } from "../../contracts/failure-class";
import { OWNER_WORD_WAIT_MS } from "../../tasks";
import { taskWordItemPrefix } from "../../contracts";
import { BREAKERS_KEY, DRILL_KEY, HOOK_TIMEOUTS_KEY, type HookTimeoutRecord } from "../../stability/server";
import { DRILL_SANDBOX_PROJECT_IDS, PARKED_KEY, type DrillOutcome, type ParkedTask } from "../../contracts";
import { FRUSTRATION_KEY, frustrationReason, type FrustrationRecord } from "../../learning";
import { DEPENDENCY_REDO_WAIT_MS, latestTaskAttempt } from "../../storage";
import type { LanePilotDatabase } from "../../storage";
import { FAILED_ATTEMPT_STATES, isOpenAttemptState, OPEN_ATTEMPT_STATES } from "../../contracts/state-machine";
import { hasOpenOwnerItem } from "../../owner-waiting";
import { attemptRunAndThread, listFailedAttemptRows, listRecentFailedAttemptRows, listStaleAttemptsInState, listStaleOpenStages, listStaleQueuedAttempts, runPmThreadId } from "../../storage";
import { LOG_TAIL_BYTES, VERSION, logIncidents, reasonSignature, writerRedCheck, writerStrayFiles } from "./episodes";
import type { Incident, SelfRepairConfig } from "./types";

const SYSTEM_REASON = /internal_error|merge_failed|merge_queue_timeout|ownership run scope invalid|spawn failed|thread_provisioning_failed|EROFS|execution_packet_failed|snapshot_failed|helper_context|workspace path is inside|stale API handle|ownership git base|cannot compare pre-existing/i;
const STUCK_MS = 45 * 60_000;
const QUEUED_MS = 2 * 3_600_000;
const STAGE_MS = 3_600_000;
const REPEAT_TASKS = 3;
/** An attempt at work for the queued-attempt check: every holding state but a queued one. */
const WORKING_ATTEMPT_STATE_LIST = OPEN_ATTEMPT_STATES.filter((state) => state !== "queued");
const WORKING_ATTEMPT_STATES = OPEN_ATTEMPT_STATES.filter((state) => state !== "queued").map((state) => `'${state}'`).join(",");
const FAILED_STATES = FAILED_ATTEMPT_STATES.map((state) => `'${state}'`).join(",");
/** Stops by design: a question for the PM, a dependency that ended blocked, or a turn the provider cut off (writer_stream_error). */
const NOT_A_FAULT = /needs_human|depends_on|workspace_not_repo_root|writer_stream_error/i;

export function createCollector(env: { bb: BbPluginApi; db: LanePilotDatabase; readTail: (path: string, bytes: number) => string }) {
  const { bb, db, readTail } = env;

  /**
   * A queued task that waits for a depends_on: one still queued or at work (checked on its own, so a chain is reported once,
   * at its head), or one that ended blocked less than the redo wait (plus a pass of slack) ago, which is the PM's move.
   */
  function waitsForDependency(projectId: string, taskId: string, contractJson: string | null, now: number): boolean {
    let deps: unknown = [];
    try { deps = contractJson ? (JSON.parse(contractJson) as { depends_on?: unknown }).depends_on : []; } catch { return false; }
    if (!Array.isArray(deps)) return false;
    return deps.some((dep) => {
      if (typeof dep !== "string" || !dep || dep === taskId) return false;
      const latest = latestTaskAttempt(db, projectId, dep);
      if (!latest) return false;
      return isOpenAttemptState(latest.state) || (latest.state === "blocked" && now - latest.updated_at < DEPENDENCY_REDO_WAIT_MS + QUEUED_MS);
    });
  }

  async function collect(since: number, cfg: SelfRepairConfig): Promise<Incident[]> {
    const ignored = new Set([...cfg.ignoreProjects, ...DRILL_SANDBOX_PROJECT_IDS]);
    const out: Incident[] = [];
    const runPm = (runId: string) => runPmThreadId(db, runId);
    const triage = listOrchestratorTriages(db as never, since).map((row) => ({ ...row, thread_id: attemptRunAndThread(db, row.attempt_id)?.thread_id ?? null }));
    for (const row of triage) {
      if (ignored.has(row.project_id) || NOT_A_FAULT.test(row.reason)) continue;
      out.push({ signature: reasonSignature("triage", row.reason), kind: "triage", projectId: row.project_id, runId: row.run_id, taskId: row.task_id,
        attemptId: row.attempt_id, pmThreadId: runPm(row.run_id), writerThreadId: row.thread_id, reason: row.reason, at: row.failed_at });
    }
    const blocked = listFailedAttemptRows(db, FAILED_ATTEMPT_STATES, since);
    for (const row of blocked) {
      if (ignored.has(row.project_id) || !row.reason || !SYSTEM_REASON.test(row.reason)) continue;
      if (out.some((item) => item.attemptId === row.id)) continue;
      out.push({ signature: reasonSignature("blocked", row.reason), kind: "blocked", projectId: row.project_id, runId: row.run_id, taskId: row.task_id,
        attemptId: row.id, pmThreadId: runPm(row.run_id), writerThreadId: row.thread_id, reason: row.reason, at: row.updated_at });
    }
    const running = listStaleAttemptsInState(db, "running", Date.now() - STUCK_MS);
    const now = Date.now();
    for (const row of running) {
      if (ignored.has(row.project_id) || !row.thread_id) continue;
      const thread = await orMiss(bb.sdk.threads.get({ threadId: row.thread_id }), null, isNotFound);
      const status = thread ? stringAt(thread, "status") : "missing";
      if (status !== "idle" && status !== "error" && status !== "stopped" && status !== "missing") continue;
      // finish.ts deliberately keeps a verified attempt running while its landing decision is open (hub 2026-10-31/11-03).
      // Match this attempt's receipt, not the project's policy; an answered or expired wait cannot hide a stuck attempt.
      if (status === "idle" && hasOpenOwnerItem(db, { key: `${taskWordItemPrefix(row.run_id, taskFamily(row.task_id))}${row.id}`, source: "writer", kind: "task_word", since: now - OWNER_WORD_WAIT_MS })) continue;
      // Its checks run or wait in the run's check pool, and that pool moves: the writer is idle by design, not stuck
      // (Vampirism Fire 2026-10-24: six attempts behind other tasks' Studio tests were reported after 47–53 minutes).
      const checks = checksInFlight(row.thread_id);
      if (checks && now - checks.movedAt < STUCK_MS) continue;
      const reason = `attempt still «running» ${Math.round((now - row.updated_at) / 60_000)} min while its writer thread is ${status}`;
      out.push({ signature: reasonSignature("stuck", `attempt running while its writer is ${status}`), kind: "stuck", projectId: row.project_id, runId: row.run_id,
        taskId: row.task_id, attemptId: row.id, pmThreadId: runPm(row.run_id), writerThreadId: row.thread_id, reason, at: now });
    }
    // Queued for hours in a run where nothing runs: whatever it waits for will never come. An attempt being spawned or
    // canceled is at work too (proj_a35nni238u 2026-10-12: ck-13 queued behind ck-14's 30-minute cancel was reported).
    // Nothing has run for hours, not only at this pass: an attempt that ended within the window freed the queue, whose
    // dispatch still runs the baseline with the attempt «queued» (Vampirism Fire 2026-10-24/26: six attempts queued behind
    // a depends_on or an owns_paths overlap were reported 1–4 min after that attempt was accepted, and ran minutes later).
    const queued = listStaleQueuedAttempts(db, now - QUEUED_MS, WORKING_ATTEMPT_STATE_LIST) as Array<{ id: string; run_id: string; task_id: string; updated_at: number; project_id: string; contract_json: string | null }>;
    for (const row of queued) {
      if (ignored.has(row.project_id)) continue;
      // A task that waits for a depends_on that ended blocked waits for the PM to send it again, by design up to six hours
      // (the PM was told it ended); the wait ends by itself after that, so only a wait past it is Lane Pilot's (ck-12 → ck-13/ck-05c,
      // and ck-14 behind ck-05c, on 2026-10-12 were reported 11 minutes after ck-12 blocked and ran once ck-12.2 was accepted).
      if (waitsForDependency(row.project_id, row.task_id, row.contract_json, now)) continue;
      out.push({ signature: reasonSignature("queued", "attempt queued for hours while nothing runs in its run"), kind: "queued", projectId: row.project_id,
        runId: row.run_id, taskId: row.task_id, attemptId: row.id, pmThreadId: runPm(row.run_id), writerThreadId: null,
        reason: `attempt queued ${Math.round((now - row.updated_at) / 60_000)} min while nothing runs in its run`, at: now });
    }
    // A stage still pending or running an hour after its task's last attempt ended: nobody will finish it. An attempt
    // being spawned or canceled has not ended: its stages waited in the queue with it.
    const stages = listStaleOpenStages(db, now - STAGE_MS, OPEN_ATTEMPT_STATES);
    for (const row of stages) {
      if (ignored.has(row.project_id)) continue;
      out.push({ signature: reasonSignature("stage", "stage left open after its task's attempts ended"), kind: "stage", projectId: row.project_id,
        runId: row.run_id, taskId: row.task_id, attemptId: `stage:${row.run_id}:${row.task_id}:${row.stage_id}`, pmThreadId: runPm(row.run_id), writerThreadId: null,
        reason: `stage ${row.stage_id} left ${row.state} ${Math.round((now - row.updated_at) / 60_000)} min after its task's attempts ended`, at: now });
    }
    // A task parked on a Lane Pilot fault for an hour: the fix has not shipped. A breaker open for 30 minutes: the
    // project's writers wait on it. Both are the watcher's to fix, not the owner's.
    const parked = await bb.storage.kv.get(PARKED_KEY);
    for (const row of (Array.isArray(parked) ? parked : []) as ParkedTask[]) {
      if (ignored.has(row.projectId) || row.klass !== "harness" || now - row.at < 60 * 60_000) continue;
      out.push({ signature: reasonSignature("parked", row.reason), kind: "parked", projectId: row.projectId, runId: row.runId, taskId: row.taskId,
        attemptId: `parked:${row.runId}:${row.taskId}`, pmThreadId: row.pmThreadId, writerThreadId: null, version: VERSION,
        reason: `task parked ${Math.round((now - row.at) / 60_000)} min on a Lane Pilot fault with no fix shipped: ${row.reason}`, at: now });
    }
    const breakers = await bb.storage.kv.get(BREAKERS_KEY);
    for (const [projectId, open] of Object.entries((breakers && typeof breakers === "object" ? breakers : {}) as Record<string, { fingerprint:string; openedAt:number; version:string }>)) {
      if (ignored.has(projectId) || open.version !== VERSION || now - open.openedAt < 30 * 60_000) continue;
      out.push({ signature: reasonSignature("breaker", open.fingerprint), kind: "breaker", projectId, runId: "-", taskId: "-",
        attemptId: `breaker:${projectId}:${open.openedAt}`, pmThreadId: null, writerThreadId: null, version: VERSION,
        reason: `the project's writers have been held ${Math.round((now - open.openedAt) / 60_000)} min: several tasks failed on «${open.fingerprint}»`, at: now });
    }
    // T6 (src/learning): the owner was clearly frustrated in a chat. The incident carries the thread and what the agent had just said.
    const annoyed = await bb.storage.kv.get(FRUSTRATION_KEY);
    for (const row of (Array.isArray(annoyed) ? annoyed : []) as FrustrationRecord[]) {
      if (row.at <= since || ignored.has(row.projectId)) continue;
      out.push({ signature: reasonSignature("owner", "the owner was clearly frustrated in a chat"), kind: "owner", projectId: row.projectId, runId: row.runId ?? "-", taskId: "-",
        attemptId: `owner:${row.messageId}`, pmThreadId: row.pmThreadId, writerThreadId: row.pmThreadId ? null : row.threadId, version: VERSION, reason: frustrationReason(row), at: row.at });
    }
    const drill = await bb.storage.kv.get(DRILL_KEY);
    for (const [hostId, row] of Object.entries((drill && typeof drill === "object" ? drill : {}) as Record<string, DrillOutcome>)) {
      if (row.version !== VERSION || row.at <= since) continue;
      for (const check of row.checks.filter((item) => !item.ok)) {
        out.push({ signature: reasonSignature("drill", check.name), kind: "drill", projectId: "-", runId: "-", taskId: "-",
          attemptId: `drill:${hostId}:${row.at}:${check.name}`, pmThreadId: null, writerThreadId: null, version: VERSION,
          reason: `weekly fire drill on ${hostId}: «${check.name}» failed: ${check.detail ?? ""}`, at: row.at });
      }
    }
    // A hook of the plugin that did not answer in its time (VK hook policy): the turn went on without Lane Pilot's env or
    // dispatch decision. A reload's own window is not a fault.
    const hookRows = await bb.storage.kv.get(HOOK_TIMEOUTS_KEY);
    for (const row of (Array.isArray(hookRows) ? hookRows : []) as HookTimeoutRecord[]) {
      if (row.quiet || row.at <= since) continue;
      const effect = row.hook === "contributeEnv" ? (row.required ? "env required, turn not started" : "env not applied") : row.hook === "messageDispatch" ? "dispatch hook not applied" : "mention not resolved";
      out.push({ signature: reasonSignature("hook", `hook ${row.hook} timed out`), kind: "hook", projectId: row.projectId ?? "-", runId: "-", taskId: "-",
        attemptId: `hook:${row.hook}:${row.at}`, pmThreadId: null, writerThreadId: row.threadId, version: VERSION,
        reason: `Lane Pilot hook ${row.hook} did not answer in ${row.timeoutMs} ms: ${effect}`, at: row.at });
    }
    // The same unfamiliar reason in several tasks within a day is a pattern, not one writer's mistake. A provider's limit
    // (a spent usage window, an open breaker, the provider's own limit) is a known reason, not an unfamiliar one: the task
    // moved down the writer chain by design (proj_acpiaqf4wq 2026-10-11: three grok-4.6 «Plan usage at 100%» hand-offs,
    // each followed by an accepted fallback attempt, raised a repair).
    // A writer's own stray files and its own red checks are its work, told in its thread (writerStrayFiles, writerRedCheck).
    const triages = new Map(listOkTriageOrigins(db as never).map((row) => [`${row.project_id}|${row.attempt_id}`, row.origin]));
    const recent = listRecentFailedAttemptRows(db, FAILED_ATTEMPT_STATES, now - 86_400_000).map((row) => ({ ...row, triage_origin: triages.get(`${row.project_id}|${row.id}`) ?? null }));
    const patterns = new Map<string, typeof recent>();
    for (const row of recent) {
      if (ignored.has(row.project_id) || !row.reason || SYSTEM_REASON.test(row.reason) || NOT_A_FAULT.test(row.reason)
        || failureClass("blocked", row.reason) === "limit" || writerStrayFiles(row.reason, row.contract_json) || writerRedCheck(row.reason, row.triage_origin, row.failure_code)) continue;
      const key = reasonSignature("repeat", row.reason);
      patterns.set(key, [...(patterns.get(key) ?? []), row]);
    }
    for (const [signature, rows] of patterns) {
      if (new Set(rows.map((row) => `${row.run_id}:${row.task_id}`)).size < REPEAT_TASKS || !rows.some((row) => row.updated_at > since)) continue;
      for (const row of rows) out.push({ signature, kind: "repeat", projectId: row.project_id, runId: row.run_id, taskId: row.task_id, attemptId: row.id,
        pmThreadId: runPm(row.run_id), writerThreadId: row.thread_id, reason: row.reason!, at: row.updated_at });
    }
    let logText = "";
    try { logText = readTail(join(bb.server.experimental_dataDir, "plugins", "lane-pilot", "logs", "plugin.log"), LOG_TAIL_BYTES); } catch { /* no log yet */ }
    for (const row of logIncidents(logText, since)) if (!ignored.has(row.projectId)) out.push(row);
    return out;
  }

  return collect;
}
