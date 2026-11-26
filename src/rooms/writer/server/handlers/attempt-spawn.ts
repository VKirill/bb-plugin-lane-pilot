import { LP_EVENTS, isTerminalAttemptState } from "@lane-pilot/contracts";
import { id } from "@lane-pilot/kit";
import { resolveStageWriterSelection, rotatedWriterSettings } from "@lane-pilot/models";
import type { ServerCore } from "../../../contracts/server";
import { closeWriterStages, coreHostsRequiredProvider, isTaskSatisfied, recordStage } from "../../../runs/server";
import {
  countAttempts, createAttempt, getAttempt, getReasoningTrace, getRunSettingsScopes,
  listAttemptsForTask, listStageReceipts, loadProjectSettings, transitionAttempt,
} from "../../../storage";
import { retargetTask } from "../../../tasks";
import type { StepContext, WorkflowEngine } from "../../../workflow";
import { isLiveDecision } from "../../models/live-folder";
import {
  WRITER_MODEL_KEY, WRITER_PROVIDER_KEY, WRITER_REASONING_EFFORT_KEY, WRITER_SILENCE_NUDGE_MIN_KEY,
} from "../../settings";
import { releaseAttemptAdmission } from "../services/attempt-admission";
import { WRITER_SILENCE_FALLBACK_SEC } from "../../models/attempt-timeouts";
import { emitAttemptEvent } from "../services/attempt-events";
import {
  handleSpawnRejected, tryEmergencyFallbackSpawn, tryStickyContinuation,
  type SpawnAttemptResult, type SpawnServicesShape,
} from "../services/attempt-spawn-fallback";
import {
  handleWriterSubscriptionFallback, resolveWriterFallbackPlan, startThreadTurnWatcher,
} from "../services/attempt-turn-watch";
import { buildQueuedReply, type DispatchRuntime } from "../services/dispatch-runtime";
import { reopenWriterStages } from "../services/dispatch-runtime";
import { lastOwnFailure } from "../services/start-failure-route";
import { walkWriterChain } from "../services/writer-hold";
import { previousAttemptBrief } from "../../models/writer-brief-feedback";

type Step = StepContext<DispatchRuntime>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Registers the reentrant `lp.attempt-spawn` executor and its poll handler. */
export function registerAttemptSpawnExecutor(
  engine: WorkflowEngine,
  resolveRuntime: (ctx: Step) => Promise<DispatchRuntime>,
): void {
  engine.register<DispatchRuntime>("lp.attempt-spawn", {
    reentrant: true,
    run: async (ctx) => {
      const r = await resolveRuntime(ctx);
      let attemptId = str(ctx.input.with.attemptId) ?? r.attemptId;
      r.attemptId = attemptId;
      if (ctx.input.with.live === true) r.live = true;
      if (!r.live && typeof (r.services as { isLiveFolder?: (runId: string, hostId: string, path: string) => Promise<boolean> }).isLiveFolder === "function") {
        if (await r.services.isLiveFolder(r.runId, r.config.hostId, r.workspacePath).catch(() => false)) r.live = true;
      }
      const pmReadContext = str(ctx.input.with.pmReadContext) ?? r.pmReadContext ?? "";
      let attempt = getAttempt(r.ctx.db, attemptId);
      const now = engine.now();
      const scopes = getRunSettingsScopes(r.ctx.db, r.runId);
      const loaded = loadProjectSettings(r.ctx.db, r.projectId, scopes);
      const baseSettings = typeof r.ctx.effectiveProjectSettings === "function"
        ? (await r.ctx.effectiveProjectSettings(r.projectId, scopes)).values
        : loaded;
      const runSettings = rotatedWriterSettings(baseSettings, r.taskId);
      const writerChoice = Object.fromEntries(
        Object.entries(runSettings).filter(([key, value]) => key.startsWith("writer.") && value !== baseSettings[key]),
      );
      const silenceMin = Number(runSettings[WRITER_SILENCE_NUDGE_MIN_KEY]);
      const silenceSec = Number.isFinite(silenceMin) && silenceMin > 0 ? Math.round(silenceMin * 60) : WRITER_SILENCE_FALLBACK_SEC;
      const kv = r.ctx.bb.storage?.kv;
      if ((kv ? await isTaskSatisfied(kv as never, r.projectId, r.taskId).catch(() => false) : false) || attempt?.state === "accepted") {
        await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
        return { output: { status: "already_settled", attemptId, attemptState: "accepted", retryable: false, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "accepted", stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } } };
      }
      const rtServices = r.services as unknown as SpawnServicesShape;

      // Compatibility mode for unit test fixtures that only stub `startWriterTask` (no `spawnWriterAttempt`).
      if (typeof rtServices.spawnWriterAttempt !== "function") {
        const dirtBefore = attempt?.dirt_before ?? [];
        const live = ctx.input.with.live === true;
        rtServices.startWriterTask({
          projectId: r.projectId, runId: r.runId, taskId: r.taskId, firstAttemptId: attemptId,
          pmThreadId: r.threadId, config: r.runConfig, task: r.task, plan: r.plan, singleAttempt: true,
          ...(pmReadContext ? { pmReadContext } : {}),
          ...(live ? { live } : {}),
          ...(dirtBefore.length ? { dirtBefore } : {}),
        });
        const after = getAttempt(r.ctx.db, attemptId);
        const st = after?.state ?? "queued";
        if (st === "accepted" || st === "blocked" || st === "validation_failed" || st === "provider_error") {
          const retryable = st === "blocked" || st === "validation_failed" || st === "provider_error";
          await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
          return {
            output: {
              status: "already_settled",
              attemptId,
              attemptState: st,
              retryable,
              writerThreadId: after?.thread_id ?? "",
              reply: { runId: r.runId, taskId: r.taskId, attemptId, state: st, retryable, ...(after?.reason ? { reason: after.reason } : {}), stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
            },
          };
        }
        return {
          output: {
            status: "running",
            attemptId,
            writerThreadId: after?.thread_id ?? "",
            silenceSec,
            until: now + silenceSec * 1_000,
            reply: { runId: r.runId, taskId: r.taskId, attemptId, state: after?.state ?? "queued", stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
          },
        };
      }

      const hasFullServices = typeof rtServices.runBudgetFor === "function";
      const providerErrCount = r.providerErrorRetries ?? 0;
      const prevFailReasonStr = typeof r.primaryFailure?.reason === "string" ? r.primaryFailure.reason : (attempt?.reason ?? null);
      const { fallbackList, useFallback } = resolveWriterFallbackPlan(runSettings, r.runConfig, prevFailReasonStr, providerErrCount, attempt?.state);

      if (hasFullServices && attempt && (attempt.state === "provider_error" || attempt.state === "validation_failed" || attempt.state === "empty_output" || attempt.state === "timeout" || attempt.state === "spawn_rejected")) {
        if (attempt.state === "provider_error" && useFallback) {
          transitionAttempt(r.ctx.db, attempt.id, "blocked", { reason: attempt.reason ?? "provider_error" });
        }
        attemptId = id("att");
        createAttempt(r.ctx.db, { id: attemptId, runId: r.runId, taskId: r.taskId });
        r.attemptId = attemptId;
        attempt = getAttempt(r.ctx.db, attemptId);
      }
      const attemptCount = countAttempts(r.ctx.db, r.runId, r.taskId);
      const retryIndex = Math.max(Math.max(0, attemptCount - 1), r.providerErrorRetries ?? 0);
      if (retryIndex > 0) reopenWriterStages(r.ctx.db, r.runId, r.taskId, r.plan);
      const existingWriterStage = listStageReceipts(r.ctx.db, r.runId, r.taskId).find((row) => row.stageId === "writer-agent");
      if (existingWriterStage?.state !== "running") {
        recordStage(r.ctx.db, { runId: r.runId, taskId: r.taskId, stageId: "writer-agent", state: "running", input: r.plan });
      }
      if (typeof rtServices.runBudgetFor === "function") {
        const check = rtServices.runBudgetFor(r.runId, runSettings).check();
        if (!check.ok) {
          const reason = check.reason ?? "run_budget_exceeded";
          if (!isTerminalAttemptState(attempt?.state ?? "")) transitionAttempt(r.ctx.db, attemptId, "blocked", { reason });
          closeWriterStages(r.ctx.db, { runId: r.runId, taskId: r.taskId, plan: r.plan, terminal: "failed", attempt: attemptCount, reason });
          r.ctx.refreshRun?.(r.runId);
          await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
          await emitAttemptEvent({ db: r.ctx.db, engine, name: LP_EVENTS.TASK_SETTLED, key: r.taskId, payload: { attemptId, taskId: r.taskId, state: "blocked", reason }, projectId: r.projectId });
          return { output: { status: "already_settled", attemptId, attemptState: "blocked", retryable: false, reason, reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "blocked", retryable: false, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) } } };
        }
      }

      const executeSpawn = async (): Promise<Record<string, unknown>> => {
        try {
          const priorAttempts = listAttemptsForTask(r.ctx.db, r.runId, r.taskId);
          const prevFailed = [...priorAttempts].reverse().find((row) => row.id !== attemptId && row.state !== "canceled");
          const prevFailedFull = prevFailed ? getAttempt(r.ctx.db, prevFailed.id) : null;
          const isLive = r.live === true || isLiveDecision(prevFailedFull?.workspace_decision ?? attempt?.workspace_decision);
          if (isLive) r.live = true;

          if (prevFailedFull) {
            const stickyResult = await tryStickyContinuation({ r, engine, rtServices, attemptId, prevFailedFull, isLive, silenceSec, now });
            if (stickyResult) return stickyResult;
          }

          const prev = retryIndex > 0
            ? previousAttemptBrief(
                lastOwnFailure(r.ctx.db, r.runId, r.taskId, attemptId) ?? { status: attempt?.state ?? "failed", reason: attempt?.reason ?? undefined },
                r.task,
              )
            : "";

          let spawned: SpawnAttemptResult | null = null;
          let attemptedEmergency: { providerId: string; model: string; trigger: string } | null = null;

          if (useFallback) {
            const fb = await tryEmergencyFallbackSpawn({ r, rtServices, attemptId, attempt, priorAttempts, prevFailedFull, isLive, pmReadContext, prev, fallbackList });
            attemptId = fb.attemptId;
            spawned = fb.spawned;
            attemptedEmergency = fb.attemptedEmergency;
          }

          if (!spawned) {
            let spawnWriterSettings = writerChoice;
            if (hasFullServices && rtServices.providerBreaker && rtServices.providerUsage) {
              const primary = resolveStageWriterSelection({ settings: runSettings, config: r.runConfig });
              const primaryPair = { providerId: primary.providerId, model: primary.model };
              const chainMembers = [{
                ...primaryPair,
                reasoningLevel: typeof runSettings[WRITER_REASONING_EFFORT_KEY] === "string" ? String(runSettings[WRITER_REASONING_EFFORT_KEY]) : "medium",
              }, ...fallbackList];
              const walked = await walkWriterChain(chainMembers, {
                hostId: r.runConfig.hostId, settings: runSettings,
                appetite: { tokens: (r.task as { appetite?: { tokens?: number } }).appetite?.tokens },
              }, {
                breaker: rtServices.providerBreaker as never,
                presence: rtServices.ownerPresence as never,
                usage: rtServices.providerUsage as never,
                money: rtServices.money as never,
                coreHosts: (pid) => coreHostsRequiredProvider(r.ctx.bb, pid),
                log: r.ctx.log,
              }, now);
              if (walked.free && walked.free.index > 0) {
                spawnWriterSettings = {
                  ...writerChoice,
                  [WRITER_PROVIDER_KEY]: walked.free.member.providerId,
                  [WRITER_MODEL_KEY]: walked.free.member.model,
                  ...(walked.free.member.reasoningLevel ? { [WRITER_REASONING_EFFORT_KEY]: walked.free.member.reasoningLevel } : {}),
                };
              }
            }
            spawned = await rtServices.spawnWriterAttempt!({
              projectId: r.projectId, runId: r.runId, taskId: r.taskId, attemptId,
              config: r.runConfig, task: r.task, plan: r.plan, pmThreadId: r.threadId, pmReadContext,
              writerSettings: spawnWriterSettings, retryIndex, ...(prev ? { previousAttempt: prev } : {}),
            });
          }

          const isRealSpawn = "ok" in spawned;
          const ok = isRealSpawn
            ? Boolean(spawned.ok)
            : spawned.status !== "blocked" && spawned.status !== "canceled" && spawned.status !== "spawn_rejected";
          const writerThreadId = (spawned.threadId ?? spawned.writerThreadId) ?? "";

          if (!ok) {
            return await handleSpawnRejected({ r, engine, rtServices, attemptId, attemptCount, spawned, attemptedEmergency, now });
          }

          if (attemptedEmergency) {
            r.emergencyFallback = {
              state: "completed", reason: attemptedEmergency.trigger,
              primaryAttemptId: r.primaryFailure?.attemptId ?? attemptId, attemptId,
              providerId: attemptedEmergency.providerId, model: attemptedEmergency.model,
            };
          }
          const boundAttempt = getAttempt(r.ctx.db, attemptId);
          if (boundAttempt && isLiveDecision(boundAttempt.workspace_decision)) {
            r.live = true;
            if (!r.liveBackupByAttempt) r.liveBackupByAttempt = {};
            r.liveBackupByAttempt[attemptId] = attemptId;
          }
          if (Array.isArray(spawned.dirtBefore)) {
            if (!r.dirtBeforeByAttempt) r.dirtBeforeByAttempt = {};
            const useLiveBaseline = r.live === true && r.liveBaselineDirt;
            r.dirtBeforeByAttempt[attemptId] = useLiveBaseline ? r.liveBaselineDirt! : spawned.dirtBefore;
            if (r.live === true && !r.liveBaselineDirt) r.liveBaselineDirt = [...spawned.dirtBefore];
          }
          if (spawned.workspacePath) {
            if (!r.activeTasksByAttempt) r.activeTasksByAttempt = {};
            r.activeTasksByAttempt[attemptId] = retargetTask(r.task, spawned.workspacePath);
          }
          const trace = getReasoningTrace(r.ctx.db, attemptId);
          const sel = spawned.providerId && spawned.model
            ? {
                providerId: spawned.providerId, model: spawned.model,
                reasoningLevel: spawned.reasoningLevel ?? trace?.effectiveReasoningLevel,
                serviceTier: spawned.serviceTier ?? trace?.serviceTier,
                selectionSource: spawned.selectionSource ?? trace?.selectionSource,
              }
            : trace
            ? {
                providerId: trace.providerId, model: trace.model,
                reasoningLevel: trace.effectiveReasoningLevel,
                serviceTier: trace.serviceTier,
                selectionSource: trace.selectionSource,
              }
            : undefined;
          if (sel) {
            if (!r.writerSelectionsByAttempt) r.writerSelectionsByAttempt = {};
            r.writerSelectionsByAttempt[attemptId] = sel;
          }
          if (spawned.executionPacketSha256) {
            if (!r.executionPacketShaByAttempt) r.executionPacketShaByAttempt = {};
            r.executionPacketShaByAttempt[attemptId] = spawned.executionPacketSha256;
          }
          if (writerThreadId) {
            recordStage(r.ctx.db, {
              runId: r.runId, taskId: r.taskId, stageId: "writer-agent", state: "running", input: r.plan,
              providerId: sel?.providerId, model: sel?.model, threadId: writerThreadId,
              result: {
                status: "running", attemptId, writerThreadId,
                ...(spawned.executionPacketSha256 ? { executionPacketSha256: spawned.executionPacketSha256 } : {}),
                ...(r.emergencyFallback ? { emergencyFallback: r.emergencyFallback } : {}),
                ...(sel ? { execution: { providerId: sel.providerId, model: sel.model, reasoningLevel: sel.reasoningLevel ?? null, serviceTier: sel.serviceTier ?? null, selectionSource: sel.selectionSource ?? null } } : {}),
              },
            });
          }

          r.queuedReply = buildQueuedReply(r, writerThreadId || null);
          if (isRealSpawn && writerThreadId) {
            startThreadTurnWatcher({
              bb: r.ctx.bb, db: r.ctx.db, engine, attemptId, taskId: r.taskId,
              projectId: r.projectId, writerThreadId, isDisposed: () => r.ctx.isDisposed?.() ?? false,
            });
          }
          return {
            status: "running",
            attemptId,
            writerThreadId,
            silenceSec,
            until: now + silenceSec * 1_000,
            reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "running", writerThreadId, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
          };
        } catch (cause) {
          const reason = cause instanceof Error ? cause.message : String(cause);
          await handleWriterSubscriptionFallback(r, reason, now);
          const after = getAttempt(r.ctx.db, attemptId);
          if (after && !isTerminalAttemptState(after.state) && after.state !== "provider_error") {
            transitionAttempt(r.ctx.db, attemptId, "provider_error", { reason });
          }
          await releaseAttemptAdmission(r.ctx.bb.storage?.kv as never, attemptId);
          return {
            status: "provider_error",
            attemptId,
            retryable: true,
            reason,
            reply: { runId: r.runId, taskId: r.taskId, attemptId, state: "provider_error", retryable: true, reason, stages: listStageReceipts(r.ctx.db, r.runId, r.taskId) },
          };
        }
      };

      if (hasFullServices) {
        r.queuedReply = buildQueuedReply(r, null);
        const spawnPromise = executeSpawn();
        void spawnPromise.then((output) => engine.resolve(ctx.runId, ctx.stepKey, output)).catch(() => undefined);
        return {
          wait: { kind: "attempt", detail: { runId: r.runId, taskId: r.taskId, attemptId } },
          partial: { reply: r.queuedReply },
        };
      }

      const PENDING = Symbol("pending");
      const spawnPromise = executeSpawn();
      const settled = await Promise.race([
        spawnPromise,
        new Promise<typeof PENDING>((resolve) => {
          const t = setTimeout(() => resolve(PENDING), 20);
          t.unref?.();
        }),
      ]);
      if (settled !== PENDING) return { output: settled };

      r.queuedReply = buildQueuedReply(r, null);
      void spawnPromise.then((output) => engine.resolve(ctx.runId, ctx.stepKey, output)).catch(() => undefined);
      return {
        wait: { kind: "attempt", detail: { runId: r.runId, taskId: r.taskId, attemptId } },
        partial: { reply: r.queuedReply },
      };
    },
    poll: async (step, ctx) => {
      const detail = step.await.detail as { runId: string; taskId: string; attemptId?: string } | undefined;
      if (!detail) return null;
      const db = engine.journal.db as unknown as ServerCore["db"];
      const latest = listAttemptsForTask(db, detail.runId, detail.taskId).at(-1);
      const attempt = (latest ? getAttempt(db, latest.id) : null) ?? (detail.attemptId ? getAttempt(db, detail.attemptId) : null);
      if (!attempt || !isTerminalAttemptState(attempt.state)) return null;
      const r = await resolveRuntime({ ...ctx, runtime: ctx.runtime } as unknown as Step).catch(() => null);
      const stages = r ? listStageReceipts(r.ctx.db, r.runId, r.taskId) : [];
      return {
        output: {
          status: "already_settled",
          attemptId: attempt.id,
          attemptState: attempt.state,
          retryable: false,
          reason: attempt.reason ?? attempt.state,
          reply: { runId: detail.runId, taskId: detail.taskId, attemptId: attempt.id, state: attempt.state, retryable: false, ...(attempt.reason ? { reason: attempt.reason } : {}), stages },
        },
      };
    },
  });
}
