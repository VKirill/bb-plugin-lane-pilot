import { join } from "node:path";
import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import {
  WORKFLOW_FILE_ID, casWriteSkillBundle, casWriteWorkflowFile, computeSkillBundleSha256, globalSkillsDir, globalWorkflowDir,
  loadWorkflow, loadWorkflowStore, nodeFileSource, readSkillBundle, removeWorkflowFile, restoreSkillBundleSnapshot,
  runDraftTest, testCasesOf, type WorkflowEngine,
} from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { closeOwnerItemsByPrefix, listOpenOwnerItems } from "../../owner-waiting";
import { projectFolder, type WorkflowEngineApi, type WorkflowTriggersApi } from "../../platform/server";
import {
  appendSkillEvolutionEvent, createDraftStore, HARNESS_VERSION,
  listLatestActivePublishedSkillEvolutionsForDraft, listSkillEvolutionsForDraft,
  type CasFilesLike, type SupersededWorkflowSnapshot,
} from "../../storage";
import { noteEngineWrite } from "../../verification/server";
import { BUILTIN_SOURCES, builtinWorkflow, isEvolvableDomainBuiltinId, rawBuiltinWorkflowSource } from "../../workflow";
import { createWorkflowArchitect, realDeps } from "../../workflow/server";
import {
  PILOT_PROCESS_STATE_REL_PATH, pilotProcessStateSchema, readPilotProcessStateCas, writePilotProcessStateCas,
  type PilotProcessState, type PilotWorkflowDraftItem, type PilotWorkflowEvolution, type ProcessStateIo,
} from "../index";
import { resolveThreadPlace } from "./place";
import { readRelText, writeExactCas } from "./project-skills";

export interface PilotPanelWorkflowDeps {
  docsPlaces?: (projectId: string) => Promise<Array<{ hostId: string; path: string; scopes: readonly unknown[] }>>;
  workflowCatalog?: WorkflowEngineApi["workflowCatalog"];
  workflowEngine?: WorkflowEngineApi["workflowEngine"];
  workflowTriggers?: WorkflowTriggersApi["workflowTriggers"];
  globalDir?: () => string;
  skillsDir?: () => string;
}

export function createProcessStateIo(ctx: Pick<ServerCore, "bb">, hostId: string, rootPath: string): ProcessStateIo {
  const filesApi = ctx.bb.sdk.files as unknown as CasFilesLike;
  return {
    read: (relPath) => readRelText(filesApi, hostId, rootPath, relPath),
    write: (args) => writeExactCas(filesApi, { hostId, rootPath, relPath: args.relPath, content: args.content, expectedSha256: args.expectedSha256 }),
    onEngineWrite: (rp, rel) => noteEngineWrite(rp, rel),
    redact: redactKnown,
  };
}

function titleOf(raw: unknown, fallback: string): string {
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  if (raw && typeof raw === "object") {
    const rec = raw as { ru?: unknown; en?: unknown };
    if (typeof rec.ru === "string" && rec.ru.trim()) return rec.ru.trim();
    if (typeof rec.en === "string" && rec.en.trim()) return rec.en.trim();
  }
  return fallback;
}

export async function collectPilotPanelEvolutionAndState(
  ctx: Pick<ServerCore, "bb" | "db" | "log">,
  place: { hostId: string | null; rootPath: string | null; projectId: string | null },
): Promise<{ processState: PilotProcessState | null; processStateError: string | null; workflowEvolution: PilotWorkflowEvolution }> {
  const stateRes =
    place.hostId && place.rootPath
      ? await readPilotProcessStateCas(createProcessStateIo(ctx, place.hostId, place.rootPath), { hostId: place.hostId, rootPath: place.rootPath, log: ctx.log })
      : { state: null, sha256: null };
  const drafts = createDraftStore(ctx.db);
  const byId = new Map<string, ReturnType<typeof drafts.listEvolutionDrafts>[number]>();
  for (const row of [
    ...drafts.listEvolutionDrafts({ scope: "global", limit: 15 }),
    ...(place.projectId ? drafts.listEvolutionDrafts({ scope: "project", projectId: place.projectId, limit: 15 }) : []),
  ]) {
    if (!byId.has(row.id) && (row.status === "tested" || row.status === "published" || row.publishedVersion !== null)) byId.set(row.id, row);
  }
  const openItems = listOpenOwnerItems(ctx.db, {});
  const items: PilotWorkflowDraftItem[] = [...byId.values()]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10)
    .map((draft) => {
      const ownerItem = openItems.find(
        (item) => item.key.startsWith(`workflow-draft:${draft.id}:`) || item.key.startsWith(`workflow-evolved:${draft.id}:`),
      );
      const testedGreen = Boolean(draft.tests?.green && draft.tests.version === draft.version);
      return {
        draftId: draft.id,
        workflowId: draft.workflowId,
        title: titleOf(draft.definition.name, draft.workflowId),
        scope: draft.scope,
        status: draft.status,
        version: draft.version,
        publishedVersion: draft.publishedVersion,
        testedGreen,
        canPublish: draft.status === "tested" && testedGreen,
        canRollback: draft.publishedVersion !== null && drafts.previousVersionSnapshot(draft.id) !== null,
        summary: ownerItem?.what ?? drafts.history(draft.id, 1)[0]?.summary ?? titleOf(draft.definition.description, draft.workflowId),
        ownerItemKey: ownerItem?.key ?? null,
        updatedAt: draft.updatedAt,
      };
    });
  return {
    processState: stateRes.state,
    processStateError: stateRes.error ?? null,
    workflowEvolution: {
      items,
      autoPublishedCount: items.filter((item) => item.status === "published").length,
      pendingApprovalCount: items.filter((item) => item.canPublish).length,
    },
  };
}

async function retireSupersededLocal(
  workflowDir: string,
  supersededIds: readonly string[],
  protectedId: string,
): Promise<SupersededWorkflowSnapshot[]> {
  const snapshots: SupersededWorkflowSnapshot[] = [];
  for (const raw of new Set(supersededIds)) {
    const oldId = raw.trim();
    if (!oldId || !WORKFLOW_FILE_ID.test(oldId) || oldId === protectedId || builtinWorkflow(oldId)) continue;
    const path = join(workflowDir, `${oldId}.json`);
    try {
      const content = await nodeFileSource.read(path);
      await removeWorkflowFile(workflowDir, oldId);
      snapshots.push({ workflowId: oldId, path, content, sha256: sha256Hex(content) });
    } catch { /* Not present on disk. */ }
  }
  return snapshots;
}

async function publishDraftWithCleanup(
  ctx: ServerCore,
  deps: PilotPanelWorkflowDeps,
  opts: { draftId: string; projectId: string; workflowId: string; fallbackVersion: number; threadId?: string; closePrefix: string; eventName: "published" | "rolledBack" },
): Promise<{ ok: true; projectId: string; version: number } | { ok: false; reason: string }> {
  const docsPlaces = deps.docsPlaces ?? (async (projectId: string) => {
    const folder = await projectFolder(ctx.bb, projectId).catch(() => null);
    return folder ? [{ hostId: folder.hostId, path: folder.path, scopes: [] }] : [];
  });
  const architectServices = {
    workflowEngine: deps.workflowEngine ?? ({ hasExecutor: () => false } as never),
    ...(deps.workflowCatalog ? { workflowCatalog: deps.workflowCatalog } : {}),
    ...(deps.workflowTriggers ? { workflowTriggers: deps.workflowTriggers } : {}),
    docsPlaces,
  };
  const architect = createWorkflowArchitect(
    ctx,
    architectServices as never,
    deps.globalDir ? { ...realDeps(ctx, architectServices as never), globalDir: deps.globalDir } : undefined,
  );
  const pub = await architect.publish({ projectId: opts.projectId, ...(opts.threadId ? { threadId: opts.threadId } : {}), draftId: opts.draftId });
  if (!pub.published) {
    const reason = String((pub as { reason?: unknown }).reason ?? "publish_refused");
    ctx.log(`WARN [pilotPanel.workflowDrafts] ${opts.eventName === "published" ? "publish_refused" : "rollback_publish_failed"} ${redactKnown(JSON.stringify({ draftId: opts.draftId, workflowId: opts.workflowId, reason }))}`);
    return { ok: false, reason };
  }
  closeOwnerItemsByPrefix(ctx.db, opts.closePrefix, "owner:pilot-panel");
  ctx.realtime?.notify(opts.projectId, "workflow-draft", opts.threadId, opts.draftId);
  const version = Number((pub as { workflowVersion?: unknown }).workflowVersion ?? opts.fallbackVersion);
  ctx.log(`INFO [pilotPanel.workflowDrafts] ${opts.eventName} ${redactKnown(JSON.stringify({ draftId: opts.draftId, workflowId: opts.workflowId, version }))}`);
  return { ok: true, projectId: opts.projectId, version };
}

export async function publishPanelWorkflowDraft(
  ctx: ServerCore,
  deps: PilotPanelWorkflowDeps,
  input: { draftId: string; threadId?: string },
): Promise<{ ok: boolean; projectId?: string; message: string }> {
  const draft = createDraftStore(ctx.db).get(input.draftId);
  if (!draft) return { ok: false, message: `Черновик ${input.draftId} не найден.` };
  const res = await publishDraftWithCleanup(ctx, deps, {
    draftId: draft.id, projectId: draft.projectId, workflowId: draft.workflowId, fallbackVersion: draft.version,
    threadId: input.threadId, closePrefix: `workflow-draft:${draft.id}:`, eventName: "published",
  });
  if (!res.ok) return { ok: false, message: `Публикация отклонена: ${res.reason}` };

  const skillsRoot = (deps.skillsDir ?? globalSkillsDir)(), globalDir = (deps.globalDir ?? globalWorkflowDir)();
  const staged = listSkillEvolutionsForDraft(ctx.db, draft.id, { draftVersion: draft.version, status: "staged" });
  const publishedSet = new Set(listSkillEvolutionsForDraft(ctx.db, draft.id, { draftVersion: draft.version, status: "published" }).map((r) => r.skillId));
  const seenSkills = new Set<string>();
  for (const row of staged) {
    if (seenSkills.has(row.skillId) || publishedSet.has(row.skillId)) continue;
    seenSkills.add(row.skillId);
    let afterSha: string | null = null;
    if (row.candidateFiles.length > 0) {
      const write = await casWriteSkillBundle(skillsRoot, row.skillId, row.candidateFiles, row.beforeBundleSha256, { log: ctx.log });
      if (write.status === "applied") afterSha = write.afterSha256;
      else {
        const disk = await readSkillBundle(skillsRoot, row.skillId).catch(() => null);
        if (disk?.bundleSha256 !== computeSkillBundleSha256(row.candidateFiles)) {
          ctx.log(`WARN [pilotPanel.workflowDrafts] coupled_skill_conflict ${redactKnown(JSON.stringify({ draftId: draft.id, skillId: row.skillId, reason: write.reason }))}`);
          continue;
        }
        afterSha = disk.bundleSha256;
      }
    }
    const supersededSnapshots = await retireSupersededLocal(globalDir, row.supersededWorkflowIds, draft.workflowId);
    appendSkillEvolutionEvent(ctx.db, { ...row, evolutionId: undefined, createdAt: undefined, draftId: draft.id, draftVersion: draft.version, workflowId: draft.workflowId, status: "published", afterBundleSha256: afterSha, supersededSnapshots }, { log: ctx.log });
    ctx.log(`INFO [pilotPanel.workflowDrafts] coupled_skill_published ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId, skillId: row.skillId, supersededCount: supersededSnapshots.length }))}`);
  }
  return { ok: true, projectId: res.projectId, message: `Граф ${draft.workflowId} (v${res.version}) опубликован.` };
}

export async function rollbackPanelWorkflowDraft(
  ctx: ServerCore,
  deps: PilotPanelWorkflowDeps,
  input: { draftId: string; threadId?: string },
): Promise<{ ok: boolean; projectId?: string; message: string }> {
  const drafts = createDraftStore(ctx.db);
  const draft = drafts.get(input.draftId);
  if (!draft) return { ok: false, message: `Черновик ${input.draftId} не найден.` };
  const prev = drafts.previousVersionSnapshot(draft.id);
  if (process.env.LOG_LEVEL === "debug" || process.env.DEBUG_FIX) ctx.log(`[FIX:rollback-snapshot] rollback_request ${redactKnown(JSON.stringify({ draftId: draft.id, draftVersion: draft.version, publishedVersion: draft.publishedVersion, targetVersion: prev?.version ?? null }))}`);
  if (!prev) {
    ctx.log(`WARN [pilotPanel.workflowDrafts] rollback_unavailable ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId }))}`);
    return { ok: false, message: "Нет предыдущей версии графа для отката." };
  }
  const restored = drafts.restore(draft.id, prev.version);
  if (!restored.ok) return { ok: false, message: `Откат не выполнен (${restored.reason}).` };
  const globalDir = (deps.globalDir ?? globalWorkflowDir)();
  const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir }).catch(() => null);
  const resolve = (id: string, version?: number) => store?.resolve(id, version) ?? builtinWorkflow(id, version);
  const loaded = loadWorkflow(restored.draft.definition, { resolve });
  if (!loaded.ok) {
    ctx.log(`WARN [pilotPanel.workflowDrafts] rollback_invalid ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId }))}`);
    return { ok: false, message: "Откаченная версия графа не прошла валидацию." };
  }
  const results = [];
  for (const tc of testCasesOf(loaded.workflow)) results.push(await runDraftTest({ db: ctx.db, harnessVersion: HARNESS_VERSION, resolveWorkflow: resolve }, loaded.workflow, tc));
  drafts.recordTests(draft.id, restored.draft.version, results, true);
  if (!results.length || !results.every((r) => r.green)) {
    ctx.log(`WARN [pilotPanel.workflowDrafts] rollback_tests_failed ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId, version: restored.draft.version }))}`);
    return { ok: false, message: "Тесты откаченной версии не прошли." };
  }
  const stripMeta = (raw: Record<string, unknown>) => { const { ui: _u, status: _st, scope: _sc, ...rest } = raw; return JSON.stringify(rest); };
  const factoryRaw = draft.scope === "global" && isEvolvableDomainBuiltinId(draft.workflowId) ? rawBuiltinWorkflowSource(draft.workflowId) : null;
  const rollsBackToFactoryBuiltin = Boolean(factoryRaw && stripMeta(restored.draft.definition as Record<string, unknown>) === stripMeta(factoryRaw));
  let publishedVersion: number;
  if (rollsBackToFactoryBuiltin) {
    await removeWorkflowFile(globalDir, draft.workflowId).catch(() => undefined);
    drafts.resetToFactoryBaseline(draft.id);
    closeOwnerItemsByPrefix(ctx.db, `workflow-evolved:${draft.id}:`, "owner:pilot-panel");
    ctx.realtime?.notify(draft.projectId, "workflow-draft", input.threadId, draft.id);
    deps.workflowCatalog?.invalidate();
    deps.workflowTriggers?.syncSoon(draft.projectId);
    publishedVersion = builtinWorkflow(draft.workflowId)?.version ?? 1;
    ctx.log(`INFO [pilotPanel.workflowDrafts] rolledBackToFactoryBuiltin ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId, version: publishedVersion }))}`);
  } else {
    const res = await publishDraftWithCleanup(ctx, deps, {
      draftId: draft.id, projectId: draft.projectId, workflowId: draft.workflowId, fallbackVersion: restored.draft.version,
      threadId: input.threadId, closePrefix: `workflow-evolved:${draft.id}:`, eventName: "rolledBack",
    });
    if (!res.ok) return { ok: false, message: `Не удалось опубликовать откаченную версию: ${res.reason}` };
    publishedVersion = res.version;
  }

  const skillsRoot = (deps.skillsDir ?? globalSkillsDir)();
  for (const row of listLatestActivePublishedSkillEvolutionsForDraft(ctx.db, draft.id)) {
    if (row.candidateFiles.length > 0 || (row.beforeFiles?.length ?? 0) > 0) {
      await restoreSkillBundleSnapshot(skillsRoot, row.skillId, row.beforeFiles ?? [], { log: ctx.log });
    }
    for (const snap of row.supersededSnapshots) await casWriteWorkflowFile(globalDir, snap.workflowId, snap.content, null).catch(() => undefined);
    appendSkillEvolutionEvent(ctx.db, { ...row, evolutionId: undefined, createdAt: undefined, status: "rolled_back", afterBundleSha256: row.beforeBundleSha256 }, { log: ctx.log });
    ctx.log(`INFO [pilotPanel.workflowDrafts] coupled_skill_restored ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId, skillId: row.skillId, restoredSuperseded: row.supersededSnapshots.length }))}`);
  }
  return { ok: true, projectId: draft.projectId, message: rollsBackToFactoryBuiltin ? `Оверлей ${draft.workflowId} удалён — восстановлен заводской граф (v${publishedVersion}).` : `Граф ${draft.workflowId} откачен и опубликован (v${publishedVersion}).` };
}

export function registerPilotProcessStateAction(engine: WorkflowEngine, ctx: ServerCore): void {
  if (engine.hasExecutor("lp.save_process_state")) return;
  engine.register<ChainRuntime>("lp.save_process_state", {
    reentrant: true,
    run: async (c) => {
      const rt = c.runtime;
      const rendered = (c.template((c.node as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown> | undefined) ?? {};
      const projectId = rt?.projectId ?? (typeof c.inputs.projectId === "string" ? c.inputs.projectId : "");
      const place = rt?.pmThreadId ? await resolveThreadPlace(ctx, rt.pmThreadId).catch(() => null) : null;
      const folder = place?.hostId && place.rootPath ? { hostId: place.hostId, path: place.rootPath } : projectId ? await projectFolder(ctx.bb, projectId) : null;
      if (!folder) throw new Error("lp.save_process_state: project checkout is unavailable");
      const io = createProcessStateIo(ctx, folder.hostId, folder.path);
      const current = await readPilotProcessStateCas(io, { hostId: folder.hostId, rootPath: folder.path, log: ctx.log });
      const prev = current.state;
      const strList = (v: unknown, fb: string[]) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0).slice(0, 20) : fb);
      const next = pilotProcessStateSchema.parse({
        stage: typeof rendered.stage === "string" && rendered.stage.trim() ? rendered.stage.trim() : prev?.stage ?? "active",
        workflowId: typeof rendered.workflowId === "string" ? rendered.workflowId : prev?.workflowId ?? c.workflow.id,
        approvedDesignBaseline: rendered.approvedDesignBaseline !== undefined ? rendered.approvedDesignBaseline : prev?.approvedDesignBaseline ?? null,
        rejectedVariants: strList(rendered.rejectedVariants, prev?.rejectedVariants ?? []),
        activeSkills: strList(rendered.activeSkills, prev?.activeSkills ?? []),
        ...(typeof rendered.notes === "string" ? { notes: rendered.notes } : prev?.notes ? { notes: prev.notes } : {}),
        updatedAt: new Date().toISOString(),
      });
      const written = await writePilotProcessStateCas(io, { hostId: folder.hostId, rootPath: folder.path, state: next, expectedSha256: current.sha256, log: ctx.log });
      if (!written.ok) throw new Error(written.error);
      return { output: { saved: true, path: PILOT_PROCESS_STATE_REL_PATH, stage: written.state.stage } };
    },
  });
}
