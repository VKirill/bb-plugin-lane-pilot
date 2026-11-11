import { bestEffort } from "@lane-pilot/kit";
import { getAttempt, getRunSettingsScopes, listStageReceipts, loadProjectSettings } from "../../storage";
import { recordStage } from "../../runs/server";
import { allowedSecretNames, secretProblem, waitingSecretNote, waitingSecretReason } from "../../secrets/server";
import { SECRET_WAIT_MS, secretPollMs } from "./start-wait-limits";
import type { StartWriterTaskDeps } from "./start-writer-task";
import type { WriterTaskInput, WriterTaskState } from "./start-task-state";

/**
 * The secrets the task's checks declare must be in Env Catalog and allowed before a writer starts (J6): a writer would
 * do the work and then fail the checks for want of them. The task waits with the stage reason `waiting_secret:NAME`,
 * no attempt is spent, the PM is told once what to do (env_request), and the wait ends by itself when the access is
 * in place. Env Catalog's change event reaches only the app, so the catalog is asked every 20 seconds meanwhile.
 */
export const waitForSecrets = async (deps: StartWriterTaskDeps, state: WriterTaskState, input: WriterTaskInput, shouldStop?:()=>string|null): Promise<string | null> => {
  const { ctx } = deps;
  const { bb, db } = ctx;
  const declared = [...new Set(input.task.verification.flatMap((check) => check.secrets ?? []))];
  if (!declared.length) return null;
  const since = Date.now();
  let noted = "";
  for (;;) {
    if (ctx.isDisposed()) return null;
    const stop = shouldStop?.();
    if (stop) return stop;
    const latest = getAttempt(db, state.attemptId);
    if (!latest || ["canceled", "blocked", "accepted"].includes(latest.state)) return null;
    const gate = await ctx.secrets.check({ declared, allowed:allowedSecretNames(loadProjectSettings(db, input.projectId, getRunSettingsScopes(db, input.runId))) }, { fresh:true });
    const names = secretProblem(gate);
    if (!names.length && !gate.unavailable) return null;
    const reason = waitingSecretReason(names.length ? names : declared);
    if (noted !== reason) {
      noted = reason;
      ctx.log(`writer ${input.taskId} waits: ${reason}`);
      recordStage(db, { runId:input.runId, taskId:input.taskId, stageId:"writer-agent", state:"pending", input:input.plan, reason });
      if (input.pmThreadId) void bestEffort(ctx.log, "writer secret wait notice", bb.sdk.threads.send({ threadId:input.pmThreadId, mode:"queue-if-active", input:[{ type:"text", mentions:[], text:waitingSecretNote(input.taskId, gate) }] } as never), undefined);
    }
    if (Date.now() - since > SECRET_WAIT_MS) return `${reason}: not provided within 12 hours; send the task again once it is saved`;
    await new Promise((wake) => setTimeout(wake, secretPollMs()));
  }
};
