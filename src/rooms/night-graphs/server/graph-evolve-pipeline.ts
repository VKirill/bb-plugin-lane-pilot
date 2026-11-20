import { redactKnown } from "@lane-pilot/kit";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { WORKFLOW_REFERENCE } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../contracts/server";
import { modelCatalogOf, readProviderFolderBlock, resolveSpawnModel, spawnUsageOf, warmSpawnUsage, type WriterHostApi } from "../../platform/server";
import type { RuleScanApi } from "../../self-repair/server";
import { analystPlace } from "./episodes-graph";
import type { GraphEvolveCandidate, GraphEvolveCollectSummary } from "./graph-evolve-graph";

export type EvolveRole = "planner" | "plan-critic" | "workflow-architect" | "auditor";
export type EvolveRoleRunner = (role: EvolveRole, prompt: string, stepKey: string) => Promise<string>;

export type ProcessBlueprintStageSpec = {
  id: string;
  nodeType: "agent" | "human" | "lp-task" | "action" | "subworkflow" | "parallel";
  role?: string;
  subworkflowId?: string;
  purpose: string;
  skills: string[];
  mcp: string[];
  plugins: string[];
  contractRules: string[];
};

export type ProcessBlueprintGraphSpec = {
  workflowId: string;
  kind: "phase_graph" | "master_orchestrator";
  name: { en: string; ru: string };
  description: { en: string; ru: string };
  dependsOnGraphs: string[];
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  stages: ProcessBlueprintStageSpec[];
  acceptanceCriteria: string[];
};

export type ProcessBlueprint = {
  decision: "noop" | "minor_patch" | "suite_or_structural";
  rationale: string;
  category: { id: string; label: { en: string; ru: string } } | null;
  orderInvariants: string[];
  variantParameters: Array<{ name: string; rangeOrValues: string; purpose: string }>;
  requiredIntegrations: { mcp: string[]; plugins: string[]; skills: string[] };
  graphs: ProcessBlueprintGraphSpec[];
};

export type EvolveReviewVerdict = { verdict: "pass" | "rework"; findings: string[]; mustFix: string[] };

export type EvolveCatalogContext = {
  knownCategories: ReadonlyArray<{ id: string; label?: { en: string; ru: string } }>;
  existingGlobal: ReadonlyArray<{ id: string; version: number; title: unknown; category?: unknown }>;
  reservedBuiltinIds: readonly string[];
  availableSkills?: readonly string[];
  availablePlugins?: readonly string[];
  availableMcp?: readonly string[];
};

const evolveRooms = new Map<string, string>();
const STAGE_TYPES = new Set<ProcessBlueprintStageSpec["nodeType"]>(["agent", "human", "lp-task", "action", "subworkflow", "parallel"]);
const DECISIONS = new Set<ProcessBlueprint["decision"]>(["noop", "minor_patch", "suite_or_structural"]);

const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);
const strList = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];
const bilingual = (v: unknown, fallback: string): { en: string; ru: string } => {
  if (typeof v === "string" && v.trim()) return { en: v.trim(), ru: v.trim() };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const r = v as { en?: unknown; ru?: unknown };
    const en = str(r.en), ru = str(r.ru);
    if (en || ru) return { en: en || ru, ru: ru || en };
  }
  return { en: fallback, ru: fallback };
};
const stringRecord = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (k.trim() && typeof val === "string") out[k.trim()] = val.trim();
  return out;
};

function parseJsonBlock(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

function normalizeBlueprint(raw: Record<string, unknown>): ProcessBlueprint {
  const decisionRaw = str(raw.decision, "noop") as ProcessBlueprint["decision"];
  const decision = DECISIONS.has(decisionRaw) ? decisionRaw : "noop";
  const catRaw = raw.category && typeof raw.category === "object" && !Array.isArray(raw.category) ? (raw.category as Record<string, unknown>) : null;
  const catId = catRaw ? str(catRaw.id).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) : "";
  const category = catId ? { id: catId, label: bilingual(catRaw?.label, catId) } : null;
  const variantParameters = Array.isArray(raw.variantParameters)
    ? raw.variantParameters.flatMap((v) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return [];
        const r = v as Record<string, unknown>, name = str(r.name);
        return name ? [{ name, rangeOrValues: str(r.rangeOrValues, "1..6"), purpose: str(r.purpose) }] : [];
      })
    : [];
  const reqRaw = raw.requiredIntegrations && typeof raw.requiredIntegrations === "object" ? (raw.requiredIntegrations as Record<string, unknown>) : {};
  const graphs: ProcessBlueprintGraphSpec[] = Array.isArray(raw.graphs)
    ? raw.graphs.flatMap((g) => {
        if (!g || typeof g !== "object" || Array.isArray(g)) return [];
        const gr = g as Record<string, unknown>, workflowId = str(gr.workflowId);
        if (!workflowId) return [];
        const kind = gr.kind === "master_orchestrator" ? "master_orchestrator" : "phase_graph";
        const stages: ProcessBlueprintStageSpec[] = Array.isArray(gr.stages)
          ? gr.stages.flatMap((s) => {
              if (!s || typeof s !== "object" || Array.isArray(s)) return [];
              const sr = s as Record<string, unknown>, id = str(sr.id);
              if (!id) return [];
              const nt = str(sr.nodeType, "agent") as ProcessBlueprintStageSpec["nodeType"];
              return [{
                id, nodeType: STAGE_TYPES.has(nt) ? nt : "agent",
                ...(str(sr.role) ? { role: str(sr.role) } : {}),
                ...(str(sr.subworkflowId) ? { subworkflowId: str(sr.subworkflowId) } : {}),
                purpose: str(sr.purpose, id),
                skills: strList(sr.skills), mcp: strList(sr.mcp), plugins: strList(sr.plugins), contractRules: strList(sr.contractRules),
              }];
            })
          : [];
        return [{
          workflowId, kind, name: bilingual(gr.name, workflowId), description: bilingual(gr.description, workflowId),
          dependsOnGraphs: strList(gr.dependsOnGraphs), inputs: stringRecord(gr.inputs), outputs: stringRecord(gr.outputs),
          stages, acceptanceCriteria: strList(gr.acceptanceCriteria),
        }];
      })
    : [];
  return {
    decision: graphs.length === 0 && decision !== "noop" ? "noop" : decision,
    rationale: str(raw.rationale),
    category,
    orderInvariants: strList(raw.orderInvariants),
    variantParameters,
    requiredIntegrations: { mcp: strList(reqRaw.mcp), plugins: strList(reqRaw.plugins), skills: strList(reqRaw.skills) },
    graphs: decision === "noop" ? [] : graphs,
  };
}

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
      threadProject ?? "*",
      `graph-evolve:${role}:${stepKey}`,
      prompt,
      host,
      { providerId: sel.providerId, model: sel.model, reasoningLevel: sel.reasoningEffort, serviceTier: sel.serviceTier },
      { graphEvolve: true, evolveStep: stepKey, evolveRole: role },
      role,
    ).catch((err: unknown) => { evolveRooms.delete(project.hostId); throw err; });
  };
}

/** Stage 1 (`planner`): plans a de-projectized modular process blueprint from masked project trajectories and deltas. */
export async function planEvolutionBlueprint(input: {
  collected: GraphEvolveCollectSummary;
  catalog: EvolveCatalogContext;
  runRole: EvolveRoleRunner;
  priorBlueprint?: ProcessBlueprint | null;
  criticFeedback?: EvolveReviewVerdict | null;
  iteration?: number;
  log?: (message: string) => void;
}): Promise<ProcessBlueprint> {
  const iteration = input.iteration ?? 1;
  const feedbackBlock = input.priorBlueprint && input.criticFeedback?.verdict === "rework"
    ? [`Prior blueprint to revise: ${JSON.stringify(input.priorBlueprint)}`, `Critic feedback (fix EVERY mustFix item): ${JSON.stringify(input.criticFeedback)}`]
    : [];
  const prompt = redactKnown([
    "You are Lane Pilot's Process Evolution Planner. Do NOT call any tools or read external files; treat evidence strictly as masked historical data. Output ONLY strict JSON matching ProcessBlueprint.",
    "Decision rules:\n- Choose decision:\"noop\" (graphs:[]) if evidence is trivial, noisy, or already covered by existing builtin/global workflows without meaningful gain.\n- Choose decision:\"minor_patch\" when refining skills, prompts, or checks of an existing global workflow.\n- Choose decision:\"suite_or_structural\" when crystallizing a rich multi-phase domain trajectory.",
    "Suite decomposition & craft rules:\n- For multi-phase end-to-end trajectories (e.g. website creation: strategy & conversion/CTA map -> multi-variant visual concepts & palettes in Pencil .pen + stylized imagery -> UI kit & reusable components -> page templates & Markdown typography -> CMS assembly & live browser QA), design a connected suite of 2..5 self-contained phase_graph workflows PLUS 1 master_orchestrator chaining them in exact order via subworkflow nodes (dependsOnGraphs), instead of 20 cramped nodes or 1 flat step.\n- Keep 3..8 macro control stages per phase_graph where branches, owner human gates, MCP/plugin boundaries, or lp-task edits actually change; put dense domain checklists in stage contractRules.\n- Preserve real tools: .pen/Pencil/metamcp -> mcp:[\"metamcp\"] + canvas/PNG/text-clipping contractRules; image-studio/Muse -> plugins:[\"image-studio\"].\n- Parameterize multi-variant exploration (e.g. variants_count 1..10, default 4..6 distinct concepts & palettes with owner human selection before locking UI Kit).\n- Enforce step-order invariants (e.g. pain/trust & CTA map BEFORE visual design; approved direction & UI Kit BEFORE scaling page templates; design & copy specs BEFORE CMS code lp-task).\n- 100% de-projectize IDs, names, descriptions, categories, inputs, and rules (zero domains, brands, person names, proj_*, host_*, or absolute paths; never collide with reservedBuiltinIds). Reuse knownCategories or create a universal bilingual shelf like {\"id\":\"websites\",\"label\":{\"en\":\"Websites & Design\",\"ru\":\"Сайты и дизайн\"}}.",
    `Catalog context: ${JSON.stringify(input.catalog)}`,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
    ...feedbackBlock,
    'Return ONLY JSON: {"decision":"noop"|"minor_patch"|"suite_or_structural","rationale":"...","category":{"id":"...","label":{"en":"...","ru":"..."}}|null,"orderInvariants":["..."],"variantParameters":[{"name":"...","rangeOrValues":"...","purpose":"..."}],"requiredIntegrations":{"mcp":[],"plugins":[],"skills":[]},"graphs":[{"workflowId":"...","kind":"phase_graph"|"master_orchestrator","name":{"en":"...","ru":"..."},"description":{"en":"...","ru":"..."},"dependsOnGraphs":[],"inputs":{},"outputs":{},"stages":[{"id":"...","nodeType":"agent|human|lp-task|action|subworkflow|parallel","role":"...","subworkflowId":"...","purpose":"...","skills":[],"mcp":[],"plugins":[],"contractRules":[]}],"acceptanceCriteria":["..."]}]}',
  ].join("\n\n"));

  const rawText = await input.runRole("planner", prompt, `plan-${iteration}`);
  const parsed = parseJsonBlock(rawText);
  if (!parsed) throw new Error("graph_evolve_planner_not_json");
  const blueprint = normalizeBlueprint(parsed);
  const orchestrators = blueprint.graphs.filter((g) => g.kind === "master_orchestrator").length;
  input.log?.(`INFO [nightGraphs.evolvePipeline] blueprint_planned ${redactKnown(JSON.stringify({
    iteration, decision: blueprint.decision, categoryId: blueprint.category?.id ?? null, graphsCount: blueprint.graphs.length, orchestrators,
  }))}`);
  return blueprint;
}

/** Stage 2 (`plan-critic`): cross-family audit of the blueprint against evidence on 6 hard fidelity and safety gates. */
export async function critiqueEvolutionBlueprint(input: {
  blueprint: ProcessBlueprint;
  collected: GraphEvolveCollectSummary;
  catalog: EvolveCatalogContext;
  runRole: EvolveRoleRunner;
  iteration?: number;
  log?: (message: string) => void;
}): Promise<EvolveReviewVerdict> {
  const iteration = input.iteration ?? 1;
  const hasRichEvidence = input.collected.clusters.some((c) => c.count >= 2 || c.traps.length > 0 || (c.lessons?.length ?? 0) > 0);
  if (input.blueprint.decision === "noop" && !hasRichEvidence) {
    const verdict: EvolveReviewVerdict = { verdict: "pass", findings: ["Noop justified: no rich trajectory clusters"], mustFix: [] };
    input.log?.(`INFO [nightGraphs.evolvePipeline] blueprint_critiqued ${redactKnown(JSON.stringify({ iteration, verdict: verdict.verdict, mustFixCount: 0 }))}`);
    return verdict;
  }

  const prompt = redactKnown([
    "You are Lane Pilot's Cross-Family Process Plan Critic. Do NOT call any tools or read external files. Output ONLY strict JSON: {\"verdict\":\"pass\"|\"rework\",\"findings\":[...],\"mustFix\":[...]}.",
    input.blueprint.decision === "noop"
      ? "The planner chose decision:\"noop\" despite rich trajectory clusters. Check whether valuable recurring workflows were mistakenly ignored; if so return verdict:\"rework\"."
      : "Audit the blueprint against the masked evidence on ALL 6 hard gates:\n1) Tool & MCP fidelity: observed MCPs/plugins (metamcp/Pencil .pen, image-studio/Muse, browser-automation) preserved on the right stages.\n2) Multi-variant fidelity: multi-concept/palette trajectories parameterize variants_count + owner human selection rather than forcing 1 variant.\n3) Order invariants: causal ordering respected (CTA/conversion map before design; UI Kit before full page templates; QA gate after build).\n4) Modular suite layout: multi-phase work split cleanly into 2..5 phase_graphs + master_orchestrator (dependsOnGraphs, subworkflow depth <= 3, no cycles, no collision with reservedBuiltinIds), without micro-node bloat.\n5) 100% De-projectization: zero domain/brand/person names, proj_*, host_*, /Users/... or /home/... leaks; dynamic category has bilingual {en, ru} label.\n6) Actionable deliverables: clear inputs, outputs, and acceptanceCriteria per graph.",
    `Catalog context: ${JSON.stringify(input.catalog)}`,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
    `Candidate blueprint: ${JSON.stringify(input.blueprint)}`,
  ].join("\n\n"));

  const verdict = normalizeVerdict(await input.runRole("plan-critic", prompt, `critique-${iteration}`));
  input.log?.(`INFO [nightGraphs.evolvePipeline] blueprint_critiqued ${redactKnown(JSON.stringify({
    iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length,
  }))}`);
  return verdict;
}

/** Stage 3 (`workflow-architect`): compiles an approved `ProcessBlueprint` into validated-ready `GraphEvolveCandidate[]` JSON. */
export async function synthesizeSuiteFromBlueprint(input: {
  blueprint: ProcessBlueprint;
  collected: GraphEvolveCollectSummary;
  catalog: EvolveCatalogContext;
  runRole: EvolveRoleRunner;
  priorCandidates?: readonly GraphEvolveCandidate[];
  validationErrors?: readonly string[];
  auditFeedback?: EvolveReviewVerdict | null;
  iteration?: number;
  log?: (message: string) => void;
}): Promise<GraphEvolveCandidate[]> {
  const iteration = input.iteration ?? 1;
  if (input.blueprint.decision === "noop" || input.blueprint.graphs.length === 0) {
    input.log?.(`INFO [nightGraphs.evolvePipeline] suite_synthesized ${redactKnown(JSON.stringify({ iteration, candidatesCount: 0, workflowIds: [] }))}`);
    return [];
  }

  const repairBlock = [
    ...(input.priorCandidates?.length ? [`Prior candidates to repair: ${JSON.stringify(input.priorCandidates)}`] : []),
    ...(input.validationErrors?.length ? [`Schema/validation/test errors to fix: ${JSON.stringify(input.validationErrors)}`] : []),
    ...(input.auditFeedback?.verdict === "rework" ? [`Auditor feedback to fix: ${JSON.stringify(input.auditFeedback)}`] : []),
  ];

  const prompt = redactKnown([
    'CRITICAL: You are running as a batch JSON workflow compiler in an isolated room. Do NOT call any tools, do NOT read files, and do NOT invoke lane_pilot_* or skill tools. Output ONLY the single JSON object {"candidates":[...]} in your message.',
    `WORKFLOW_REFERENCE:\n${JSON.stringify(WORKFLOW_REFERENCE)}`,
    "Strict Compiler Rules (must pass loadWorkflow, validateWorkflow, and runDraftTest):\n"
      + "1) Compile EVERY graph in blueprint.graphs into one GraphEvolveCandidate ({workflowId, scope:\"global\", name:{en,ru}, description:{en,ru}, category, sourceDeltaIds, definition}).\n"
      + "2) In definition set: id, version (1 or existingGlobal.version + 1), name, description, category:{id,label:{en,ru}}, status:\"draft\", triggers:[\"manual\"] (or [\"chat\",\"manual\"] WITH non-empty examples:[...] and not_for:[...]), inputs ({type:\"string\"|\"int\"|\"number\"|\"bool\"|\"json\", required?, default?, description?}), outputs ({<field>:\"string\"|\"int\"|\"bool\"}), nodes, edges, test.\n"
      + "3) nodeSchema is .strict() — NEVER invent extra node properties!\n"
      + "   - agent: {id, type:\"agent\", title:{en,ru}, role:\"planner\"|\"analyst\"|\"plan-critic\"|\"auditor\"|\"browser-qa\"|\"errand\"|\"specialist:design-lead\"|\"specialist:copy-lead\"|\"specialist:seo-specialist\"|\"specialist:growth-marketer\"|\"specialist:visual-artist\"|\"specialist:tavily\", prompt, skills?, plugins?, mcp?, out:{...}, guards?:{maxVisits?:3}}. NEVER set model, provider, reasoning, model_preset, or environment!\n"
      + "   - human: {id, type:\"human\", title:{en,ru}, question, options:[\"approve\",\"rework\",\"abort\"], out:{answer:\"string\", answer_kind:\"approve|rework|abort\"}} (omit timeoutSec unless \"timeout\" is in answer_kind and routed).\n"
      + "   - lp-task: {id, type:\"lp-task\", title:{en,ru}, owns_paths:[...], contract:{title, goal, acceptance:[...]}, out:{state:\"accepted|blocked|failed\", summary:\"string\"}, guards?:{maxVisits?:2}}.\n"
      + "   - subworkflow: {id, type:\"subworkflow\", title:{en,ru}, workflow:\"<child-workflow-id>\", inputs:{\"<childInput>\":\"{{$inputs.goal}}\"}, out:{\"<childOutputField>\":\"<matchingChildOutputType>\"}, guards:{maxVisits:1}}. CRITICAL: template refs in subworkflow.inputs MUST use \"{{...}}\" braces, map every required:true child input by exact name, and every subworkflow.out field MUST exist in the child's outputs with matching type!\n"
      + "   - terminal action: {id:\"done\", type:\"action\", action:\"emit\", map:{...every workflow output...}} (string literals in emit.map MUST be single-quoted like \"'completed'\", or reference upstream node.field; NEVER invent custom action names).\n"
      + "4) Every loop back-edge MUST have guards:{maxVisits:N} on the loop target AND when:\"... && visits('target') < N\" plus a fallback edge so every path reaches an emit node.\n"
      + "5) test: {id:\"happy-path\", sim:{input:{...valid sample inputs...}, stubs:{<nodeId>:{...matching node.out fields...}}, human_answers:{<humanNodeId>:\"approve\"}, expect_status:\"succeeded\", expect_path:[...exact node ids from start to done...]}}. For master_orchestrator, stub each subworkflow node by its node.id with values matching node.out!",
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
  input.log?.(`INFO [nightGraphs.evolvePipeline] suite_synthesized ${redactKnown(JSON.stringify({
    iteration, candidatesCount: candidates.length, workflowIds: candidates.map((c) => c.workflowId),
  }))}`);
  return candidates;
}

/** Stage 4 (`auditor`): cross-family fidelity audit comparing compiled candidate JSONs against the blueprint and evidence. */
export async function auditSynthesizedSuite(input: {
  blueprint: ProcessBlueprint;
  candidates: readonly GraphEvolveCandidate[];
  collected: GraphEvolveCollectSummary;
  runRole: EvolveRoleRunner;
  iteration?: number;
  log?: (message: string) => void;
}): Promise<EvolveReviewVerdict> {
  const iteration = input.iteration ?? 1;
  const prompt = redactKnown([
    "You are Lane Pilot's Cross-Family Senior Suite Auditor. Do NOT call any tools or read external files. Output ONLY strict JSON: {\"verdict\":\"pass\"|\"rework\",\"findings\":[\"<string>\",...],\"mustFix\":[\"<string>\",...]} (elements of findings and mustFix MUST be plain strings).",
    `WORKFLOW_REFERENCE:\n${JSON.stringify(WORKFLOW_REFERENCE)}`,
    "Engine Schema Constraints (NEVER ask mustFix to violate WORKFLOW_REFERENCE):\n"
      + "- nodeSchema is .strict(): ONLY type:\"agent\" nodes accept mcp, plugins, and skills. type:\"human\", \"lp-task\", \"subworkflow\", and \"action\" nodes FORBID mcp/plugins/skills (lp-task integrations live in contract text, and human nodes are owner choice gates).\n"
      + "- There is NO parallel node type in the schema (multi-item work executes inside agent or lp-task contracts).\n"
      + "- definition.test is a SINGLE {id, sim} object per workflow (not an array of multiple simulations), and synthetic /tmp/... strings inside test.sim stubs are valid test fixtures, NOT project path leaks.",
    "Audit Calibration (return verdict:\"rework\" + non-empty mustFix ONLY for genuine schema-valid blocking defects):\n"
      + "- Blocking (rework): a planned graph from blueprint.graphs is missing; master_orchestrator subworkflow links are missing or out of blueprint order; required MCPs (metamcp/Pencil .pen), plugins (image-studio, browser-automation), multi-variant count inputs, or human selection gates are missing from the relevant agent/workflow definitions; or real project/domain/brand/person/proj_*/host_* identifiers leaked.\n"
      + "- Non-blocking (pass): if all planned graphs, subworkflow links, required agent MCPs/plugins, multi-variant inputs, human gates, core phase handoffs, and de-projectization hold, return verdict:\"pass\" with mustFix:[] (record optional prose or edge refinements in findings only).",
    `Approved blueprint: ${JSON.stringify(input.blueprint)}`,
    `Compiled candidates: ${JSON.stringify(input.candidates)}`,
    `Masked evidence: ${JSON.stringify(input.collected)}`,
  ].join("\n\n"));

  const verdict = normalizeVerdict(await input.runRole("auditor", prompt, `audit-${iteration}`));
  input.log?.(`INFO [nightGraphs.evolvePipeline] suite_audited ${redactKnown(JSON.stringify({
    iteration, verdict: verdict.verdict, mustFixCount: verdict.mustFix.length,
  }))}`);
  return verdict;
}
