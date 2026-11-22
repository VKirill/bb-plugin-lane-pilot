import { canonicalBroadCategory, isAllowedBroadCategoryId } from "./category-taxonomy";

export type EvolutionOperator =
  | "noop"
  | "patch_converge"
  | "split_node"
  | "extend_module"
  | "create_suite"
  | "prune_or_relax";

export type CompanionArchetypeOverlaySpec = {
  slug: string;
  title: string;
  whenToUse: string;
  rules: string[];
};

export type CompanionSkillSpec = {
  skillId: string;
  workflowIds: string[];
  mergeMode: "create_bundle" | "merge_core_and_overlay";
  summary: string;
  whenToUse: string;
  whenNotToUse: string;
  coreRules: string[];
  goldenSkeletonSections: string[];
  qaRubricChecks: string[];
  archetypeOverlays: CompanionArchetypeOverlaySpec[];
};

export type ProcessBlueprintStageSpec = {
  id: string;
  nodeType: "agent" | "human" | "lp-task" | "action" | "subworkflow" | "parallel";
  role?: string;
  subworkflowId?: string;
  purpose: string;
  necessity?: "core" | "optional";
  skipConditionHint?: string;
  skills: string[];
  mcp: string[];
  plugins: string[];
  contractRules: string[];
};

export type ProcessBlueprintGraphSpec = {
  workflowId: string;
  kind: "phase_graph" | "master_orchestrator";
  standaloneChat?: boolean;
  name: { en: string; ru: string };
  description: { en: string; ru: string };
  dependsOnGraphs: string[];
  inputs: Record<string, string>;
  outputs: Record<string, string>;
  stages: ProcessBlueprintStageSpec[];
  acceptanceCriteria: string[];
};

export type ProcessBlueprint = {
  operator?: EvolutionOperator;
  decision: "noop" | "minor_patch" | "suite_or_structural";
  rationale: string;
  category: { id: string; label: { en: string; ru: string } } | null;
  supersededWorkflowIds?: string[];
  orderInvariants: string[];
  variantParameters: Array<{ name: string; rangeOrValues: string; purpose: string }>;
  requiredIntegrations: { mcp: string[]; plugins: string[]; skills: string[] };
  graphs: ProcessBlueprintGraphSpec[];
  companionSkills?: CompanionSkillSpec[];
};

export type NormalizedProcessBlueprint = ProcessBlueprint & {
  operator: EvolutionOperator;
  supersededWorkflowIds: string[];
  companionSkills: CompanionSkillSpec[];
};

export const EVOLUTION_OPERATORS = new Set<EvolutionOperator>([
  "noop",
  "patch_converge",
  "split_node",
  "extend_module",
  "create_suite",
  "prune_or_relax",
]);
const DECISIONS = new Set<ProcessBlueprint["decision"]>(["noop", "minor_patch", "suite_or_structural"]);
const STAGE_TYPES = new Set<ProcessBlueprintStageSpec["nodeType"]>(["agent", "human", "lp-task", "action", "subworkflow", "parallel"]);
const SKILL_ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
const ARCHETYPE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

export const str = (v: unknown, fallback = ""): string => (typeof v === "string" && v.trim() ? v.trim() : fallback);
export const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()) : [];

export const bilingual = (v: unknown, fallback: string): { en: string; ru: string } => {
  if (typeof v === "string" && v.trim()) return { en: v.trim(), ru: v.trim() };
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const r = v as { en?: unknown; ru?: unknown };
    const en = str(r.en), ru = str(r.ru);
    if (en || ru) return { en: en || ru, ru: ru || en };
  }
  return { en: fallback, ru: fallback };
};

export const stringRecord = (v: unknown): Record<string, string> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (k.trim() && typeof val === "string") out[k.trim()] = val.trim();
  return out;
};

export function parseJsonBlock(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch { return null; }
}

const toKebab = (raw: string, maxLen: number): string =>
  raw.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, maxLen).replace(/-+$/g, "");

function normalizeCategory(raw: unknown): ProcessBlueprint["category"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const catRaw = raw as Record<string, unknown>;
  const catId = toKebab(str(catRaw.id), 32);
  if (!catId) return null;
  const lifted = canonicalBroadCategory(catId);
  if (!isAllowedBroadCategoryId(catId) && lifted) return { id: lifted.id, label: lifted.label };
  if ((!catRaw.label || typeof catRaw.label !== "object") && lifted?.label) return { id: catId, label: lifted.label };
  return { id: catId, label: bilingual(catRaw.label, catId) };
}

function normalizeArchetypeOverlay(raw: unknown): CompanionArchetypeOverlaySpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const slug = toKebab(str(r.slug), 48);
  if (!slug || !ARCHETYPE_SLUG_RE.test(slug)) return null;
  return {
    slug, title: str(r.title, slug),
    whenToUse: str(r.whenToUse, `applying this process to the ${slug} archetype`),
    rules: strList(r.rules),
  };
}

/** Normalizes a raw companion skill specification object from planner/architect JSON. */
export function normalizeCompanionSkillSpec(raw: unknown): CompanionSkillSpec | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const skillId = toKebab(str(r.skillId), 48);
  if (!SKILL_ID_RE.test(skillId)) return null;
  const overlayListRaw = Array.isArray(r.archetypeOverlays) ? r.archetypeOverlays : (r.archetypeOverlay ? [r.archetypeOverlay] : []);
  const overlaysBySlug = new Map<string, CompanionArchetypeOverlaySpec>();
  for (const item of overlayListRaw) {
    const parsed = normalizeArchetypeOverlay(item);
    if (parsed) overlaysBySlug.set(parsed.slug, parsed);
  }
  return {
    skillId,
    workflowIds: [...new Set(strList(r.workflowIds))],
    mergeMode: r.mergeMode === "merge_core_and_overlay" ? "merge_core_and_overlay" : "create_bundle",
    summary: str(r.summary, `Standard companion specification for ${skillId}.`),
    whenToUse: str(r.whenToUse, `producing or auditing ${skillId} deliverables`),
    whenNotToUse: str(r.whenNotToUse, `unrelated tasks outside ${skillId}`),
    coreRules: strList(r.coreRules),
    goldenSkeletonSections: strList(r.goldenSkeletonSections),
    qaRubricChecks: strList(r.qaRubricChecks),
    archetypeOverlays: [...overlaysBySlug.values()],
  };
}

function normalizeGraphs(raw: unknown): ProcessBlueprintGraphSpec[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((g) => {
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
          const necessity = sr.necessity === "optional" ? "optional" : sr.necessity === "core" ? "core" : undefined;
          const skipConditionHint = str(sr.skipConditionHint) || undefined;
          return [{
            id, nodeType: STAGE_TYPES.has(nt) ? nt : "agent",
            ...(str(sr.role) ? { role: str(sr.role) } : {}),
            ...(str(sr.subworkflowId) ? { subworkflowId: str(sr.subworkflowId) } : {}),
            purpose: str(sr.purpose, id),
            ...(necessity ? { necessity } : {}),
            ...(skipConditionHint ? { skipConditionHint } : {}),
            skills: strList(sr.skills), mcp: strList(sr.mcp), plugins: strList(sr.plugins), contractRules: strList(sr.contractRules),
          }];
        })
      : [];
    return [{
      workflowId, kind,
      ...(typeof gr.standaloneChat === "boolean" ? { standaloneChat: gr.standaloneChat } : {}),
      name: bilingual(gr.name, workflowId), description: bilingual(gr.description, workflowId),
      dependsOnGraphs: strList(gr.dependsOnGraphs), inputs: stringRecord(gr.inputs), outputs: stringRecord(gr.outputs),
      stages, acceptanceCriteria: strList(gr.acceptanceCriteria),
    }];
  });
}

/** Resolves a blueprint's effective AFlow evolution operator even for legacy blueprints omitting `operator`. */
export function resolveBlueprintOperator(bp: Pick<ProcessBlueprint, "operator" | "decision" | "supersededWorkflowIds">): EvolutionOperator {
  if (bp.operator && EVOLUTION_OPERATORS.has(bp.operator)) return bp.operator;
  if (bp.decision === "noop") return "noop";
  if (bp.decision === "minor_patch") return "patch_converge";
  return (bp.supersededWorkflowIds?.length ?? 0) > 0 ? "patch_converge" : "create_suite";
}

/** Normalizes raw planner JSON into a validated `NormalizedProcessBlueprint` with consistent operator, category, and companion skills. */
export function normalizeBlueprint(raw: Record<string, unknown>): NormalizedProcessBlueprint {
  const opRaw = str(raw.operator) as EvolutionOperator;
  const hasExplicitOp = EVOLUTION_OPERATORS.has(opRaw);
  const decisionRaw = str(raw.decision) as ProcessBlueprint["decision"];
  const hasExplicitDecision = DECISIONS.has(decisionRaw);
  const supersededWorkflowIds = [...new Set(strList(raw.supersededWorkflowIds))];
  const graphs = normalizeGraphs(raw.graphs);
  const companionSkills = Array.isArray(raw.companionSkills)
    ? raw.companionSkills.map(normalizeCompanionSkillSpec).filter((s): s is CompanionSkillSpec => s !== null)
    : [];

  let operator: EvolutionOperator;
  let decision: ProcessBlueprint["decision"];
  if (hasExplicitOp) {
    operator = opRaw;
    if (operator === "noop") decision = "noop";
    else if (operator === "patch_converge" || operator === "prune_or_relax") {
      decision = supersededWorkflowIds.length === 0 && hasExplicitDecision && decisionRaw === "minor_patch" ? "minor_patch" : "suite_or_structural";
    } else decision = "suite_or_structural";
  } else {
    decision = hasExplicitDecision ? decisionRaw : "noop";
    operator = resolveBlueprintOperator({ decision, supersededWorkflowIds });
  }

  if (graphs.length === 0 && companionSkills.length === 0 && decision !== "noop") {
    operator = "noop";
    decision = "noop";
  }

  const reqRaw = raw.requiredIntegrations && typeof raw.requiredIntegrations === "object" ? (raw.requiredIntegrations as Record<string, unknown>) : {};
  const variantParameters = Array.isArray(raw.variantParameters)
    ? raw.variantParameters.flatMap((v) => {
        if (!v || typeof v !== "object" || Array.isArray(v)) return [];
        const r = v as Record<string, unknown>, name = str(r.name);
        return name ? [{ name, rangeOrValues: str(r.rangeOrValues, "1..6"), purpose: str(r.purpose) }] : [];
      })
    : [];

  return {
    operator, decision, rationale: str(raw.rationale), category: normalizeCategory(raw.category),
    supersededWorkflowIds: decision === "noop" ? [] : supersededWorkflowIds,
    orderInvariants: strList(raw.orderInvariants), variantParameters,
    requiredIntegrations: { mcp: strList(reqRaw.mcp), plugins: strList(reqRaw.plugins), skills: strList(reqRaw.skills) },
    graphs: decision === "noop" ? [] : graphs,
    companionSkills: decision === "noop" ? [] : companionSkills,
  };
}
