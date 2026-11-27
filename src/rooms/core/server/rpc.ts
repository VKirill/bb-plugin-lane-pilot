import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { roomRpcHandlers } from "../../registry";
import { buildTaskBoard, conveyorState, runsConsoleRpc, runsRpc, setConveyor } from "../../runs/server";
import { stackRpc } from "../../native-install/server";
import { workspaceProviderRpc } from "../../native-agent/server";
import { chatAgentRpc } from "./rpc-chat-agent";
import { builtinWorkflows, workflowExportRpc, workflowsRpc, workflowOpsRpc, createWorkflowArchitect, architectStartRpc, resolveWorkflowLoader } from "../../workflow/server";
import { WORKFLOW_TRIGGERS_PAUSED_KEY, isTriggersPaused } from "../../workflow";
import { projectPlace, schedulesRpc } from "../../schedule/server";
import { taskOf } from "../../schedule";
import { memoryProbeRpc } from "./rpc-memory-probe";
import { deferralRpc } from "../../deferral/server";
import { rollbackRpc } from "../../rollback/server";
import { collectOwnerWaiting } from "../../owner-waiting";
import { brakesRpc, createManualModeService, manualModeRpc, ownerWaitingRpc, type BrakesDeps } from "../../owner-waiting/server";
import { SPECIALIST_PAUSED_ALL_KEY } from "../../specialist";
import { specialistOverview } from "../../specialist/server";
import { countQueuedAttempts, loadProjectSettings, saveProjectSetting } from "../../storage";
import { deskRpc } from "../../reports/server";
import { errandsRpc } from "../../errands/server";
import { stageReturnRpc } from "../../stage-return/server";
import { workGraphRpc } from "../../work-graph/server";
import { cardsRpc, projectScopeOf, sessionMemoryRpc } from "../../memory/server";
import { createProjectGit, getBootstrapRecord } from "../../project-git/server";
import { repoTrustRpc } from "../../repo-trust/server";
import type { PluginRpcHandlers } from "@get-bb/plugin-sdk";
import type { Services } from "../../services";

import { handleDirectoryMove } from "../../native-agent/server";
import type { rpcContract } from "./plugin-contracts";
import type { ServerCore } from "../../contracts/server";

import { recordTaskWord, waitingAttemptId } from "../../tasks/server";

import { LP_EVENTS, taskFamily } from "@lane-pilot/contracts";
import { insertInboxEvent } from "@lane-pilot/workflow-engine";

import { budgetSpentSweep } from "../../writer/server";
import { OWNER_ITEM_SWEEPS } from "../../lead/server";

import { tokenCursorRow } from "../../usage/server";

import { postEvent, uiVersion } from "../../relay/server";

import { timeRpcHandlers } from "./rpc-timing";

import { invalidateRpcTags } from "../../platform/server";

/** The sweeps «waiting for the owner» collects over: shared by the RPC read and the five-minute bell (SMA m_ws_notify). */
export const ownerItemSweeps = (services: Services) => [...OWNER_ITEM_SWEEPS, budgetSpentSweep(services)];

function specialistScheduleIdentity(row: { id: string; project_id: string; kind: string; task_json: string }): string | null {
  if (row.kind === "agent") {
    try {
      const task = taskOf(row as never);
      if (task.kind === "agent") return `${row.project_id}:agent:${task.agentId}`;
    } catch { /* fall back to schedule id */ }
    return `${row.project_id}:schedule:${row.id}`;
  }
  if (row.kind === "workflow") {
    try {
      const task = taskOf(row as never);
      if (task.kind === "workflow" && (task.workflowId === "agent-routine" || task.workflowId === "sp-specialist-tick")) {
        const domain = typeof task.inputs?.domain === "string" && task.inputs.domain.trim() ? task.inputs.domain.trim() : null;
        return domain ? `${row.project_id}:wf:${task.workflowId}:${domain}` : `${row.project_id}:schedule:${row.id}`;
      }
    } catch { /* ignore malformed task_json */ }
  }
  return null;
}

export function buildBrakesDeps(ctx: ServerCore, services: Partial<Services>, haltRun: (runId: string) => Promise<{ ok: boolean }>): BrakesDeps {
  const kv = ctx.bb.storage?.kv as { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<void> } | undefined;
  const schedules = services.schedules;
  return {
    schedules: schedules?.pause
      ? {
          getState: async () => {
            const state = await schedules.pause.load();
            return { paused: state.paused, since: state.at, reason: state.reason };
          },
          setState: async (paused, reason) => {
            await schedules.pause.set(paused, reason);
            const state = schedules.pause.state();
            return { paused: state.paused, since: state.at, reason: state.reason };
          },
          activeCount: () => schedules.store.list({ states: ["active"] }).length,
        }
      : null,
    conveyor: kv
      ? {
          getState: () => conveyorState(kv),
          setState: (on, reason) => setConveyor(kv, on, reason),
          queuedCount: () => countQueuedAttempts(ctx.db),
        }
      : null,
    graphs: kv
      ? {
          getState: async () => {
            const settingVal = loadProjectSettings(ctx.db, GLOBAL_SETTINGS_PROJECT_ID)[WORKFLOW_TRIGGERS_PAUSED_KEY];
            if (!isTriggersPaused(settingVal)) return { paused: false, since: null, reason: null };
            const meta = (await kv.get(WORKFLOW_TRIGGERS_PAUSED_KEY).catch(() => null)) as {
              paused?: unknown;
              since?: unknown;
              reason?: unknown;
            } | null;
            return {
              paused: true,
              since: meta?.paused === true && typeof meta.since === "number" ? meta.since : null,
              reason: meta?.paused === true && typeof meta.reason === "string" ? meta.reason : null,
            };
          },
          setState: async (paused, reason) => {
            const cleanReason = reason?.trim().slice(0, 300) || null;
            const existing = (await kv.get(WORKFLOW_TRIGGERS_PAUSED_KEY).catch(() => null)) as {
              paused?: unknown;
              since?: unknown;
            } | null;
            const since = paused ? (existing?.paused === true && typeof existing.since === "number" ? existing.since : Date.now()) : null;
            saveProjectSetting(ctx.db, GLOBAL_SETTINGS_PROJECT_ID, WORKFLOW_TRIGGERS_PAUSED_KEY, paused);
            await kv.set(WORKFLOW_TRIGGERS_PAUSED_KEY, paused ? { paused: true, since, reason: cleanReason } : null);
            return { paused, since, reason: paused ? cleanReason : null };
          },
          triggeredCount: () => {
            const workflows = services.workflowCatalog?.peek()?.list().map((item) => item.workflow) ?? builtinWorkflows();
            return workflows.filter((wf) => wf.status === "published" && wf.triggers.some((t) => t.type === "event" || t.type === "schedule")).length;
          },
        }
      : null,
    staff: kv
      ? {
          getState: async () => {
            const stored = await kv.get(SPECIALIST_PAUSED_ALL_KEY);
            if (stored === true) return { paused: true, since: null, reason: null };
            if (stored && typeof stored === "object" && (stored as { paused?: unknown }).paused === true) {
              const meta = stored as { since?: unknown; reason?: unknown };
              return {
                paused: true,
                since: typeof meta.since === "number" ? meta.since : null,
                reason: typeof meta.reason === "string" ? meta.reason : null,
              };
            }
            return { paused: false, since: null, reason: null };
          },
          setState: async (paused, reason) => {
            const cleanReason = reason?.trim().slice(0, 300) || null;
            const prev = (await kv.get(SPECIALIST_PAUSED_ALL_KEY).catch(() => null)) as {
              paused?: unknown;
              since?: unknown;
              pausedScheduleIds?: unknown;
            } | null;
            if (paused) {
              const newlyPaused: string[] = [];
              if (services.schedules) {
                for (const row of services.schedules.store.list({ states: ["active"] })) {
                  if (specialistScheduleIdentity(row) !== null) {
                    services.schedules.setPaused(row.id, true, cleanReason ?? "paused by staff brake");
                    newlyPaused.push(row.id);
                  }
                }
              }
              const prevIds = Array.isArray(prev?.pausedScheduleIds) ? prev.pausedScheduleIds.filter((x): x is string => typeof x === "string") : [];
              const pausedScheduleIds = [...new Set([...prevIds, ...newlyPaused])];
              const since = prev?.paused === true && typeof prev.since === "number" ? prev.since : Date.now();
              await kv.set(SPECIALIST_PAUSED_ALL_KEY, { paused: true, since, reason: cleanReason, pausedScheduleIds });
              return { paused: true, since, reason: cleanReason };
            }
            const toResume = Array.isArray(prev?.pausedScheduleIds) ? prev.pausedScheduleIds.filter((x): x is string => typeof x === "string") : [];
            if (services.schedules) {
              for (const scheduleId of toResume) {
                services.schedules.setPaused(scheduleId, false);
              }
            }
            await kv.set(SPECIALIST_PAUSED_ALL_KEY, null);
            return { paused: false, since: null, reason: null };
          },
          activeSpecialistCount: () => {
            if (!services.schedules) return 0;
            const rows = services.schedules.store.list({ states: ["active"] });
            return new Set(rows.map(specialistScheduleIdentity).filter((id): id is string => id !== null)).size;
          },
        }
      : null,
    listActiveRunIds: () => {
      const items = buildTaskBoard(ctx.db, { projectId: null, doneSince: Date.now() + 1 });
      const runIds = new Set<string>();
      for (const item of items) {
        if ((item.kind === "task" || item.kind === "workflow") && item.column !== "done" && item.column !== "blocked" && item.runId) {
          runIds.add(item.runId);
        }
      }
      return [...runIds];
    },
    haltRun,
  };
}

type RpcHandlers = PluginRpcHandlers<typeof rpcContract>;

export function registerRpc(ctx: ServerCore, services: Services, contract: typeof rpcContract) {
  const ownerSweeps = ownerItemSweeps(services);
  const scopeGit = createProjectGit({
    host: ctx.host,
    kv: ctx.bb.storage.kv,
    ownerAsk: ctx.ownerAsk,
    log: ctx.log,
    activeLiveRun: async () => null,
  });
  const runsHandlers = runsRpc(ctx, services);
  // Every call is timed (rpc-timing.ts). No caller check: every machine and every caller is the owner's (owner decision 2026-10-08).
  const own = {
    experimental_vk_directory_move: (input) => handleDirectoryMove({ bb: ctx.bb, db: ctx.db, loadParked: services.stability.loadParked }, input),
    ...runsHandlers,
    ...runsConsoleRpc(ctx, {
      money: services.money,
      specialistOverview,
      collectOwnerWaiting: (db, now) => collectOwnerWaiting(db, now, ownerSweeps),
      projectPlace: (projectId) => projectPlace(ctx, services, projectId),
      memoryProject: async (hostId, path) => {
        const found = await projectScopeOf(ctx, services, { hostId, path });
        if (!found.projectId) return null;
        const lastScope = found.scopes.at(-1);
        const sectionId = lastScope?.startsWith("section:") ? lastScope.slice("section:".length) : lastScope;
        return { projectId: found.projectId, ...(sectionId ? { sectionId } : {}) };
      },
      probeRepo: async (hostId, path) => {
        const found = await scopeGit.probe(hostId, path);
        if (found.state === "noGit") return null;
        if (found.state === "unknown" || !found.root) {
          throw new Error(found.reason ?? "git probe failed");
        }
        const rec = await getBootstrapRecord(ctx.bb.storage.kv, hostId, found.root).catch(() => null);
        return {
          root: found.root,
          remote: found.state === "origin" ? (found.origin ?? null) : null,
          githubRepoId: rec?.repo?.id !== undefined && rec?.repo?.id !== null ? String(rec.repo.id) : null,
        };
      },
    }),
    ...stackRpc(ctx),
    ...workspaceProviderRpc(ctx),
    ...chatAgentRpc(ctx),
    ...workflowsRpc(ctx, services),
    ...workflowExportRpc(ctx, services),
    ...workflowOpsRpc(ctx, services),
    ...schedulesRpc(ctx, services),
    ...memoryProbeRpc(services),
    ...deferralRpc(services.deferrals),
    ...rollbackRpc(services.rollback),
    ...ownerWaitingRpc(ctx.db, ownerSweeps, (message) => ctx.log(message), postEvent,
      () => invalidateRpcTags(ctx.bb, ["owner_waiting"]), (message) => ctx.bb.log.debug(message)),
    ...brakesRpc(ctx, buildBrakesDeps(ctx, services, (runId) => runsHandlers.halt_run({ runId }))),
    ...manualModeRpc(createManualModeService({
      manualMode: ctx.manualMode,
      brakes: { ...buildBrakesDeps(ctx, services, (runId) => runsHandlers.halt_run({ runId })), log: { info: (message) => ctx.bb.log.info(message), warn: (message) => ctx.log(message) } },
      resumeWork: () => services.resumeWork?.() ?? Promise.resolve(),
    })),
    ...errandsRpc(ctx, services),
    ...deskRpc(ctx, {
      answerDeps: {
        ...(services.workflowEngine ? { architect: createWorkflowArchitect(ctx, services) } : {}),
        loadWorkflow: resolveWorkflowLoader(services),
        ...(services.evolvePublishDraft ? { evolveDeps: { publishDraft: services.evolvePublishDraft } } : {}),
      },
    }),
    ...stageReturnRpc(services.stageReturn),
    ...workGraphRpc(ctx, { tokenCursorRow }),
    task_word: async ({ runId, taskId, decision, text }: { runId: string; taskId: string; decision: "yes" | "no"; text: string }) => {
      const family = taskFamily(taskId);
      // The first press claims the decision (SMA tr_approving): the second presser loses.
      const waiting = waitingAttemptId(ctx.db, runId, family) ?? null;
      const claim = services.taskWords.decide(ctx.db, runId, family, decision, "screen", Date.now(), waiting);
      if (!claim.ok) return { ok: false as const, reason: claim.reason };
      await recordTaskWord(ctx.bb.storage.kv as never, runId, family, decision, text, Date.now(), waiting);
      services.taskWords.answer(ctx.db, runId, family, decision, text, "screen");
      if (waiting) {
        const payload = { kind: "owner_word", decision, text, runId, taskId, attemptId: waiting };
        try { insertInboxEvent(ctx.db, { id: `evt_word_${Date.now()}`, name: LP_EVENTS.WRITER_ANSWERED, key: waiting, payload, createdAt: Date.now() }); } catch { /* ignore */ }
        await services.workflowEngine?.wake(LP_EVENTS.WRITER_ANSWERED, waiting, payload).catch(() => undefined);
      }
      return { ok: true as const };
    },
    ui_version: async () => ({ version: uiVersion() }),
    money_status: async () => services.money.status(),
    conveyor: async ({ set, reason }: { set?: "on" | "off"; reason?: string }) => set ? await setConveyor(ctx.bb.storage.kv as never, set === "on", reason) : await conveyorState(ctx.bb.storage.kv as never),
    ...sessionMemoryRpc(ctx, services),
    ...cardsRpc(ctx),
    ...repoTrustRpc(ctx, {
      projectPlace: (projectId) => projectPlace(ctx, services, projectId),
      probe: scopeGit.probe,
    }),
    ...createWorkflowArchitect(ctx, services).rpc,
    ...architectStartRpc(ctx, services),
  } satisfies Partial<RpcHandlers>;
  const handlers = { ...own, ...roomRpcHandlers(ctx, services) } as Record<string, unknown> as RpcHandlers;
  // The contract type no longer proves every key has a handler once rooms add theirs, so the start does.
  const missing = Object.keys(contract).filter((key) => !(key in handlers));
  if (missing.length) throw new Error(`rpc keys without a handler: ${missing.join(", ")}`);
  ctx.bb.rpc.register(contract, timeRpcHandlers(handlers, (message) => ctx.bb.log.debug(message)));
}
