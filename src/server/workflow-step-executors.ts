import type { z } from "zod";
import type { stepExecutorSchema } from "../contracts";
import { automaticEffortRoutingEnabled, writerServiceTier } from "../jev-reasoning";
import { resolveStageWriterSelection } from "../stage-writer-selection";
import { writerFallbackChain, writerFallbacks } from "../writer-fallbacks";
import { costTier, validateChoice, type ModelCatalog } from "../workflow/model-catalog";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_REASONING, PRESETS, roleSpec } from "./workflow-agent";

/**
 * Who works on a step, and with which model. One place answers it for every node type, from the same rules the executors
 * use, so the card on the graph and the table in the Models view say what will run, not what someone hopes will:
 *
 *  - an agent node: the node's own `provider`/`model`/`reasoning`, then its `model_preset`, then the workflow agent's default
 *    (workflow-agent.ts). Settings do not reach it: the stage selections of Settings belong to the pipeline's own stages;
 *  - the pipeline's stages (`lp.pm-read`, `lp.plan-critique`, `lp.specialist-review`): the stage's selection in Settings,
 *    else the writer's profile (`writer.provider` / `writer.model`), as `resolveStageWriterSelection` does;
 *  - a code task (`lp-task`): the writer's model from `writer.*`, then fallback 1, fallback 2 and the PM's model; its code critic
 *    is the `code_critique` selection;
 *  - an action that goes through a helper thread (a Telegram send, a skill script): the errand helper on the agent default;
 *  - every other action, a decision, a question to the owner, a call of another workflow: no model.
 */
export type StepExecutor = z.infer<typeof stepExecutorSchema>;
type Raw = Record<string, unknown>;
type Settings = Record<string, unknown>;
export type PmPair = { providerId: string; model: string };

const isRaw = (value: unknown): value is Raw => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * The actions that run in an errand helper thread (see DELEGATED in workflow-executors.ts; a test keeps the two lists equal).
 */
export const DELEGATED_ACTIONS = ["telegram.send_rich", "shell.skill_script", "shell.repo_script", "deploy.post_check", "lp.preflight", "lp.project_checks", "bb.tasks.get", "bb.tasks.update", "bb.tasks.create"] as const;

type StageDef = {
  /** The settings prefix: `<stage>.provider`, `<stage>.model`, `<stage>.reasoning_effort`, `<stage>.service_tier`. */
  stage: string; label: string; helper: string;
  /** What the effort is when the stage sets none: the writer's, or a fixed level. */
  effort: { writer: boolean; fallback: string };
  tier: "writer" | "stage-only";
};
/** The agent nodes of the task pipeline (`uses`) that are the pipeline's own stages. */
const STAGE_NODES: Record<string, StageDef> = {
  "lp.pm-read": { stage: "pm_read", label: "PM read", helper: "pm-reader", effort: { writer: false, fallback: "low" }, tier: "stage-only" },
  "lp.plan-critique": { stage: "plan_critique", label: "Plan critique", helper: "plan-critic", effort: { writer: true, fallback: "medium" }, tier: "writer" },
  "lp.specialist-review": { stage: "specialist", label: "Specialist review", helper: "specialist-reviewer", effort: { writer: false, fallback: "high" }, tier: "stage-only" },
};
const CODE_CRITIQUE: StageDef = { stage: "code_critique", label: "Code critique", helper: "code-critic", effort: { writer: true, fallback: "medium" }, tier: "writer" };

const tierWord = (value: unknown): "fast" | "standard" | null => (value === "fast" || value === "standard" ? value : null);

function stageSelection(settings: Settings, def: StageDef) {
  const picked = resolveStageWriterSelection({ settings, config: { writerProviderId: "", writerModel: "" }, stageProviderKey: `${def.stage}.provider`, stageModelKey: `${def.stage}.model` });
  const effortKey = `${def.stage}.reasoning_effort`;
  const stageEffort = text(settings[effortKey]);
  const writerEffort = def.effort.writer ? text(settings["writer.reasoning_effort"]) : null;
  const tier = tierWord(settings[`${def.stage}.service_tier`]) ?? (def.tier === "writer" ? writerServiceTier(settings) : "standard");
  const fromStage = picked.source === "stage";
  return {
    providerId: text(picked.providerId), model: text(picked.model), reasoningEffort: stageEffort ?? writerEffort ?? def.effort.fallback, serviceTier: tier,
    source: (fromStage ? "stage" : picked.source === "writer-profile" ? "writer" : "none") as StepExecutor["source"],
    sourceKey: fromStage ? `${def.stage}.model` : picked.source === "writer-profile" ? "writer.model" : null,
  };
}

const none = (node: Raw, id: string, kind: string, label: string, extra: Partial<StepExecutor> = {}): StepExecutor => ({
  nodeId: id, kind, uses: text(node.uses), mode: "none", agent: { role: text(node.role), helper: null, label },
  providerId: null, model: null, reasoningEffort: null, serviceTier: null, source: "none", sourceKey: null, inherited: false, fallbacks: [], parts: [],
  overridable: false, settingsKey: null, costTier: "none", issues: [], ...extra,
});

function agentNode(node: Raw, id: string): StepExecutor {
  const role = text(node.role) ?? "worker";
  const helper = roleSpec(role).helper;
  const own = { provider: text(node.provider), model: text(node.model), reasoning: text(node.reasoning) };
  const presetName = text(node.model_preset);
  const preset = presetName ? PRESETS[presetName] : undefined;
  const set = Boolean(own.provider || own.model || own.reasoning);
  const providerId = own.provider ?? DEFAULT_PROVIDER;
  const model = own.model ?? preset?.model ?? DEFAULT_MODEL;
  const issues: string[] = [];
  if (presetName && !preset) issues.push("unknown_preset");
  if (own.provider && !own.model) issues.push("provider_without_model");
  return {
    nodeId: id, kind: "agent", uses: text(node.uses), mode: "model", agent: { role, helper, label: role },
    providerId, model, reasoningEffort: own.reasoning ?? preset?.reasoning ?? DEFAULT_REASONING, serviceTier: null,
    source: set ? "node" : preset ? "preset" : "role-default", sourceKey: set ? null : presetName ?? null, inherited: !set,
    fallbacks: [], parts: [], overridable: true, settingsKey: null, costTier: costTier(model), issues,
  };
}

function stageNode(node: Raw, id: string, def: StageDef, settings: Settings): StepExecutor {
  const picked = stageSelection(settings, def);
  return {
    nodeId: id, kind: "agent", uses: text(node.uses), mode: "model", agent: { role: text(node.role) ?? def.helper, helper: def.helper, label: def.label },
    providerId: picked.providerId, model: picked.model, reasoningEffort: picked.reasoningEffort, serviceTier: picked.serviceTier, source: picked.source, sourceKey: picked.sourceKey,
    inherited: picked.source !== "stage", fallbacks: [], parts: [], overridable: false, settingsKey: def.stage, costTier: costTier(picked.model),
    issues: picked.providerId && picked.model ? [] : ["no_selection"],
  };
}

function codeTask(node: Raw, id: string, settings: Settings, pm: PmPair | null): StepExecutor {
  const providerId = text(settings["writer.provider"]), model = text(settings["writer.model"]);
  const effort = text(settings["writer.reasoning_effort"]) ?? "medium";
  const tier = writerServiceTier(settings);
  const chain = providerId && model ? writerFallbackChain({ providerId, model }, writerFallbacks(settings), pm ?? { providerId: "", model: "" }) : [];
  const fallbacks: StepExecutor["fallbacks"] = chain.map((row) => ({ providerId: row.providerId, model: row.model, reasoningEffort: row.pm ? null : row.reasoningLevel || null, pm: row.pm }));
  if (!pm && providerId && model) fallbacks.push({ providerId: null, model: null, reasoningEffort: null, pm: true });
  const stages = Array.isArray(node.stages) ? node.stages.filter((item): item is string => typeof item === "string") : [];
  const parts: StepExecutor["parts"] = [];
  if (!stages.length || stages.includes("code-critique")) {
    const critic = stageSelection(settings, CODE_CRITIQUE);
    parts.push({ stage: "code-critique", providerId: critic.providerId, model: critic.model, reasoningEffort: critic.reasoningEffort, serviceTier: critic.serviceTier, source: critic.source, sourceKey: critic.sourceKey });
  }
  const issues: string[] = [];
  if (!providerId || !model) issues.push("no_selection");
  if (automaticEffortRoutingEnabled(settings)) issues.push("effort_auto");
  return {
    nodeId: id, kind: "lp-task", uses: text(node.uses), mode: "chain", agent: { role: "writer", helper: "writer", label: "writer" },
    providerId, model, reasoningEffort: effort, serviceTier: tier, source: providerId || model ? "writer" : "none", sourceKey: "writer.model", inherited: true,
    fallbacks, parts, overridable: false, settingsKey: "writer", costTier: costTier(model), issues,
  };
}

function stepOf(node: Raw, id: string, settings: Settings, pm: PmPair | null): StepExecutor | null {
  const kind = text(node.type) ?? "agent";
  const uses = text(node.uses);
  switch (kind) {
    case "note": case "join": case "parallel": return null;
    case "agent": {
      const stage = uses ? STAGE_NODES[uses] : undefined;
      return stage ? stageNode(node, id, stage, settings) : agentNode(node, id);
    }
    case "lp-task": return codeTask(node, id, settings, pm);
    case "action": {
      const key = uses ?? text(node.action);
      if (key && (DELEGATED_ACTIONS as readonly string[]).includes(key)) {
        return { ...agentNode({ role: "errand" }, id), kind: "action", uses, mode: "helper", agent: { role: "errand", helper: "errand", label: key }, source: "helper", sourceKey: "errand", inherited: true, overridable: false };
      }
      return none(node, id, kind, text(node.action) ?? "action");
    }
    case "human": return none(node, id, kind, "owner");
    case "decision": return none(node, id, kind, "decision");
    case "subworkflow": return none(node, id, kind, text(node.workflow) ?? "workflow");
    default: return none(node, id, kind, kind);
  }
}

export type ResolveInput = {
  /** The nodes of a workflow or of a draft as written (a draft may be unfinished). */
  nodes: ReadonlyArray<unknown>;
  /** The effective settings of the project (or the global ones). */
  settings: Settings;
  /** The model the PM chat runs on, when known: the last model of the writer chain. */
  pm: PmPair | null;
  catalog?: ModelCatalog | null;
};

/** Marks a step whose provider, model or effort the hub's machines do not offer. */
function withCatalogIssues(step: StepExecutor, catalog: ModelCatalog): StepExecutor {
  if (step.mode === "none" || !step.providerId || !step.model) return step;
  const verdict = validateChoice(catalog, { providerId: step.providerId, model: step.model, effort: step.reasoningEffort });
  if (verdict.ok) return step;
  // An effort the model lacks is the model's smaller problem; the provider and the model being absent come first.
  return { ...step, issues: [...step.issues, verdict.code] };
}

/** One entry per step that runs (not notes, joins or the container of a parallel), in graph order; the body of a parallel is `<id>:child`. */
export function resolveStepExecutors(input: ResolveInput): StepExecutor[] {
  const out: StepExecutor[] = [];
  for (const raw of input.nodes) {
    if (!isRaw(raw)) continue;
    const id = text(raw.id);
    if (!id) continue;
    const found = stepOf(raw, id, input.settings, input.pm);
    if (found) out.push(found);
    if (text(raw.type) === "parallel" && isRaw(raw.child)) {
      const body = stepOf(raw.child, `${id}:child`, input.settings, input.pm);
      if (body) out.push(body);
    }
  }
  return input.catalog ? out.map((step) => withCatalogIssues(step, input.catalog!)) : out;
}
