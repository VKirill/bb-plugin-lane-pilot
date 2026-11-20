// Disk workflow reads go through workflow-engine's nodeFileSource (no direct node:fs in server/).
import { join } from "node:path";
import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { loadWorkflow, runDraftTest, testCasesOf, wfTerminalByIdemKey, type NodeExecutor, type Workflow } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { listUnprocessedTrajectoryDeltas, markTrajectoryDeltasProcessed } from "../../errands";
import type { HarnessApi } from "../../harness/server";
import { postOwnerItem, rpcLine } from "../../owner-waiting";
import { modelCatalogOf, readProviderFolderBlock, resolveSpawnModel, scheduleIsolated, spawnUsageOf, warmSpawnUsage, type WorkflowEngineApi, type WorkflowTriggersApi, type WriterHostApi } from "../../platform/server";
import type { RuleScanApi } from "../../self-repair/server";
import { HARNESS_VERSION, createDraftStore, globalWorkflowDir, latestErrandEpisodeRows, listErrandEpisodeRows, listPilotDayDigests, loadWorkflowStore, nodeFileSource, type PilotDayCategoryHint } from "../../storage";
import { BUILTIN_SOURCES, builtinWorkflow, isBuiltinWorkflowCategory, workflowCategory, WORKFLOW_CATEGORIES } from "../../workflow";
import { createWorkflowArchitect, type ArchitectDeps, type WorkflowArchitect } from "../../workflow/server";
import { checkDeprojectization, classifyEvolutionDiff, type DeprojectizeContext } from "../deprojectize";
import { analystPlace } from "./episodes-graph";
import { createLivePilotDayDigestDeps, digestPilotDayDialogues, loadDigestSkillCatalog } from "./pilot-day-digest";

export const GRAPH_EVOLVE_WORKFLOW = "lp.graph-evolve-nightly";
export const GRAPH_EVOLVE_SCHEDULE = "graph-evolve-nightly";
export const GRAPH_EVOLVE_CRON = "50 4 * * *";

export type GraphEvolveCandidate = {
  workflowId: string; scope: "global" | "project"; projectId?: string | null;
  name: string | { en: string; ru: string }; description: string | { en: string; ru: string };
  category?: string | { id: string; label?: { en: string; ru: string } };
  definition: Record<string, unknown>; sourceDeltaIds?: string[]; sourceProcessKey?: string | null;
};

export type GraphEvolveCollectSummary = {
  clusters: Array<{
    processKey: string; count: number; topSkills: string[]; sampleGoals: string[]; traps: string[];
    lessons?: string[]; categoryHint?: PilotDayCategoryHint | null;
  }>;
  deltas: Array<{ id: string; projectId: string | null; workflowId: string | null; stageArchetype: string; interventionKind: string; resolvedSkills: string[]; maskedSummary: string }>;
  deltaIds: string[]; status: "ready" | "empty";
};

export type GraphEvolveDeps = {
  db: ServerCore["db"]; globalDir?: () => string; knownContext?: DeprojectizeContext;
  synthesize?: (collected: GraphEvolveCollectSummary) => Promise<GraphEvolveCandidate[]>;
  architectDeps?: Partial<ArchitectDeps>; architect?: Pick<WorkflowArchitect, "publish">;
  resolveWorkflow?: (id: string, version?: number) => Workflow | null;
  now?: () => number; log?: (message: string) => void;
};

export type GraphEvolveOutcome = {
  workflowId: string; draftId: string | null; kind: "minor_patch" | "structural_or_new";
  status: "auto_published" | "proposed_tested" | "rejected_deprojectize" | "rejected_invalid" | "rejected_tests" | "publish_failed";
  version: number | null; reason?: string;
};

interface Services {
  harness?: Pick<HarnessApi, "threadEvents">;
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  ruleScan: Pick<RuleScanApi, "runAnalyzer">;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowCatalog?: WorkflowEngineApi["workflowCatalog"];
  workflowTriggers?: WorkflowTriggersApi["workflowTriggers"];
}

const evolveRooms = new Map<string, string>();
const bilingual = (v: string | { en: string; ru: string }) => typeof v === "string" ? { en: v, ru: v } : { en: v.en || v.ru, ru: v.ru || v.en };
const titleRuOf = (v: string | { en: string; ru: string }, fallback: string) => (typeof v === "string" ? v : v.ru || v.en) || fallback;
const parseJson = <T,>(raw: unknown, fallback: T): T => { try { return typeof raw === "string" && raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };
const fixEvolveLog = (log: (m: string) => void, event: string, detail: Record<string, unknown>) => {
  if (process.env.LOG_LEVEL === "debug" || process.env.DEBUG_FIX) log(`[FIX:graph-evolve] ${event} ${redactKnown(JSON.stringify(detail))}`);
};

/** Collects enriched process clusters (errand episodes + daily Pilot digests) and unprocessed trajectory deltas for nightly graph evolution. */
export function collectGraphEvolveEvidence(
  db: ServerCore["db"],
  options?: { days?: number; minClusterSize?: number; now?: () => number; log?: (message: string) => void },
): GraphEvolveCollectSummary {
  const now = options?.now?.() ?? Date.now();
  const minCluster = options?.minClusterSize ?? 2;
  const sinceMs = now - (options?.days ?? 14) * 86_400_000;
  const rawDeltas = listUnprocessedTrajectoryDeltas(db, { limit: 100 });
  const deltaProjects = new Set(rawDeltas.map((d) => d.projectId).filter((x): x is string => Boolean(x)));
  const deltaThreads = new Set(rawDeltas.map((d) => d.threadId).filter((x): x is string => Boolean(x)));
  const deltas = rawDeltas.map((d) => ({
    id: d.id, projectId: d.projectId, workflowId: d.workflowId, stageArchetype: d.stageArchetype,
    interventionKind: d.interventionKind, resolvedSkills: d.resolvedSkills, maskedSummary: d.maskedSummary,
  }));
  const rawEpisodes = listErrandEpisodeRows(db, sinceMs, null, 400);
  const runIds = [...new Set(rawEpisodes.map((r) => String(r.run_id ?? "")).filter(Boolean))];
  const latestMap = runIds.length ? latestErrandEpisodeRows(db, runIds) : new Map<string, Record<string, unknown>>();
  const rows = latestMap.size ? [...latestMap.values()] : rawEpisodes;
  const digests = listPilotDayDigests(db, sinceMs, 400);

  type ClusterAcc = { count: number; skills: Map<string, number>; goals: Set<string>; traps: Set<string>; lessons: Set<string>; categoryHint: PilotDayCategoryHint | null; richPilotRun: boolean };
  const grouped = new Map<string, ClusterAcc>();
  const ensureGroup = (key: string): ClusterAcc => {
    const existing = grouped.get(key);
    if (existing) return existing;
    const created: ClusterAcc = { count: 0, skills: new Map<string, number>(), goals: new Set<string>(), traps: new Set<string>(), lessons: new Set<string>(), categoryHint: null, richPilotRun: false };
    grouped.set(key, created);
    return created;
  };

  for (const row of rows) {
    if (row.enrichment_state !== "enriched") continue;
    const key = ((typeof row.process_key === "string" && row.process_key.trim()) || (typeof row.process_key_proposed === "string" && row.process_key_proposed.trim()) || "").trim();
    if (!key) continue;
    const entry = ensureGroup(key);
    entry.count += 1;
    const summary = parseJson<Record<string, unknown>>(row.summary_json, {});
    if (typeof summary.goal === "string" && summary.goal.trim() && entry.goals.size < 5) entry.goals.add(summary.goal.trim());
    for (const trap of Array.isArray(summary.traps) ? summary.traps : []) if (typeof trap === "string" && trap.trim() && entry.traps.size < 8) entry.traps.add(trap.trim());
    for (const sk of Array.isArray(summary.skills) ? summary.skills : []) {
      const rec = sk && typeof sk === "object" ? (sk as { name?: unknown; read?: unknown; used?: unknown }) : null;
      if (rec && (rec.read === true || rec.used === true) && typeof rec.name === "string" && rec.name.trim()) entry.skills.set(rec.name.trim(), (entry.skills.get(rec.name.trim()) ?? 0) + 1);
    }
  }
  for (const digest of digests) {
    const key = digest.processKey.trim();
    if (!key) continue;
    const entry = ensureGroup(key);
    entry.count += 1;
    const hasMatchingDelta = (digest.projectId !== null && deltaProjects.has(digest.projectId)) || (digest.threadId !== null && deltaThreads.has(digest.threadId));
    if (digest.sourceKind === "pilot_run" && (digest.taskCount >= 2 || (digest.outcome === "done" && hasMatchingDelta))) entry.richPilotRun = true;
    if (!entry.categoryHint && digest.categoryHint) entry.categoryHint = digest.categoryHint;
    if (digest.maskedGoal.trim() && entry.goals.size < 5) entry.goals.add(digest.maskedGoal.trim());
    for (const trap of digest.traps) if (trap.trim() && entry.traps.size < 8) entry.traps.add(trap.trim());
    for (const lesson of digest.maskedLessons) if (lesson.trim() && entry.lessons.size < 8) entry.lessons.add(lesson.trim());
    for (const sk of digest.skills) if (sk.trim()) entry.skills.set(sk.trim(), (entry.skills.get(sk.trim()) ?? 0) + 1);
  }

  const clusters = [...grouped.entries()].filter(([, g]) => g.count >= minCluster || g.richPilotRun).sort((a, b) => b[1].count - a[1].count).slice(0, 12).map(([processKey, g]) => ({
    processKey, count: g.count, topSkills: [...g.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n),
    sampleGoals: [...g.goals], traps: [...g.traps], lessons: [...g.lessons], categoryHint: g.categoryHint,
  }));
  options?.log?.(`INFO [nightGraphs.graphEvolve] collected ${redactKnown(JSON.stringify({ clusters: clusters.length, deltas: deltas.length, digests: digests.length }))}`);
  return { clusters, deltas, deltaIds: deltas.map((d) => d.id), status: clusters.length || deltas.length ? "ready" : "empty" };
}

function buildArchitect(deps: GraphEvolveDeps, dirFn: () => string): Pick<WorkflowArchitect, "publish"> {
  if (deps.architect) return deps.architect;
  const minCtx = { db: deps.db, log: deps.log ?? (() => undefined), realtime: { notify: () => undefined } } as unknown as ServerCore;
  const archDeps: ArchitectDeps = {
    globalDir: dirFn, projectPlace: async () => null, capabilityPorts: () => ({}), hasExecutor: () => false,
    writeProjectFile: async () => ({ status: "conflict", path: "", afterSha256: null, reason: "project_place_unknown" }),
    ...deps.architectDeps,
  };
  return createWorkflowArchitect(minCtx, { workflowEngine: { hasExecutor: archDeps.hasExecutor } } as never, archDeps);
}

async function readDiskBase(dir: string, workflowId: string): Promise<{ path: string; sha256: string; version: number; def: Record<string, unknown> } | null> {
  // Read via workflow-engine's FileSource abstraction to avoid node:fs in server/.
  const path = join(dir, `${workflowId}.json`);
  try {
    const raw = await nodeFileSource.read(path);
    const def = JSON.parse(raw) as Record<string, unknown>;
    return { path, sha256: sha256Hex(raw), version: typeof def.version === "number" ? def.version : 1, def };
  } catch { return null; }
}

/** Validates, de-projectizes, tests on stubs, and applies minor auto-publish or owner-approval policy to each candidate. */
export async function applyGraphEvolveCandidates(
  deps: GraphEvolveDeps,
  candidates: readonly GraphEvolveCandidate[],
  options?: { deltaIds?: readonly string[] },
): Promise<{ outcomes: GraphEvolveOutcome[]; publishedCount: number; proposedCount: number; rejectedCount: number; summary: string }> {
  const now = deps.now ?? Date.now, log = deps.log ?? (() => undefined), dirFn = deps.globalDir ?? globalWorkflowDir;
  const resolve = deps.resolveWorkflow ?? ((id: string, version?: number) => builtinWorkflow(id, version));
  const drafts = createDraftStore(deps.db, now), architect = buildArchitect(deps, dirFn);
  const outcomes: GraphEvolveOutcome[] = [];
  let publishedCount = 0, proposedCount = 0, rejectedCount = 0, citedAnyDelta = false;

  for (const candidate of candidates) {
    const workflowId = candidate.workflowId.trim();
    if (!workflowId || builtinWorkflow(workflowId)) {
      log(`WARN [nightGraphs.graphEvolve] reserved_or_empty ${redactKnown(JSON.stringify({ workflowId }))}`);
      outcomes.push({ workflowId, draftId: null, kind: "structural_or_new", status: "rejected_invalid", version: null, reason: "id_reserved" });
      rejectedCount += 1; continue;
    }
    const category = candidate.definition.category ?? candidate.category;
    const candidateDef = category !== undefined && candidate.definition.category === undefined
      ? { ...candidate.definition, category }
      : candidate.definition;
    const existing = drafts.listEvolutionDrafts({ workflowId, scope: candidate.scope, ...(candidate.scope === "project" && candidate.projectId ? { projectId: candidate.projectId } : {}) })[0] ?? null;
    const diskBase = candidate.scope === "global" ? await readDiskBase(dirFn(), workflowId) : null;
    const baseDef = existing?.publishedVersion ? (drafts.latestPublishedSnapshot(existing.id)?.definition ?? diskBase?.def ?? null) : (diskBase?.def ?? null);
    const diff = classifyEvolutionDiff(baseDef, candidateDef, { log });

    if (candidate.scope === "global") {
      const verdict = checkDeprojectization(candidateDef, { ...deps.knownContext, log });
      if (!verdict.ok) {
        const codes = verdict.findings.map((f) => f.code).join(",");
        log(`WARN [nightGraphs.graphEvolve] deprojectize_failed ${redactKnown(JSON.stringify({ workflowId, codes }))}`);
        outcomes.push({ workflowId, draftId: null, kind: diff.kind, status: "rejected_deprojectize", version: null, reason: codes });
        rejectedCount += 1; continue;
      }
    }

    const projectId = existing?.projectId ?? (candidate.projectId?.trim() || "*");
    const preparedDef: Record<string, unknown> = {
      ...candidateDef, id: workflowId, status: "draft",
      name: candidate.definition.name ?? bilingual(candidate.name),
      description: candidate.definition.description ?? bilingual(candidate.description),
      scope: candidate.scope === "project" ? { level: "project", projectId } : { level: "global" },
    };
    const loaded = loadWorkflow(preparedDef, { resolve });
    if (!loaded.ok) {
      const reason = loaded.problems.filter((p) => p.level === "error").map((p) => `${p.code}:${p.message}`).slice(0, 4).join("; ");
      log(`WARN [nightGraphs.graphEvolve] invalid_workflow ${redactKnown(JSON.stringify({ workflowId, reason }))}`);
      outcomes.push({ workflowId, draftId: null, kind: diff.kind, status: "rejected_invalid", version: null, reason });
      rejectedCount += 1; continue;
    }
    log(`INFO [nightGraphs.graphEvolve] category_selected ${redactKnown(JSON.stringify({ workflowId, categoryId: loaded.workflow.category?.id ?? workflowCategory(loaded.workflow), isDynamic: Boolean(loaded.workflow.category && !isBuiltinWorkflowCategory(loaded.workflow.category.id)) }))}`);

    const results = [];
    for (const tc of testCasesOf(loaded.workflow)) results.push(await runDraftTest({ db: deps.db as never, harnessVersion: HARNESS_VERSION, resolveWorkflow: resolve, now }, loaded.workflow, tc));
    const allGreen = results.length > 0 && results.every((r) => r.green);
    if (!allGreen) {
      fixEvolveLog(log, "rejected_before_mutate", { workflowId, existingDraftId: existing?.id ?? null, cases: results.length });
      log(`WARN [nightGraphs.graphEvolve] tested ${redactKnown(JSON.stringify({ workflowId, draftId: existing?.id ?? null, cases: results.length, green: false }))}`);
      outcomes.push({ workflowId, draftId: existing?.id ?? null, kind: diff.kind, status: "rejected_tests", version: null, reason: results.filter((r) => !r.green).flatMap((r) => r.failures).slice(0, 4).join("; ") || "draft_test_failed" });
      rejectedCount += 1; continue;
    }

    const draft = existing && (!diskBase || existing.publishedSha256 === diskBase.sha256)
      ? drafts.replaceDefinition(existing.id, preparedDef, `nightly evolution (${diff.kind})`)!
      : diskBase
        ? drafts.replaceDefinition(drafts.create({ projectId, threadId: null, scope: candidate.scope, name: candidate.name, description: candidate.description, workflowId, definition: diskBase.def, base: { path: diskBase.path, sha256: diskBase.sha256, version: diskBase.version } }).id, preparedDef, `nightly evolution (${diff.kind})`)!
        : drafts.create({ projectId, threadId: null, scope: candidate.scope, name: candidate.name, description: candidate.description, workflowId, definition: preparedDef });
    const recorded = drafts.recordTests(draft.id, draft.version, results, true) ?? draft;
    log(`INFO [nightGraphs.graphEvolve] tested ${redactKnown(JSON.stringify({ workflowId, draftId: recorded.id, draftVersion: recorded.version, cases: results.length, green: true }))}`);

    const titleRu = titleRuOf(candidate.name, workflowId), ownerProject = recorded.scope === "project" ? recorded.projectId : null;
    if (diff.kind === "minor_patch" && baseDef) {
      const pub = await architect.publish({ projectId: recorded.projectId, draftId: recorded.id });
      if (!pub.published) {
        const reason = String((pub as { reason?: unknown }).reason ?? "publish_failed");
        log(`WARN [nightGraphs.graphEvolve] publish_failed ${redactKnown(JSON.stringify({ workflowId, draftId: recorded.id, reason }))}`);
        outcomes.push({ workflowId, draftId: recorded.id, kind: diff.kind, status: "publish_failed", version: null, reason });
        rejectedCount += 1; continue;
      }
      if (candidate.sourceDeltaIds?.length) { citedAnyDelta = true; markTrajectoryDeltasProcessed(deps.db, candidate.sourceDeltaIds, now(), log); }
      const nextVer = Number((pub as { workflowVersion?: number }).workflowVersion ?? (Number(baseDef.version ?? 1) + 1));
      postOwnerItem(deps.db, {
        key: `workflow-evolved:${recorded.id}:v${nextVer}`, source: "night", kind: "workflow_evolved_digest", projectId: ownerProject, wake: false,
        what: `Граф «${titleRu}» (${workflowId}) автоматически обновлён до v${nextVer}`,
        why: `Минорное ночное улучшение (${diff.reasons.join(", ") || "уточнение скиллов и проверок"}) прошло фильтр депроектизации и все симуляции (${results.length}/${results.length}). Доступен откат в 1 клик.`,
        evidence: [{ kind: "file", ref: String((pub as { path?: unknown }).path ?? workflowId) }],
        actions: [{ id: "rollback", label: "Откатить версию", cli: rpcLine("pilot_panel_rollback_workflow_draft", { draftId: recorded.id }), rpc: { method: "pilot_panel_rollback_workflow_draft", input: { draftId: recorded.id } } }],
      }, now());
      log(`INFO [nightGraphs.graphEvolve] auto_published ${redactKnown(JSON.stringify({ workflowId, draftId: recorded.id, version: nextVer }))}`);
      outcomes.push({ workflowId, draftId: recorded.id, kind: diff.kind, status: "auto_published", version: nextVer });
      publishedCount += 1;
    } else {
      if (candidate.sourceDeltaIds?.length) { citedAnyDelta = true; markTrajectoryDeltasProcessed(deps.db, candidate.sourceDeltaIds, now(), log); }
      postOwnerItem(deps.db, {
        key: `workflow-draft:${recorded.id}:v${recorded.version}`, source: "night", kind: "workflow_draft_proposed", projectId: ownerProject, wake: true,
        what: `Предложен ${baseDef ? "обновлённый" : "новый"} граф «${titleRu}» (${workflowId}, draft v${recorded.version})`,
        why: `Ночной синтез подготовил и проверил на стабах (${results.length}/${results.length} PASS) ${baseDef ? "структурное изменение" : "новый универсальный граф v1"}. Требуется подтверждение владельца перед публикацией.`,
        evidence: [{ kind: "text", ref: `${workflowId}#v${recorded.version}` }],
        actions: [{ id: "publish", label: "Опубликовать граф", cli: rpcLine("pilot_panel_publish_workflow_draft", { draftId: recorded.id }), rpc: { method: "pilot_panel_publish_workflow_draft", input: { draftId: recorded.id } } }],
      }, now());
      log(`INFO [nightGraphs.graphEvolve] proposed_tested ${redactKnown(JSON.stringify({ workflowId, draftId: recorded.id, draftVersion: recorded.version }))}`);
      outcomes.push({ workflowId, draftId: recorded.id, kind: diff.kind, status: "proposed_tested", version: recorded.version });
      proposedCount += 1;
    }
  }

  if (options?.deltaIds?.length && !citedAnyDelta && rejectedCount === 0 && publishedCount + proposedCount > 0) {
    fixEvolveLog(log, "batch_mark_deltas", { count: options.deltaIds.length });
    markTrajectoryDeltasProcessed(deps.db, options.deltaIds, now(), log);
  }
  return { outcomes, publishedCount, proposedCount, rejectedCount, summary: `graph-evolve: ${publishedCount} auto-published, ${proposedCount} proposed, ${rejectedCount} rejected` };
}

type KnownCategory = { id: string; label?: { en: string; ru: string } };
function collectKnownCategories(catalog: ReadonlyArray<{ workflow: Workflow }>, collected: GraphEvolveCollectSummary): KnownCategory[] {
  const map = new Map<string, KnownCategory>(WORKFLOW_CATEGORIES.map((id) => [id, { id }]));
  const merge = (id: string, label?: { en: string; ru: string } | null) => {
    const slug = id.trim();
    if (!slug) return;
    const prev = map.get(slug);
    map.set(slug, label ? { id: slug, label } : (prev ?? { id: slug }));
  };
  for (const item of catalog) if (item.workflow.status === "published" && item.workflow.category) merge(item.workflow.category.id, item.workflow.category.label);
  for (const cluster of collected.clusters) if (cluster.categoryHint) merge(cluster.categoryHint.id, cluster.categoryHint.label);
  return [...map.values()];
}

async function synthesizeInIsolatedRoom(ctx: ServerCore, services: Services, collected: GraphEvolveCollectSummary): Promise<GraphEvolveCandidate[]> {
  const hintProject = collected.deltas.find((d) => d.projectId)?.projectId ?? null;
  const { place, projectId: threadProject } = await analystPlace(ctx.db, hintProject, (id) =>
    services.resolveProjectWriterHost({ projectId: id } as never).catch((cause: unknown) => { ctx.log(`WARN [nightGraphs.graphEvolve] host_lookup ${cause instanceof Error ? cause.message : String(cause)}`); return null; }));
  if (!place || (place as { status?: string }).status !== "resolved") throw new Error("graph_evolve_no_host");
  const project = place as { hostId: string; path: string };
  const made = await ctx.host.call("runCommand", {
    requestedHostId: project.hostId, cwd: project.path, timeoutSec: 30,
    command: 'mkdir -p "$HOME/.lane-pilot/graph-evolve" && cd "$HOME/.lane-pilot/graph-evolve" && pwd',
  }, { hostId: project.hostId, timeoutMs: 40_000 }) as { exitCode: number; stdout: string };
  const room = (made.exitCode === 0 ? made.stdout.trim().split("\n").at(-1) : undefined) ?? evolveRooms.get(project.hostId);
  if (!room) throw new Error("graph_evolve_no_empty_room");
  evolveRooms.set(project.hostId, room);
  const host = { hostId: project.hostId, path: room };
  const settings = (await ctx.effectiveProjectSettings(GLOBAL_SETTINGS_PROJECT_ID).catch(() => null))?.values ?? {};
  const spawnUsage = spawnUsageOf(ctx);
  await warmSpawnUsage(spawnUsage, host.hostId);
  const role = resolveSpawnModel({ role: "episode-analyst", settings, catalog: modelCatalogOf(ctx).peek(), usage: spawnUsage, hostId: host.hostId, envPath: host.path, folderBlock: await readProviderFolderBlock(ctx.bb.storage.kv, host.hostId) });
  const catalogItems = (await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir: globalWorkflowDir() }).catch(() => null))?.list() ?? [];
  const existingGlobal = catalogItems.filter((s) => s.origin === "global").map((s) => ({ id: s.workflow.id, version: s.workflow.version, title: s.workflow.name }));
  const knownCategories = collectKnownCategories(catalogItems, collected);
  const prompt = redactKnown([
    "You are Lane Pilot's nightly graph evolution synthesizer. Do not read files outside this message.",
    "Parameterize all project-specific values with $inputs.* (no absolute paths, domains, projectIds, hostIds or secrets).",
    `Known categories: ${JSON.stringify(knownCategories)}`,
    'Category rule: if the workflow belongs to an existing category, specify definition.category (e.g. {"id":"<existing-id>"}) or matching tags. If a new reusable domain/direction crystallizes from daily chats and work that does not fit existing shelves, CREATE a universal deprojectized category directly in definition.category: {"id":"<kebab-slug>","label":{"en":"...","ru":"..."}}.',
    `Existing global workflows: ${JSON.stringify(existingGlobal)}`,
    `Masked evidence: ${JSON.stringify(collected)}`,
    'Return ONLY JSON: {"candidates":[{"workflowId":"...","scope":"global","name":{"en":"...","ru":"..."},"description":{"en":"...","ru":"..."},"sourceDeltaIds":[],"definition":{...}}]}',
  ].join("\n\n"));
  const text = await services.ruleScan.runAnalyzer(threadProject ?? "*", "graph-evolve-nightly", prompt, host, {
    providerId: role.providerId, model: role.model, reasoningLevel: role.reasoningEffort, serviceTier: role.serviceTier,
  }, { graphEvolve: true }, "episode-analyst").catch((err: unknown) => { evolveRooms.delete(project.hostId); throw err; });
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  const parsed = parseJson<{ candidates?: unknown }>(text.slice(start, end + 1), {});
  return Array.isArray(parsed.candidates) ? (parsed.candidates as GraphEvolveCandidate[]) : [];
}

async function knownContextOf(ctx: ServerCore, collected: GraphEvolveCollectSummary): Promise<DeprojectizeContext> {
  const projects = await ctx.bb.sdk.projects.list().catch(() => []);
  const projectList = Array.isArray(projects) ? projects : ((projects as { projects?: unknown[] })?.projects ?? []);
  const hosts = await (ctx.bb.sdk as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.().catch(() => []) ?? [];
  const hostList = Array.isArray(hosts) ? hosts : ((hosts as { hosts?: unknown[] })?.hosts ?? []);
  return {
    knownProjectIds: [...new Set([...collected.deltas.map((d) => d.projectId).filter((x): x is string => Boolean(x)), ...projectList.map((p) => String((p as { id?: unknown }).id ?? "")).filter(Boolean)])],
    knownProjectNames: projectList.map((p) => String((p as { name?: unknown }).name ?? "")).filter(Boolean),
    knownHostIds: hostList.map((h) => String((h as { id?: unknown }).id ?? "")).filter(Boolean),
  };
}

/** Mounts nightly graph evolution executors (`lp.graph_evolve_*`) and daily cron `50 4 * * *`. */
export function mountGraphEvolveNightly(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;
  engine.register<ChainRuntime>("lp.graph_evolve_digest", { reentrant: true, run: async (c) => {
    const catalog = await loadDigestSkillCatalog(ctx);
    const result = await digestPilotDayDialogues(createLivePilotDayDigestDeps(ctx, services, () => ctx.isDisposed() || c.signal.aborted, catalog));
    return { output: { status: "done", picked: result.picked, digested: result.digested, deltasRecorded: result.deltasRecorded, skipped: result.skippedSandbox + result.skippedDisabled, failed: result.failed } };
  } } as NodeExecutor<ChainRuntime>);
  engine.register<ChainRuntime>("lp.graph_evolve_collect", { reentrant: true, run: async () => {
    const collected = collectGraphEvolveEvidence(ctx.db, { log: (m) => ctx.log(m) });
    return { output: { status: collected.status, clustersCount: collected.clusters.length, deltasCount: collected.deltas.length, payload_json: JSON.stringify(collected) } };
  } } as NodeExecutor<ChainRuntime>);
  engine.register<ChainRuntime>("lp.graph_evolve_synthesize", { reentrant: true, run: async (c) => {
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), { clusters: [], deltas: [], deltaIds: [], status: "empty" });
    if (collected.status === "empty") return { output: { candidatesCount: 0, candidates_json: "[]" } };
    const candidates = await synthesizeInIsolatedRoom(ctx, services, collected);
    ctx.log(`INFO [nightGraphs.graphEvolve] synthesized ${redactKnown(JSON.stringify({ candidatesCount: candidates.length }))}`);
    return { output: { candidatesCount: candidates.length, candidates_json: JSON.stringify(candidates) } };
  } } as NodeExecutor<ChainRuntime>);
  engine.register<ChainRuntime>("lp.graph_evolve_apply", { reentrant: true, run: async (c) => {
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), { clusters: [], deltas: [], deltaIds: [], status: "empty" });
    const candidates = parseJson<GraphEvolveCandidate[]>(c.resolve("synthesize.candidates_json"), []);
    if (!candidates.length) return { output: { status: "held", publishedCount: 0, proposedCount: 0, rejectedCount: 0, summary: "graph-evolve: no candidates" } };
    const applied = await applyGraphEvolveCandidates({ db: ctx.db, log: (m) => ctx.log(m), knownContext: await knownContextOf(ctx, collected), architect: createWorkflowArchitect(ctx, services as never) }, candidates, { deltaIds: collected.deltaIds });
    return { output: { status: applied.publishedCount || applied.proposedCount ? "done" : "held", publishedCount: applied.publishedCount, proposedCount: applied.proposedCount, rejectedCount: applied.rejectedCount, summary: applied.summary } };
  } } as NodeExecutor<ChainRuntime>);

  scheduleIsolated(ctx.bb, GRAPH_EVOLVE_SCHEDULE, GRAPH_EVOLVE_CRON, async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const workflow = engine.resolveWorkflow(GRAPH_EVOLVE_WORKFLOW);
    if (!workflow) return;
    const key = `graph-evolve:${new Date().toISOString().slice(0, 10)}`;
    if (wfTerminalByIdemKey(ctx.db as never, key)) { ctx.log(`DEBUG [nightGraphs.graphEvolve] skipped_idempotent ${JSON.stringify({ key })}`); return; }
    ctx.log(`INFO [nightGraphs.graphEvolve] starting ${JSON.stringify({ key })}`);
    await engine.start({
      workflow, key, link: { projectId: "*" },
      runtime: { ctx, services, pmThreadId: null, projectId: "*", runId: null, origin: "schedule" } satisfies ChainRuntime,
      inputs: {},
    }).done.catch((cause: unknown) => ctx.log(`ERROR [nightGraphs.graphEvolve] run_failed ${redactKnown(cause instanceof Error ? cause.message : String(cause))}`));
  }, { timeoutMs: 60 * 60_000 });
}
