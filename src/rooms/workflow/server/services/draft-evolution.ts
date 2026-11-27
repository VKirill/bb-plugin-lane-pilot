import { join } from "node:path";
import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import {
  WORKFLOW_FILE_ID, casWriteSkillBundle, casWriteWorkflowFile, computeSkillBundleSha256,
  globalSkillsDir, globalWorkflowDir, loadWorkflow, loadWorkflowStore, nodeFileSource,
  readSkillBundle, removeWorkflowFile, restoreSkillBundleSnapshot, runDraftTest, testCasesOf,
} from "@lane-pilot/workflow-engine";
import { archivePreviousRevision, archivePublishedRevision, makeArchiveLogger } from "./archive-publish";
import type { ServerCore } from "../../../contracts/server";
import { closeOwnerItemsByPrefix, listOpenOwnerItems } from "../../../owner-waiting";
import { projectFolder } from "../../../platform/server";
import {
  appendSkillEvolutionEvent, createDraftStore, HARNESS_VERSION,
  listLatestActivePublishedSkillEvolutionsForDraft, listSkillEvolutionsForDraft,
  type SupersededWorkflowSnapshot,
} from "../../../storage";
import { BUILTIN_SOURCES, builtinWorkflow, isEvolvableDomainBuiltinId, rawBuiltinWorkflowSource } from "../../builtin";
import type { WorkflowEngineApi } from "./workflow";
import { draftSha256, grantOwner, peekAuthority, publishGateLog } from "./publish-gate";
import { createWorkflowArchitect, realDeps } from "./workflow-architect";
import type { WorkflowTriggersApi } from "./workflow-triggers-live";

export interface WorkflowEvolutionItem {
  draftId: string;
  workflowId: string;
  title: string;
  scope: "global" | "project";
  status: "draft" | "tested" | "published";
  version: number;
  publishedVersion: number | null;
  testedGreen: boolean;
  canPublish: boolean;
  canRollback: boolean;
  summary: string;
  ownerItemKey: string | null;
  updatedAt: number;
}

export interface WorkflowEvolutionList {
  items: WorkflowEvolutionItem[];
  autoPublishedCount: number;
  pendingApprovalCount: number;
}

export interface WorkflowEvolutionDeps {
  docsPlaces?: (projectId: string) => Promise<Array<{ hostId: string; path: string; scopes: readonly unknown[] }>>;
  workflowCatalog?: WorkflowEngineApi["workflowCatalog"];
  workflowEngine?: WorkflowEngineApi["workflowEngine"];
  workflowTriggers?: WorkflowTriggersApi["workflowTriggers"];
  globalDir?: () => string;
  skillsDir?: () => string;
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

/** Lists recent tested/published evolution drafts and whether each can be published or rolled back. */
export function listWorkflowEvolution(
  ctx: Pick<ServerCore, "db">,
  place: { projectId?: string | null },
): WorkflowEvolutionList {
  const drafts = createDraftStore(ctx.db);
  const byId = new Map<string, ReturnType<typeof drafts.listEvolutionDrafts>[number]>();
  for (const row of [
    ...drafts.listEvolutionDrafts({ scope: "global", limit: 15 }),
    ...(place.projectId ? drafts.listEvolutionDrafts({ scope: "project", projectId: place.projectId, limit: 15 }) : []),
  ]) {
    if (!byId.has(row.id) && (row.status === "tested" || row.status === "published" || row.publishedVersion !== null)) byId.set(row.id, row);
  }
  const openItems = listOpenOwnerItems(ctx.db, {});
  const items: WorkflowEvolutionItem[] = [...byId.values()]
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
    items,
    autoPublishedCount: items.filter((item) => item.status === "published").length,
    pendingApprovalCount: items.filter((item) => item.canPublish).length,
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
  deps: WorkflowEvolutionDeps,
  opts: { draftId: string; projectId: string; workflowId: string; fallbackVersion: number; threadId?: string; ownerGrant?: boolean; closePrefix: string; eventName: "published" | "rolledBack" },
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
  const pub = await architect.publish({
    projectId: opts.projectId,
    ...(opts.threadId ? { threadId: opts.threadId } : {}),
    draftId: opts.draftId,
    ...(opts.ownerGrant ? { ownerGrant: true } : {}),
  });
  if (!pub.published) {
    const reason = String((pub as { reason?: unknown }).reason ?? "publish_refused");
    ctx.log(`WARN [workflow.drafts] ${opts.eventName === "published" ? "publish_refused" : "rollback_publish_failed"} ${redactKnown(JSON.stringify({ draftId: opts.draftId, workflowId: opts.workflowId, reason }))}`);
    return { ok: false, reason };
  }
  closeOwnerItemsByPrefix(ctx.db, opts.closePrefix, "owner:workflows");
  ctx.realtime?.notify(opts.projectId, "workflow-draft", opts.threadId, opts.draftId);
  const version = Number((pub as { workflowVersion?: unknown }).workflowVersion ?? opts.fallbackVersion);
  ctx.log(`INFO [workflow.drafts] ${opts.eventName} ${redactKnown(JSON.stringify({ draftId: opts.draftId, workflowId: opts.workflowId, version }))}`);
  return { ok: true, projectId: opts.projectId, version };
}

/** Publishes a tested evolution draft together with any staged coupled skill bundles and superseded workflow retirement. */
export async function publishEvolutionWorkflowDraft(
  ctx: ServerCore,
  deps: WorkflowEvolutionDeps,
  input: { draftId: string; threadId?: string; ownerGrant?: boolean; ensureTests?: boolean },
): Promise<{ ok: boolean; projectId?: string; version?: number; reason?: string; message: string }> {
  const drafts = createDraftStore(ctx.db);
  let draft = drafts.get(input.draftId);
  if (!draft) return { ok: false, reason: "not_found", message: `Черновик ${input.draftId} не найден.` };
  const gateLog = publishGateLog(ctx);
  const authCheck = peekAuthority(ctx.db, draft.id, draftSha256(draft.definition));
  if (!authCheck.ok) {
    gateLog.warn(`publish refused draft=${draft.id} reason=${authCheck.reason}`);
    return { ok: false, reason: authCheck.reason, message: `Публикация отклонена: ${authCheck.reason}` };
  }
  // «Ручной режим»: automatic evolution receipts cannot publish workflows or ~/.bb/skills while manual;
  // an explicit owner grant (`kind === "owner"`) is a person's press and still publishes.
  if (ctx.manualMode?.on() && authCheck.authority.kind !== "owner" && !input.ownerGrant) {
    gateLog.info(`publish skipped draft=${draft.id} reason=manual_mode`);
    return { ok: false, reason: "manual_mode", message: "Публикация отклонена: включён ручной режим." };
  }
  const archiveLog = makeArchiveLogger(ctx);
  const globalDir = (deps.globalDir ?? globalWorkflowDir)();
  const resolve = (id: string, version?: number) => builtinWorkflow(id, version, ctx.db);
  if (input.ensureTests && (!draft.tests || draft.tests.version !== draft.version || !draft.tests.green)) {
    const loaded = loadWorkflow(draft.definition, { resolve });
    if (!loaded.ok) {
      return { ok: false, message: `Публикация отклонена: invalid (${loaded.problems.filter((p) => p.level === "error").map((p) => p.message).join("; ")})` };
    }
    const results = [];
    for (const tc of testCasesOf(loaded.workflow)) {
      results.push(await runDraftTest({ db: ctx.db, harnessVersion: HARNESS_VERSION, resolveWorkflow: resolve }, loaded.workflow, tc));
    }
    draft = drafts.recordTests(draft.id, draft.version, results, true) ?? draft;
    if (!results.length || !results.every((r) => r.green)) {
      return { ok: false, message: "Публикация отклонена: tests_not_green" };
    }
  }
  await archivePreviousRevision(ctx, { draft, drafts, globalDir, resolve, log: archiveLog });
  const res = await publishDraftWithCleanup(ctx, deps, {
    draftId: draft.id, projectId: draft.projectId, workflowId: draft.workflowId, fallbackVersion: draft.version,
    threadId: input.threadId, ...(input.ownerGrant ? { ownerGrant: true } : {}),
    closePrefix: `workflow-draft:${draft.id}:`, eventName: "published",
  });
  if (!res.ok) return { ok: false, message: `Публикация отклонена: ${res.reason}` };
  const publishedRow = drafts.get(draft.id);
  if (publishedRow) {
    const publishedScope = publishedRow.scope === "project" ? { level: "project" as const, projectId: publishedRow.projectId } : { level: "global" as const };
    const loadedPub = loadWorkflow({ ...publishedRow.definition, status: "published", version: res.version, scope: publishedScope }, { resolve });
    if (loadedPub.ok) archivePublishedRevision(ctx, { workflow: loadedPub.workflow, scope: publishedRow.scope, log: archiveLog });
  }

  const skillsRoot = (deps.skillsDir ?? globalSkillsDir)();
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
          ctx.log(`WARN [workflow.drafts] coupled_skill_conflict ${redactKnown(JSON.stringify({ draftId: draft.id, skillId: row.skillId, reason: write.reason }))}`);
          continue;
        }
        afterSha = disk.bundleSha256;
      }
    }
    const supersededSnapshots = await retireSupersededLocal(globalDir, row.supersededWorkflowIds, draft.workflowId);
    appendSkillEvolutionEvent(ctx.db, { ...row, evolutionId: undefined, createdAt: undefined, draftId: draft.id, draftVersion: draft.version, workflowId: draft.workflowId, status: "published", afterBundleSha256: afterSha, supersededSnapshots }, { log: ctx.log });
    ctx.log(`INFO [workflow.drafts] coupled_skill_published ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId, skillId: row.skillId, supersededCount: supersededSnapshots.length }))}`);
  }
  return { ok: true, projectId: res.projectId, version: res.version, message: `Граф ${draft.workflowId} (v${res.version}) опубликован.` };
}

/** Rolls an evolved workflow back to its prior snapshot (or factory built-in) and restores coupled skill bundles. */
export async function rollbackEvolutionWorkflowDraft(
  ctx: ServerCore,
  deps: WorkflowEvolutionDeps,
  input: { draftId: string; threadId?: string },
): Promise<{ ok: boolean; projectId?: string; message: string }> {
  const drafts = createDraftStore(ctx.db);
  const draft = drafts.get(input.draftId);
  if (!draft) return { ok: false, message: `Черновик ${input.draftId} не найден.` };
  const prev = drafts.previousVersionSnapshot(draft.id);
  if (!prev) {
    ctx.log(`WARN [workflow.drafts] rollback_unavailable ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId }))}`);
    return { ok: false, message: "Нет предыдущей версии графа для отката." };
  }
  const restored = drafts.restore(draft.id, prev.version);
  if (!restored.ok) return { ok: false, message: `Откат не выполнен (${restored.reason}).` };
  const globalDir = (deps.globalDir ?? globalWorkflowDir)();
  const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir }).catch(() => null);
  const resolve = (id: string, version?: number) => store?.resolve(id, version) ?? builtinWorkflow(id, version);
  const loaded = loadWorkflow(restored.draft.definition, { resolve });
  if (!loaded.ok) {
    ctx.log(`WARN [workflow.drafts] rollback_invalid ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId }))}`);
    return { ok: false, message: "Откаченная версия графа не прошла валидацию." };
  }
  const results = [];
  for (const tc of testCasesOf(loaded.workflow)) results.push(await runDraftTest({ db: ctx.db, harnessVersion: HARNESS_VERSION, resolveWorkflow: resolve }, loaded.workflow, tc));
  drafts.recordTests(draft.id, restored.draft.version, results, true);
  if (!results.length || !results.every((r) => r.green)) {
    ctx.log(`WARN [workflow.drafts] rollback_tests_failed ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId, version: restored.draft.version }))}`);
    return { ok: false, message: "Тесты откаченной версии не прошли." };
  }
  const stripMeta = (raw: Record<string, unknown>) => { const { ui: _u, status: _st, scope: _sc, ...rest } = raw; return JSON.stringify(rest); };
  const factoryRaw = draft.scope === "global" && isEvolvableDomainBuiltinId(draft.workflowId) ? rawBuiltinWorkflowSource(draft.workflowId) : null;
  const rollsBackToFactoryBuiltin = Boolean(factoryRaw && stripMeta(restored.draft.definition as Record<string, unknown>) === stripMeta(factoryRaw));
  let publishedVersion: number;
  if (rollsBackToFactoryBuiltin) {
    await removeWorkflowFile(globalDir, draft.workflowId).catch(() => undefined);
    drafts.resetToFactoryBaseline(draft.id);
    closeOwnerItemsByPrefix(ctx.db, `workflow-evolved:${draft.id}:`, "owner:workflows");
    ctx.realtime?.notify(draft.projectId, "workflow-draft", input.threadId, draft.id);
    deps.workflowCatalog?.invalidate();
    await deps.workflowTriggers?.syncTriggers?.(draft.projectId);
    publishedVersion = builtinWorkflow(draft.workflowId)?.version ?? 1;
    ctx.log(`INFO [workflow.drafts] rolledBackToFactoryBuiltin ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId, version: publishedVersion }))}`);
  } else {
    grantOwner(ctx.db, draft.id, "desk", { log: publishGateLog(ctx) });
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
    ctx.log(`INFO [workflow.drafts] coupled_skill_restored ${redactKnown(JSON.stringify({ draftId: draft.id, workflowId: draft.workflowId, skillId: row.skillId, restoredSuperseded: row.supersededSnapshots.length }))}`);
  }
  return { ok: true, projectId: draft.projectId, message: rollsBackToFactoryBuiltin ? `Оверлей ${draft.workflowId} удалён — восстановлен заводской граф (v${publishedVersion}).` : `Граф ${draft.workflowId} откачен и опубликован (v${publishedVersion}).` };
}
