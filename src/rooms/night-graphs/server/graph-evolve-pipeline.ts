import { redactKnown } from "@lane-pilot/kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { WORKFLOW_REFERENCE, sortSkillBundleFiles, type SkillBundleFile } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../contracts/server";
import { modelCatalogOf, readProviderFolderBlock, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, type WriterHostApi } from "../../platform/server";
import type { RuleScanApi } from "../../self-repair/server";
import { BROAD_DYNAMIC_CATEGORIES, isAllowedBroadCategoryId, validateCategoryAndIdentityGeneralization } from "../category-taxonomy";
import {
  bilingual, normalizeBlueprint, normalizeCompanionSkillSpec, parseJsonBlock, resolveBlueprintOperator, str, strList,
  type CompanionArchetypeOverlaySpec, type CompanionSkillSpec, type EvolutionOperator, type NormalizedProcessBlueprint,
  type ProcessBlueprint, type ProcessBlueprintGraphSpec, type ProcessBlueprintStageSpec,
} from "../process-blueprint";
import {
  lintAndVerifyCompanionSkill, renderCompanionSkillBundle, verifyNonDestructiveSkillMerge,
  type CompanionSkillCandidate, type NonDestructiveMergeVerdict,
} from "./companion-skill-merge";
import { analystPlace } from "./episodes-graph";
import type { GraphEvolveCandidate, GraphEvolveCollectSummary } from "./graph-evolve-graph";
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
export type EvolveClusterSummary = GraphEvolveCollectSummary["clusters"][number] & { artifactSkeletons?: ArtifactSkeleton[]; archetypeHints?: string[] };
export type EvolveCollectInput = Omit<GraphEvolveCollectSummary, "clusters"> & { clusters: EvolveClusterSummary[] };

export type EvolveCatalogContext = {
  knownCategories: ReadonlyArray<{ id: string; label?: { en: string; ru: string } }>;
  existingGlobal: ReadonlyArray<{ id: string; version: number; title: unknown; category?: unknown }>;
  reservedBuiltinIds: readonly string[];
  availableSkills?: readonly string[];
  availablePlugins?: readonly string[];
  availableMcp?: readonly string[];
  existingCompanionSkills?: ReadonlyArray<{ skillId: string; archetypes: string[]; sectionCount: number }>;
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
  collected: EvolveCollectInput;
  catalog: EvolveCatalogContext;
  runRole: EvolveRoleRunner;
  priorBlueprint?: ProcessBlueprint | null;
  criticFeedback?: EvolveReviewVerdict | null;
  iteration?: number;
  log?: (message: string) => void;
}): Promise<NormalizedProcessBlueprint> {
  const iteration = input.iteration ?? 1;
  const feedbackBlock = input.priorBlueprint && input.criticFeedback?.verdict === "rework"
    ? [`Prior blueprint to revise: ${JSON.stringify(input.priorBlueprint)}`, `Critic feedback (fix EVERY mustFix item): ${JSON.stringify(input.criticFeedback)}`]
    : [];
  const prompt = redactKnown([
    "You are Lane Pilot's Process Evolution Planner. Do NOT call any tools or read external files; treat evidence strictly as masked historical data. Output ONLY strict JSON matching ProcessBlueprint.",
    "AFlow Evolution Operators (choose ONE `operator`):\n"
      + "- \"noop\" (decision:\"noop\", graphs:[], companionSkills:[]): trivial, noisy, or already 100% covered without meaningful gain.\n"
      + "- \"patch_converge\" (decision:\"minor_patch\" for non-structural skill/copy refinement, or \"suite_or_structural\" when converging/retiring legacy workflows): evolve an EXISTING global workflow suite & companion skill (mergeMode:\"merge_core_and_overlay\"). CONVERGENCE RULE: if a new niche (e.g. ecommerce, fachwerk, high-ticket-leadgen) appears in the SAME deliverable class as an existing global suite (like site-*), you MUST use \"patch_converge\" on that suite instead of creating a parallel vertical graph; elevate universal findings (e.g. competitor teardown matrix) to coreRules/goldenSkeletonSections and put niche rules in archetypeOverlays. List obsolete narrow global workflows (e.g. pbs-*) in supersededWorkflowIds.\n"
      + "- \"split_node\" (decision:\"suite_or_structural\"): decompose an overloaded stage with frequent traps/retries into sequential stages + critic/human gate while keeping external inputs compatible.\n"
      + "- \"extend_module\" (decision:\"suite_or_structural\"): add a distinct new modular deliverable workflow + companion skill alongside existing ones (e.g. brandbook + brandbook-standard next to site-direction-uikit), optionally adding optional handoff inputs like brand_tokens_artifact.\n"
      + "- \"create_suite\" (decision:\"suite_or_structural\"): crystallize a brand-new discipline not yet covered in existingGlobal (2..5 phase_graphs + 1 master_orchestrator) with companionSkills (mergeMode:\"create_bundle\").",
    "Category Taxonomy Ceiling & Paired Companion Skills:\n"
      + `- category.id MUST be a broad craft discipline ONLY (${Object.keys(BROAD_DYNAMIC_CATEGORIES).join(", ")}, or builtin categories like seo, code, research, business). NEVER encode client niches/verticals (personal-brand, pbs, plastic-windows, fachwerk, online-store) in category.id, workflowId, or name! Parameterize niches via project_archetype / domain_brief workflow inputs and companionSkills[].archetypeOverlays.\n`
      + "- Whenever clusters include artifactSkeletons or structured craft deliverables (UI kit, brandbook, design spec, competitor matrix), define paired `companionSkills` with skillId (kebab-case), workflowIds, mergeMode (\"create_bundle\" | \"merge_core_and_overlay\"), summary, whenToUse, whenNotToUse, coreRules, goldenSkeletonSections, qaRubricChecks, and archetypeOverlays ([{slug, title, whenToUse, rules}]).\n"
      + "- Preserve real tools (.pen/Pencil/metamcp -> mcp:[\"metamcp\"], image-studio -> plugins:[\"image-studio\"]), multi-variant parameters (variants_count + owner human selection), and strict step-order invariants. 100% de-projectize all IDs, labels, and rules.",
    `Catalog context: ${JSON.stringify(input.catalog)}`,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
    ...feedbackBlock,
    'Return ONLY JSON: {"operator":"noop"|"patch_converge"|"split_node"|"extend_module"|"create_suite","decision":"noop"|"minor_patch"|"suite_or_structural","rationale":"...","category":{"id":"...","label":{"en":"...","ru":"..."}}|null,"supersededWorkflowIds":[],"orderInvariants":["..."],"variantParameters":[{"name":"...","rangeOrValues":"...","purpose":"..."}],"requiredIntegrations":{"mcp":[],"plugins":[],"skills":[]},"graphs":[{"workflowId":"...","kind":"phase_graph"|"master_orchestrator","name":{"en":"...","ru":"..."},"description":{"en":"...","ru":"..."},"dependsOnGraphs":[],"inputs":{},"outputs":{},"stages":[{"id":"...","nodeType":"agent|human|lp-task|action|subworkflow|parallel","role":"...","subworkflowId":"...","purpose":"...","skills":[],"mcp":[],"plugins":[],"contractRules":[]}],"acceptanceCriteria":["..."]}],"companionSkills":[{"skillId":"...","workflowIds":[],"mergeMode":"create_bundle"|"merge_core_and_overlay","summary":"...","whenToUse":"...","whenNotToUse":"...","coreRules":[],"goldenSkeletonSections":[],"qaRubricChecks":[],"archetypeOverlays":[{"slug":"...","title":"...","whenToUse":"...","rules":[]}]}]}',
  ].join("\n\n"));

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

/** Stage 2 (`plan-critic`): cross-family audit with anti-clone, category ceiling, and companion-skill gates. */
export async function critiqueEvolutionBlueprint(input: {
  blueprint: ProcessBlueprint;
  collected: EvolveCollectInput;
  catalog: EvolveCatalogContext;
  runRole: EvolveRoleRunner;
  iteration?: number;
  log?: (message: string) => void;
}): Promise<EvolveReviewVerdict> {
  const iteration = input.iteration ?? 1;
  const operator = resolveBlueprintOperator(input.blueprint);
  const hasRichEvidence = input.collected.clusters.some((c) => c.count >= 2 || c.traps.length > 0 || (c.lessons?.length ?? 0) > 0);
  if (input.blueprint.decision === "noop" && !hasRichEvidence) {
    const verdict: EvolveReviewVerdict = { verdict: "pass", findings: ["Noop justified: no rich trajectory clusters"], mustFix: [] };
    input.log?.(`INFO [nightGraphs.pipeline] plan_critic_verdict ${redactKnown(JSON.stringify({ iteration, operator, verdict: verdict.verdict, mustFixCount: 0 }))}`);
    input.log?.(`INFO [nightGraphs.evolvePipeline] blueprint_critiqued ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: 0 }))}`);
    return verdict;
  }

  const deterministicMustFix: string[] = [];
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
    const verdict: EvolveReviewVerdict = { verdict: "rework", findings: deterministicMustFix, mustFix: deterministicMustFix };
    input.log?.(`INFO [nightGraphs.pipeline] plan_critic_verdict ${redactKnown(JSON.stringify({ iteration, operator, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length, deterministicGate: true }))}`);
    input.log?.(`INFO [nightGraphs.evolvePipeline] blueprint_critiqued ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length }))}`);
    return verdict;
  }

  const prompt = redactKnown([
    "You are Lane Pilot's Cross-Family Process Plan Critic. Do NOT call any tools or read external files. Output ONLY strict JSON: {\"verdict\":\"pass\"|\"rework\",\"findings\":[...],\"mustFix\":[...]}.",
    input.blueprint.decision === "noop"
      ? "The planner chose decision:\"noop\" despite rich trajectory clusters. Check whether valuable recurring workflows were mistakenly ignored; if so return verdict:\"rework\"."
      : "Audit the blueprint against the masked evidence on ALL 8 hard gates:\n1) Tool & MCP fidelity: observed MCPs/plugins preserved on the right stages.\n2) Multi-variant fidelity: multi-concept/palette trajectories parameterize variants_count + owner human selection.\n3) Order invariants: causal ordering respected (CTA/conversion map before design; UI Kit before full page templates; QA gate after build).\n4) Modular suite layout: multi-phase work split cleanly into 2..5 phase_graphs + master_orchestrator (no cycles, no collision with reservedBuiltinIds).\n5) 100% De-projectization: zero domain/brand/person names, proj_*, host_*, /Users/... or /home/... leaks; dynamic category has bilingual {en, ru} label.\n6) Actionable deliverables: clear inputs, outputs, and acceptanceCriteria per graph.\n7) Anti-clone & Category Taxonomy Ceiling: reject niche categories/workflowIds (use broad discipline + archetypeOverlays + project_archetype input), and reject create_suite when an existing global suite covers the same deliverable discipline (require patch_converge or extend_module).\n8) Companion Skill Golden Skeleton: when structured deliverables or artifactSkeletons appear, require companionSkills with Golden Skeleton sections, QA rubric checks, and archetypeOverlays.",
    `Catalog context: ${JSON.stringify(input.catalog)}`,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
    `Candidate blueprint: ${JSON.stringify(input.blueprint)}`,
  ].join("\n\n"));

  const verdict = normalizeVerdict(await input.runRole("plan-critic", prompt, `critique-${iteration}`));
  input.log?.(`INFO [nightGraphs.pipeline] plan_critic_verdict ${redactKnown(JSON.stringify({ iteration, operator, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length }))}`);
  input.log?.(`INFO [nightGraphs.evolvePipeline] blueprint_critiqued ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length }))}`);
  return verdict;
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
    } else compiled.set(spec.skillId, renderCompanionSkillBundle(spec, existingSkillBundles?.get(spec.skillId)));
  }
  for (const [id, raw] of rawById) {
    if (compiled.has(id)) continue;
    const spec = normalizeCompanionSkillSpec(raw);
    if (spec) compiled.set(spec.skillId, renderCompanionSkillBundle(spec, existingSkillBundles?.get(spec.skillId)));
  }
  return [...compiled.values()];
}

/** Stage 3 (`workflow-architect`): compiles an approved `ProcessBlueprint` into `candidates` + paired `companionSkills`. */
export async function synthesizeSuiteAndSkillsFromBlueprint(input: {
  blueprint: ProcessBlueprint;
  collected: EvolveCollectInput;
  catalog: EvolveCatalogContext;
  runRole: EvolveRoleRunner;
  priorCandidates?: readonly GraphEvolveCandidate[];
  existingSkillBundles?: ReadonlyMap<string, readonly SkillBundleFile[]>;
  validationErrors?: readonly string[];
  auditFeedback?: EvolveReviewVerdict | null;
  iteration?: number;
  log?: (message: string) => void;
}): Promise<SynthesizeSuiteResult> {
  const iteration = input.iteration ?? 1;
  if (input.blueprint.decision === "noop" || (input.blueprint.graphs.length === 0 && (input.blueprint.companionSkills?.length ?? 0) === 0)) {
    input.log?.(`INFO [nightGraphs.evolvePipeline] suite_synthesized ${redactKnown(JSON.stringify({ iteration, candidatesCount: 0, companionSkillsCount: 0, workflowIds: [] }))}`);
    return { candidates: [], companionSkills: [], supersededWorkflowIds: [] };
  }

  const repairBlock = [
    ...(input.priorCandidates?.length ? [`Prior candidates to repair: ${JSON.stringify(input.priorCandidates)}`] : []),
    ...(input.validationErrors?.length ? [`Schema/validation/test errors to fix: ${JSON.stringify(input.validationErrors)}`] : []),
    ...(input.auditFeedback?.verdict === "rework" ? [`Auditor feedback to fix: ${JSON.stringify(input.auditFeedback)}`] : []),
  ];

  const prompt = redactKnown([
    'CRITICAL: You are running as a batch JSON workflow compiler in an isolated room. Do NOT call any tools, do NOT read files, and do NOT invoke lane_pilot_* or skill tools. Output ONLY the single JSON object {"candidates":[...],"companionSkills":[...]} in your message.',
    `WORKFLOW_REFERENCE:\n${JSON.stringify(WORKFLOW_REFERENCE)}`,
    "Strict Compiler Rules (must pass loadWorkflow, validateWorkflow, and runDraftTest):\n"
      + "1) Compile EVERY graph in blueprint.graphs into one GraphEvolveCandidate ({workflowId, scope:\"global\", name:{en,ru}, description:{en,ru}, category, sourceDeltaIds, definition}).\n"
      + "2) In definition set: id, version (1 or existingGlobal.version + 1), name, description, category:{id,label:{en,ru}}, status:\"draft\", triggers:[\"manual\"] (or [\"chat\",\"manual\"] WITH non-empty examples:[...] and not_for:[...]), inputs ({type:\"string\"|\"int\"|\"number\"|\"bool\"|\"json\", required?, default?, description?}), outputs ({<field>:\"string\"|\"int\"|\"bool\"}), nodes, edges, test.\n"
      + "3) nodeSchema is .strict() — NEVER invent extra node properties!\n"
      + "   - agent: {id, type:\"agent\", title:{en,ru}, role:\"planner\"|\"analyst\"|\"plan-critic\"|\"auditor\"|\"browser-qa\"|\"errand\"|\"specialist:design-lead\"|\"specialist:copy-lead\"|\"specialist:seo-specialist\"|\"specialist:growth-marketer\"|\"specialist:visual-artist\"|\"specialist:tavily\", prompt, skills?, plugins?, mcp?, out:{...}, guards?:{maxVisits?:3}}. NEVER set model, provider, reasoning, model_preset, or environment!\n"
      + "   - human: {id, type:\"human\", title:{en,ru}, question, options:[\"approve\",\"rework\",\"abort\"], out:{answer:\"string\", answer_kind:\"approve|rework|abort\"}}.\n"
      + "   - lp-task: {id, type:\"lp-task\", title:{en,ru}, owns_paths:[...], contract:{title, goal, acceptance:[...]}, out:{state:\"accepted|blocked|failed\", summary:\"string\"}, guards?:{maxVisits?:2}}.\n"
      + "   - subworkflow: {id, type:\"subworkflow\", title:{en,ru}, workflow:\"<child-workflow-id>\", inputs:{\"<childInput>\":\"{{$inputs.goal}}\"}, out:{\"<childOutputField>\":\"<matchingChildOutputType>\"}, guards:{maxVisits:1}}.\n"
      + "   - terminal action: {id:\"done\", type:\"action\", action:\"emit\", map:{...every workflow output...}}.\n"
      + "4) Every loop back-edge MUST have guards:{maxVisits:N} on the loop target AND when:\"... && visits('target') < N\" plus a fallback edge.\n"
      + "5) test: {id:\"happy-path\", sim:{input:{...}, stubs:{<nodeId>:{...}}, human_answers:{<humanNodeId>:\"approve\"}, expect_status:\"succeeded\", expect_path:[...]}}.\n"
      + "6) Companion Skills: For every spec in blueprint.companionSkills, attach <skillId> to `skills` of the relevant craft `agent` nodes on spec.workflowIds, and either omit companionSkills (so the compiler renders SKILL.md + references/* deterministically) or return companionSkills:[{skillId, workflowIds, mergeMode, files?:[{path,text}]}].",
    `Catalog context: ${JSON.stringify(input.catalog)}`,
    `Delta IDs: ${JSON.stringify(input.collected.deltaIds)}`,
    `Approved blueprint: ${JSON.stringify(input.blueprint)}`,
    ...repairBlock,
  ].join("\n\n"));

  const parsed = parseJsonBlock(await input.runRole("workflow-architect", prompt, `synthesize-${iteration}`));
  const rawList = parsed && Array.isArray(parsed.candidates) ? parsed.candidates : [];
  const candidates: GraphEvolveCandidate[] = rawList.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const r = item as Record<string, unknown>, def = r.definition;
    const workflowId = str(r.workflowId) || (def && typeof def === "object" ? str((def as Record<string, unknown>).id) : "");
    if (!workflowId || !def || typeof def !== "object" || Array.isArray(def)) return [];
    const cat = r.category ?? (def as Record<string, unknown>).category ?? input.blueprint.category;
    return [{
      workflowId, scope: r.scope === "project" ? "project" : "global",
      ...(str(r.projectId) ? { projectId: str(r.projectId) } : {}),
      name: bilingual(r.name, workflowId), description: bilingual(r.description, workflowId),
      ...(cat !== undefined ? { category: cat as GraphEvolveCandidate["category"] } : {}),
      definition: def as Record<string, unknown>,
      sourceDeltaIds: strList(r.sourceDeltaIds).length ? strList(r.sourceDeltaIds) : [...input.collected.deltaIds],
    }];
  });

  const companionSkills = compileCompanionSkills(input.blueprint, parsed?.companionSkills, input.existingSkillBundles);
  attachSkillsToWorkflowCandidates(candidates, companionSkills);

  input.log?.(`INFO [nightGraphs.evolvePipeline] suite_synthesized ${redactKnown(JSON.stringify({
    iteration, candidatesCount: candidates.length, companionSkillsCount: companionSkills.length,
    workflowIds: candidates.map((c) => c.workflowId), skillIds: companionSkills.map((s) => s.skillId),
  }))}`);
  return { candidates, companionSkills, supersededWorkflowIds: [...(input.blueprint.supersededWorkflowIds ?? [])] };
}

/** Backwards-compatible Stage 3 wrapper returning compiled `GraphEvolveCandidate[]`. */
export async function synthesizeSuiteFromBlueprint(
  input: Parameters<typeof synthesizeSuiteAndSkillsFromBlueprint>[0],
): Promise<GraphEvolveCandidate[]> {
  return (await synthesizeSuiteAndSkillsFromBlueprint(input)).candidates;
}

/** Stage 4 (`auditor`): deterministic skill-merge gate + cross-family audit of compiled candidates & companion skills. */
export async function auditSynthesizedSuite(input: {
  blueprint: ProcessBlueprint;
  candidates: readonly GraphEvolveCandidate[];
  companionSkills?: readonly CompanionSkillCandidate[];
  existingSkillBundles?: ReadonlyMap<string, readonly SkillBundleFile[]>;
  collected: EvolveCollectInput;
  runRole: EvolveRoleRunner;
  iteration?: number;
  log?: (message: string) => void;
}): Promise<EvolveReviewVerdict> {
  const iteration = input.iteration ?? 1;
  const skillFailures: string[] = [];
  for (const cs of input.companionSkills ?? []) {
    const check = lintAndVerifyCompanionSkill(cs, input.existingSkillBundles?.get(cs.skillId), { log: input.log });
    if (!check.ok) for (const f of check.findings) skillFailures.push(`[${cs.skillId}] ${f.code}: ${f.detail}`);
  }
  if (skillFailures.length > 0) {
    const verdict: EvolveReviewVerdict = { verdict: "rework", findings: skillFailures, mustFix: skillFailures };
    input.log?.(`INFO [nightGraphs.pipeline] audit_suite_verdict ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length, deterministicSkillGate: true }))}`);
    input.log?.(`INFO [nightGraphs.evolvePipeline] suite_audited ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length }))}`);
    return verdict;
  }

  const companionSummary = input.companionSkills?.length
    ? [`Companion skills: ${JSON.stringify(input.companionSkills.map((s) => ({
        skillId: s.skillId, workflowIds: s.workflowIds, mergeMode: s.mergeMode,
        files: s.files.map((f) => ({ path: f.path, bytes: Buffer.byteLength(f.text, "utf8"), preview: f.text.slice(0, 600) })),
      })))}`]
    : [];

  const prompt = redactKnown([
    "You are Lane Pilot's Cross-Family Senior Suite Auditor. Do NOT call any tools or read external files. Output ONLY strict JSON: {\"verdict\":\"pass\"|\"rework\",\"findings\":[\"<string>\",...],\"mustFix\":[\"<string>\",...]} (elements of findings and mustFix MUST be plain strings).",
    `WORKFLOW_REFERENCE:\n${JSON.stringify(WORKFLOW_REFERENCE)}`,
    "Engine Schema Constraints (NEVER ask mustFix to violate WORKFLOW_REFERENCE):\n"
      + "- nodeSchema is .strict(): ONLY type:\"agent\" nodes accept mcp, plugins, and skills. type:\"human\", \"lp-task\", \"subworkflow\", and \"action\" nodes FORBID mcp/plugins/skills.\n"
      + "- There is NO parallel node type in the schema; definition.test is a SINGLE {id, sim} object per workflow.\n"
      + "Audit Calibration (return verdict:\"rework\" + non-empty mustFix ONLY for genuine schema-valid blocking defects):\n"
      + "- Blocking (rework): planned graph missing; master_orchestrator subworkflow links missing or out of order; required MCPs/plugins/variants_count/human gates missing; companion skill Golden Skeleton/QA rubric/archetype overlays missing or unattached to craft agent nodes when blueprint.companionSkills is non-empty; or project/domain/brand/person/proj_*/host_* leaks.\n"
      + "- Non-blocking (pass): return verdict:\"pass\" with mustFix:[] when all structural, skill-attachment, and de-projectization invariants hold.",
    `Approved blueprint: ${JSON.stringify(input.blueprint)}`,
    `Compiled candidates: ${JSON.stringify(input.candidates)}`,
    ...companionSummary,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
  ].join("\n\n"));

  const verdict = normalizeVerdict(await input.runRole("auditor", prompt, `audit-${iteration}`));
  input.log?.(`INFO [nightGraphs.pipeline] audit_suite_verdict ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length }))}`);
  input.log?.(`INFO [nightGraphs.evolvePipeline] suite_audited ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length }))}`);
  return verdict;
}
