import { createHash } from "node:crypto";
import { detectRequiredSessionPolicyCapability, type ActivationApi } from "../../contracts";
import type { ServerCore } from "../../contracts/server";
import { conveyorState } from "../../runs";
import { readTaskCard } from "../../runs/server";
import {
  activeRunForProject,
  getActivation,
  getRun,
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
  type PilotDelegationChoice,
  type PilotDelegationView,
  type PilotPanelSnapshot,
} from "../index";
import { collectDelegationView, resolveThreadPlace } from "./place";
import {
  currentPluginVersion,
  inspectProjectPilotWorkspace,
  materializeProjectPilotSetup,
} from "./project-skills";
import {
  collectPilotPanelEvolutionAndState,
  publishPanelWorkflowDraft,
  rollbackPanelWorkflowDraft,
  type PilotPanelWorkflowDeps,
} from "./workflow-drafts";

type DeliveryRecord = {
  requestId: string;
  actionId: string;
  fingerprint?: string;
  state?: "attempting" | "sent" | "queued";
  at: number;
};

const skipStorageKey = (hostId: string, rootPath: string) => `pilot-readiness-skip:${hostId}:${rootPath}`;
const selectionStorageKey = (threadId: string) => `pilot-panel-plan:${threadId}`;
const deliveriesStorageKey = (threadId: string) => `pilot-panel-deliveries:${threadId}`;

export function createPilotPanelService(
  ctx: ServerCore,
  deps: { activate?: ActivationApi["activate"] } & PilotPanelWorkflowDeps = {},
) {
  const { bb, db } = ctx;
  const resolvePlace = (threadId: string) => resolveThreadPlace(ctx, threadId);

  const notifyPanelChanged = (threadId: string, projectId?: string | null) => {
    if (projectId) ctx.realtime?.notify(projectId, "helpers");
    try {
      (bb as { realtime?: { publish?: (event: string, payload: unknown) => void } }).realtime?.publish?.(
        "pilot-panel-changed",
        { threadId },
      );
    } catch {
      // Realtime notification is best-effort.
    }
  };

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
    const baseSession = {
      threadId: place.threadId, providerId: place.providerId, threadState: place.threadState, pendingQuestions: place.pendingQuestions,
      role: place.pluginRole, cleanSubthreadsActive: cleanCap, serviceTierPolicy: "standard" as const, activeRun, runItems,
    };
    const baseProject = { id: place.projectId, name: place.projectName, hostId: place.hostId, rootPath: place.rootPath, environmentId: place.environmentId };
    if (!place.hostId || !place.rootPath) {
      diagnostics.push("У текущего чата ещё не выбрана рабочая папка проекта; подключите папку проекта для автоподготовки и установки скиллов.");
      const [emptyDelegation, evo] = await Promise.all([
        collectDelegationView(ctx, place, { mode: "pilot-lanes" }, false, null, activeRun?.runId ?? null),
        collectPilotPanelEvolutionAndState(ctx, { hostId: null, rootPath: null, projectId: place.projectId }),
      ]);
      const fingerprint = createHash("sha256").update(JSON.stringify([place.threadId, "no-workspace", activeRun?.runId ?? null, evo.workflowEvolution.items.map((i) => `${i.draftId}:${i.version}:${i.status}`)])).digest("hex");
      return {
        collectedAt: new Date().toISOString(),
        fingerprint,
        pluginVersion: currentPluginVersion(),
        project: { ...baseProject, gitBranch: null, gitDirty: null },
        session: baseSession,
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
          providerId: place.providerId,
          canActivatePm,
        }),
        processState: null,
        workflowEvolution: evo.workflowEvolution,
        diagnostics,
      };
    }

    const [inspected, evo] = await Promise.all([
      inspectProjectPilotWorkspace(ctx, { hostId: place.hostId, rootPath: place.rootPath }),
      collectPilotPanelEvolutionAndState(ctx, { hostId: place.hostId, rootPath: place.rootPath, projectId: place.projectId }),
    ]);
    if (inspected.configError) diagnostics.push(inspected.configError);
    if (evo.processStateError) diagnostics.push(evo.processStateError);

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
      ctx,
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
          evo.processState?.updatedAt ?? "",
          evo.workflowEvolution.items.map((i) => `${i.draftId}:${i.version}:${i.status}:${i.canPublish}:${i.canRollback}`),
        ]),
      )
      .digest("hex");
    if (process.env.LOG_LEVEL?.trim().toLowerCase() === "debug") {
      ctx.log(`DEBUG [pilotPanel.status] fingerprint ${JSON.stringify({ threadId: place.threadId, fingerprint: fingerprint.slice(0, 12), evo: evo.workflowEvolution.items.length })}`);
    }

    return {
      collectedAt: new Date().toISOString(),
      fingerprint,
      pluginVersion: currentPluginVersion(),
      project: { ...baseProject, gitBranch: inspected.gitBranch, gitDirty: inspected.gitDirty },
      session: baseSession,
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
        providerId: place.providerId,
        canActivatePm,
      }),
      processState: evo.processState,
      workflowEvolution: evo.workflowEvolution,
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
    notifyPanelChanged(threadId, place.projectId);
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
    notifyPanelChanged(threadId, place.projectId);
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
    notifyPanelChanged(threadId, place.projectId);
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
      const existing = history.find((d) => d.requestId === input.requestId);
      if (existing) {
        return {
          sent: false,
          message:
            existing.state === "attempting"
              ? "Отправка ещё не подтверждена; проверьте ленту чата."
              : "Действие уже выполнено.",
        };
      }
      if (input.actionId === "prepare-project") {
        const prepared = await prepareProject(input.threadId);
        const count = prepared.installedSkills.length + prepared.updatedSkills.length;
        return {
          sent: true,
          message:
            count > 0
              ? `Проект подготовлен: синхронизировано скиллов в .bb/skills/ — ${count}.`
              : "Конфигурация .agents/pilot/ и скиллы в .bb/skills/ уже актуальны.",
        };
      }
      let current = await status({ threadId: input.threadId, targetPlan: input.targetPlan, force: true });
      const planBound = input.actionId === "implement" || input.actionId === "verify" || Boolean(input.targetPlan);
      if (planBound && current.fingerprint !== input.fingerprint) {
        return {
          sent: false,
          stale: true,
          message: "Состояние выбранного плана изменилось. Проверьте панель и нажмите ещё раз.",
        };
      }
      if (input.actionId === "activate-pilot") {
        if (!current.project.id || !deps.activate) {
          throw new Error("Активация PM недоступна: проект чата не определён.");
        }
        const activated = await deps.activate(current.project.id, input.threadId, "bb");
        await bb.storage.kv.set(delivKey, [
          ...history.slice(-20),
          { requestId: input.requestId, actionId: input.actionId, state: "sent", at: Date.now() },
        ]);
        notifyPanelChanged(input.threadId, current.project.id);
        return {
          sent: true,
          threadId: activated.threadId,
          runId: activated.runId,
          message: `Открыт PM-чат Lane Pilot (${activated.runId}).`,
        };
      }
      const action = current.actions.find((a) => a.id === input.actionId);
      if (!action || !action.available) {
        throw new Error(
          current.project.rootPath
            ? `Действие «${input.actionId}» сейчас недоступно для текущего состояния проекта.`
            : "Сначала выберите проект с подключённой рабочей папкой для этого чата.",
        );
      }
      if (current.session.threadState === "archived") {
        throw new Error("Текущий чат находится в архиве. Разархивируйте чат или откройте новый.");
      }
      if (current.session.pendingQuestions && current.session.pendingQuestions > 0) {
        throw new Error("Сначала ответьте на открытые вопросы текущего шага в чате.");
      }
      if (
        history.some(
          (d) =>
            d.actionId === input.actionId &&
            d.fingerprint === current.fingerprint &&
            Date.now() - d.at < 10_000,
        )
      ) {
        return { sent: false, message: "Эта команда только что отправлена в чат." };
      }

      if (
        current.project.hostId &&
        current.project.rootPath &&
        (!current.delegation.configured || current.projectSkills.synced < current.projectSkills.total)
      ) {
        await materializeProjectPilotSetup(ctx, {
          hostId: current.project.hostId,
          rootPath: current.project.rootPath,
          projectName: current.project.name,
          preserveExistingAgentsMd: true,
        });
        current = await status({ threadId: input.threadId, targetPlan: input.targetPlan, force: true });
      }

      const prompt = buildPilotActionPrompt(input.actionId, current);
      if (!prompt) throw new Error(`Неизвестное действие панели: ${input.actionId}`);

      const record: DeliveryRecord = {
        requestId: input.requestId,
        actionId: input.actionId,
        fingerprint: current.fingerprint,
        state: "attempting",
        at: Date.now(),
      };
      const pendingHistory = [...history.slice(-20), record];
      await bb.storage.kv.set(delivKey, pendingHistory);

      let sendResult: Awaited<ReturnType<typeof bb.sdk.threads.send>>;
      try {
        sendResult = await bb.sdk.threads.send({
          threadId: input.threadId,
          mode: "queue-if-active",
          input: [
            { type: "text", text: prompt.visible, mentions: [] },
            { type: "text", text: prompt.context, mentions: [], visibility: "agent-only" },
          ],
        });
      } catch (cause) {
        await bb.storage.kv.set(
          delivKey,
          pendingHistory.filter((d) => d.requestId !== input.requestId),
        );
        throw cause;
      }

      const queued = (sendResult as { delivery?: unknown } | undefined)?.delivery === "queued";
      record.state = queued ? "queued" : "sent";
      await bb.storage.kv.set(delivKey, pendingHistory);
      notifyPanelChanged(input.threadId, current.project.id);
      return {
        sent: true,
        ...(queued ? { queued: true } : {}),
        message: queued
          ? `Команда «${prompt.visible}» поставлена в очередь текущего чата.`
          : `В чат отправлена команда «${prompt.visible}».`,
      };
    });
  }

  async function runDraftOp(
    op: typeof publishPanelWorkflowDraft,
    input: { draftId: string; threadId?: string },
  ) {
    const res = await op(ctx, deps, input);
    if (res.ok && input.threadId) notifyPanelChanged(input.threadId, res.projectId);
    const snapshot = res.ok && input.threadId ? await status({ threadId: input.threadId, force: true }) : undefined;
    return { ok: res.ok, message: res.message, ...(snapshot ? { snapshot } : {}) };
  }

  return {
    status,
    prepareProject,
    setDelegation,
    setReadinessSkip,
    runAction,
    publishWorkflowDraft: (input: { draftId: string; threadId?: string }) => runDraftOp(publishPanelWorkflowDraft, input),
    rollbackWorkflowDraft: (input: { draftId: string; threadId?: string }) => runDraftOp(rollbackPanelWorkflowDraft, input),
  };
}

export type PilotPanelService = ReturnType<typeof createPilotPanelService>;
