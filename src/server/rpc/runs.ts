import { t } from "../../../i18n";
import { setRunHalted } from "../runs-halt";
import { PARKED_KEY } from "../stability";
import { agentPickerLabel } from "../../agent-display";
import { compileEffectiveMainAgent, detectCompiledMainAgentCapability } from "../../agent-profile";
import { countAttempts, createAttempt, getActivation, getAttempt, transitionAttempt } from "../../database";
import { detectRequiredSessionPolicyCapability } from "../../helper-context";
import { storeNativeSelection } from "../native-profile";
import { DEFAULT_NATIVE_AGENT, nativeAgentCliId, nativeSelectionSchema } from "../../native-session";
import { userVisibleProjects } from "../../project-scope";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../../state-machine";
import type { AttemptState } from "../../state-machine";
import { finishRunSafely } from "../run-finish";
import { cancelAttemptById } from "../cancel";
import { id, stringAt, valueAt } from "../values";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../contracts";
import type { ServerCore } from "../core";
import type { Services } from "../services";

export function runsRpc(ctx: ServerCore, services: Services) {
  const { bb, cancelQueuedAttempt, db, effectiveProjectSettings, nativeInstaller, ownedAgents } = ctx;
  const handlers = {
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
    native_install_status: ({ hostId }) => nativeInstaller.status(hostId),
    prepare_native_session: async ({ projectId, agentId }) => {
      const { selection: record, description } = await storeNativeSelection(ctx, { projectId, agentId: agentId || DEFAULT_NATIVE_AGENT });
      const label = agentPickerLabel({ id: record.agentId, description }, t);
      return { token: record.token, label, agentId: record.agentId, profileMode: record.profileMode, cliAgentsCollision: null };
    },
    // The PM chat's helpers that are still working: writers, specialists, the browser check, council seats, critics.
    list_helper_threads: async ({ threadId }) => {
      // A long PM chat has hundreds of finished helpers (SelfyStudio: 335); one page of 50 held old ones only, so a
      // working writer never got its square next to the badge. Unarchived ones, every page.
      const rows:unknown[] = [];
      for (let offset = 0; offset < 2_000; offset += 200) {
        const page = await bb.sdk.threads.list({ parentThreadId: threadId, includeHidden: true, archived: false, limit: 200, offset }).catch(() => []);
        rows.push(...page);
        if (page.length < 200) break;
      }
      const working = (rows as unknown as Array<Record<string, unknown>>)
        .filter((row) => typeof row.id === "string" && !row.archivedAt && !["idle", "error", "stopped", "completed"].includes(String(row.status)));
      const threads = await Promise.all(working.map(async (row) => {
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: String(row.id) }).catch(() => null);
        return {
          id: String(row.id),
          // «Lane Pilot writer: <task>» → «<task>»: the square's icon already says the role.
          title: (stringAt(row, "title") ?? stringAt(row, "titleFallback") ?? String(row.id)).replace(/^Lane Pilot [^:]{1,40}:\s*/, ""),
          status: String(row.status),
          role: stringAt(metadata, "role") ?? "helper",
          detail: stringAt(metadata, "specialist"),
        };
      }));
      return { threads: threads.filter((row) => row.role !== "workspace-provisioner") };
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
      let chosenAgent: string | null = null;
      if (projectId) {
        const binding = await services.resolveProjectWriterHost({ projectId });
        bindingStatus = binding.status;
        const settings = (await effectiveProjectSettings(projectId)).values;
        writer = {
          providerId: typeof settings["writer.provider"] === "string" ? settings["writer.provider"] as string : null,
          model: typeof settings["writer.model"] === "string" ? settings["writer.model"] as string : null,
          reasoningEffort: typeof settings["writer.reasoning_effort"] === "string" ? settings["writer.reasoning_effort"] as string : null,
        };
        chosenAgent = typeof settings["main.agent"] === "string" && settings["main.agent"] ? settings["main.agent"] as string : null;
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
      const mainAgents = (await services.listedAgentProfiles()).map((row) => ({ id: row.id, description: row.description }));
      return {
        projectId,
        projects,
        bindingStatus,
        compiledMainAgent: detectCompiledMainAgentCapability(
          (bb as { agents?: { experimental_vkCompiledMainAgent?: unknown } }).agents ?? {},
        ),
        mainAgents,
        mainAgent: chosenAgent && mainAgents.some((row) => row.id === chosenAgent) ? chosenAgent : null,
        writer,
        liveRun,
        pluginRole,
        threadStatus,
        requiredSessionPolicy: detectRequiredSessionPolicyCapability((bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {}) ? "required" : "none",
      };
    },
    cancel_attempt: async ({ attemptId }) => cancelAttemptById(ctx, attemptId),
    halt_run: async ({ runId }) => {
      await setRunHalted(bb.storage.kv as never, runId, true);
      const open = db.prepare(`SELECT id FROM lane_pilot_attempt WHERE run_id=? AND state IN ('queued','spawn_requested','spawn_unknown','running','cancel_requested')`).all(runId) as Array<{ id:string }>;
      const canceled:string[] = [], left:string[] = [];
      for (const { id } of open) {
        const result = await handlers.cancel_attempt({ attemptId:id }).catch(() => ({ ok:false }));
        (result.ok ? canceled : left).push(id);
      }
      const parked = await bb.storage.kv.get(PARKED_KEY).catch(() => null);
      if (Array.isArray(parked)) await bb.storage.kv.set(PARKED_KEY, parked.filter((row) => (row as { runId?:string }).runId !== runId));
      return { ok:left.length === 0, canceled, left };
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
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "finish_run" | "activate_pm" | "native_install_start" | "native_install_status" | "prepare_native_session" | "list_helper_threads" | "native_thread" | "activation_context" | "cancel_attempt" | "halt_run" | "retry_attempt" | "resume_runs">;
  return handlers;
}
