import { LP_EVENTS } from "@lane-pilot/contracts";
import { buildMainfixTask, gateResolverFor, handleLandingRed, IntegrationGateRunner } from "../../../verification/server";
import { parseIntegrationGateSettings as parseGate } from "../../../contracts/integration-gate";
import { listOpenAttempts, loadProjectSettings, getRunSettingsScopes } from "../../../storage";
import { isRunHalted } from "../../../runs/server";
import { join, relative, resolve } from "node:path";
import type { TaskV2 } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";
import type { BaselineApi } from "../../../baseline/server";
import type { LeadRoadApi } from "../../../contracts";
import type { WriterDispatchApi } from "./dispatch";
import type { WriterVerifyApi } from "./verify";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  baseline: BaselineApi;
  dispatchWriter: WriterDispatchApi["dispatchWriter"];
  runVerification: WriterVerifyApi["runVerification"];
  leadRoad: LeadRoadApi;
  workflowTriggers?: { emitEvent: (name: string, payload?: Record<string, unknown>, options?: { id?: string; key?: string; attemptKey?: string; projectId?: string }) => Promise<unknown> };
}

/**
 * What a landed task hands off to the unified landing step: in production, emitting `lp.attempt.merged` starts
 * `workflows/lp.landing-suite.json` (`lp.landing_suite`) idempotently once per merged attempt. Direct callers
 * (`noteMergedForGate`, `checkMainAfterMerge`) still delegate to the same shared runner/handler in verification.
 */
export function mountVerificationAttemptFinished(ctx: ServerCore, services: Services) {
  const { db } = ctx;
  const integrationGateRunner = new IntegrationGateRunner(ctx, services);

  const gateFor = (projectId: string, runId: string, hostId: string, basePath: string) =>
    gateResolverFor(ctx)({ runId, hostId, basePath, gate: parseGate(loadProjectSettings(db, projectId, getRunSettingsScopes(db, runId))) });

  function noteMergedForGate(
    input: { projectId: string; runId: string; taskId: string; attemptId: string; writerThreadId: string | null; pmThreadId: string; config: { hostId: string } },
    basePath: string,
    commitSha: string,
    produced: string[],
    live: boolean,
  ) {
    integrationGateRunner.noteMergedTask({ taskId: input.taskId, commitSha, threadId: input.writerThreadId, attemptId: input.attemptId, produced },
      { projectId: input.projectId, hostId: input.config.hostId, basePath });
    const drained = !listOpenAttempts(db).some((row) => row.project_id === input.projectId && row.id !== input.attemptId);
    return integrationGateRunner.maybeRunGate({ runId: input.runId, projectId: input.projectId, pmThreadId: input.pmThreadId, basePath,
      configHostId: input.config.hostId, trigger: drained ? "drain" : "merge", ...(live ? { live: true } : {}) })
      .catch((cause: unknown) => { ctx.log(`integration-gate: failed after merging ${input.taskId}: ${cause instanceof Error ? cause.message : String(cause)}`); return { ran: false }; });
  }

  async function checkMainAfterMerge(input: {
    projectId: string; pmThreadId: string; config: Parameters<typeof services.runVerification>[0];
    runId: string; task: TaskV2; basePath: string; worktreePath: string;
    attemptId?: string; mergeCommit?: string;
    greenInWorktree?: readonly string[];
  }) {
    if (!input.task.verification.length || !input.pmThreadId || await isRunHalted(ctx.bb.storage.kv as never, input.runId)) return;
    const onBase = (cwd: string) => resolve(cwd).startsWith(resolve(input.worktreePath)) ? join(input.basePath, relative(input.worktreePath, cwd)) : cwd;
    const onMain = { ...input.task, project_cwd: input.basePath, verification: input.task.verification.map((command) => ({ ...command, cwd: onBase(command.cwd) })) };
    const checks = await services.runVerification(input.config, onMain, input.runId, undefined, {
      background: true,
      jobKey: `post-merge:${input.attemptId ?? input.task.id}:${input.mergeCommit ?? ""}`,
    }).catch((cause: unknown) => {
      ctx.log(`post-merge check of ${input.task.id} could not run: ${cause instanceof Error ? cause.message : String(cause)}`);
      return null;
    });
    const unrun = checks?.filter((check) => check.hostError) ?? [];
    if (unrun.length) ctx.log(`post-merge check of ${input.task.id} could not run on the host: ${unrun.map((check) => `${check.command} (${check.stderr.slice(0, 160)})`).join(", ")}`);
    await handleLandingRed(ctx, services, {
      projectId: input.projectId,
      pmThreadId: input.pmThreadId,
      config: input.config,
      runId: input.runId,
      task: input.task,
      onMain,
      basePath: input.basePath,
      attemptId: input.attemptId,
      mergeCommit: input.mergeCommit,
      greenInWorktree: input.greenInWorktree,
      checks: checks ?? [],
    });
  }

  function landed(
    input: { projectId: string; runId: string; taskId: string; attemptId: string; writerThreadId: string | null; pmThreadId: string; config: { hostId: string }; task: TaskV2 },
    basePath: string,
    commit: string | null,
    produced: string[],
    live: boolean,
    worktreePath: string | null,
    greenInWorktree: readonly string[] | undefined,
  ): void {
    void (async () => {
      if (ctx.state.disposed) return;
      if (services.workflowTriggers?.emitEvent) {
        await services.workflowTriggers.emitEvent(
          LP_EVENTS.ATTEMPT_MERGED,
          {
            attemptId: input.attemptId,
            runId: input.runId,
            taskId: input.taskId,
            projectId: input.projectId,
            pmThreadId: input.pmThreadId,
            writerThreadId: input.writerThreadId,
            hostId: input.config.hostId,
            basePath,
            ...(commit ? { mergeCommit: commit } : {}),
            ...(worktreePath ? { worktreePath } : {}),
            live,
            produced,
            ...(greenInWorktree ? { greenInWorktree: [...greenInWorktree] } : {}),
          },
          {
            id: `${LP_EVENTS.ATTEMPT_MERGED}:${input.attemptId}`,
            key: input.attemptId,
            projectId: input.projectId,
          },
        );
        return;
      }
      const gate = await gateFor(input.projectId, input.runId, input.config.hostId, basePath);
      if (ctx.state.disposed) return;
      if (gate) await noteMergedForGate(input, basePath, commit ?? "", produced, live);
      else if (!live && worktreePath) {
        await checkMainAfterMerge({
          projectId: input.projectId, pmThreadId: input.pmThreadId, config: input.config as never,
          runId: input.runId, task: input.task, basePath, worktreePath, attemptId: input.attemptId,
          mergeCommit: commit ?? undefined, greenInWorktree,
        });
      }
    })().catch((cause: unknown) => {
      ctx.log(`landed reactions of ${input.taskId} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    });
  }

  return { noteMergedForGate, checkMainAfterMerge, landed };
}

/** Single `-mainfix` builder owned by verification (`src/rooms/verification/server/landing-suite.ts`). */
export const postMergeRepair = buildMainfixTask;
