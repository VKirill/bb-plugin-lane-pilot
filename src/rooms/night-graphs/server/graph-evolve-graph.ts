// Nightly graph evolution evidence collection and workflow executor wiring (`lp.graph_evolve_*`).
import { redactKnown } from "@lane-pilot/kit";
import { wfTerminalByIdemKey, type NodeExecutor, type Workflow } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { listUnprocessedTrajectoryDeltas } from "../../errands";
import type { HarnessApi } from "../../harness/server";
import { scheduleIsolated, type WorkflowEngineApi, type WorkflowTriggersApi, type WriterHostApi } from "../../platform/server";
import type { RuleScanApi } from "../../self-repair/server";
import { globalWorkflowDir, latestErrandEpisodeRows, listErrandEpisodeRows, listPilotDayDigests, loadWorkflowStore, type PilotDayCategoryHint } from "../../storage";
import { BUILTIN_SOURCES, WORKFLOW_CATEGORIES } from "../../workflow";
import {
  auditSynthesizedSuite,
  createLiveEvolveRoleRunner,
  critiqueEvolutionBlueprint,
  planEvolutionBlueprint,
  synthesizeSuiteFromBlueprint,
  type EvolveCatalogContext,
  type EvolveReviewVerdict,
  type ProcessBlueprint,
} from "./graph-evolve-pipeline";
import {
  applyGraphEvolveCandidates,
  validateEvolveSuiteCandidates,
  type GraphEvolveCandidate,
  type GraphEvolveCollectSummary,
  type GraphEvolveDeps,
  type GraphEvolveOutcome,
} from "./graph-evolve-suite";
import { createLivePilotDayDigestDeps, digestPilotDayDialogues, loadDigestSkillCatalog } from "./pilot-day-digest";

export const GRAPH_EVOLVE_WORKFLOW = "lp.graph-evolve-nightly";
export const GRAPH_EVOLVE_SCHEDULE = "graph-evolve-nightly";
export const GRAPH_EVOLVE_CRON = "50 4 * * *";

export {
  applyGraphEvolveCandidates,
  validateEvolveSuiteCandidates,
  type GraphEvolveCandidate,
  type GraphEvolveCollectSummary,
  type GraphEvolveDeps,
  type GraphEvolveOutcome,
};

interface Services {
  harness?: Pick<HarnessApi, "threadEvents">;
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  ruleScan: Pick<RuleScanApi, "runAnalyzer">;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowCatalog?: WorkflowEngineApi["workflowCatalog"];
  workflowTriggers?: WorkflowTriggersApi["workflowTriggers"];
}

const parseJson = <T,>(raw: unknown, fallback: T): T => { try { return typeof raw === "string" && raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };

function domainFamilyOf(processKey: string, categoryHint?: PilotDayCategoryHint | null): string {
  if (categoryHint?.id === "websites") return "websites";
  const prefix = (processKey.split("|")[0] ?? "").trim().toLowerCase();
  if (/^(?:website|web-design|website-design.*|site|landing|pen-design|pencil|figma|ui-kit|image-studio|competitor.*|personal-brand.*)$/.test(prefix)) return "websites";
  if (/^seo(?:-|$)/.test(prefix)) return "seo";
  if (/^(?:mkt|marketing|ads|cro)(?:-|$)/.test(prefix)) return "marketing";
  if (/^(?:video|audio|voice)(?:-|$)/.test(prefix)) return "media";
  return prefix || "general";
}

/** Collects enriched process clusters (errand episodes + daily Pilot digests) and unprocessed trajectory deltas for nightly graph evolution. */
export function collectGraphEvolveEvidence(
  db: ServerCore["db"],
  options?: { days?: number; minClusterSize?: number; projectId?: string | null; now?: () => number; log?: (message: string) => void },
): GraphEvolveCollectSummary {
  const now = options?.now?.() ?? Date.now();
  const minCluster = options?.minClusterSize ?? 2;
  const pid = options?.projectId?.trim() || null;
  const sinceMs = now - (options?.days ?? 14) * 86_400_000;
  const rawDeltas = listUnprocessedTrajectoryDeltas(db, { ...(pid ? { projectId: pid } : {}), limit: 100 });
  const deltaProjects = new Set(rawDeltas.map((d) => d.projectId).filter((x): x is string => Boolean(x)));
  const deltaThreads = new Set(rawDeltas.map((d) => d.threadId).filter((x): x is string => Boolean(x)));
  const deltas = rawDeltas.map((d) => ({
    id: d.id, projectId: d.projectId, workflowId: d.workflowId, stageArchetype: d.stageArchetype,
    interventionKind: d.interventionKind, resolvedSkills: d.resolvedSkills, maskedSummary: d.maskedSummary,
  }));
  const rawEpisodes = listErrandEpisodeRows(db, sinceMs, pid, 400);
  const runIds = [...new Set(rawEpisodes.map((r) => String(r.run_id ?? "")).filter(Boolean))];
  const latestMap = runIds.length ? latestErrandEpisodeRows(db, runIds) : new Map<string, Record<string, unknown>>();
  const rows = latestMap.size ? [...latestMap.values()] : rawEpisodes;
  const digests = listPilotDayDigests(db, sinceMs, 400, pid);

  type EvidenceItem = { key: string; projectId: string | null; richPilotRun: boolean; categoryHint: PilotDayCategoryHint | null; goal: string; traps: string[]; lessons: string[]; skills: string[] };
  type ClusterAcc = { count: number; skills: Map<string, number>; goals: Set<string>; traps: Set<string>; lessons: Set<string>; categoryHint: PilotDayCategoryHint | null; richPilotRun: boolean };
  const newAcc = (): ClusterAcc => ({ count: 0, skills: new Map(), goals: new Set(), traps: new Set(), lessons: new Set(), categoryHint: null, richPilotRun: false });
  const merge = (acc: ClusterAcc, item: EvidenceItem, maxGoals: number, maxTraps: number, maxLessons: number) => {
    acc.count += 1;
    if (item.richPilotRun) acc.richPilotRun = true;
    if (!acc.categoryHint && item.categoryHint) acc.categoryHint = item.categoryHint;
    if (item.goal && acc.goals.size < maxGoals) acc.goals.add(item.goal);
    for (const t of item.traps) if (t && acc.traps.size < maxTraps) acc.traps.add(t);
    for (const l of item.lessons) if (l && acc.lessons.size < maxLessons) acc.lessons.add(l);
    for (const sk of item.skills) if (sk) acc.skills.set(sk, (acc.skills.get(sk) ?? 0) + 1);
  };

  const items: EvidenceItem[] = [];
  for (const row of rows) {
    if (row.enrichment_state !== "enriched") continue;
    const key = ((typeof row.process_key === "string" && row.process_key.trim()) || (typeof row.process_key_proposed === "string" && row.process_key_proposed.trim()) || "").trim();
    if (!key) continue;
    const summary = parseJson<Record<string, unknown>>(row.summary_json, {});
    const traps = (Array.isArray(summary.traps) ? summary.traps : []).filter((t): t is string => typeof t === "string" && t.trim().length > 0).map((t) => t.trim());
    const skills = (Array.isArray(summary.skills) ? summary.skills : []).flatMap((sk) => {
      const rec = sk && typeof sk === "object" ? (sk as { name?: unknown; read?: unknown; used?: unknown }) : null;
      return rec && (rec.read === true || rec.used === true) && typeof rec.name === "string" && rec.name.trim() ? [rec.name.trim()] : [];
    });
    items.push({ key, projectId: typeof row.project_id === "string" && row.project_id ? row.project_id : null, richPilotRun: false, categoryHint: null, goal: typeof summary.goal === "string" ? summary.goal.trim() : "", traps, lessons: [], skills });
  }
  for (const d of digests) {
    const key = d.processKey.trim();
    if (!key) continue;
    const hasDelta = (d.projectId !== null && deltaProjects.has(d.projectId)) || (d.threadId !== null && deltaThreads.has(d.threadId));
    items.push({
      key, projectId: d.projectId, richPilotRun: d.sourceKind === "pilot_run" && (d.taskCount >= 2 || (d.outcome === "done" && hasDelta)),
      categoryHint: d.categoryHint, goal: d.maskedGoal.trim(), traps: d.traps.map((t) => t.trim()).filter(Boolean),
      lessons: d.maskedLessons.map((l) => l.trim()).filter(Boolean), skills: d.skills.map((s) => s.trim()).filter(Boolean),
    });
  }

  const exact = new Map<string, ClusterAcc>();
  for (const item of items) {
    const acc = exact.get(item.key) ?? newAcc();
    exact.set(item.key, acc);
    merge(acc, item, 5, 8, 8);
  }
  const finalGroups = new Map<string, ClusterAcc>();
  for (const [k, g] of exact) if (g.count >= minCluster || g.richPilotRun) finalGroups.set(k, g);
  const singletons = items.filter((item) => !finalGroups.has(item.key));

  const famBuckets = new Map<string, EvidenceItem[]>();
  for (const item of singletons) { const f = domainFamilyOf(item.key, item.categoryHint); const l = famBuckets.get(f) ?? []; l.push(item); famBuckets.set(f, l); }
  let singletonMerged = 0;
  const leftover: EvidenceItem[] = [];
  const emitMerged = (key: string, fam: string, list: EvidenceItem[]) => {
    const acc = finalGroups.get(key) ?? newAcc();
    for (const i of list) merge(acc, i, 10, 12, 12);
    if (fam === "websites" && !acc.categoryHint) acc.categoryHint = { id: "websites", label: { en: "Websites & Design", ru: "Сайты и дизайн" } };
    finalGroups.set(key, acc);
    singletonMerged += list.length;
  };
  for (const [fam, list] of famBuckets) {
    if (list.length >= minCluster || list.some((i) => i.richPilotRun)) emitMerged(`${fam}|trajectory-suite`, fam, list);
    else leftover.push(...list);
  }
  const byProj = new Map<string, EvidenceItem[]>();
  for (const item of leftover) if (item.projectId) { const l = byProj.get(item.projectId) ?? []; l.push(item); byProj.set(item.projectId, l); }
  for (const list of byProj.values()) {
    if (list.length < minCluster) continue;
    const famCounts = new Map<string, number>();
    for (const i of list) { const f = domainFamilyOf(i.key, i.categoryHint); famCounts.set(f, (famCounts.get(f) ?? 0) + 1); }
    const dominant = [...famCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
    emitMerged(`${dominant}|project-trajectory`, dominant, list);
  }

  const clusters = [...finalGroups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12).map(([processKey, g]) => ({
    processKey, count: g.count, topSkills: [...g.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n),
    sampleGoals: [...g.goals], traps: [...g.traps], lessons: [...g.lessons], categoryHint: g.categoryHint,
  }));
  options?.log?.(`INFO [nightGraphs.graphEvolve] collected ${redactKnown(JSON.stringify({ projectId: pid, clusters: clusters.length, singletonMerged, deltas: deltas.length, digests: digests.length }))}`);
  return { clusters, deltas, deltaIds: deltas.map((d) => d.id), status: clusters.length || deltas.length ? "ready" : "empty" };
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

async function buildEvolveCatalogContext(ctx: ServerCore, collected: GraphEvolveCollectSummary): Promise<EvolveCatalogContext> {
  const catalogItems = (await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir: globalWorkflowDir() }).catch(() => null))?.list() ?? [];
  const knownCategories = collectKnownCategories(catalogItems, collected);
  const existingGlobal = catalogItems
    .filter((s) => s.origin === "global")
    .map((s) => ({ id: s.workflow.id, version: s.workflow.version, title: s.workflow.name, ...(s.workflow.category ? { category: s.workflow.category } : {}) }));
  const reservedBuiltinIds = BUILTIN_SOURCES.map((s) => String((s.value as { id?: unknown })?.id ?? "")).filter(Boolean);
  const availableSkills = (await loadDigestSkillCatalog(ctx)).map((s) => s.name).slice(0, 120);
  return {
    knownCategories, existingGlobal, reservedBuiltinIds, availableSkills,
    availablePlugins: ["image-studio", "browser-automation", "env-catalog"],
    availableMcp: ["metamcp", "gitnexus", "blender"],
  };
}

async function knownContextOf(ctx: ServerCore, collected: GraphEvolveCollectSummary) {
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

function readEvolveInputs(c: { resolve(ref: string): unknown }) {
  const rawProj = c.resolve("$inputs.project_id");
  const projectId = typeof rawProj === "string" && rawProj.trim() ? rawProj.trim() : null;
  const rawDays = Number(c.resolve("$inputs.lookback_days"));
  const lookbackDays = Number.isFinite(rawDays) && rawDays >= 1 ? Math.min(90, Math.floor(rawDays)) : 1;
  const collectDays = lookbackDays > 1 ? lookbackDays : 14;
  const rawPub = c.resolve("$inputs.publish_approved_suite");
  return { projectId, lookbackDays, collectDays, publishApprovedSuite: rawPub === true || rawPub === "true" };
}

/** Mounts nightly graph evolution executors (`lp.graph_evolve_*`) and daily cron `50 4 * * *`. */
export function mountGraphEvolveNightly(ctx: ServerCore, services: Services): void {
  const engine = services.workflowEngine;
  const emptyCollected: GraphEvolveCollectSummary = { clusters: [], deltas: [], deltaIds: [], status: "empty" };
  const hintOf = (projectId: string | null, collected: GraphEvolveCollectSummary) => projectId ?? collected.deltas.find((d) => d.projectId)?.projectId ?? null;

  engine.register<ChainRuntime>("lp.graph_evolve_digest", { reentrant: true, run: async (c) => {
    const { projectId, lookbackDays } = readEvolveInputs(c);
    const catalog = await loadDigestSkillCatalog(ctx);
    const result = await digestPilotDayDialogues(createLivePilotDayDigestDeps(ctx, services, () => ctx.isDisposed() || c.signal.aborted, catalog, { projectId, lookbackDays }));
    return { output: { status: "done", picked: result.picked, digested: result.digested, deltasRecorded: result.deltasRecorded, skipped: result.skippedSandbox + result.skippedDisabled, failed: result.failed } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_collect", { reentrant: true, run: async (c) => {
    const { projectId, collectDays } = readEvolveInputs(c);
    const collected = collectGraphEvolveEvidence(ctx.db, { projectId, days: collectDays, log: (m) => ctx.log(m) });
    return { output: { status: collected.status, clustersCount: collected.clusters.length, deltasCount: collected.deltas.length, payload_json: JSON.stringify(collected) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_plan", { reentrant: true, run: async (c) => {
    const { projectId } = readEvolveInputs(c);
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    if (collected.status === "empty") {
      const noopBp: ProcessBlueprint = { decision: "noop", rationale: "empty evidence", category: null, orderInvariants: [], variantParameters: [], requiredIntegrations: { mcp: [], plugins: [], skills: [] }, graphs: [] };
      return { output: { decision: "noop", graphsCount: 0, blueprint_json: JSON.stringify(noopBp) } };
    }
    const priorBlueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null);
    const criticFeedback = parseJson<EvolveReviewVerdict | null>(c.resolve("critique_plan.critique_json"), null);
    const catalog = await buildEvolveCatalogContext(ctx, collected);
    const blueprint = await planEvolutionBlueprint({
      collected, catalog, runRole: createLiveEvolveRoleRunner(ctx, services, hintOf(projectId, collected)),
      priorBlueprint, criticFeedback, iteration: priorBlueprint ? 2 : 1, log: (m) => ctx.log(m),
    });
    return { output: { decision: blueprint.decision, graphsCount: blueprint.graphs.length, blueprint_json: JSON.stringify(blueprint) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_critique", { reentrant: true, run: async (c) => {
    const { projectId } = readEvolveInputs(c);
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    const blueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null);
    if (!blueprint) return { output: { verdict: "rework", mustFixCount: 1, critique_json: JSON.stringify({ verdict: "rework", findings: ["Missing blueprint"], mustFix: ["Generate ProcessBlueprint"] }) } };
    const priorCritique = parseJson<EvolveReviewVerdict | null>(c.resolve("critique_plan.critique_json"), null);
    const catalog = await buildEvolveCatalogContext(ctx, collected);
    const critique = await critiqueEvolutionBlueprint({
      blueprint, collected, catalog, runRole: createLiveEvolveRoleRunner(ctx, services, hintOf(projectId, collected)),
      iteration: priorCritique ? 2 : 1, log: (m) => ctx.log(m),
    });
    return { output: { verdict: critique.verdict, mustFixCount: critique.mustFix.length, critique_json: JSON.stringify(critique) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_synthesize", { reentrant: true, run: async (c) => {
    const { projectId } = readEvolveInputs(c);
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    if (collected.status === "empty") return { output: { candidatesCount: 0, candidates_json: "[]" } };
    const blueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null);
    if (!blueprint || blueprint.decision === "noop" || !blueprint.graphs.length) return { output: { candidatesCount: 0, candidates_json: "[]" } };
    const priorCandidates = parseJson<GraphEvolveCandidate[]>(c.resolve("synthesize.candidates_json"), []);
    const auditFeedback = parseJson<EvolveReviewVerdict | null>(c.resolve("audit_suite.audit_json"), null);
    const iteration = priorCandidates.length || auditFeedback ? 2 : 1;
    const catalog = await buildEvolveCatalogContext(ctx, collected);
    const runRole = createLiveEvolveRoleRunner(ctx, services, hintOf(projectId, collected));
    const log = (m: string) => ctx.log(m);
    let candidates = await synthesizeSuiteFromBlueprint({
      blueprint, collected, catalog, runRole,
      ...(priorCandidates.length ? { priorCandidates } : {}), ...(auditFeedback ? { auditFeedback } : {}), iteration, log,
    });
    const knownContext = await knownContextOf(ctx, collected);
    const validation = await validateEvolveSuiteCandidates({ db: ctx.db, log, knownContext }, candidates);
    if (!validation.ok || (blueprint.graphs.length > 0 && candidates.length === 0)) {
      const errors = validation.errors.length ? validation.errors : ["workflow-architect returned 0 candidates for non-noop blueprint"];
      log(`WARN [nightGraphs.graphEvolve] synthesize_repair ${redactKnown(JSON.stringify({ iteration, errors: errors.slice(0, 6) }))}`);
      candidates = await synthesizeSuiteFromBlueprint({
        blueprint, collected, catalog, runRole, priorCandidates: candidates, validationErrors: errors,
        ...(auditFeedback ? { auditFeedback } : {}), iteration: iteration + 1, log,
      });
    }
    ctx.log(`INFO [nightGraphs.graphEvolve] synthesized ${redactKnown(JSON.stringify({ candidatesCount: candidates.length }))}`);
    return { output: { candidatesCount: candidates.length, candidates_json: JSON.stringify(candidates) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_audit", { reentrant: true, run: async (c) => {
    const { projectId } = readEvolveInputs(c);
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    const blueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null);
    const candidates = parseJson<GraphEvolveCandidate[]>(c.resolve("synthesize.candidates_json"), []);
    if (!candidates.length || !blueprint) return { output: { verdict: "pass", mustFixCount: 0, audit_json: "{}" } };
    const priorAudit = parseJson<EvolveReviewVerdict | null>(c.resolve("audit_suite.audit_json"), null);
    const audit = await auditSynthesizedSuite({
      blueprint, candidates, collected, runRole: createLiveEvolveRoleRunner(ctx, services, hintOf(projectId, collected)),
      iteration: priorAudit ? 2 : 1, log: (m) => ctx.log(m),
    });
    return { output: { verdict: audit.verdict, mustFixCount: audit.mustFix.length, audit_json: JSON.stringify(audit) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_apply", { reentrant: true, run: async (c) => {
    const { projectId, publishApprovedSuite } = readEvolveInputs(c);
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    const candidates = parseJson<GraphEvolveCandidate[]>(c.resolve("synthesize.candidates_json"), []);
    if (!candidates.length) return { output: { status: "held", publishedCount: 0, proposedCount: 0, rejectedCount: 0, summary: "graph-evolve: no candidates" } };
    const auditVerdict = String(c.resolve("audit_suite.verdict") ?? "");
    const applied = await applyGraphEvolveCandidates({
      db: ctx.db, log: (m) => ctx.log(m), knownContext: await knownContextOf(ctx, collected),
      invalidateCatalog: () => { services.workflowCatalog?.invalidate(); services.workflowTriggers?.syncSoon?.(projectId ?? "*"); },
    }, candidates, { deltaIds: collected.deltaIds, publishApprovedSuite: Boolean(publishApprovedSuite && auditVerdict === "pass") });
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
