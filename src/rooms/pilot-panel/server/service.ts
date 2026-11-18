import { createHash } from "node:crypto";
import { isNotFound, orMiss, stringAt, valueAt } from "@lane-pilot/kit";
import { detectRequiredSessionPolicyCapability, type ActivationApi } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { conveyorState } from "../../runs";
import { readTaskCard } from "../../runs/server";
import {
  activeRunForProject,
  getActivation,
  getRun,
  listOpenAttempts,
  listTasksForRun,
  loadPrototypeConfig,
  openRunOfPmThread,
} from "../../storage";
import {
  PILOT_SKILLS_DIR_REL_PATH,
  buildPilotActionPrompt,
  buildPilotPanelActions,
  mapPilotTaskColumn,
  pilotReadinessSteps,
  type PilotChildThread,
  type PilotDelegationChoice,
  type PilotDelegationView,
  type PilotPanelSnapshot,
} from "../index";
import {
  currentPluginVersion,
  inspectProjectPilotWorkspace,
  materializeProjectPilotSetup,
} from "./project-skills";

type DeliveryRecord = { requestId: string; actionId: string; at: number };

interface ResolvedThreadPlace {
  threadId: string;
  threadState: string;
  pendingQuestions: number | null;
  pluginRole: string | null;
  projectId: string | null;
  projectName: string | null;
  environmentId: string | null;
  hostId: string | null;
  rootPath: string | null;
}

const skipStorageKey = (hostId: string, rootPath: string) => `pilot-readiness-skip:${hostId}:${rootPath}`;
const selectionStorageKey = (threadId: string) => `pilot-panel-plan:${threadId}`;
const deliveriesStorageKey = (threadId: string) => `pilot-panel-deliveries:${threadId}`;

export function createPilotPanelService(
  ctx: ServerCore,
  deps: { activate?: ActivationApi["activate"] } = {},
) {
  const { bb, db } = ctx;

  async function resolvePlace(threadId: string): Promise<ResolvedThreadPlace> {
    const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound);
    const meta = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound);
    const pluginRole = typeof valueAt(meta, "role") === "string" ? (valueAt(meta, "role") as string) : null;
    const projectId = stringAt(thread, "projectId") ?? null;
    const environmentId = stringAt(thread, "environmentId") ?? null;
    const runtimeObj = valueAt(thread, "runtime") as { displayStatus?: unknown } | undefined;
    const threadState =
      (typeof runtimeObj?.displayStatus === "string" ? runtimeObj.displayStatus : null) ??
      stringAt(thread, "status") ??
      "idle";

    let pendingQuestions: number | null = null;
    try {
      if (typeof bb.sdk.threads.interactions?.list === "function") {
        const list = await bb.sdk.threads.interactions.list({ threadId });
        pendingQuestions = Array.isArray(list) ? list.length : 0;
      }
    } catch {
      pendingQuestions = null;
    }

    let projectName: string | null = null;
    let hostId: string | null = null;
    let rootPath: string | null;
    rootPath = null;

    if (environmentId && typeof bb.sdk.environments?.get === "function") {
      const env = await orMiss(bb.sdk.environments.get({ environmentId }), null, isNotFound);
      hostId = stringAt(env, "hostId") ?? null;
      rootPath = stringAt(env, "path") ?? null;
    }
    if (projectId && typeof bb.sdk.projects?.get === "function") {
      const proj = (await orMiss(bb.sdk.projects.get({ projectId }), null, isNotFound)) as {
        name?: unknown;
        sources?: Array<{ hostId?: string; path?: string; isDefault?: boolean }>;
      } | null;
      if (typeof proj?.name === "string") projectName = proj.name;
      if ((!hostId || !rootPath) && Array.isArray(proj?.sources) && proj.sources.length > 0) {
        const pick = proj.sources.find((s) => s.isDefault && s.hostId && s.path) ?? proj.sources.find((s) => s.hostId && s.path);
        if (pick?.hostId && pick?.path) {
          hostId = pick.hostId;
          rootPath = pick.path;
        }
      }
    }
    return {
      threadId,
      threadState: pendingQuestions && pendingQuestions > 0 ? "awaiting_input" : threadState,
      pendingQuestions,
      pluginRole,
      projectId,
      projectName,
      environmentId,
      hostId,
      rootPath,
    };
  }

  async function collectDelegationView(
    place: ResolvedThreadPlace,
    choice: PilotDelegationChoice,
    configured: boolean,
    error: string | null,
    activeRunId: string | null,
  ): Promise<PilotDelegationView> {
    const cleanCap = detectRequiredSessionPolicyCapability(
      (bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {},
    );
    const [providersRaw, childrenRaw] = await Promise.all([
      place.environmentId && typeof bb.sdk.providers?.list === "function"
        ? bb.sdk.providers.list({ environmentId: place.environmentId }).catch(() => [])
        : place.hostId && typeof bb.sdk.providers?.list === "function"
          ? bb.sdk.providers.list({ hostId: place.hostId } as never).catch(() => [])
          : Promise.resolve([]),
      typeof bb.sdk.threads.list === "function"
        ? bb.sdk.threads.list({ parentThreadId: place.threadId, limit: 20 }).catch(() => [])
        : Promise.resolve([]),
    ]);

    const providers = (Array.isArray(providersRaw) ? providersRaw : [])
      .filter((p) => (p as { available?: unknown }).available !== false && typeof (p as { id?: unknown }).id === "string")
      .map((p) => ({
        id: String((p as { id: unknown }).id),
        name: String((p as { displayName?: unknown; id: unknown }).displayName ?? (p as { id: unknown }).id),
      }));

    const seenIds = new Set<string>();
    const children: PilotChildThread[] = [];
    for (const row of Array.isArray(childrenRaw) ? childrenRaw : []) {
      const cid = stringAt(row, "id");
      if (!cid || seenIds.has(cid)) continue;
      seenIds.add(cid);
      const meta = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: cid }), null, isNotFound);
      const cRole = typeof valueAt(meta, "role") === "string" ? (valueAt(meta, "role") as string) : null;
      const isPmChild = cRole === "pm" || cRole === "bench-pm";
      children.push({
        id: cid,
        title: stringAt(row, "title") ?? "Субтред без названия",
        status: stringAt(row, "status") ?? "idle",
        role: cRole ?? "subthread",
        providerId: stringAt(row, "providerId") ?? null,
        cleanSession: isPmChild ? false : cRole ? cleanCap : true,
      });
    }

    if (activeRunId) {
      const openForRun = listOpenAttempts(db).filter((att) => att.run_id === activeRunId).slice(0, 12);
      for (const att of openForRun) {
        if (!att.thread_id || seenIds.has(att.thread_id)) continue;
        seenIds.add(att.thread_id);
        children.push({
          id: att.thread_id,
          title: `Дорожка ${att.task_id}`,
          status: att.state === "running" ? "active" : att.state,
          role: "writer",
          providerId: null,
          cleanSession: cleanCap,
        });
      }
    }

    return { choice, configured, error, providers, children };
  }

  async function status(input: { threadId: string; targetPlan?: string; force?: boolean }): Promise<PilotPanelSnapshot> {
    const place = await resolvePlace(input.threadId);
    const diagnostics: string[] = [];
    const cleanCap = detectRequiredSessionPolicyCapability(
      (bb as { agents?: { experimental_vkRequiredSessionPolicy?: unknown } }).agents ?? {},
    );

    const pmRun = openRunOfPmThread(db, place.threadId);
    const projActivation = place.projectId ? getActivation(db, place.projectId) : undefined;
    const projOpenRun = place.projectId ? activeRunForProject(db, place.projectId) : undefined;
    const candidateRunId = pmRun?.id ?? projActivation?.run_id ?? projOpenRun?.id ?? null;
    const activeRunRow = candidateRunId ? getRun(db, candidateRunId) : undefined;

    const conveyor = await conveyorState(bb.storage.kv as never).catch(() => ({ on: true }));
    const activeRun = activeRunRow
      ? {
          runId: activeRunRow.id,
          pmThreadId: activeRunRow.pm_thread_id ?? null,
          state: activeRunRow.state,
          conveyorOn: Boolean((conveyor as { on?: unknown }).on ?? true),
        }
      : null;

    const runItems: PilotPanelSnapshot["session"]["runItems"] = [];
    if (activeRunRow) {
      for (const taskRow of listTasksForRun(db, activeRunRow.id).slice(0, 20)) {
        const card = readTaskCard(db, { runId: activeRunRow.id, taskId: taskRow.id });
        if (!card) continue;
        const latestAttempt = card.attempts.at(-1);
        const activeStage = [...card.stages].reverse().find((s) => s.state !== "pending");
        const phase = latestAttempt?.state ?? card.state ?? "queued";
        runItems.push({
          key: `${activeRunRow.id}:${taskRow.id}`,
          runId: activeRunRow.id,
          taskId: taskRow.id,
          title: card.title || taskRow.id,
          column: mapPilotTaskColumn(phase),
          phase,
          stage: activeStage?.id ?? null,
          model: activeStage?.model ?? null,
          threadId: latestAttempt?.threadId ?? activeStage?.threadId ?? null,
          detail: latestAttempt?.reason ?? card.reason ?? null,
          kind: "task",
        });
      }
    }

    const canActivatePm = Boolean(
      place.projectId && deps.activate && place.pluginRole !== "writer" && loadPrototypeConfig(db, place.projectId),
    );
    if (!place.hostId || !place.rootPath) {
      diagnostics.push("У текущего чата ещё не выбрана рабочая папка проекта; подключите папку проекта для автоподготовки и установки скиллов.");
      const emptyDelegation = await collectDelegationView(place, { mode: "pilot-lanes" }, false, null, activeRun?.runId ?? null);
      const fingerprint = createHash("sha256").update(JSON.stringify([place.threadId, "no-workspace", activeRun?.runId ?? null])).digest("hex");
      return {
        collectedAt: new Date().toISOString(),
        fingerprint,
        pluginVersion: currentPluginVersion(),
        project: {
          id: place.projectId,
          name: place.projectName,
          hostId: place.hostId,
          rootPath: place.rootPath,
          environmentId: place.environmentId,
          gitBranch: null,
          gitDirty: null,
        },
        session: {
          threadId: place.threadId,
          threadState: place.threadState,
          pendingQuestions: place.pendingQuestions,
          role: place.pluginRole,
          cleanSubthreadsActive: cleanCap,
          serviceTierPolicy: "standard",
          activeRun,
          runItems,
        },
        readiness: [],
        projectSkills: { rootRelPath: PILOT_SKILLS_DIR_REL_PATH, total: 0, synced: 0, items: [] },
        plans: { candidates: [], selected: null },
        delegation: emptyDelegation,
        actions: buildPilotPanelActions({
          hasWorkspace: false,
          configured: false,
          skillsSynced: false,
          hasContext: false,
          hasArchitecture: false,
          selectedPlan: null,
          hasActiveRun: Boolean(activeRun),
          projectId: place.projectId,
          canActivatePm,
        }),
        diagnostics,
      };
    }

    const inspected = await inspectProjectPilotWorkspace(ctx, { hostId: place.hostId, rootPath: place.rootPath });
    if (inspected.configError) diagnostics.push(inspected.configError);

    const skipped = (await bb.storage.kv.get<string[]>(skipStorageKey(place.hostId, place.rootPath))) ?? [];
    const missingOrOutdated = inspected.skillStates.filter((s) => s.state !== "synced").map((s) => s.name);
    const skillsSynced = inspected.skillStates.length > 0 && missingOrOutdated.length === 0;
    const readiness = pilotReadinessSteps(
      {
        configured: inspected.configured,
        skillsSynced,
        missingOrOutdatedSkills: missingOrOutdated,
        hasDescription: inspected.hasDescription,
        hasRulesBase: inspected.hasRulesBase,
        hasAgentsMd: inspected.hasAgentsMd,
        hasArchitecture: inspected.hasArchitecture,
        files: inspected.files,
      },
      skipped,
    );

    const savedPlan = await bb.storage.kv.get<string>(selectionStorageKey(place.threadId));
    const desiredPlanPath = input.targetPlan !== undefined ? input.targetPlan : savedPlan ?? "";
    if (input.targetPlan !== undefined) {
      await bb.storage.kv.set(selectionStorageKey(place.threadId), input.targetPlan);
    }
    const selectedPlan =
      inspected.plans.find((p) => p.path === desiredPlanPath) ??
      (desiredPlanPath === "" && inspected.plans.length === 1 ? inspected.plans[0]! : null);

    const candidates = inspected.plans.map((p) => ({
      path: p.path,
      title: p.title,
      done: p.tasks.filter((t) => t.state === "done").length,
      total: p.tasks.length,
    }));

    const delegation = await collectDelegationView(
      place,
      inspected.delegation,
      inspected.configured,
      inspected.configError,
      activeRun?.runId ?? null,
    );

    const syncedCount = inspected.skillStates.filter((s) => s.state === "synced").length;
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          place.hostId,
          place.rootPath,
          inspected.configured,
          syncedCount,
          inspected.delegation,
          readiness.map((r) => [r.id, r.state]),
          selectedPlan?.path ?? "",
          selectedPlan?.tasks.map((t) => t.state) ?? [],
          activeRun?.runId ?? "",
        ]),
      )
      .digest("hex");

    return {
      collectedAt: new Date().toISOString(),
      fingerprint,
      pluginVersion: currentPluginVersion(),
      project: {
        id: place.projectId,
        name: place.projectName,
        hostId: place.hostId,
        rootPath: place.rootPath,
        environmentId: place.environmentId,
        gitBranch: inspected.gitBranch,
        gitDirty: inspected.gitDirty,
      },
      session: {
        threadId: place.threadId,
        threadState: place.threadState,
        pendingQuestions: place.pendingQuestions,
        role: place.pluginRole,
        cleanSubthreadsActive: cleanCap,
        serviceTierPolicy: "standard",
        activeRun,
        runItems,
      },
      readiness,
      projectSkills: {
        rootRelPath: PILOT_SKILLS_DIR_REL_PATH,
        total: inspected.skillStates.length,
        synced: syncedCount,
        items: inspected.skillStates,
      },
      plans: {
        candidates,
        selected: selectedPlan,
      },
      delegation,
      actions: buildPilotPanelActions({
        hasWorkspace: true,
        configured: inspected.configured,
        skillsSynced,
        hasContext: inspected.hasDescription && inspected.hasRulesBase && inspected.hasAgentsMd,
        hasArchitecture: inspected.hasArchitecture,
        selectedPlan,
        hasActiveRun: Boolean(activeRun),
        projectId: place.projectId,
        canActivatePm,
      }),
      diagnostics,
    };
  }

  async function prepareProject(threadId: string) {
    const place = await resolvePlace(threadId);
    if (!place.hostId || !place.rootPath) {
      throw new Error("Не найдена рабочая папка проекта для текущего чата.");
    }
    const result = await materializeProjectPilotSetup(ctx, {
      hostId: place.hostId,
      rootPath: place.rootPath,
      projectName: place.projectName,
    });
    if (place.projectId) ctx.realtime?.notify(place.projectId, "helpers");
    const snapshot = await status({ threadId, force: true });
    return { ok: true as const, ...result, snapshot };
  }

  async function setDelegation(threadId: string, choice: PilotDelegationChoice): Promise<PilotDelegationView> {
    const place = await resolvePlace(threadId);
    if (!place.hostId || !place.rootPath) {
      throw new Error("Не найдена рабочая папка проекта для сохранения настроек делегирования.");
    }
    await materializeProjectPilotSetup(ctx, {
      hostId: place.hostId,
      rootPath: place.rootPath,
      projectName: place.projectName,
      delegationOverride: choice,
    });
    const next = await status({ threadId, force: true });
    return next.delegation;
  }

  async function setReadinessSkip(threadId: string, stepId: "quality" | "ci", skipped: boolean) {
    const place = await resolvePlace(threadId);
    if (!place.hostId || !place.rootPath) {
      throw new Error("Не найдена рабочая папка проекта.");
    }
    const key = skipStorageKey(place.hostId, place.rootPath);
    const list = (await bb.storage.kv.get<string[]>(key)) ?? [];
    const next = skipped ? [...new Set([...list, stepId])] : list.filter((id) => id !== stepId);
    await bb.storage.kv.set(key, next);
    return { ok: true as const };
  }

  async function runAction(input: {
    threadId: string;
    actionId: string;
    targetPlan?: string;
    fingerprint: string;
    requestId: string;
  }) {
    const delivKey = deliveriesStorageKey(input.threadId);
    const runLocked = ctx.serializedKv ?? (<T>(fn: () => Promise<T>) => fn());
    return runLocked(async () => {
      const history = (await bb.storage.kv.get<DeliveryRecord[]>(delivKey)) ?? [];
      if (history.some((d) => d.requestId === input.requestId)) {
        return { sent: false, message: "Действие уже выполнено." };
      }
      const current = await status({ threadId: input.threadId, targetPlan: input.targetPlan, force: true });
      if (current.fingerprint !== input.fingerprint && input.actionId !== "prepare-project") {
        return { sent: false, stale: true, message: "Состояние проекта обновилось. Проверьте панель и нажмите ещё раз." };
      }
      if (input.actionId === "prepare-project") {
        const prepared = await prepareProject(input.threadId);
        const count = prepared.installedSkills.length + prepared.updatedSkills.length;
        return {
          sent: true,
          message: count > 0
            ? `Проект подготовлен: синхронизировано скиллов в .bb/skills/ — ${count}.`
            : "Конфигурация .agents/pilot/ и скиллы в .bb/skills/ уже актуальны.",
        };
      }
      if (input.actionId === "activate-pilot") {
        if (!current.project.id || !deps.activate) {
          throw new Error("Активация PM недоступна: проект чата не определён.");
        }
        const activated = await deps.activate(current.project.id, input.threadId, "bb");
        await bb.storage.kv.set(delivKey, [...history.slice(-20), { requestId: input.requestId, actionId: input.actionId, at: Date.now() }]);
        return {
          sent: true,
          threadId: activated.threadId,
          runId: activated.runId,
          message: `Открыт PM-чат Lane Pilot (${activated.runId}).`,
        };
      }
      if (!["idle", "error", "stopped", "completed", "archived"].includes(current.session.threadState)) {
        throw new Error("Дождитесь завершения текущего ответа агента перед отправкой следующего шага.");
      }
      const prompt = buildPilotActionPrompt(input.actionId, current);
      if (!prompt) throw new Error(`Неизвестное действие панели: ${input.actionId}`);
      await bb.sdk.threads.send({
        threadId: input.threadId,
        serviceTier: "default",
        executionInputSources: { serviceTier: "explicit" },
        input: [
          { type: "text", text: prompt.visible, mentions: [] },
          { type: "text", text: prompt.context, mentions: [], visibility: "agent-only" },
        ],
      } as never);
      await bb.storage.kv.set(delivKey, [...history.slice(-20), { requestId: input.requestId, actionId: input.actionId, at: Date.now() }]);
      return { sent: true, message: `В чат отправлена команда «${prompt.visible}».` };
    });
  }

  return { status, prepareProject, setDelegation, setReadinessSkip, runAction };
}

export type PilotPanelService = ReturnType<typeof createPilotPanelService>;
