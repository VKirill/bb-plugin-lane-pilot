import type { z } from "zod";
import type { stepExecutorSchema } from "../contracts";
import { automaticEffortRoutingEnabled, writerServiceTier } from "@lane-pilot/models";
import { resolveStageWriterSelection } from "../stage-writer-selection";
import { writerFallbackChain, writerFallbacks } from "../writer-fallbacks";
import { costTier, offeredOnHost, validateChoice, type ModelCatalog } from "@lane-pilot/models";
import { roleSpec } from "./workflow-agent";
import { modelOverrideAt, modelOverrideKey, resolveAgentModel } from "./workflow-agent-model";

type At = { workflowId: string; ownKeys: ReadonlySet<string> } | undefined;

/**
 * Who works on a step, and with which model. One place answers it for every node type, from the same rules the executors
 * use, so the card on the graph and the table in the Models view say what will run, not what someone hopes will:
 *
 *  - a generic agent node: the node's own `provider`/`model`/`reasoning`, then its `model_preset` (a named setting), then the
 *    role's stage selection in Settings, the generic `workflow.agent.*` selection and the PM's model (resolveAgentModel,
 *    workflow-agent-model.ts, the function the executor calls);
 *  - the pipeline's stages (`lp.pm-read`, `lp.plan-critique`, `lp.specialist-review`): the stage's selection in Settings,
 *    else the writer's profile (`writer.provider` / `writer.model`), as `resolveStageWriterSelection` does;
 *  - a code task (`lp-task`): the writer's model from `writer.*`, then fallback 1, fallback 2 and the PM's model; its code critic
 *    is the `code_critique` selection;
 *  - an action that goes through a helper thread (a Telegram send, a skill script): the errand helper, resolved like an agent node;
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

/** Whether the owner's override applies to the step (an errand action takes the override's model too, but keeps saying it is the helper's otherwise). */
const overridden = (settings: Settings, id: string, at: At): boolean => Boolean(at && modelOverrideAt(settings, modelOverrideKey(at.workflowId, id)));

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
  overridable: false, canOverride: false, overrideScope: null, settingsKey: null, costTier: "none", issues: [], ...extra,
});

type Offered = ((providerId: string, model: string) => boolean | null) | undefined;

function agentNode(node: Raw, id: string, settings: Settings, pm: PmPair | null, at: At, offered?: Offered): StepExecutor {
  const role = text(node.role) ?? "worker";
  const helper = roleSpec(role).helper;
  // The same function the executor calls (withResolvedModel, workflow-agent.ts): the card says what will be spawned.
  const chosen = resolveAgentModel({ role, node: { provider: text(node.provider), model: text(node.model), reasoning: text(node.reasoning), service_tier: text(node.service_tier), model_preset: text(node.model_preset) }, settings, pm, ...(offered ? { offered } : {}), ...(at ? { at: { workflowId: at.workflowId, nodeId: id } } : {}) });
  return {
    nodeId: id, kind: "agent", uses: text(node.uses), mode: "model", agent: { role, helper, label: role },
    providerId: chosen.providerId, model: chosen.model, reasoningEffort: chosen.reasoningEffort, serviceTier: chosen.serviceTier,
    source: chosen.source, sourceKey: chosen.sourceKey, inherited: chosen.inherited,
    fallbacks: [], parts: [], overridable: true, canOverride: Boolean(at), overrideScope: chosen.source === "override" && at ? (chosen.sourceKey && at.ownKeys.has(chosen.sourceKey) ? "project" : "global") : null,
    settingsKey: null, costTier: costTier(chosen.model), issues: chosen.issues,
  };
}

function stageNode(node: Raw, id: string, def: StageDef, settings: Settings): StepExecutor {
  const picked = stageSelection(settings, def);
  return {
    nodeId: id, kind: "agent", uses: text(node.uses), mode: "model", agent: { role: text(node.role) ?? def.helper, helper: def.helper, label: def.label },
    providerId: picked.providerId, model: picked.model, reasoningEffort: picked.reasoningEffort, serviceTier: picked.serviceTier, source: picked.source, sourceKey: picked.sourceKey,
    inherited: picked.source !== "stage", fallbacks: [], parts: [], overridable: false, canOverride: false, overrideScope: null, settingsKey: def.stage, costTier: costTier(picked.model),
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
    fallbacks, parts, overridable: false, canOverride: false, overrideScope: null, settingsKey: "writer", costTier: costTier(model), issues,
  };
}

function stepOf(node: Raw, id: string, settings: Settings, pm: PmPair | null, at: At, offered?: Offered): StepExecutor | null {
  const kind = text(node.type) ?? "agent";
  const uses = text(node.uses);
  switch (kind) {
    case "note": case "join": case "parallel": return null;
    case "agent": {
      const stage = uses ? STAGE_NODES[uses] : undefined;
      return stage ? stageNode(node, id, stage, settings) : agentNode(node, id, settings, pm, at, offered);
    }
    case "lp-task": return codeTask(node, id, settings, pm);
    case "action": {
      const key = uses ?? text(node.action);
      if (key && (DELEGATED_ACTIONS as readonly string[]).includes(key)) {
        return { ...agentNode({ role: "errand", model_preset: node.model_preset }, id, settings, pm, at, offered), kind: "action", uses, mode: "helper", agent: { role: "errand", helper: "errand", label: key }, ...(overridden(settings, id, at) ? {} : { source: "helper" as const, sourceKey: "errand", inherited: true }), overridable: false };
      }
      return none(node, id, kind, text(node.action) ?? "action");
    }
    case "human": return none(node, id, kind, "owner");
    case "decision": return none(node, id, kind, "decision");
    case "subworkflow": return none(node, id, kind, text(node.workflow) ?? "workflow");
    default: return none(node, id, kind, kind);
  }
}

/** The nodes and edges of one workflow, as written (a draft may be unfinished). */
export type WorkflowShape = { nodes: ReadonlyArray<unknown>; edges?: ReadonlyArray<unknown> | undefined; entry?: string | undefined };

export type ResolveInput = WorkflowShape & {
  /** The effective settings of the project (or the global ones). */
  settings: Settings;
  /** The model the PM chat runs on, when known: the last model of the writer chain. */
  pm: PmPair | null;
  catalog?: ModelCatalog | null;
  /**
   * The workflow the nodes belong to and the keys of the settings the project holds itself (the rest is the global level): with them
   * the owner's per-step overrides (`workflow.model_override.<workflowId>/<nodeId>`) apply and say which level they come from.
   * Without a workflow id (a draft of a new workflow) none applies to its own steps.
   */
  workflowId?: string; ownKeys?: ReadonlySet<string>;
  /** The workflows the subworkflow nodes call, by id: their steps are listed right after the call, with the fragment they belong to. */
  fragments?: ReadonlyMap<string, WorkflowShape>;
};

/** Marks a step whose provider, model or effort the hub's machines do not offer. */
function withCatalogIssues(step: StepExecutor, catalog: ModelCatalog): StepExecutor {
  if (step.mode === "none" || !step.providerId || !step.model) return step;
  const verdict = validateChoice(catalog, { providerId: step.providerId, model: step.model, effort: step.reasoningEffort });
  if (verdict.ok) return step;
  // An effort the model lacks is the model's smaller problem; the provider and the model being absent come first.
  return step.issues.includes(verdict.code) ? step : { ...step, issues: [...step.issues, verdict.code] };
}

/** How many calls deep the steps of called workflows are followed. */
const MAX_FRAGMENT_DEPTH = 3;

/**
 * A step that only ever goes on in an earlier agent's session (every edge into it is `same-session`, it is not the entry and does not
 * say `session: new`) runs in that session: the model is the earlier step's, whatever the step itself names. The engine takes the step's
 * own earlier session first and the source's after, so a step with any other way in (the entry, an artifact) starts a session of its own.
 */
function withInheritedSessions(raws: ReadonlyArray<Raw>, shape: WorkflowShape, steps: Map<string, StepExecutor>): void {
  const edges = (shape.edges ?? []).filter(isRaw);
  const rawById = new Map(raws.map((node) => [text(node.id) ?? "", node]));
  const sourceOf = (id: string): string | null => {
    const node = rawById.get(id);
    if (!node || text(node.session) === "new" || shape.entry === id) return null;
    const into = edges.filter((edge) => text(edge.to) === id);
    if (!into.length || !into.every((edge) => text(edge.pass) === "same-session" && text(edge.from) !== "start")) return null;
    return into.map((edge) => text(edge.from) ?? "").find((from) => from !== id && steps.get(from)?.kind === "agent" && steps.get(from)?.mode === "model") ?? null;
  };
  const resolved = new Map<string, StepExecutor>();
  const finalOf = (id: string, seen: ReadonlySet<string>): StepExecutor | undefined => {
    const own = steps.get(id);
    if (!own) return undefined;
    const known = resolved.get(id);
    if (known) return known;
    const from = seen.has(id) ? null : sourceOf(id);
    const base = from ? finalOf(from, new Set([...seen, id])) : undefined;
    const done: StepExecutor = base && from
      ? { ...base, nodeId: own.nodeId, uses: own.uses, agent: own.agent, source: "session", sourceKey: from, inherited: true, overridable: false, canOverride: false, overrideScope: null, settingsKey: null }
      : own;
    resolved.set(id, done);
    return done;
  };
  for (const id of [...steps.keys()]) steps.set(id, finalOf(id, new Set())!);
}

/**
 * One entry per step that runs (not notes, joins or the container of a parallel), in graph order; the body of a parallel is `<id>:child`.
 * The steps of a workflow a subworkflow node calls follow the call, each marked with its `fragment`.
 */
export function resolveStepExecutors(input: ResolveInput): StepExecutor[] {
  // The machine the helpers run on decides what is offered: a model another machine has is not one this step can start on.
  const offered: Offered = input.catalog?.runHostId ? (providerId, model) => offeredOnHost(input.catalog!, providerId, model, input.catalog!.runHostId) : undefined;
  const ownKeys = input.ownKeys ?? new Set<string>();

  const level = (shape: WorkflowShape, at: At, tag: StepExecutor["fragment"], path: readonly string[]): StepExecutor[] => {
    const raws = shape.nodes.filter(isRaw);
    const steps = new Map<string, StepExecutor>();
    const order: string[] = [];
    const calls = new Map<string, string>();
    for (const raw of raws) {
      const id = text(raw.id);
      if (!id) continue;
      const found = stepOf(raw, id, input.settings, input.pm, at, offered);
      if (found) { steps.set(id, found); order.push(id); }
      if (text(raw.type) === "parallel" && isRaw(raw.child)) {
        const body = stepOf(raw.child, `${id}:child`, input.settings, input.pm, at, offered);
        if (body) { steps.set(`${id}:child`, body); order.push(`${id}:child`); }
      }
      const callee = text(raw.type) === "subworkflow" ? text(raw.workflow) : null;
      if (callee) calls.set(id, callee);
    }
    withInheritedSessions(raws, shape, steps);
    const out: StepExecutor[] = [];
    for (const id of order) {
      const step = steps.get(id)!;
      // A step of a called workflow is not a node of this graph: only its override setting changes it.
      const marked = tag ? { ...step, fragment: tag, overridable: false } : step;
      out.push(input.catalog ? withCatalogIssues(marked, input.catalog) : marked);
      const callee = calls.get(id);
      const child = callee ? input.fragments?.get(callee) : undefined;
      if (callee && child && !path.includes(callee) && path.length <= MAX_FRAGMENT_DEPTH) {
        out.push(...level(child, { workflowId: callee, ownKeys }, { nodeId: tag?.nodeId ?? id, workflowId: callee }, [...path, callee]));
      }
    }
    return out;
  };
  return level(input, input.workflowId ? { workflowId: input.workflowId, ownKeys } : undefined, undefined, input.workflowId ? [input.workflowId] : []);
}
