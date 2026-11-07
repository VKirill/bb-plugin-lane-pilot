import { claimAttemptWake, getRun, getTask, getTaskPlan, listDueWakes } from "../../storage";
import { taskV2Schema } from "../../contracts";
import { sendServiceMessage } from "../../relay/server";
import { providerDisplayName } from "./writer-hold";
import type { ServerCore } from "../../contracts/server";

import type { WriterStartApi } from "./start";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  startWriterTask: WriterStartApi["startWriterTask"];
}


/**
 * The waker of H2: every minute the attempts parked `waiting_writer:` whose earliest hold ended are taken up again —
 * `claimAttemptWake` clears wake_at once, so two ticks can never start the same attempt twice. `startWriterTask`
 * re-walks the chain itself: a still-held attempt is parked again with a fresh `wake_at` and an updated reason.
 */
export async function sweepWriterWakes(ctx: ServerCore, services: Services, now = Date.now()): Promise<number> {
  const { db } = ctx;
  let woken = 0;
  for (const attempt of listDueWakes(db, now)) {
    if (ctx.isDisposed()) break;
    if (!claimAttemptWake(db, attempt.id)) continue;
    const run = getRun(db, attempt.run_id);
    const task = getTask(db, attempt.task_id);
    const parsed = task?.kind === "bb" ? taskV2Schema.safeParse(task.contract) : null;
    if (!run || !run.pm_thread_id || !parsed?.success) {
      ctx.log(`writer wake ${attempt.id}: the run or task of the parked attempt is gone; leaving it queued for the reconcile`);
      continue;
    }
    const config = await ctx.configForRun(run.project_id, run).catch(() => null);
    if (!config) {
      ctx.log(`writer wake ${attempt.id}: no prototype config for ${run.project_id}; leaving it queued for the reconcile`);
      continue;
    }
    woken += 1;
    services.startWriterTask({
      projectId: run.project_id, runId: run.id, taskId: attempt.task_id, firstAttemptId: attempt.id,
      pmThreadId: run.pm_thread_id, config, task: parsed.data, plan: getTaskPlan(db, attempt.task_id) ?? parsed.data.objective,
    });
  }
  return woken;
}

const unsupportedKey = (providerId: string) => `writer-unsupported:${providerId}`;

/**
 * Tells the owner once per provider that this core cannot run it and which setting to change — one item per provider,
 * not one per task that tripped over it. Returns true when the note was sent now.
 */
export async function noteUnsupportedProvider(ctx: ServerCore, input: {
  providerId: string; pmThreadId: string | null | undefined; taskId: string;
}): Promise<boolean> {
  const key = unsupportedKey(input.providerId);
  const told = await ctx.bb.storage.kv.get(key).catch(() => null);
  if (told) return false;
  await ctx.bb.storage.kv.set(key, String(Date.now())).catch(() => undefined);
  ctx.log(`writer ${input.taskId}: provider ${input.providerId} is not supported by this core; the task is blocked`);
  if (!input.pmThreadId) return true;
  await sendServiceMessage(ctx.bb, {
    threadId: input.pmThreadId,
    text: `Lane Pilot: задача ${input.taskId} остановлена — писатель ${providerDisplayName(input.providerId)} не поддерживается этим ядром (core_unsupported). ` +
      `Смените writer.provider (или включите поддержку провайдера в настройках ядра) и отправьте задачу ещё раз. Это сообщение приходит один раз на провайдера, не на каждую задачу.`,
  }).catch(() => undefined);
  return true;
}

const waitToldKey = (attemptId: string) => `writer-wait-told:${attemptId}`;

/**
 * The one PM line of a wait («задача X ждёт свободного писателя…»): once per attempt, never per tick. Returns true
 * when the line was sent now.
 */
export async function noteWriterWait(ctx: ServerCore, input: { attemptId: string; pmThreadId: string | null | undefined; taskId: string; text: string }): Promise<boolean> {
  const key = waitToldKey(input.attemptId);
  const told = await ctx.bb.storage.kv.get(key).catch(() => null);
  if (told) return false;
  await ctx.bb.storage.kv.set(key, "1").catch(() => undefined);
  if (!input.pmThreadId) return true;
  await sendServiceMessage(ctx.bb, {
    threadId: input.pmThreadId,
    text: `Lane Pilot: задача ${input.taskId} ждёт свободного писателя (${input.text}). Проверяю сам, ничего делать не нужно.`,
  }).catch(() => undefined);
  return true;
}
