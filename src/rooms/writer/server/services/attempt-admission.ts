import { breakerKey } from "@lane-pilot/resilience";
import { rotatedWriterSettings, writerFallbackChain, writerFallbacks } from "@lane-pilot/models";
import { bestEffort, ownsPathsOverlap } from "@lane-pilot/kit";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { providerPoolCap } from "@lane-pilot/settings-catalog";
import type { TaskV2 } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import {
  getAttempt, getRun, getRunSettingsScopes, getTask, getTaskPlan, latestRunTaskAttemptState,
  listOpenAttempts, listStageReceipts, loadProjectSettings, parkAttemptWake, taskHeldUntil,
} from "../../../storage";
import { isHeld, isRunHalted, isRunPaused, isTaskSatisfied, recordStage } from "../../../runs/server";
import { sendServiceMessage } from "../../../relay/server";
import { checkoutOwnsOverlap, dependsOnTask, HOLD_FOREVER } from "../../../tasks";
import { allowedSecretNames, secretProblem, waitingSecretNote, waitingSecretReason } from "../../../secrets/server";
import { restoreProviderBreaker } from "../repositories/breaker-hold";
import { ATTEMPT_WAIT_MAX_MS } from "../../models/attempt-timeouts";
import { secretPollMs } from "./start-wait-limits";
import { DEFAULT_WRITER_MAX_CONCURRENT, WRITER_MAX_CONCURRENT_KEY, WRITER_MODEL_KEY, WRITER_PROVIDER_KEY } from "../../settings";
import type { WriterStateApi } from "./state";
import type { StabilityPort } from "../../../contracts";

const ADMITTED_KV_KEY = "writer-admitted-attempts:v1";
const admissionQueues = new Map<string, Promise<void>>();

/** Serializes admission checks per project so concurrent dispatches observe each other's slot & path claims. */
async function withProjectAdmissionLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = admissionQueues.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  admissionQueues.set(projectId, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (admissionQueues.get(projectId) === next) admissionQueues.delete(projectId);
  }
}

export type AdmissionServices = {
  activeWriterTasks?: WriterStateApi["activeWriterTasks"];
  concurrencyLimit?: { hostCap(hostId: string): Promise<number | null> };
  providerBreaker?: WriterStateApi["providerBreaker"];
  stability?: StabilityPort;
};

export type AdmissionResult =
  | { status: "admitted" }
  | { status: "already_done"; reason: string }
  | { status: "blocked"; reason: string }
  | { status: "wait"; waitUntil: number; durationSec: number; event: string; waitReason: string };

type Kv = { get<T = unknown>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<unknown> };

async function readAdmittedMap(kv: Kv | undefined): Promise<Record<string, { taskId: string; projectId: string; at: number }>> {
  if (!kv) return {};
  const raw = await kv.get<Record<string, { taskId: string; projectId: string; at: number }>>(ADMITTED_KV_KEY).catch(() => null);
  return raw && typeof raw === "object" ? raw : {};
}

export async function markAttemptAdmitted(kv: Kv | undefined, attemptId: string, taskId: string, projectId: string, now = Date.now()): Promise<void> {
  if (!kv) return;
  const map = await readAdmittedMap(kv);
  map[attemptId] = { taskId, projectId, at: now };
  await kv.set(ADMITTED_KV_KEY, map).catch(() => undefined);
}

export async function releaseAttemptAdmission(kv: Kv | undefined, attemptId: string): Promise<void> {
  if (!kv) return;
  const map = await readAdmittedMap(kv);
  if (attemptId in map) {
    delete map[attemptId];
    await kv.set(ADMITTED_KV_KEY, map).catch(() => undefined);
  }
}

export function declaredPathsOfTask(task: Pick<TaskV2, "owns_paths" | "expected_outputs">): string[] {
  return [...new Set([...(task.owns_paths ?? []), ...(task.expected_outputs ?? [])].filter(Boolean))];
}

/** Tracks which secret-wait notifications were already sent to PM so periodic secret polling never spams chat. */
const secretNotedByCore = new WeakMap<object, Map<string, string>>();

/** Counts currently active or admitted attempts for other tasks in the same project and run. */
export async function countActiveProjectWriters(
  db: ServerCore["db"],
  kv: Kv | undefined,
  projectId: string,
  excludeAttemptId: string,
  excludeTaskId: string,
  runId?: string,
): Promise<{
  activeCount: number;
  runActiveCount: number;
  overlappingTaskIds: string[];
  candidateTask: (otherId: string) => TaskV2 | null;
}> {
  const admitted = await readAdmittedMap(kv);
  const open = listOpenAttempts(db);
  const activeTaskIds = new Set<string>();
  const runActiveTaskIds = new Set<string>();
  const cache = new Map<string, TaskV2 | null>();
  const taskOf = (taskId: string): TaskV2 | null => {
    if (cache.has(taskId)) return cache.get(taskId)!;
    const row = getTask(db, taskId);
    const val = row?.kind === "bb" && row.contract && typeof row.contract === "object" ? (row.contract as TaskV2) : null;
    cache.set(taskId, val);
    return val;
  };
  for (const row of open) {
    if (row.project_id !== projectId || row.id === excludeAttemptId || row.task_id === excludeTaskId) continue;
    const full = getAttempt(db, row.id);
    const isWorkingState = row.state === "spawn_requested" || row.state === "running" || row.state === "cancel_requested";
    const isAdmittedQueued = row.state === "queued" && (row.id in admitted || full?.reason === "admitted");
    if (isWorkingState || isAdmittedQueued) {
      activeTaskIds.add(row.task_id);
      if (runId && row.run_id === runId) runActiveTaskIds.add(row.task_id);
    }
  }
  return { activeCount: activeTaskIds.size, runActiveCount: runActiveTaskIds.size, overlappingTaskIds: [...activeTaskIds], candidateTask: taskOf };
}

/** Single-pass durable admission evaluation for `lp.attempt-admission`. */
export async function evaluateAttemptAdmission(input: {
  ctx: ServerCore;
  services: AdmissionServices;
  projectId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  task: TaskV2;
  config?: { hostId?: string; pmProviderId?: string; pmModel?: string; writerProviderId?: string; writerModel?: string } | null;
  baselineState?: string;
  liveFolder?: boolean;
  useFallback?: boolean;
  now?: number;
}): Promise<AdmissionResult> {
  return withProjectAdmissionLock(input.projectId, async () => evaluateAttemptAdmissionLocked(input));
}

async function evaluateAttemptAdmissionLocked(input: {
  ctx: ServerCore;
  services: AdmissionServices;
  projectId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  task: TaskV2;
  config?: { hostId?: string; pmProviderId?: string; pmModel?: string; writerProviderId?: string; writerModel?: string } | null;
  baselineState?: string;
  liveFolder?: boolean;
  useFallback?: boolean;
  now?: number;
}): Promise<AdmissionResult> {
  const now = input.now ?? Date.now();
  const { ctx, services, projectId, runId, taskId, attemptId, task } = input;
  const { bb, db } = ctx;
  const kv = bb.storage?.kv as Kv | undefined;
  const attempt = getAttempt(db, attemptId);
  if (!attempt || attempt.state === "cancel_requested" || attempt.state === "canceled") {
    return { status: "blocked", reason: attempt?.reason ?? "attempt canceled before admission" };
  }
  const alreadySatisfied = kv ? await isTaskSatisfied(kv as never, projectId, taskId).catch(() => false) : false;
  if (attempt.state === "accepted" || alreadySatisfied) {
    return { status: "already_done", reason: "task already satisfied" };
  }
  if (input.baselineState === "already_built") {
    return { status: "already_done", reason: "already_built" };
  }

  const deadlineAt = (attempt.created_at || now) + ATTEMPT_WAIT_MAX_MS;
  if (now >= deadlineAt) {
    return { status: "blocked", reason: "attempt_wait_timeout: exceeded 48h admission deadline" };
  }

  const updatePendingStageReason = (waitReason: string) => {
    const existing = listStageReceipts(db, runId, taskId).find((row) => row.stageId === "writer-agent");
    if (!existing || existing.state === "pending") {
      const plan = getTaskPlan(db, taskId) ?? (task.objective || taskId);
      recordStage(db, { runId, taskId, stageId: "writer-agent", state: "pending", input: plan, reason: waitReason });
    }
  };

  const boundedWait = (targetMs: number, waitReason: string, allowSubSecond = false): AdmissionResult => {
    const floor = allowSubSecond ? now + 20 : now + 1_000;
    const waitUntil = Math.max(floor, Math.min(targetMs, deadlineAt));
    const durationSec = Math.max(allowSubSecond ? 0.05 : 1, Math.min(86_400, (waitUntil - now) / 1_000));
    parkAttemptWake(db, attemptId, waitReason, waitUntil);
    updatePendingStageReason(waitReason);
    return { status: "wait", waitUntil, durationSec, event: LP_EVENTS.TASK_SETTLED, waitReason };
  };

  if (await isRunHalted(kv as never, runId).catch(() => false)) {
    return { status: "blocked", reason: `run ${runId} is halted` };
  }
  if ((await isRunPaused(kv as never, runId).catch(() => false)) || (kv ? await isHeld(kv as never, runId).catch(() => false) : false)) {
    return boundedWait(now + 300_000, "waiting for paused run to resume");
  }
  const heldUntil = taskHeldUntil(db, taskId);
  if (heldUntil && heldUntil > now) {
    return boundedWait(heldUntil >= HOLD_FOREVER ? now + 3_600_000 : heldUntil, "task is held by PM");
  }

  for (const depId of task.depends_on ?? []) {
    if (!depId || depId === taskId) continue;
    const depState = latestRunTaskAttemptState(db, runId, depId);
    if (depState === "accepted") continue;
    if (depState === "blocked" || depState === "canceled") {
      if (kv && await isTaskSatisfied(kv as never, projectId, depId).catch(() => false)) continue;
      return { status: "blocked", reason: `dependency ${depId} ended ${depState}` };
    }
    return boundedWait(deadlineAt, `waiting for dependency ${depId}`);
  }

  const settings = loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId));
  const envNames = [...new Set((task.verification ?? []).flatMap((v) => v.secrets ?? []).filter(Boolean))];
  if (envNames.length > 0 && ctx.secrets?.check) {
    const check = await ctx.secrets.check({ declared: envNames, allowed: allowedSecretNames(settings) }, { fresh: true }).catch(() => null);
    const problem = check ? secretProblem(check) : [];
    if (check && problem.length > 0) {
      const waitReason = waitingSecretReason(problem.length ? problem : envNames);
      const runRow = getRun(db, runId);
      if (runRow?.pm_thread_id) {
        let map = secretNotedByCore.get(ctx);
        if (!map) { map = new Map(); secretNotedByCore.set(ctx, map); }
        if (map.get(attemptId) !== waitReason) {
          map.set(attemptId, waitReason);
          void bestEffort(ctx.log, "writer secret wait notice", sendServiceMessage(bb as never, {
            threadId: runRow.pm_thread_id, mode: "queue-if-active", text: waitingSecretNote(taskId, check),
          }), undefined);
        }
      }
      const pollMs = secretPollMs();
      return boundedWait(now + pollMs, waitReason, pollMs < 1_000);
    }
  }

  // Restore any persisted provider-breaker holds before consulting the breaker.
  await restoreProviderBreaker(kv, services.providerBreaker, now);
  const run = getRun(db, runId);
  const cfg = typeof ctx.configForRun === "function"
    ? await ctx.configForRun(projectId, run).catch(() => input.config ?? null)
    : (input.config ?? null);
  const rotated = rotatedWriterSettings(settings, taskId);
  const providerId = String(rotated[WRITER_PROVIDER_KEY] ?? cfg?.writerProviderId ?? "");
  const modelId = String(rotated[WRITER_MODEL_KEY] ?? cfg?.writerModel ?? "");
  if (services.providerBreaker && providerId && modelId) {
    const pmPair = { providerId: cfg?.pmProviderId ?? "", model: cfg?.pmModel ?? "" };
    const candidates = input.useFallback
      ? writerFallbackChain({ providerId, model: modelId }, writerFallbacks(rotated), pmPair).filter((entry) => entry.providerId && entry.model)
      : [{ providerId, model: modelId }];
    let earliestHold: { key: string; until: number } | null = null;
    let allHeld = candidates.length > 0;
    for (const candidate of candidates) {
      const key = breakerKey(candidate.providerId, candidate.model);
      const holdUntil = typeof (services.providerBreaker as { holdUntil?: (k: string, n?: number) => number | null }).holdUntil === "function"
        ? (services.providerBreaker as { holdUntil: (k: string, n?: number) => number | null }).holdUntil(key, now)
        : (() => { const d = services.providerBreaker.decide(key, now); return !d.allow ? d.retryAt : null; })();
      if (!holdUntil || holdUntil <= now) {
        allHeld = false;
        break;
      }
      if (!earliestHold || holdUntil < earliestHold.until) earliestHold = { key, until: holdUntil };
    }
    if (allHeld && earliestHold) {
      return boundedWait(earliestHold.until, `provider_limit_hold:${earliestHold.key}:${earliestHold.until}`);
    }
  }

  const projectBreaker = services.stability?.breakerHolds?.(projectId, now);
  if (projectBreaker) {
    return boundedWait(now + 300_000, projectBreaker);
  }

  // Writer concurrency cap (default 3, configurable via writer.max_concurrent), run pool (ops.pool_size), provider pool cap, & declared file overlap.
  const rawCap = Number(settings[WRITER_MAX_CONCURRENT_KEY] ?? DEFAULT_WRITER_MAX_CONCURRENT);
  const cap = Number.isFinite(rawCap) && rawCap >= 1 ? Math.floor(rawCap) : DEFAULT_WRITER_MAX_CONCURRENT;
  const runPoolCap = typeof ctx.runPolicyFor === "function" ? ctx.runPolicyFor(runId).pools.provider : cap;
  const provPoolCap = providerId ? providerPoolCap(settings, providerId) : 0;
  const active = await countActiveProjectWriters(db, kv, projectId, attemptId, taskId, runId);

  const myPaths = declaredPathsOfTask(task);
  for (const otherId of active.overlappingTaskIds) {
    const otherTask = active.candidateTask(otherId);
    if (!otherTask) continue;
    const otherPaths = declaredPathsOfTask(otherTask);
    if (input.liveFolder) {
      return boundedWait(deadlineAt, `waiting for ${otherId}: one writer at a time in live folder`);
    }
    if (
      ownsPathsOverlap(myPaths, otherPaths)
      || checkoutOwnsOverlap(task.project_cwd, task.owns_paths, otherTask.project_cwd, otherTask.owns_paths)
      || dependsOnTask(task.depends_on, otherId)
      || dependsOnTask(otherTask.depends_on, taskId)
    ) {
      return boundedWait(deadlineAt, `serialised on declared files with ${otherId}`);
    }
  }
  const hostCap = !input.liveFolder && services.concurrencyLimit && cfg?.hostId
    ? await services.concurrencyLimit.hostCap(cfg.hostId).catch(() => null)
    : null;
  if (hostCap !== null && active.activeCount >= Math.min(hostCap, 15)) {
    return boundedWait(deadlineAt, `waiting for host concurrency limit (${active.activeCount}/${Math.min(hostCap, 15)})`);
  }
  if (active.runActiveCount >= runPoolCap) {
    return boundedWait(deadlineAt, `waiting for run provider pool slot (${active.runActiveCount}/${runPoolCap})`);
  }
  if (provPoolCap !== null && provPoolCap > 0 && active.activeCount >= provPoolCap) {
    return boundedWait(deadlineAt, `waiting for provider pool slot (${active.activeCount}/${provPoolCap})`);
  }
  if (active.activeCount >= cap) {
    return boundedWait(deadlineAt, `waiting for writer concurrency slot (${active.activeCount}/${cap})`);
  }

  await markAttemptAdmitted(kv, attemptId, taskId, projectId, now);
  return { status: "admitted" };
}

export { recordAndPersistBreaker } from "../repositories/breaker-hold";
