import type { NodeForm } from "@lane-pilot/contracts";
import { AUTHOR_ROWS, CLAUDE_PROFILE_ROLES, ROLE_MODEL_OPTIONS, modelFamily, modelTier, offeredForRole, roleRowOf, zcodeBackgroundOn, type ModelCatalog } from "@lane-pilot/models";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime } from "../../../contracts/server";
import { providerBlockedForFolder, type ProviderFolderBlock } from "../../../platform/server";

type AgentNode = Extract<GraphNode, { type: "agent" }>;

/** Renders a node's saved plan into prompt instructions for `plan` form (saved plan adapted by a small model). */
export function formatSavedPlan(ctx: StepContext<ChainRuntime>, node: AgentNode): string {
  const plan = node.plan;
  if (!plan) return "";
  const lines: string[] = [];
  if (typeof plan === "string") {
    lines.push(ctx.render(plan));
  } else {
    if (plan.summary) lines.push(`Summary: ${ctx.render(plan.summary)}`);
    if (plan.template) lines.push(ctx.render(plan.template));
    if (plan.steps?.length) {
      lines.push(...plan.steps.map((step, i) => `${i + 1}. ${ctx.render(step)}`));
    }
  }
  const body = lines.filter(Boolean).join("\n");
  if (!body) return "";
  return `<saved_plan>\n${body}\n</saved_plan>\nAdapt and follow this saved plan for the current inputs rather than planning from scratch.`;
}

/** Optional explicit model override declared inside `node.plan`. */
export function planModelOverride(ctx: StepContext<ChainRuntime>, node: AgentNode): {
  provider?: string;
  model?: string;
  reasoning?: string;
  nodeModel?: true;
} {
  if (ctx.form !== "plan" || !node.plan || typeof node.plan === "string") return {};
  const model = node.plan.model ? ctx.render(node.plan.model) : "";
  return {
    ...(node.plan.provider ? { provider: ctx.render(node.plan.provider) } : {}),
    ...(model ? { model, nodeModel: true as const } : {}),
    ...(node.plan.reasoning ? { reasoning: node.plan.reasoning } : {}),
  };
}

/** Picks a small (`light`-tier) model for `plan` form while respecting host availability, profile restrictions, and judge family separation. */
export function pickPlanSmallModel(input: {
  form?: NodeForm;
  nodeModel?: true;
  role: string;
  chosen: { providerId: string; model: string; reasoningEffort: string; issues: string[] };
  author: { providerId: string; model: string } | null;
  catalog: ModelCatalog | null;
  hostId: string | null;
  envPath: string | null;
  folderBlock: ProviderFolderBlock | null;
  settings: Record<string, unknown>;
}): { providerId: string; model: string; reasoningEffort: string; issues: string[] } | null {
  if (input.form !== "plan" || input.nodeModel) return null;
  if (modelTier(input.chosen.model) === "light") return null;
  const row = roleRowOf(input.role);
  const profileOnly = CLAUDE_PROFILE_ROLES.has(row);
  const authorFamily = input.author && AUTHOR_ROWS[row] ? modelFamily(input.author.model) : null;
  const preferredFamily = modelFamily(input.chosen.model);

  const lightOptions = ROLE_MODEL_OPTIONS.filter((opt) => {
    if (opt.tier !== "light") return false;
    if (opt.providerId === "zcode" && !zcodeBackgroundOn(input.settings)) return false;
    if (profileOnly && opt.providerId !== "claude-code") return false;
    if (providerBlockedForFolder(opt.providerId, input.envPath, input.folderBlock)) return false;
    if (input.catalog && offeredForRole(input.catalog, opt.providerId, opt.id, input.hostId) === false) return false;
    return true;
  });
  if (!lightOptions.length) return null;

  const sorted = [...lightOptions].sort((a, b) => {
    const aJudgeOk = authorFamily ? (a.family !== authorFamily ? 0 : 1) : 0;
    const bJudgeOk = authorFamily ? (b.family !== authorFamily ? 0 : 1) : 0;
    if (aJudgeOk !== bJudgeOk) return aJudgeOk - bJudgeOk;
    const aFam = preferredFamily && a.family === preferredFamily ? 0 : 1;
    const bFam = preferredFamily && b.family === preferredFamily ? 0 : 1;
    return aFam - bFam;
  });
  const picked = sorted[0]!;
  return {
    providerId: picked.providerId,
    model: picked.id,
    reasoningEffort: picked.defaultEffort ?? "medium",
    issues: input.chosen.issues.filter((i) => i !== "model_unavailable_here"),
  };
}
