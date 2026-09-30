import { t } from "../../../i18n";
import { agentPickerLabel } from "../../agent-display";
import { MAIN_AGENT_PROFILE_IDS, compileEffectiveMainAgent, compileMainAgentProfile, detectCompiledMainAgentCapability } from "../../agent-profile";
import { countAttempts, createAttempt, getActivation, getAttempt, getTask, getTaskPlan, listStageReceipts, transitionAttempt } from "../../database";
import { detectRequiredSessionPolicyCapability } from "../../helper-context";
import { sessionOverrideAgentsJson } from "../../native-agent-definition";
import { prepareNativeSessionRecord } from "../../native-dispatch";
import { DEFAULT_NATIVE_AGENT, nativeAgentCliId, nativeSelectionSchema } from "../../native-session";
import { userVisibleProjects } from "../../project-scope";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../../state-machine";
import type { AttemptState } from "../../state-machine";
import { cancelRejection, finishRunSafely } from "../run-finish";
import { recordStage } from "../stage-records";
import { id, stringAt, valueAt } from "../values";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../contracts";
import type { ServerCore } from "../core";
import type { Services } from "../services";

export function runsRpc(ctx: ServerCore, services: Services) {
  const { bb, cancelQueuedAttempt, db, effectiveProjectSettings, nativeInstaller, ownedAgents } = ctx;
  return {
    finish_run: async ({ projectId, runId }) => {
      await finishRunSafely(bb, db, projectId, runId, "rpc");
      return { projectId, finishedRunIds: [runId], closed: true };
    },
    activate_pm: ({ projectId, sourceThreadId, agentId, snapshot }) => {
      return services.activate(projectId, sourceThreadId, "bb", agentId, snapshot);
    },
    native_install_start: async ({ hostId }) => {
      await nativeInstaller.start(hostId);
      return { started: true };
    },
    prepare_native_session: async ({ projectId, agentId }) => {
      const shortId = nativeAgentCliId(agentId || DEFAULT_NATIVE_AGENT);
      const owned = await ownedAgents();
      const stored = owned[shortId];
      if (stored?.compiledCorrupt) throw new Error(`compiled_main_agent_corrupt:${shortId}`);
      let compiled = null;
      try { compiled = compileEffectiveMainAgent(shortId, stored); } catch { compiled = null; }
      const stock = (MAIN_AGENT_PROFILE_IDS as readonly string[]).includes(shortId) ? compileMainAgentProfile(shortId) : null;
      const edited = compiled && stock ? compiled.sourceHash !== stock.sourceHash : Boolean(compiled && !stock);
      if (!compiled && !stock) throw new Error(`Unknown Lane Pilot profile ${shortId}.`);
      const profileMode = edited ? "session-override" as const : "installed" as const;
      const agentsJson = sessionOverrideAgentsJson({ agentId: shortId, edited: true, compiled: compiled ?? stock });
      const record = await prepareNativeSessionRecord({
        projectId,
        agentId: shortId,
        profileMode,
        agentsJson,
        sourceHash: compiled?.sourceHash ?? null,
      });
      await bb.storage.kv.set(`native-selection:${record.token}`, record);
      const label = agentPickerLabel({
        id: shortId,
        description: compiled?.description ?? shortId,
      }, t);
      return { token: record.token, label, agentId: shortId, profileMode, cliAgentsCollision: null };
    },
    native_thread: async ({ threadId }) => {
      const selected = await bb.storage.kv.get(`native-thread:${threadId}`);
      if (!selected) return null;
      const parsed = nativeSelectionSchema.parse(selected);
      const agentType = await bb.storage.kv.get<string>(`native-agent-type:${threadId}`) ?? parsed.agentId;
      let shortId = parsed.agentId;
      try { shortId = nativeAgentCliId(agentType); } catch { shortId = parsed.agentId; }
      const stored = (await ownedAgents())[shortId];
      let compiled = null;
      try { compiled = compileEffectiveMainAgent(shortId, stored); } catch { compiled = null; }
      return {
        token: parsed.token,
        agentId: parsed.agentId,
        agentType,
        projectId: parsed.projectId,
        description: compiled?.description ?? shortId,
      };
    },
    activation_context: async ({ projectId, threadId }) => {
      const listed = await bb.sdk.projects.list({ includePersonal: true });
      const projects = userVisibleProjects(listed.map((row) => ({
        id: row.id,
        name: row.name,
        kind: row.kind === "personal" || row.kind === "standard" ? row.kind : undefined,
      }))).map((row) => ({ id: row.id, name: row.name }));
      let bindingStatus: "resolved" | "ambiguous" | "setup_required" | "offline" | "catalog_unavailable" | null = null;
      let writer = { providerId: null as string | null, model: null as string | null, reasoningEffort: null as string | null };
      let liveRun: { threadId: string; runId: string } | null = null;
      if (projectId) {
        const binding = await services.resolveProjectWriterHost({ projectId });
        bindingStatus = binding.status;
        const settings = (await effectiveProjectSettings(projectId)).values;
        writer = {
          providerId: typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : null,
          model: typeof settings["writer.model"] === "string" ? settings["writer.model"] as string : null,
          reasoningEffort: typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : null,
        };
        const activation = getActivation(db, projectId);
        if (activation && !activation.pm_thread_id.startsWith("pending:")) {
          liveRun = { threadId: activation.pm_thread_id, runId: activation.run_id };
        }
      }
      let pluginRole: string | null = null;
      let threadStatus: string | null = null;
      if (threadId) {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null);
        const role = valueAt(metadata, "role");
        pluginRole = typeof role === "string" ? role : null;
        const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
        threadStatus = stringAt(thread, "status");
      }
      return {
        projectId,
        projects,
        bindingStatus,
        compiledMainAgent: detectCompiledMainAgentCapability(
          (bb as { agents?: { experimental_vkCompiledMainAgent?: unknown } }).agents ?? {},
        ),
        mainAgents: (await services.listedAgentProfiles()).map((row) => ({ id: row.id, description: row.description })),
        writer,
        liveRun,
        pluginRole,
        threadStatus,
        requiredSessionPolicy: detectRequiredSessionPolicyCapability((bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {}) ? "required" : "none",
      };
    },
    cancel_attempt: async ({ attemptId }) => {
      const attempt = getAttempt(db, attemptId);
      if (!attempt) return { ok: false, state: "missing", reason: "attempt does not exist" };
      if (!attempt.thread_id) return cancelQueuedAttempt(attempt);
      const rejection = cancelRejection(db, attempt);
      if (rejection) return { ok:false, state:attempt.state, reason:rejection };
      transitionAttempt(db, attempt.id, "cancel_requested", { threadId: attempt.thread_id });
      await bb.sdk.threads.stop({ threadId: attempt.thread_id });
      const observed = await bb.sdk.threads.get({ threadId: attempt.thread_id });
      const status = stringAt(observed, "status");
      const listRunning = (bb.sdk.threads as { listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>> }).listRunning;
      const running = listRunning ? await listRunning({}) : [];
      const stillRunning = running.some((thread) => thread.id === attempt.thread_id)
        || status === "active" || status === "running";
      if (stillRunning) return { ok: false, state: "cancel_requested", reason: `writer stop was not independently observed (status=${status ?? "unknown"})` };
      transitionAttempt(db, attempt.id, "canceled", { threadId: attempt.thread_id });
      const task = getTask(db, attempt.task_id);
      const plan = getTaskPlan(db, attempt.task_id) ?? (task?.kind === "bb" ? valueAt(task.contract, "objective") : "") as string;
      for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
        const current = listStageReceipts(db, attempt.run_id, attempt.task_id).find((row) => row.stageId === stageId);
        if (current && (current.state === "pending" || current.state === "running")) {
          recordStage(db, { runId:attempt.run_id, taskId:attempt.task_id, stageId, state:"canceled", input:plan,
            attempt:attempt.attempt_no, threadId:attempt.thread_id, reason:"writer stop observed" });
        }
      }
      return { ok: true, state: "canceled", reason: null };
    },
    retry_attempt: ({ attemptId }) => {
      const attempt = getAttempt(db, attemptId);
      if (!attempt) return { ok: false, state: "missing", attemptId, reason: "attempt does not exist" };
      const used = countAttempts(db, attempt.run_id, attempt.task_id);
      if (!RETRY_ELIGIBLE.includes(attempt.state as AttemptState)) {
        return { ok: false, state: attempt.state, attemptId, reason: `retry is not legal from ${attempt.state}` };
      }
      if (used >= MAIN_ATTEMPT_LIMIT) {
        const exhausted = `retry limit 2 exhausted${attempt.reason ? `: ${attempt.reason}` : ""}`;
        transitionAttempt(db, attempt.id, "blocked", { reason: exhausted });
        return { ok: false, state: "blocked", attemptId, reason: exhausted };
      }
      const nextId = id("lpattempt");
      createAttempt(db, { id: nextId, runId: attempt.run_id, taskId: attempt.task_id });
      return { ok: true, state: "queued", attemptId: nextId, reason: null };
    },
    resume_runs: ({ projectId }) => services.resumeOrphans(projectId),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "finish_run" | "activate_pm" | "native_install_start" | "prepare_native_session" | "native_thread" | "activation_context" | "cancel_attempt" | "retry_attempt" | "resume_runs">;
}
