// Nightly graph evolution evidence collection and workflow executor wiring (`lp.graph_evolve_*`).
import { redactKnown } from "@lane-pilot/kit";
import { globalSkillsDir, wfTerminalByIdemKey, type NodeExecutor, type StoredSkillBundleFile, type Workflow } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { listUnprocessedTrajectoryDeltas } from "../../errands";
import type { HarnessApi } from "../../harness/server";
import { scheduleIsolated, type WorkflowEngineApi, type WorkflowTriggersApi, type WriterHostApi } from "../../platform/server";
import type { RuleScanApi } from "../../self-repair/server";
import { globalWorkflowDir, latestErrandEpisodeRows, listErrandEpisodeRows, listPilotDayDigests, loadWorkflowStore, type PilotDayCategoryHint } from "../../storage";
import { BUILTIN_SOURCES, WORKFLOW_CATEGORIES } from "../../workflow";
import { validateLeanSuitePolicy } from "../lean-suite-policy";
import { readExistingCompanionSkills, type ExistingCompanionSkillInfo } from "./companion-skill-evolve";
import { MAX_GOLDEN_SKELETON_SECTIONS, type CompanionSkillCandidate } from "./companion-skill-merge";
import { auditSynthesizedSuite, createLiveEvolveRoleRunner, critiqueEvolutionBlueprint, planEvolutionBlueprint, synthesizeSuiteAndSkillsFromBlueprint, type EvolveCatalogContext, type EvolveReviewVerdict, type ExistingGlobalWorkflowSummary, type ProcessBlueprint } from "./graph-evolve-pipeline";
import { applyGraphEvolveCandidates, validateEvolveSuiteCandidates, type GraphEvolveCandidate, type GraphEvolveCollectSummary, type GraphEvolveDeps, type GraphEvolveOutcome } from "./graph-evolve-suite";
import { createLivePilotDayDigestDeps, digestPilotDayDialogues, loadDigestSkillCatalog } from "./pilot-day-digest";
import type { ArtifactSkeleton } from "./pilot-day-skeleton";

export const GRAPH_EVOLVE_WORKFLOW = "lp.graph-evolve-nightly";
export const GRAPH_EVOLVE_SCHEDULE = "graph-evolve-nightly";
export const GRAPH_EVOLVE_CRON = "50 4 * * *";
export { applyGraphEvolveCandidates, validateEvolveSuiteCandidates, type GraphEvolveCandidate, type GraphEvolveCollectSummary, type GraphEvolveDeps, type GraphEvolveOutcome };

interface Services {
  harness?: Pick<HarnessApi, "threadEvents">;
  resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"];
  ruleScan: Pick<RuleScanApi, "runAnalyzer">;
  workflowEngine: WorkflowEngineApi["workflowEngine"];
  workflowCatalog?: WorkflowEngineApi["workflowCatalog"];
  workflowTriggers?: WorkflowTriggersApi["workflowTriggers"];
}

const parseJson = <T,>(raw: unknown, fallback: T): T => { try { return typeof raw === "string" && raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; } };
export type SynthesizedPayload = { candidates: GraphEvolveCandidate[]; companionSkills: CompanionSkillCandidate[]; operator?: string; supersededWorkflowIds?: string[] };

/** Parses either `{ candidates, companionSkills, operator, supersededWorkflowIds }` or legacy `GraphEvolveCandidate[]`. */
export function parseSynthesizedPayload(raw: unknown): SynthesizedPayload {
  const parsed = typeof raw === "string" ? parseJson<unknown>(raw, null) : raw;
  if (Array.isArray(parsed)) return { candidates: parsed as GraphEvolveCandidate[], companionSkills: [] };
  if (!parsed || typeof parsed !== "object") return { candidates: [], companionSkills: [] };
  const r = parsed as Record<string, unknown>;
  return {
    candidates: Array.isArray(r.candidates) ? (r.candidates as GraphEvolveCandidate[]) : [],
    companionSkills: Array.isArray(r.companionSkills) ? (r.companionSkills as CompanionSkillCandidate[]) : [],
    ...(typeof r.operator === "string" && r.operator ? { operator: r.operator } : {}),
    ...(Array.isArray(r.supersededWorkflowIds) ? { supersededWorkflowIds: r.supersededWorkflowIds.filter((s): s is string => typeof s === "string") } : {}),
  };
}

function domainFamilyOf(processKey: string, categoryHint?: PilotDayCategoryHint | null): string {
  if (categoryHint?.id === "websites") return "websites";
  const prefix = (processKey.split("|")[0] ?? "").trim().toLowerCase();
  if (/^(?:website|web-design|website-design.*|site|landing|pen-design|pencil|figma|ui-kit|image-studio|competitor.*|personal-brand.*)$/.test(prefix)) return "websites";
  if (/^seo(?:-|$)/.test(prefix)) return "seo";
  if (/^(?:mkt|marketing|ads|cro)(?:-|$)/.test(prefix)) return "marketing";
  if (/^(?:video|audio|voice)(?:-|$)/.test(prefix)) return "media";
  return prefix || "general";
}

function deltaFamilyOf(workflowId: string | null, wfCatById: ReadonlyMap<string, string>): string | null {
  const wid = workflowId?.trim().toLowerCase();
  if (!wid) return null;
  const cat = wfCatById.get(wid);
  if (cat) return domainFamilyOf(cat, { id: cat });
  const head = wid.split(/[-_.]/)[0] ?? "";
  const fam = domainFamilyOf(head);
  if (fam !== head) return fam;
  return /(?:landing|website|web|uikit|ui-kit|cms|design)/.test(wid) ? "websites" : (fam || null);
}

type LeanDebtBucket = { catId: string; category: PilotDayCategoryHint | null; wfIds: Set<string>; summaries: string[]; topSkills: Set<string> };

function evalGlobalLeanViolations(wfs: ReadonlyArray<{ workflow: Workflow }>) {
  if (!wfs.length) return { violations: [], byWf: new Map<string, string[]>() };
  const res = validateLeanSuitePolicy(wfs.map((s) => ({ workflowId: s.workflow.id, scope: "global" as const, definition: s.workflow as unknown as Record<string, unknown> })));
  const byWf = new Map<string, string[]>();
  for (const v of res.violations) {
    const list = byWf.get(v.workflowId) ?? [];
    list.push(`${v.code}${v.nodeId ? `(${v.nodeId})` : ""}: ${v.detail}`);
    byWf.set(v.workflowId, list);
  }
  return { violations: res.violations, byWf };
}

function collectLeanDebt(globalWfs: ReadonlyArray<{ workflow: Workflow }> | undefined, skills: ReadonlyArray<ExistingCompanionSkillInfo> | undefined) {
  const wfs = globalWfs ?? [], wfById = new Map(wfs.map((s) => [s.workflow.id, s.workflow]));
  const wfCatById = new Map<string, string>(wfs.flatMap((s) => s.workflow.category?.id ? [[s.workflow.id.toLowerCase(), s.workflow.category.id] as const] : []));
  const { violations } = evalGlobalLeanViolations(wfs);
  const bloatedSkills = (skills ?? []).filter((s) => s.hasSemanticDuplicates || s.sectionCount > MAX_GOLDEN_SKELETON_SECTIONS);
  const leanDebtCount = violations.length + bloatedSkills.length, debtByFamily = new Map<string, LeanDebtBucket>();
  if (leanDebtCount === 0) return { leanDebtCount, debtByFamily, wfCatById };
  const ensureBucket = (wf?: Workflow): LeanDebtBucket => {
    const catId = wf?.category?.id ?? "websites", fam = domainFamilyOf(catId, wf?.category ?? null);
    let b = debtByFamily.get(fam);
    if (!b) { b = { catId, category: wf?.category ?? null, wfIds: new Set(), summaries: [], topSkills: new Set() }; debtByFamily.set(fam, b); }
    return b;
  };
  for (const v of violations) { const b = ensureBucket(wfById.get(v.workflowId)); b.wfIds.add(v.workflowId); b.summaries.push(`${v.workflowId}: ${v.code}${v.nodeId ? `(${v.nodeId})` : ""}: ${v.detail}`); }
  for (const bs of bloatedSkills) {
    const owner = wfs.find((s) => s.workflow.requires.skills.includes(bs.skillId) || s.workflow.nodes.some((n) => n.type === "agent" && n.skills.includes(bs.skillId)))?.workflow ?? wfs[0]?.workflow;
    const b = ensureBucket(owner);
    b.topSkills.add(bs.skillId);
    b.summaries.push(`${bs.skillId}: bloated companion skill (sections=${bs.sectionCount}, coreRules=${bs.coreRuleCount}, dup=${bs.hasSemanticDuplicates})`);
  }
  return { leanDebtCount, debtByFamily, wfCatById };
}

/** Collects enriched process clusters (errand episodes + daily Pilot digests) and unprocessed trajectory deltas for nightly graph evolution. */
export function collectGraphEvolveEvidence(
  db: ServerCore["db"],
  options?: { days?: number; minClusterSize?: number; projectId?: string | null; existingGlobalWorkflows?: ReadonlyArray<{ workflow: Workflow }>; existingCompanionSkills?: ReadonlyArray<ExistingCompanionSkillInfo>; now?: () => number; log?: (message: string) => void },
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
  const overConstraintDeltas = deltas.filter((d) => d.interventionKind === "over_constraint");
  const { leanDebtCount, debtByFamily, wfCatById } = collectLeanDebt(options?.existingGlobalWorkflows, options?.existingCompanionSkills);
  const rawEpisodes = listErrandEpisodeRows(db, sinceMs, pid, 400);
  const runIds = [...new Set(rawEpisodes.map((r) => String(r.run_id ?? "")).filter(Boolean))];
  const latestMap = runIds.length ? latestErrandEpisodeRows(db, runIds) : new Map<string, Record<string, unknown>>();
  const rows = latestMap.size ? [...latestMap.values()] : rawEpisodes;
  const digests = listPilotDayDigests(db, sinceMs, 400, pid);

  type EvidenceItem = { key: string; projectId: string | null; richPilotRun: boolean; categoryHint: PilotDayCategoryHint | null; archetypeHint: string | null; artifactSkeleton: ArtifactSkeleton | null; goal: string; traps: string[]; lessons: string[]; skills: string[] };
  type ClusterAcc = { count: number; projectIds: Set<string>; skills: Map<string, number>; goals: Set<string>; traps: Set<string>; lessons: Set<string>; categoryHint: PilotDayCategoryHint | null; archetypes: Set<string>; skeletons: Map<string, ArtifactSkeleton>; richPilotRun: boolean };
  const newAcc = (): ClusterAcc => ({ count: 0, projectIds: new Set(), skills: new Map(), goals: new Set(), traps: new Set(), lessons: new Set(), categoryHint: null, archetypes: new Set(), skeletons: new Map(), richPilotRun: false });
  const merge = (acc: ClusterAcc, item: EvidenceItem, maxGoals: number, maxTraps: number, maxLessons: number) => {
    acc.count += 1;
    if (item.projectId) acc.projectIds.add(item.projectId);
    if (item.richPilotRun) acc.richPilotRun = true;
    if (!acc.categoryHint && item.categoryHint) acc.categoryHint = item.categoryHint;
    if (item.archetypeHint && acc.archetypes.size < 8) acc.archetypes.add(item.archetypeHint);
    if (item.artifactSkeleton && acc.skeletons.size < 6) {
      const skKey = `${item.artifactSkeleton.deliverableClass}:${item.artifactSkeleton.sections.join("|")}`;
      if (!acc.skeletons.has(skKey)) acc.skeletons.set(skKey, item.artifactSkeleton);
    }
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
    items.push({ key, projectId: typeof row.project_id === "string" && row.project_id ? row.project_id : null, richPilotRun: false, categoryHint: null, archetypeHint: null, artifactSkeleton: null, goal: typeof summary.goal === "string" ? summary.goal.trim() : "", traps, lessons: [], skills });
  }
  for (const d of digests) {
    const key = d.processKey.trim();
    if (!key) continue;
    const hasDelta = (d.projectId !== null && deltaProjects.has(d.projectId)) || (d.threadId !== null && deltaThreads.has(d.threadId));
    items.push({
      key, projectId: d.projectId, richPilotRun: d.sourceKind === "pilot_run" && (d.taskCount >= 2 || (d.outcome === "done" && hasDelta)),
      categoryHint: d.categoryHint, archetypeHint: d.archetypeHint?.trim() || null, artifactSkeleton: d.artifactSkeleton ?? null,
      goal: d.maskedGoal.trim(), traps: d.traps.map((t) => t.trim()).filter(Boolean),
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

  const attachedDebt = new Set<string>();
  const clusters: GraphEvolveCollectSummary["clusters"] = [...finalGroups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 12).map(([processKey, g]) => {
    const artifactSkeletons = [...g.skeletons.values()], archetypeHints = [...g.archetypes], fam = domainFamilyOf(processKey, g.categoryHint);
    const matchedDeltas = overConstraintDeltas.filter((d) => (d.projectId && g.projectIds.has(d.projectId)) || deltaFamilyOf(d.workflowId, wfCatById) === fam);
    const debt = debtByFamily.get(fam);
    if (debt) attachedDebt.add(fam);
    const frictionSignals = [...new Set([...matchedDeltas.map((d) => d.maskedSummary), ...(debt?.summaries.slice(0, 8) ?? [])])].slice(0, 12);
    const overConstraintCount = matchedDeltas.length + (debt?.summaries.length ?? 0), leanViolations = debt?.summaries.slice(0, 12) ?? [];
    return {
      processKey, count: g.count, topSkills: [...g.skills.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([n]) => n),
      sampleGoals: [...g.goals], traps: [...g.traps], lessons: [...g.lessons], categoryHint: g.categoryHint,
      ...(artifactSkeletons.length ? { artifactSkeletons } : {}), ...(archetypeHints.length ? { archetypeHints } : {}),
      ...(overConstraintCount > 0 ? { overConstraintCount } : {}), ...(frictionSignals.length ? { frictionSignals } : {}),
      ...(leanViolations.length ? { leanViolations } : {}),
    };
  });
  for (const [fam, debt] of debtByFamily) {
    if (attachedDebt.has(fam) || clusters.length >= 12) continue;
    const matchedDeltas = overConstraintDeltas.filter((d) => deltaFamilyOf(d.workflowId, wfCatById) === fam);
    const frictionSignals = [...new Set([...matchedDeltas.map((d) => d.maskedSummary), ...debt.summaries.slice(0, 8)])].slice(0, 12);
    clusters.push({
      processKey: `${debt.catId}|lean-self-regulation`, count: Math.max(1, debt.wfIds.size), topSkills: [...debt.topSkills],
      sampleGoals: [`Self-regulate published ${debt.catId} workflows and companion skills to satisfy lean suite policy`],
      traps: debt.summaries.slice(0, 8),
      lessons: ["Convert niche stages to skip_when + skip_out, add bypassable skip on human gates, generalize narrow owns_paths to **, add scope_tier + variant_lean + chat triggers, and compact duplicate companion skill sections"],
      categoryHint: debt.category, overConstraintCount: matchedDeltas.length + debt.summaries.length, frictionSignals, leanViolations: debt.summaries.slice(0, 12),
    });
  }
  const clustersWithFriction = clusters.filter((c) => (c.overConstraintCount ?? 0) > 0 || (c.leanViolations?.length ?? 0) > 0).length;
  options?.log?.(`INFO [nightGraphs.graphEvolve] collected ${redactKnown(JSON.stringify({ projectId: pid, clusters: clusters.length, singletonMerged, deltas: deltas.length, digests: digests.length, overConstraintDeltas: overConstraintDeltas.length, clustersWithFriction, leanDebtCount }))}`);
  return { clusters, deltas, deltaIds: deltas.map((d) => d.id), status: clusters.length || deltas.length || leanDebtCount > 0 ? "ready" : "empty", leanDebtCount };
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

async function buildEvolveCatalogContext(
  ctx: ServerCore,
  collected: GraphEvolveCollectSummary,
): Promise<{ catalog: EvolveCatalogContext; existingSkillBundles: Map<string, StoredSkillBundleFile[]> }> {
  const catalogItems = (await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir: globalWorkflowDir() }).catch(() => null))?.list() ?? [];
  const knownCategories = collectKnownCategories(catalogItems, collected);
  const globalItems = catalogItems.filter((s) => s.origin === "global");
  const leanByWf = evalGlobalLeanViolations(globalItems).byWf;
  const existingGlobal: ExistingGlobalWorkflowSummary[] = globalItems.map((s) => {
    const wf = s.workflow, leanViolations = leanByWf.get(wf.id) ?? [];
    return {
      id: wf.id, version: wf.version, title: wf.name, ...(wf.category ? { category: wf.category } : {}),
      triggers: wf.triggers.map((t) => t.type),
      inputs: wf.inputs.map((f) => `${f.name}:${f.type}${f.required ? "!" : ""}`),
      outputs: wf.outputs.map((f) => `${f.name}:${f.type}`),
      nodes: wf.nodes.filter((n) => n.type !== "note").map((n) => ({
        id: n.id, type: n.type,
        ...(n.skip_when ? { skipWhen: typeof n.skip_when === "string" ? n.skip_when : JSON.stringify(n.skip_when) } : {}),
        ...(n.type === "lp-task" ? { ownsPaths: n.owns_paths } : {}),
        ...(n.type === "human" ? { options: n.options } : {}),
        ...(n.type === "subworkflow" ? { workflow: n.workflow } : {}),
      })),
      ...(leanViolations.length ? { leanViolations } : {}),
    };
  });
  const reservedBuiltinIds = BUILTIN_SOURCES.map((s) => String((s.value as { id?: unknown })?.id ?? "")).filter(Boolean);
  const availableSkills = (await loadDigestSkillCatalog(ctx)).map((s) => s.name).slice(0, 120);
  const { existingCompanionSkills, existingSkillBundles } = await readExistingCompanionSkills(globalSkillsDir());
  return {
    catalog: {
      knownCategories, existingGlobal, reservedBuiltinIds, availableSkills, existingCompanionSkills,
      availablePlugins: ["image-studio", "browser-automation", "env-catalog"], availableMcp: ["metamcp", "gitnexus", "blender"],
    },
    existingSkillBundles,
  };
}

function isLeanAwareBlueprint(blueprint: ProcessBlueprint, collected: GraphEvolveCollectSummary): boolean {
  return blueprint.operator === "prune_or_relax"
    || collected.deltas.some((d) => d.interventionKind === "over_constraint")
    || (collected.leanDebtCount ?? 0) > 0
    || blueprint.graphs.some((g) => g.standaloneChat !== undefined || "scope_tier" in g.inputs || g.stages.some((s) => s.necessity !== undefined));
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
    const store = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, globalDir: globalWorkflowDir() }).catch(() => null);
    const existingGlobalWorkflows = (store?.list() ?? []).filter((s) => s.origin === "global");
    const { existingCompanionSkills } = await readExistingCompanionSkills(globalSkillsDir());
    const collected = collectGraphEvolveEvidence(ctx.db, { projectId, days: collectDays, existingGlobalWorkflows, existingCompanionSkills, log: (m) => ctx.log(m) });
    return { output: { status: collected.status, clustersCount: collected.clusters.length, deltasCount: collected.deltas.length, payload_json: JSON.stringify(collected) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_plan", { reentrant: true, run: async (c) => {
    const { projectId } = readEvolveInputs(c), collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    if (collected.status === "empty") {
      const noopBp: ProcessBlueprint = { decision: "noop", rationale: "empty evidence", category: null, orderInvariants: [], variantParameters: [], requiredIntegrations: { mcp: [], plugins: [], skills: [] }, graphs: [] };
      return { output: { decision: "noop", graphsCount: 0, blueprint_json: JSON.stringify(noopBp) } };
    }
    const priorBlueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null), criticFeedback = parseJson<EvolveReviewVerdict | null>(c.resolve("critique_plan.critique_json"), null);
    const { catalog } = await buildEvolveCatalogContext(ctx, collected);
    const blueprint = await planEvolutionBlueprint({ collected, catalog, runRole: createLiveEvolveRoleRunner(ctx, services, hintOf(projectId, collected)), priorBlueprint, criticFeedback, iteration: priorBlueprint ? 2 : 1, log: (m) => ctx.log(m) });
    return { output: { decision: blueprint.decision, graphsCount: blueprint.graphs.length, blueprint_json: JSON.stringify(blueprint) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_critique", { reentrant: true, run: async (c) => {
    const { projectId } = readEvolveInputs(c), collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    const blueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null);
    if (!blueprint) return { output: { verdict: "rework", mustFixCount: 1, critique_json: JSON.stringify({ verdict: "rework", findings: ["Missing blueprint"], mustFix: ["Generate ProcessBlueprint"] }) } };
    const priorCritique = parseJson<EvolveReviewVerdict | null>(c.resolve("critique_plan.critique_json"), null);
    const { catalog } = await buildEvolveCatalogContext(ctx, collected);
    const critique = await critiqueEvolutionBlueprint({ blueprint, collected, catalog, runRole: createLiveEvolveRoleRunner(ctx, services, hintOf(projectId, collected)), iteration: priorCritique ? 2 : 1, log: (m) => ctx.log(m) });
    return { output: { verdict: critique.verdict, mustFixCount: critique.mustFix.length, critique_json: JSON.stringify(critique) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_synthesize", { reentrant: true, run: async (c) => {
    const { projectId } = readEvolveInputs(c);
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    if (collected.status === "empty") return { output: { candidatesCount: 0, candidates_json: "[]" } };
    const blueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null);
    if (!blueprint || blueprint.decision === "noop" || (!blueprint.graphs.length && !(blueprint.companionSkills?.length))) return { output: { candidatesCount: 0, candidates_json: "[]" } };
    const prior = parseSynthesizedPayload(c.resolve("synthesize.candidates_json"));
    const auditFeedback = parseJson<EvolveReviewVerdict | null>(c.resolve("audit_suite.audit_json"), null);
    const iteration = prior.candidates.length || prior.companionSkills.length || auditFeedback ? 2 : 1;
    const { catalog, existingSkillBundles } = await buildEvolveCatalogContext(ctx, collected);
    const runRole = createLiveEvolveRoleRunner(ctx, services, hintOf(projectId, collected));
    const log = (m: string) => ctx.log(m);
    let synth = await synthesizeSuiteAndSkillsFromBlueprint({
      blueprint, collected, catalog, runRole, existingSkillBundles,
      ...(prior.candidates.length ? { priorCandidates: prior.candidates } : {}), ...(auditFeedback ? { auditFeedback } : {}), iteration, log,
    });
    const knownContext = await knownContextOf(ctx, collected), enforceLean = isLeanAwareBlueprint(blueprint, collected);
    const valOpts = (s: typeof synth) => ({ companionSkills: s.companionSkills, ...(enforceLean ? { blueprint, enforceLeanPolicy: true } : {}) });
    const validation = await validateEvolveSuiteCandidates({ db: ctx.db, log, knownContext }, synth.candidates, valOpts(synth));
    if (!validation.ok || (blueprint.graphs.length > 0 && synth.candidates.length === 0)) {
      const errors = validation.errors.length ? validation.errors : ["workflow-architect returned 0 candidates for non-noop blueprint"];
      log(`WARN [nightGraphs.graphEvolve] synthesize_repair ${redactKnown(JSON.stringify({ iteration, errors: errors.slice(0, 6) }))}`);
      synth = await synthesizeSuiteAndSkillsFromBlueprint({
        blueprint, collected, catalog, runRole, existingSkillBundles, priorCandidates: synth.candidates, validationErrors: errors,
        ...(auditFeedback ? { auditFeedback } : {}), iteration: iteration + 1, log,
      });
      const recheck = await validateEvolveSuiteCandidates({ db: ctx.db, log, knownContext }, synth.candidates, valOpts(synth));
      log(`INFO [nightGraphs.graphEvolve] post_repair_validated ${redactKnown(JSON.stringify({ ok: recheck.ok, errorsCount: recheck.errors.length }))}`);
    }
    const payload = { candidates: synth.candidates, companionSkills: synth.companionSkills, operator: blueprint.operator, supersededWorkflowIds: synth.supersededWorkflowIds };
    ctx.log(`INFO [nightGraphs.graphEvolve] synthesized ${redactKnown(JSON.stringify({ candidatesCount: synth.candidates.length, companionSkillsCount: synth.companionSkills.length }))}`);
    return { output: { candidatesCount: synth.candidates.length, candidates_json: JSON.stringify(payload) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_audit", { reentrant: true, run: async (c) => {
    const { projectId } = readEvolveInputs(c);
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    const blueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null);
    const { candidates, companionSkills } = parseSynthesizedPayload(c.resolve("synthesize.candidates_json"));
    if (!candidates.length || !blueprint) return { output: { verdict: "pass", mustFixCount: 0, audit_json: "{}" } };
    const priorAudit = parseJson<EvolveReviewVerdict | null>(c.resolve("audit_suite.audit_json"), null);
    const { existingSkillBundles } = await readExistingCompanionSkills(globalSkillsDir());
    const enforceLeanPolicy = isLeanAwareBlueprint(blueprint, collected);
    const audit = await auditSynthesizedSuite({
      blueprint, candidates, companionSkills, existingSkillBundles, collected, enforceLeanPolicy,
      runRole: createLiveEvolveRoleRunner(ctx, services, hintOf(projectId, collected)),
      iteration: priorAudit ? 2 : 1, log: (m) => ctx.log(m),
    });
    return { output: { verdict: audit.verdict, mustFixCount: audit.mustFix.length, audit_json: JSON.stringify(audit) } };
  } } as NodeExecutor<ChainRuntime>);

  engine.register<ChainRuntime>("lp.graph_evolve_apply", { reentrant: true, run: async (c) => {
    const { projectId, publishApprovedSuite } = readEvolveInputs(c);
    const collected = parseJson<GraphEvolveCollectSummary>(c.resolve("collect.payload_json"), emptyCollected);
    const blueprint = parseJson<ProcessBlueprint | null>(c.resolve("plan_blueprint.blueprint_json"), null);
    const { candidates, companionSkills, operator, supersededWorkflowIds } = parseSynthesizedPayload(c.resolve("synthesize.candidates_json"));
    if (!candidates.length) return { output: { status: "held", publishedCount: 0, proposedCount: 0, rejectedCount: 0, summary: "graph-evolve: no candidates" } };
    const rawVerdict = c.resolve("audit_suite.verdict");
    const auditVerdict = typeof rawVerdict === "string" ? rawVerdict : "";
    const enforceLean = blueprint ? isLeanAwareBlueprint(blueprint, collected) : false;
    const applied = await applyGraphEvolveCandidates({
      db: ctx.db, log: (m) => ctx.log(m), knownContext: await knownContextOf(ctx, collected),
      invalidateCatalog: () => { services.workflowCatalog?.invalidate(); services.workflowTriggers?.syncSoon?.(projectId ?? "*"); },
    }, candidates, {
      deltaIds: collected.deltaIds, publishApprovedSuite, auditVerdict, companionSkills, operator, supersededWorkflowIds,
      ...(enforceLean ? { blueprint, enforceLeanPolicy: true } : {}),
    });
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
