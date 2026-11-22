import { redactKnown } from "@lane-pilot/kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { sortSkillBundleFiles, type SkillBundleFile } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../contracts/server";
import { modelCatalogOf, readProviderFolderBlock, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, type WriterHostApi } from "../../platform/server";
import type { RuleScanApi } from "../../self-repair/server";
import { isAllowedBroadCategoryId, validateCategoryAndIdentityGeneralization } from "../category-taxonomy";
import { MAX_PHASE_GRAPH_EXECUTABLE_NODES, MAX_PHASE_GRAPH_HUMAN_GATES, validateLeanSuitePolicy } from "../lean-suite-policy";
import {
  bilingual, normalizeBlueprint, normalizeCompanionSkillSpec, parseJsonBlock, resolveBlueprintOperator, str, strList,
  type CompanionArchetypeOverlaySpec, type CompanionSkillSpec, type EvolutionOperator, type NormalizedProcessBlueprint,
  type ProcessBlueprint, type ProcessBlueprintGraphSpec, type ProcessBlueprintStageSpec,
} from "../process-blueprint";
import {
  MAX_GOLDEN_SKELETON_SECTIONS, lintAndVerifyCompanionSkill, renderCompanionSkillBundle, verifyNonDestructiveSkillMerge,
  type CompanionSkillCandidate, type NonDestructiveMergeVerdict,
} from "./companion-skill-merge";
import { analystPlace } from "./episodes-graph";
import type { GraphEvolveCandidate, GraphEvolveCollectSummary } from "./graph-evolve-graph";
import { buildArchitectPrompt, buildAuditorPrompt, buildPlanCriticPrompt, buildPlannerPrompt } from "./graph-evolve-prompts";
import type { ArtifactSkeleton } from "./pilot-day-skeleton";

export {
  normalizeBlueprint, resolveBlueprintOperator,
  type CompanionArchetypeOverlaySpec, type CompanionSkillSpec, type EvolutionOperator, type NormalizedProcessBlueprint,
  type ProcessBlueprint, type ProcessBlueprintGraphSpec, type ProcessBlueprintStageSpec,
};
export {
  lintAndVerifyCompanionSkill, renderCompanionSkillBundle, verifyNonDestructiveSkillMerge,
  type CompanionSkillCandidate, type NonDestructiveMergeVerdict,
};

export type EvolveRole = "planner" | "plan-critic" | "workflow-architect" | "auditor";
export type EvolveRoleRunner = (role: EvolveRole, prompt: string, stepKey: string) => Promise<string>;
export type EvolveReviewVerdict = { verdict: "pass" | "rework"; findings: string[]; mustFix: string[] };
export type EvolveClusterSummary = GraphEvolveCollectSummary["clusters"][number] & {
  artifactSkeletons?: ArtifactSkeleton[]; archetypeHints?: string[];
  overConstraintCount?: number; frictionSignals?: string[]; leanViolations?: string[];
};
export type EvolveCollectInput = Omit<GraphEvolveCollectSummary, "clusters"> & { clusters: EvolveClusterSummary[] };

export type ExistingGlobalWorkflowSummary = {
  id: string; version: number; title: unknown; category?: unknown;
  triggers?: string[]; inputs?: string[]; outputs?: string[];
  nodes?: Array<{ id: string; type: string; skipWhen?: string; ownsPaths?: string[]; options?: string[]; workflow?: string }>;
  leanViolations?: string[];
};

export type EvolveCatalogContext = {
  knownCategories: ReadonlyArray<{ id: string; label?: { en: string; ru: string } }>;
  existingGlobal: ReadonlyArray<ExistingGlobalWorkflowSummary>;
  reservedBuiltinIds: readonly string[];
  availableSkills?: readonly string[]; availablePlugins?: readonly string[]; availableMcp?: readonly string[];
  existingCompanionSkills?: ReadonlyArray<{
    skillId: string; archetypes: string[]; sectionCount: number;
    goldenSectionTitles?: string[]; coreRuleCount?: number; hasSemanticDuplicates?: boolean;
  }>;
};

export type SynthesizeSuiteResult = { candidates: GraphEvolveCandidate[]; companionSkills: CompanionSkillCandidate[]; supersededWorkflowIds: string[] };

const evolveRooms = new Map<string, string>();
const verdictList = (v: unknown): string[] => Array.isArray(v)
  ? v.flatMap((x) => typeof x === "string" && x.trim() ? [x.trim()] : (x && typeof x === "object" ? [JSON.stringify(x)] : []))
  : [];

function normalizeVerdict(text: string): EvolveReviewVerdict {
  const raw = parseJsonBlock(text);
  if (!raw) return { verdict: "rework", findings: ["Reviewer did not return valid JSON"], mustFix: ["Return valid JSON {verdict, findings, mustFix}"] };
  const verdict = typeof raw.verdict === "string" && raw.verdict.trim().toLowerCase() === "pass" ? "pass" : "rework";
  const findings = verdictList(raw.findings), mustFix = verdictList(raw.mustFix);
  return { verdict: verdict === "pass" && mustFix.length === 0 ? "pass" : "rework", findings, mustFix };
}

function categoryIdOf(cat: unknown): string | null {
  if (typeof cat === "string") return cat.trim().toLowerCase() || null;
  if (cat && typeof cat === "object" && !Array.isArray(cat)) {
    const id = (cat as { id?: unknown }).id;
    if (typeof id === "string") return id.trim().toLowerCase() || null;
  }
  return null;
}

const isControlStage = (s: ProcessBlueprintStageSpec): boolean =>
  s.nodeType === "action" && (/^(?:save[_-]?state|save[_-]?process[_-]?state|emit|done)$/i.test(s.id) || /\b(?:lp\.save_process_state|emit)\b/i.test(`${s.id} ${s.purpose}`));

/** Creates a live runner executing each evolution role in `$HOME/.lane-pilot/graph-evolve` via `resolveSpawnModel` + `runAnalyzer`. */
export function createLiveEvolveRoleRunner(
  ctx: ServerCore,
  services: { resolveProjectWriterHost: WriterHostApi["resolveProjectWriterHost"]; ruleScan: Pick<RuleScanApi, "runAnalyzer"> },
  projectIdHint: string | null,
): EvolveRoleRunner {
  return async (role, prompt, stepKey) => {
    const hint = projectIdHint?.trim() || null;
    const { place, projectId: threadProject } = await analystPlace(ctx.db, hint, (id) =>
      services.resolveProjectWriterHost({ projectId: id } as never).catch((cause: unknown) => {
        ctx.log(`WARN [nightGraphs.evolvePipeline] host_lookup ${cause instanceof Error ? cause.message : String(cause)}`);
        return null;
      }),
    );
    if (!place || (place as { status?: string }).status !== "resolved") throw new Error("graph_evolve_no_host");
    const project = place as { hostId: string; path: string };
    let room = evolveRooms.get(project.hostId);
    if (!room) {
      const made = await ctx.host.call("runCommand", {
        requestedHostId: project.hostId, cwd: project.path, timeoutSec: 30,
        command: 'mkdir -p "$HOME/.lane-pilot/graph-evolve" && cd "$HOME/.lane-pilot/graph-evolve" && pwd',
      }, { hostId: project.hostId, timeoutMs: 40_000 }) as { exitCode: number; stdout: string };
      room = made.exitCode === 0 ? made.stdout.trim().split("\n").at(-1) : undefined;
      if (!room) throw new Error("graph_evolve_no_empty_room");
      evolveRooms.set(project.hostId, room);
    }
    const host = { hostId: project.hostId, path: room };
    const settings = (await ctx.effectiveProjectSettings(hint ?? GLOBAL_SETTINGS_PROJECT_ID).catch(() => null))?.values ?? {};
    const spawnUsage = spawnUsageOf(ctx);
    await warmSpawnUsage(spawnUsage, host.hostId);
    const folderBlock = await readProviderFolderBlock(ctx.bb.storage.kv, host.hostId);
    const sel = resolveSpawnModel({
      role, settings, catalog: modelCatalogOf(ctx).peek(), usage: spawnUsage,
      hostId: host.hostId, envPath: host.path, folderBlock,
    });
    ctx.log(`INFO [nightGraphs.evolvePipeline] role_selected ${redactKnown(JSON.stringify({
      stepKey, role, providerId: sel.providerId, model: sel.model, reasoningLevel: sel.reasoningEffort,
    }))}`);
    return services.ruleScan.runAnalyzer(
      threadProject ?? "*", `graph-evolve:${role}:${stepKey}`, prompt, host,
      { providerId: sel.providerId, model: sel.model, reasoningLevel: sel.reasoningEffort, serviceTier: sel.serviceTier },
      { graphEvolve: true, evolveStep: stepKey, evolveRole: role }, role,
    ).catch((err: unknown) => { evolveRooms.delete(project.hostId); throw err; });
  };
}

/** Stage 1 (`planner`): plans an AFlow-operator `ProcessBlueprint` + paired `companionSkills` from masked trajectories. */
export async function planEvolutionBlueprint(input: {
  collected: EvolveCollectInput; catalog: EvolveCatalogContext; runRole: EvolveRoleRunner;
  priorBlueprint?: ProcessBlueprint | null; criticFeedback?: EvolveReviewVerdict | null;
  iteration?: number; log?: (message: string) => void;
}): Promise<NormalizedProcessBlueprint> {
  const iteration = input.iteration ?? 1;
  const prompt = buildPlannerPrompt({ collected: input.collected, catalog: input.catalog, priorBlueprint: input.priorBlueprint, criticFeedback: input.criticFeedback });
  const parsed = parseJsonBlock(await input.runRole("planner", prompt, `plan-${iteration}`));
  if (!parsed) throw new Error("graph_evolve_planner_not_json");
  const blueprint = normalizeBlueprint(parsed);
  const orchestrators = blueprint.graphs.filter((g) => g.kind === "master_orchestrator").length;
  input.log?.(`INFO [nightGraphs.pipeline] operator_selected ${redactKnown(JSON.stringify({
    iteration, operator: blueprint.operator, targetWorkflowIds: blueprint.graphs.map((g) => g.workflowId),
    targetSkillIds: blueprint.companionSkills.map((s) => s.skillId), supersededWorkflowIds: blueprint.supersededWorkflowIds,
  }))}`);
  input.log?.(`INFO [nightGraphs.evolvePipeline] blueprint_planned ${redactKnown(JSON.stringify({
    iteration, operator: blueprint.operator, decision: blueprint.decision, categoryId: blueprint.category?.id ?? null,
    graphsCount: blueprint.graphs.length, orchestrators, companionSkillsCount: blueprint.companionSkills.length,
  }))}`);
  return blueprint;
}

function emitCritiqueVerdict(
  log: ((message: string) => void) | undefined,
  iteration: number,
  operator: EvolutionOperator,
  verdict: EvolveReviewVerdict,
  deterministicGate?: boolean,
): EvolveReviewVerdict {
  log?.(`INFO [nightGraphs.pipeline] plan_critic_verdict ${redactKnown(JSON.stringify({
    iteration, operator, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length, ...(deterministicGate ? { deterministicGate: true } : {}),
  }))}`);
  log?.(`INFO [nightGraphs.evolvePipeline] blueprint_critiqued ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length }))}`);
  return verdict;
}

function emitAuditVerdict(
  log: ((message: string) => void) | undefined,
  iteration: number,
  verdict: EvolveReviewVerdict,
  extra?: { deterministicSkillGate?: boolean; deterministicLeanGate?: boolean },
): EvolveReviewVerdict {
  log?.(`INFO [nightGraphs.pipeline] audit_suite_verdict ${redactKnown(JSON.stringify({
    iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length, ...extra,
  }))}`);
  log?.(`INFO [nightGraphs.evolvePipeline] suite_audited ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length }))}`);
  return verdict;
}

/** Stage 2 (`plan-critic`): cross-family audit with parsimony, anti-clone, category ceiling, and companion-skill gates. */
export async function critiqueEvolutionBlueprint(input: {
  blueprint: ProcessBlueprint; collected: EvolveCollectInput; catalog: EvolveCatalogContext;
  runRole: EvolveRoleRunner; iteration?: number; log?: (message: string) => void;
}): Promise<EvolveReviewVerdict> {
  const iteration = input.iteration ?? 1;
  const operator = resolveBlueprintOperator(input.blueprint);
  const hasRichEvidence = input.collected.clusters.some((c) => c.count >= 2 || c.traps.length > 0 || (c.lessons?.length ?? 0) > 0);
  const hasLeanPressure = input.collected.deltas.some((d) => d.interventionKind === "over_constraint")
    || input.collected.clusters.some((c) => (c.overConstraintCount ?? 0) > 0 || (c.frictionSignals?.length ?? 0) > 0 || (c.leanViolations?.length ?? 0) > 0)
    || input.catalog.existingGlobal.some((g) => (g.leanViolations?.length ?? 0) > 0)
    || (input.catalog.existingCompanionSkills?.some((s) => s.hasSemanticDuplicates || s.sectionCount > MAX_GOLDEN_SKELETON_SECTIONS) ?? false);

  const parsimonyIssues: string[] = [];
  if (input.blueprint.decision === "noop") {
    if (hasLeanPressure) {
      parsimonyIssues.push('Over-constraint deltas, existingGlobal leanViolations, or bloated companion skills detected: use operator "prune_or_relax" instead of "noop".');
    }
  } else {
    for (const g of input.blueprint.graphs) {
      if (g.kind !== "phase_graph") continue;
      const executableStages = g.stages.filter((s) => !isControlStage(s));
      if (executableStages.length > MAX_PHASE_GRAPH_EXECUTABLE_NODES) {
        parsimonyIssues.push(`${g.workflowId}: phase_graph has ${executableStages.length} executable stages (max ${MAX_PHASE_GRAPH_EXECUTABLE_NODES}); merge or trim non-core stages.`);
      }
      const humanGates = g.stages.filter((s) => s.nodeType === "human").length;
      if (humanGates > MAX_PHASE_GRAPH_HUMAN_GATES) {
        parsimonyIssues.push(`${g.workflowId}: phase_graph has ${humanGates} human gates (max ${MAX_PHASE_GRAPH_HUMAN_GATES}); consolidate or remove redundant human gates.`);
      }
    }
  }
  input.log?.(`INFO [nightGraphs.pipeline] parsimony_gate ${redactKnown(JSON.stringify({ iteration, operator, ok: parsimonyIssues.length === 0, issueCount: parsimonyIssues.length }))}`);

  if (input.blueprint.decision === "noop" && !hasRichEvidence && !hasLeanPressure) {
    return emitCritiqueVerdict(input.log, iteration, operator, { verdict: "pass", findings: ["Noop justified: no rich trajectory clusters"], mustFix: [] });
  }

  const deterministicMustFix: string[] = [...parsimonyIssues];
  if (input.blueprint.decision !== "noop") {
    const catId = input.blueprint.category?.id ?? null;
    if (catId && !isAllowedBroadCategoryId(catId)) {
      deterministicMustFix.push(`Category "${catId}" violates the broad discipline ceiling; lift to a broad discipline category and move niche traits into archetypeOverlays.`);
    }
    for (const g of input.blueprint.graphs) {
      for (const v of validateCategoryAndIdentityGeneralization({ id: g.workflowId, name: g.name, category: input.blueprint.category })) {
        deterministicMustFix.push(`${g.workflowId}: ${v.code} (${v.matchedToken}) — ${v.detail}`);
      }
    }
    if (operator === "create_suite" && catId && (input.blueprint.supersededWorkflowIds?.length ?? 0) === 0) {
      const overlap = input.catalog.existingGlobal.filter((g) => categoryIdOf(g.category) === catId);
      if (overlap.length > 0) {
        deterministicMustFix.push(`Anti-clone gate: global catalog already contains workflows in "${catId}" (${overlap.map((g) => g.id).slice(0, 6).join(", ")}); use operator "patch_converge" or "extend_module" instead of "create_suite" (or list retired narrow workflows in supersededWorkflowIds).`);
      }
    }
    if (input.collected.clusters.some((c) => (c.artifactSkeletons?.length ?? 0) > 0) && (input.blueprint.companionSkills?.length ?? 0) === 0) {
      deterministicMustFix.push("Collected clusters include artifactSkeletons; planner must provide companionSkills with goldenSkeletonSections, qaRubricChecks, and archetypeOverlays.");
    }
  }

  if (deterministicMustFix.length > 0) {
    return emitCritiqueVerdict(input.log, iteration, operator, { verdict: "rework", findings: deterministicMustFix, mustFix: deterministicMustFix }, true);
  }
  const prompt = buildPlanCriticPrompt({ blueprint: input.blueprint, collected: input.collected, catalog: input.catalog });
  return emitCritiqueVerdict(input.log, iteration, operator, normalizeVerdict(await input.runRole("plan-critic", prompt, `critique-${iteration}`)));
}

function attachSkillsToWorkflowCandidates(candidates: readonly GraphEvolveCandidate[], companionSkills: readonly CompanionSkillCandidate[]): void {
  for (const cs of companionSkills) {
    if (cs.workflowIds.length === 0) continue;
    const targets = new Set(cs.workflowIds);
    for (const cand of candidates) {
      if (!targets.has(cand.workflowId) || !Array.isArray(cand.definition.nodes)) continue;
      for (const node of cand.definition.nodes) {
        if (!node || typeof node !== "object") continue;
        const n = node as Record<string, unknown>;
        if (n.type !== "agent") continue;
        const current = strList(n.skills);
        if (!current.includes(cs.skillId)) n.skills = [...current, cs.skillId];
      }
    }
  }
}

function compileCompanionSkills(
  blueprint: ProcessBlueprint,
  parsedSkills: unknown,
  existingSkillBundles?: ReadonlyMap<string, readonly SkillBundleFile[]>,
  log?: (message: string) => void,
): CompanionSkillCandidate[] {
  const rawById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(parsedSkills)) {
    for (const item of parsedSkills) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const id = str((item as Record<string, unknown>).skillId).toLowerCase();
      if (id) rawById.set(id, item as Record<string, unknown>);
    }
  }
  const compiled = new Map<string, CompanionSkillCandidate>();
  for (const spec of blueprint.companionSkills ?? []) {
    const raw = rawById.get(spec.skillId);
    const rawFiles = raw && Array.isArray(raw.files)
      ? raw.files.filter((f): f is SkillBundleFile => Boolean(f && typeof f === "object" && typeof (f as SkillBundleFile).path === "string" && typeof (f as SkillBundleFile).text === "string"))
      : [];
    if (rawFiles.length > 0) {
      compiled.set(spec.skillId, {
        skillId: spec.skillId,
        workflowIds: strList(raw?.workflowIds).length ? strList(raw?.workflowIds) : [...spec.workflowIds],
        mergeMode: spec.mergeMode,
        files: sortSkillBundleFiles(rawFiles.map((f) => ({ path: f.path, text: f.text }))),
      });
    } else compiled.set(spec.skillId, renderCompanionSkillBundle(spec, existingSkillBundles?.get(spec.skillId), { log }));
  }
  for (const [id, raw] of rawById) {
    if (compiled.has(id)) continue;
    const spec = normalizeCompanionSkillSpec(raw);
    if (spec) compiled.set(spec.skillId, renderCompanionSkillBundle(spec, existingSkillBundles?.get(spec.skillId), { log }));
  }
  return [...compiled.values()];
}

/** Stage 3 (`workflow-architect`): compiles an approved `ProcessBlueprint` into `candidates` + paired `companionSkills`. */
export async function synthesizeSuiteAndSkillsFromBlueprint(input: {
  blueprint: ProcessBlueprint; collected: EvolveCollectInput; catalog: EvolveCatalogContext; runRole: EvolveRoleRunner;
  priorCandidates?: readonly GraphEvolveCandidate[]; existingSkillBundles?: ReadonlyMap<string, readonly SkillBundleFile[]>;
  validationErrors?: readonly string[]; auditFeedback?: EvolveReviewVerdict | null;
  iteration?: number; log?: (message: string) => void;
}): Promise<SynthesizeSuiteResult> {
  const iteration = input.iteration ?? 1;
  if (input.blueprint.decision === "noop" || (input.blueprint.graphs.length === 0 && (input.blueprint.companionSkills?.length ?? 0) === 0)) {
    input.log?.(`INFO [nightGraphs.evolvePipeline] suite_synthesized ${redactKnown(JSON.stringify({ iteration, candidatesCount: 0, companionSkillsCount: 0, workflowIds: [] }))}`);
    return { candidates: [], companionSkills: [], supersededWorkflowIds: [] };
  }

  const prompt = buildArchitectPrompt({
    blueprint: input.blueprint, collected: input.collected, catalog: input.catalog,
    priorCandidates: input.priorCandidates, validationErrors: input.validationErrors, auditFeedback: input.auditFeedback,
  });
  const parsed = parseJsonBlock(await input.runRole("workflow-architect", prompt, `synthesize-${iteration}`));
  const rawList = parsed && Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates: GraphEvolveCandidate[] = rawList.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const r = item as Record<string, unknown>, def = r.definition;
    const workflowId = str(r.workflowId) || (def && typeof def === "object" ? str((def as Record<string, unknown>).id) : "");
    if (!workflowId || !def || typeof def !== "object" || Array.isArray(def)) return [];
    const cat = r.category ?? (def as Record<string, unknown>).category ?? input.blueprint.category;
    return [{
      workflowId, scope: r.scope === "project" ? "project" : "global", ...(str(r.projectId) ? { projectId: str(r.projectId) } : {}),
      name: bilingual(r.name, workflowId), description: bilingual(r.description, workflowId),
      ...(cat !== undefined ? { category: cat as GraphEvolveCandidate["category"] } : {}),
      definition: def as Record<string, unknown>, sourceDeltaIds: strList(r.sourceDeltaIds).length ? strList(r.sourceDeltaIds) : [...input.collected.deltaIds],
    }];
  });

  const companionSkills = compileCompanionSkills(input.blueprint, parsed?.companionSkills, input.existingSkillBundles, input.log);
  attachSkillsToWorkflowCandidates(candidates, companionSkills);
  input.log?.(`INFO [nightGraphs.evolvePipeline] suite_synthesized ${redactKnown(JSON.stringify({
    iteration, candidatesCount: candidates.length, companionSkillsCount: companionSkills.length,
    workflowIds: candidates.map((c) => c.workflowId), skillIds: companionSkills.map((s) => s.skillId),
  }))}`);
  return { candidates, companionSkills, supersededWorkflowIds: [...(input.blueprint.supersededWorkflowIds ?? [])] };
}

/** Backwards-compatible Stage 3 wrapper returning compiled `GraphEvolveCandidate[]`. */
export async function synthesizeSuiteFromBlueprint(input: Parameters<typeof synthesizeSuiteAndSkillsFromBlueprint>[0]): Promise<GraphEvolveCandidate[]> {
  return (await synthesizeSuiteAndSkillsFromBlueprint(input)).candidates;
}

/** Stage 4 (`auditor`): deterministic skill-merge + lean-policy gates followed by cross-family suite audit. */
export async function auditSynthesizedSuite(input: {
  blueprint: ProcessBlueprint; candidates: readonly GraphEvolveCandidate[]; companionSkills?: readonly CompanionSkillCandidate[];
  existingSkillBundles?: ReadonlyMap<string, readonly SkillBundleFile[]>; collected: EvolveCollectInput; runRole: EvolveRoleRunner;
  enforceLeanPolicy?: boolean; iteration?: number; log?: (message: string) => void;
}): Promise<EvolveReviewVerdict> {
  const iteration = input.iteration ?? 1;
  const skillFailures: string[] = [];
  for (const cs of input.companionSkills ?? []) {
    const check = lintAndVerifyCompanionSkill(cs, input.existingSkillBundles?.get(cs.skillId), { log: input.log });
    if (!check.ok) for (const f of check.findings) skillFailures.push(`[${cs.skillId}] ${f.code}: ${f.detail}`);
  }
  if (skillFailures.length > 0) {
    return emitAuditVerdict(input.log, iteration, { verdict: "rework", findings: skillFailures, mustFix: skillFailures }, { deterministicSkillGate: true });
  }
  if (input.enforceLeanPolicy === true || resolveBlueprintOperator(input.blueprint) === "prune_or_relax") {
    const leanVerdict = validateLeanSuitePolicy(input.candidates, { blueprint: input.blueprint, log: input.log });
    if (!leanVerdict.ok) {
      const leanFailures = leanVerdict.violations.map((v) => `[${v.workflowId}${v.nodeId ? `#${v.nodeId}` : ""}] ${v.code}: ${v.detail}`);
      return emitAuditVerdict(input.log, iteration, { verdict: "rework", findings: leanFailures, mustFix: leanFailures }, { deterministicLeanGate: true });
    }
  }
  const prompt = buildAuditorPrompt({ blueprint: input.blueprint, candidates: input.candidates, companionSkills: input.companionSkills, collected: input.collected });
  return emitAuditVerdict(input.log, iteration, normalizeVerdict(await input.runRole("auditor", prompt, `audit-${iteration}`)));
}
