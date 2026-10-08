import { t } from "@lane-pilot/i18n";
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
  let lastListErrorLogAt = 0;
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
      const rows: unknown[] = [];
      const PAGE_SIZE = 100;
      for (let offset = 0; offset < 2_000; offset += PAGE_SIZE) {
        let page: unknown[] = [];
        try {
          page = await bb.sdk.threads.list({ parentThreadId: threadId, includeHidden: true, archived: false, limit: PAGE_SIZE, offset });
        } catch (cause) {
          const now = Date.now();
          if (now - lastListErrorLogAt > 60_000) {
            lastListErrorLogAt = now;
            bb.log.warn(`Lane Pilot list_helper_threads error: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
          break;
        }
        rows.push(...page);
        if (page.length < PAGE_SIZE) break;
      }

      // Find the open run for this PM thread (if any)
      const openRun = db.prepare(
        "SELECT id, project_id FROM lane_pilot_run WHERE pm_thread_id=? AND closed_at IS NULL ORDER BY created_at DESC LIMIT 1",
      ).get(threadId) as { id: string; project_id: string } | undefined;

      // Find tasks in this run with open attempts, their latest attempt and stages
      type OpenAttemptRow = {
        id: string;
        run_id: string;
        task_id: string;
        thread_id: string | null;
        state: string;
        reason: string | null;
      };
      const openAttemptsByThread = new Map<string, OpenAttemptRow>();
      const queuedTaskIds: string[] = [];

      if (openRun) {
        // Find latest attempt for each task in this run
        const attempts = db.prepare(`
          SELECT a.id, a.run_id, a.task_id, a.thread_id, a.state, a.reason
          FROM lane_pilot_attempt a
          WHERE a.run_id=?
            AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
        `).all(openRun.id) as OpenAttemptRow[];

        const TERMINAL_ATTEMPTS = new Set(["accepted", "blocked", "canceled", "failed"]);
        for (const att of attempts) {
          if (!TERMINAL_ATTEMPTS.has(att.state)) {
            if (att.state === "queued" && !att.thread_id) {
              queuedTaskIds.push(att.task_id);
            } else if (att.thread_id) {
              openAttemptsByThread.set(att.thread_id, att);
            }
          }
        }
      }

      const rowList = (rows as unknown as Array<Record<string, unknown>>)
        .filter((row) => typeof row.id === "string" && !row.archivedAt);

      const isTerminalThread = (status: string) => ["error", "stopped", "completed"].includes(status);

      const working = rowList.filter((row) => {
        const id = String(row.id);
        const status = String(row.status);
        if (isTerminalThread(status)) return false;
        if (status === "idle") {
          return openAttemptsByThread.has(id);
        }
        return true;
      });

      const threads = await Promise.all(working.map(async (row) => {
        const threadIdStr = String(row.id);
        const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: threadIdStr }).catch(() => null);
        const statusStr = String(row.status);

        let phase: string | null = null;
        if (statusStr !== "idle") {
          phase = "работает";
        } else {
          const attempt = openAttemptsByThread.get(threadIdStr);
          if (attempt && openRun) {
            const receipts = (db.prepare(
              "SELECT stage_id, state FROM lane_pilot_stage_receipt WHERE run_id=? AND task_id=?",
            ).all(openRun.id, attempt.task_id) as Array<{ stage_id: string; state: string }>);

            const verification = receipts.find((r) => r.stage_id === "verification");
            const acceptance = receipts.find((r) => r.stage_id === "acceptance-receipt");

            const isVerifying = verification?.state === "running";
            const isAccepting = acceptance?.state === "running" || (verification?.state === "passed" && (!acceptance || acceptance.state === "pending"));

            if (isVerifying) {
              phase = "проверка";
            } else if (isAccepting) {
              phase = "приёмка";
            } else if (attempt.reason?.includes("merge") || attempt.reason?.includes("busy") || attempt.reason?.includes("conflict")) {
              phase = "ждёт слияния";
            } else {
              phase = "проверка";
            }
          } else {
            phase = "работает";
          }
        }

        return {
          id: threadIdStr,
          title: (stringAt(row, "title") ?? stringAt(row, "titleFallback") ?? threadIdStr).replace(/^Lane Pilot [^:]{1,40}:\s*/, ""),
          status: statusStr,
          role: stringAt(metadata, "role") ?? "helper",
          detail: stringAt(metadata, "specialist"),
          phase,
        };
      }));

      return {
        threads: threads.filter((row) => row.role !== "workspace-provisioner"),
        queued: queuedTaskIds,
      };
    },
    get_run_card: ({ runId }) => {
      const run = db.prepare("SELECT id, state, closed_at, writer_host_id FROM lane_pilot_run WHERE id=?")
        .get(runId) as { id: string; state: string; closed_at: number | null; writer_host_id: string | null } | undefined;
      if (!run) return null;
      const rows = db.prepare(`
        SELECT t.id, t.contract_json, a.state, a.thread_id, a.workspace_path
        FROM lane_pilot_task t
        LEFT JOIN lane_pilot_attempt a ON a.run_id=t.run_id AND a.task_id=t.id
          AND a.created_at=(SELECT MAX(b.created_at) FROM lane_pilot_attempt b WHERE b.run_id=a.run_id AND b.task_id=a.task_id)
        WHERE t.run_id=? ORDER BY t.created_at LIMIT 200
      `).all(runId) as Array<{ id: string; contract_json: string; state: string | null; thread_id: string | null; workspace_path: string | null }>;
      const logs = new Map<string, string>();
      for (const row of db.prepare("SELECT task_id, result_json FROM lane_pilot_stage_receipt WHERE run_id=? AND result_json LIKE '%checkLogPath%'")
        .all(runId) as Array<{ task_id: string; result_json: string | null }>) {
        const found = /"checkLogPath"\s*:\s*"([^"]+)"/.exec(row.result_json ?? "");
        if (found) logs.set(row.task_id, found[1]!);
      }
      const titleOf = (json: string, fallback: string) => {
        try { const title = (JSON.parse(json) as { title?: unknown }).title; return typeof title === "string" && title ? title : fallback; } catch { return fallback; }
      };
      const tasks = new Map<string, { id: string; title: string; state: string | null; threadId: string | null; checkLog: { hostId: string; path: string } | null }>();
      for (const row of rows) {
        const rel = logs.get(row.id);
        const safe = rel && !rel.startsWith("/") && !rel.split("/").includes("..") ? rel : null;
        tasks.set(row.id, {
          id: row.id, title: titleOf(row.contract_json, row.id), state: row.state, threadId: row.thread_id,
          checkLog: safe && run.writer_host_id && row.workspace_path ? { hostId: run.writer_host_id, path: `${row.workspace_path.replace(/\/+$/, "")}/${safe}` } : null,
        });
      }
      return { runId: run.id, state: run.state, closed: run.closed_at !== null, tasks: [...tasks.values()] };
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
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "finish_run" | "activate_pm" | "native_install_start" | "native_install_status" | "prepare_native_session" | "list_helper_threads" | "get_run_card" | "native_thread" | "activation_context" | "cancel_attempt" | "halt_run" | "retry_attempt" | "resume_runs">;
  return handlers;
}
