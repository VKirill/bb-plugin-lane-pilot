import { MACHINE_AFFINITY_ANY } from "@lane-pilot/contracts";
import { loadProjectSettings, countAttempts, createAttempt, failedBackgroundStageRows, failureFieldsOf, getActivation, getAttempt, getRunCard, latestAttemptsPerTask, stageReceiptStates, openAttemptIdsOfRun, openRunOfPmThread, runTaskCardRows, taskCheckLogRows, transitionAttempt } from "../../../storage";
import { ownerWordsMode } from "../../../tasks";
import { createFromDraft, dispatchChecked, getDraftOf } from "../../../tasks/server";
import { t } from "@lane-pilot/i18n";
import { resolveRoleModel } from "@lane-pilot/models";
import { setRunHalted } from "../runs-halt";
import { PARKED_KEY } from "../../../contracts/stability-api";
import { agentPickerLabel } from "../../../contracts/agent-display"
import { employeeView } from "../../../contracts/employee-manifest"
import { pickableAgent } from "../../../contracts/agent-picker";
import { detectRequiredSessionPolicyCapability } from "../../../contracts/helper-context";
import { DEFAULT_NATIVE_AGENT, nativeAgentCliId } from "../../../contracts/native-agent-id"
import { nativeAgentTypeKey, nativeThreadKey } from "../../../contracts"
import { nativeSelectionSchema } from "../../../contracts/native-selection";
import { userVisibleProjects } from "../../../contracts/project-scope";
import { MAIN_ATTEMPT_LIMIT, RETRY_ELIGIBLE } from "../../../contracts/state-machine";
import type { AttemptState } from "../../../contracts/state-machine";
import { finishRunSafely } from "../run-finish";
import { buildTaskGraph } from "../task-graph";
import { buildTaskBoard, readTaskCard, type CardThread } from "../task-board";
import type { TokenCursorReader } from "../../../work-graph/server";
import { readThreadLive } from "../thread-live";
import { cancelAttemptById } from "../cancel";
import { queueWaitPercentiles, runQueueWaits } from "../../../usage/server/attempt-metrics";
import { pauseRun } from "../runs-pause";
import { folderEnvironment, projectSources } from "../../../platform/server";
import { id, stringAt, valueAt, orMiss, isNotFound } from "@lane-pilot/kit";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import { rpcContract } from "../../../contracts";
import type { ServerCore } from "../../../contracts/server";

import type { ActivationApi, AgentOpsApi } from "../../../contracts";
import type { RollbackApi } from "../../../rollback/server/rollback";
import type { ResumeOrphansPort } from "../../../contracts/stability-api";
import type { WriterHostApi } from "../../../platform/server";
import type { DispatchWriter } from "../../../platform/server";

/** The fields of the services bag this file reads, typed by the rooms that own them. */
interface Services {
  activate: ActivationApi["activate"];
  placeEmployeeOn: AgentOpsApi["placeEmployeeOn"];
  storeNativeSelection: AgentOpsApi["storeNativeSelection"];
  compileEffectiveMainAgent: AgentOpsApi["compileEffectiveMainAgent"];
  detectCompiledMainAgentCapability: AgentOpsApi["detectCompiledMainAgentCapability"];
  pendingSwitch: AgentOpsApi["pendingSwitch"];
  listedAgentProfiles: WriterHostApi["listedAgentProfiles"];
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  resumeOrphans: ResumeOrphansPort["resumeOrphans"];
  rollback: RollbackApi;
  tokenCursorRow: TokenCursorReader;
  dispatchWriter: DispatchWriter;
  phaseIntake: { dispatchRefusal(threadId: string): Promise<string | null> };
}


export function runsRpc(ctx: ServerCore, services: Services) {
  const { bb, cancelQueuedAttempt, db, effectiveProjectSettings, nativeInstaller, ownedAgents } = ctx;
  let lastListErrorLogAt = 0;
  const pmTitles = new Map<string, { title: string | null; at: number }>();
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
      const settings = (await effectiveProjectSettings(projectId)).values;
      const { selection: record, description } = await services.storeNativeSelection({ projectId, agentId: agentId || DEFAULT_NATIVE_AGENT });
      const label = agentPickerLabel({ id: record.agentId, description }, t);
      const pinned = employeeView(record.agentId).machineAffinity !== MACHINE_AFFINITY_ANY;
      const place = pinned ? await services.placeEmployeeOn(record.agentId, await projectSources(bb, projectId)) : { mode: "inherit" as const };
      const environment = place.mode === "folder" ? folderEnvironment({ hostId: place.hostId, path: place.path }) : null;
      const placementNote = place.mode === "fallback" ? place.reason : null;
      // A specialist runs its role's model (the owner's table or the row default); the coordinator stays on Opus.
      const isSpecialist = record.agentId !== DEFAULT_NATIVE_AGENT;
      const roleModel = isSpecialist
        ? (() => { const resolved = resolveRoleModel(`specialist:${record.agentId}`, settings); return { providerId: resolved.providerId, model: resolved.model, effort: resolved.effort ?? null }; })()
        : null;
      return { token: record.token, label, agentId: record.agentId, profileMode: record.profileMode, cliAgentsCollision: null, environment, placementNote, roleModel };
    },
    // threadId → its LP role from the thread's plugin metadata (the sidebar row mark; empty for threads that are not Lane Pilot's).
    helper_thread_labels: async ({ threadIds }) => {
      const labels: Record<string, string> = {};
      await Promise.all((threadIds as string[]).map(async (threadId) => {
        const meta = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound);
        const role = meta && typeof meta === "object" ? (meta as Record<string, unknown>).role : null;
        if (typeof role === "string" && role) labels[threadId] = role;
      }));
      return { labels };
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
      const openRun = openRunOfPmThread(db, threadId) as { id: string; project_id: string } | undefined;

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
        const attempts = latestAttemptsPerTask(db, openRun.id) as OpenAttemptRow[];

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
        const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: threadIdStr }), null, isNotFound);
        const statusStr = String(row.status);

        let phase: string | null = null;
        if (statusStr !== "idle") {
          phase = "работает";
        } else {
          const attempt = openAttemptsByThread.get(threadIdStr);
          if (attempt && openRun) {
            const receipts = stageReceiptStates(db, openRun.id, attempt.task_id);

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
        ...(openRun ? { graph: buildTaskGraph(db, openRun.id) } : {}),
      };
    },
    task_draft_card: async ({ draftId, projectId }) => {
      const draft = getDraftOf(db, draftId, projectId);
      if (!draft) return null;
      const titles = draft.contracts.map((contract) => String((contract as { display_title?: string }).display_title ?? (contract as { id?: string }).id ?? "task"));
      const areas = [...new Set(draft.contracts.map((contract) => String((contract as { area?: string }).area ?? "")))].filter(Boolean);
      return { id: draft.id, kind: draft.kind, state: draft.state, runId: draft.runId, taskIds: draft.taskIds,
        failed: draft.results.flatMap((result, index) => (result?.state === "failed" ? [{ title: titles[index] ?? "task", reason: result.reason }] : [])),
        title: draft.objective ?? titles[0] ?? "task", promise: draft.objective ?? `Создам ${titles.length === 1 ? "задачу" : `${titles.length} задачи`}: ${titles.join(", ")}`,
        groups: areas.length ? areas.map((area) => ({ area, titles: draft.contracts.filter((c) => String((c as { area?: string }).area ?? "") === area).map((c) => String((c as { display_title?: string }).display_title ?? "")) })) : [{ area: "", titles }] };
    },
    // The card's button: the same createFromDraft and the same dispatch function as the PM's confirmed call and lane_pilot_dispatch_writer.
    // A window that names its project (projectId) creates only that project's drafts. No owner-turn gate: this is the owner's own click, not an agent turn.
    task_draft_create: async ({ draftId, projectId }) => {
      const draft = getDraftOf(db, draftId, projectId);
      if (!draft) throw new Error(projectId ? "draft_not_in_project" : `draft ${draftId} does not exist`);
      return await createFromDraft(db, draftId, async (contract) => dispatchChecked(
        { dispatchRefusal: (threadId) => services.phaseIntake.dispatchRefusal(threadId), dispatchWriter: services.dispatchWriter as never },
        { threadId: draft.threadId ?? "", projectId: draft.projectId, task: contract, plan: draft.plan ?? undefined, objective: draft.objective ?? undefined }), { projectId });
    },
    task_board: async ({ projectId, doneHours }) => {
      const items = buildTaskBoard(db, { projectId: projectId ?? null, doneSince: Date.now() - doneHours * 3_600_000 });
      // The PM chat's title groups the board «by chat»; titles change rarely, so each is read at most every five minutes.
      const now = Date.now();
      const ids = [...new Set(items.flatMap((item) => (item.pmThreadId ? [item.pmThreadId] : [])))];
      await Promise.all(ids.filter((id) => (pmTitles.get(id)?.at ?? 0) < now - 300_000).slice(0, 40).map(async (id) => {
        const row = await orMiss(bb.sdk.threads.get({ threadId: id }), null, isNotFound) as Record<string, unknown> | null;
        pmTitles.set(id, { title: stringAt(row, "title") ?? null, at: now });
      }));
      return { items: items.map((item) => ({ ...item, pmThreadTitle: item.pmThreadId ? pmTitles.get(item.pmThreadId)?.title ?? null : null })) };
    },
    thread_live: async ({ threadId }) => readThreadLive(db, threadId, services.tokenCursorRow),
    task_card: async ({ runId, taskId }) => {
      const card = readTaskCard(db, { runId, taskId });
      if (!card) return null;
      const { roots, ...rest } = card;
      const pmThreadId = card.pmThreadId;
      // The threads that worked on it (writer per attempt, a helper per stage) under the PM chat, each with the BB child
      // threads it started (sub-agents); archived ones too, since a finished task's helpers are archived.
      const describe = async (id: string, role: string): Promise<CardThread> => {
        const row = await orMiss(bb.sdk.threads.get({ threadId: id }), null, isNotFound) as Record<string, unknown> | null;
        return { id, role, title: stringAt(row, "title") ?? null, status: stringAt(row, "status") ?? null, children: [] };
      };
      const childrenOf = async (id: string): Promise<CardThread[]> => {
        const listed = await (bb.sdk.threads.list({ parentThreadId: id, includeHidden: true, limit: 30 } as never) as Promise<unknown>).catch((cause: unknown) => { bb.log.warn(`Lane Pilot child threads of ${id} unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return []; });
        return (Array.isArray(listed) ? listed as Array<Record<string, unknown>> : []).filter((row) => typeof row.id === "string").map((row) => ({
          id: String(row.id), role: "sub-agent", title: stringAt(row, "title") ?? null, status: stringAt(row, "status") ?? null, children: [],
        }));
      };
      const workers = await Promise.all(roots.slice(0, 24).map(async (root) => ({ ...(await describe(root.id, root.role)), children: await childrenOf(root.id) })));
      const threads = pmThreadId ? { ...(await describe(pmThreadId, "PM")), children: workers } : workers.length ? { id: "", role: "run", title: null, status: null, children: workers } : null;
      return { ...rest, threads };
    },
    get_run_card: ({ runId }) => {
      const run = getRunCard(db, runId) as { id: string; state: string; closed_at: number | null; writer_host_id: string | null } | undefined;
      if (!run) return null;
      const rows = runTaskCardRows(db, runId) as Array<{ id: string; contract_json: string; state: string | null; thread_id: string | null; workspace_path: string | null }>;
      const logs = new Map<string, string>();
      for (const row of taskCheckLogRows(db, runId) as Array<{ task_id: string; result_json: string | null }>) {
        const found = /"checkLogPath"\s*:\s*"([^"]+)"/.exec(row.result_json ?? "");
        if (found) logs.set(row.task_id, found[1]!);
      }
      // Accepted code and the background work after it are two results: a failed memory write is shown, not hidden behind «Accepted».
      const background = new Map<string, string[]>();
      for (const row of failedBackgroundStageRows(db, runId) as Array<{ task_id: string; stage_id: string }>) {
        background.set(row.task_id, [...(background.get(row.task_id) ?? []), row.stage_id]);
      }
      const titleOf = (json: string, fallback: string) => {
        try { const title = (JSON.parse(json) as { title?: unknown }).title; return typeof title === "string" && title ? title : fallback; } catch { return fallback; }
      };
      const tasks = new Map<string, { id: string; title: string; state: string | null; threadId: string | null; checkLog: { hostId: string; path: string } | null; background?: string[] }>();
      for (const row of rows) {
        const rel = logs.get(row.id);
        const safe = rel && !rel.startsWith("/") && !rel.split("/").includes("..") ? rel : null;
        tasks.set(row.id, {
          id: row.id, title: titleOf(row.contract_json, row.id), state: row.state, threadId: row.thread_id,
          checkLog: safe && run.writer_host_id && row.workspace_path ? { hostId: run.writer_host_id, path: `${row.workspace_path.replace(/\/+$/, "")}/${safe}` } : null,
          ...(row.state === "accepted" && background.has(row.id) ? { background: background.get(row.id)! } : {}),
        });
      }
      return { runId: run.id, state: run.state, closed: run.closed_at !== null, tasks: [...tasks.values()],
        // W31 rank 11: how long this run's attempts sat in the queue (settled waits only).
        queueWait: queueWaitPercentiles(runQueueWaits(db, run.id)) };
    },
    native_thread: async ({ threadId }) => {
      // An agent the chat was switched to counts from the moment it is chosen; its next message binds it.
      const pending = await services.pendingSwitch(threadId);
      const selected = pending ?? await bb.storage.kv.get(nativeThreadKey(threadId));
      if (!selected) return null;
      const parsed = nativeSelectionSchema.parse(selected);
      const agentType = (pending ? null : await bb.storage.kv.get<string>(nativeAgentTypeKey(threadId))) ?? parsed.agentId;
      let shortId = parsed.agentId;
      try { shortId = nativeAgentCliId(agentType); } catch { shortId = parsed.agentId; }
      const stored = (await ownedAgents())[shortId];
      let compiled = null;
      try { compiled = services.compileEffectiveMainAgent(shortId, stored); } catch { compiled = null; }
      // The thread's Lane Pilot role (pm, writer, …) from its plugin metadata: the composer's boundary line shows for a PM chat only.
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId }).catch(() => null) as { role?: unknown } | null;
      return {
        token: parsed.token,
        agentId: parsed.agentId,
        agentType,
        projectId: parsed.projectId,
        description: compiled?.description ?? shortId,
        role: typeof metadata?.role === "string" ? metadata.role : null,
        ownerWords: ownerWordsMode(loadProjectSettings(db, parsed.projectId)),
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
        const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound);
        const role = valueAt(metadata, "role");
        pluginRole = typeof role === "string" ? role : null;
        const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound);
        threadStatus = stringAt(thread, "status");
      }
      const mainAgents = (await services.listedAgentProfiles({ pickable: true })).map(pickableAgent);
      return {
        projectId,
        projects,
        bindingStatus,
        compiledMainAgent: services.detectCompiledMainAgentCapability(
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
    cancel_attempt: async ({ attemptId, code }) => cancelAttemptById(ctx, attemptId, services.rollback, "canceled by RPC", code),
    pause_run: async ({ runId }) => await pauseRun(ctx, runId, "pause"),
    resume_run: async ({ runId }) => await pauseRun(ctx, runId, "resume"),
    halt_run: async ({ runId }) => {
      await setRunHalted(bb.storage.kv as never, runId, true);
      const open = openAttemptIdsOfRun(db, runId).map((id) => ({ id }));
      const canceled:string[] = [], left:string[] = [];
      for (const { id } of open) {
        // a failed cancel lands in `left`, not silently dropped
        const result = await handlers.cancel_attempt({ attemptId:id, code:"run_closed" }).catch(() => ({ ok:false }));
        (result.ok ? canceled : left).push(id);
      }
      const parked = await bb.storage.kv.get(PARKED_KEY);
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
        transitionAttempt(db, attempt.id, "blocked", { reason: exhausted, ...failureFieldsOf({ failureCode: attempt.failure_code, checkName: attempt.check_name, timeoutSec: attempt.timeout_sec }) });
        return { ok: false, state: "blocked", attemptId, reason: exhausted };
      }
      const nextId = id("lpattempt");
      createAttempt(db, { id: nextId, runId: attempt.run_id, taskId: attempt.task_id });
      return { ok: true, state: "queued", attemptId: nextId, reason: null };
    },
    resume_runs: ({ projectId }) => services.resumeOrphans(projectId),
  } satisfies Pick<PluginRpcHandlers<typeof rpcContract>, "finish_run" | "activate_pm" | "native_install_start" | "native_install_status" | "prepare_native_session" | "helper_thread_labels" | "list_helper_threads" | "task_board" | "task_draft_card" | "task_draft_create" | "thread_live" | "task_card" | "get_run_card" | "native_thread" | "activation_context" | "cancel_attempt" | "pause_run" | "resume_run" | "halt_run" | "retry_attempt" | "resume_runs">;
  return handlers;
}
