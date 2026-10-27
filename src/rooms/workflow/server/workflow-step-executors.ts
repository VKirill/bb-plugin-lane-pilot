import type { z } from "zod";
import type { stepExecutorSchema } from "../../contracts";
import { automaticEffortRoutingEnabled, writerServiceTier } from "@lane-pilot/models";
import { resolveStageWriterSelection } from "../../writer";
import { writerFallbackChain, writerFallbacks } from "../../writer";
import { costTier, offeredOnHost, peerOffSpent, resolveRoleModel, roleModelKey, roleRowOf, validateChoice, type ModelCatalog, type SpentProbe } from "@lane-pilot/models";
import { roleSpec } from "./workflow-agent";
import { pmAuthorOf, resolveAgentModel } from "./workflow-agent-model";

/**
 * Who works on a step, and with which model. One place answers it for every node type, from the same rules the executors
 * use, so the card on the graph and the table in the Models view say what will run, not what someone hopes will:
 *
 * The model belongs to the ROLE: one table «role -> model» (packages/models/src/role-models.ts). This view only READS it, nothing
 * on a step changes the model.
 *
 *  - a generic agent node: the role's row of the table (resolveAgentModel, workflow-agent-model.ts, the function the executor calls);
 *  - the pipeline's stages (`lp.pm-read`, `lp.plan-critique`, `lp.specialist-review`): the row of their role (pm-reader, plan-critic,
 *    specialist-reviewer), as the stage runs it (critique-runs.ts);
 *  - a code task (`lp-task`): the writer's model from `writer.*` (Jev's pick per task), then fallback 1, fallback 2 and the PM's
 *    model; its code critic is the code-critic row (the other family than the writer's model when the task runs);
 *  - an action that goes through a helper thread (a Telegram send, a skill script): the errand helper, the errand row;
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
export const DELEGATED_ACTIONS = ["telegram.send_rich", "shell.skill_script", "shell.repo_script", "deploy.post_check", "lp.preflight", "lp.project_checks"] as const;

type StageDef = {
  /** The settings prefix of the stage's tier: `<stage>.service_tier`. */
  stage: string; label: string; helper: string;
  /** The role-table row the stage runs on. */
  role: string;
  tier: "writer" | "stage-only";
};
/** The agent nodes of the task pipeline (`uses`) that are the pipeline's own stages. */
const STAGE_NODES: Record<string, StageDef> = {
  "lp.pm-read": { stage: "pm_read", label: "PM read", helper: "pm-reader", role: "pm-reader", tier: "stage-only" },
  "lp.plan-critique": { stage: "plan_critique", label: "Plan critique", helper: "plan-critic", role: "plan-critic", tier: "writer" },
  "lp.specialist-review": { stage: "specialist", label: "Specialist review", helper: "specialist-reviewer", role: "specialist-reviewer", tier: "stage-only" },
};
const CODE_CRITIQUE: StageDef = { stage: "code_critique", label: "Code critique", helper: "code-critic", role: "code-critic", tier: "writer" };

const tierWord = (value: unknown): "fast" | "standard" | null => (value === "fast" || value === "standard" ? value : null);

function stageSelection(settings: Settings, def: StageDef, offered?: Offered, spent?: SpentProbe) {
  const table = resolveRoleModel(def.role, settings);
  // The stage asks the same limit rule as the executor (critic-pair.ts criticOffSpent): a nearly spent provider's pick moves to the other family.
  const moved = peerOffSpent(table, spent, (providerId, model) => offered?.(providerId, model) !== false);
  const picked = moved ? { ...table, providerId: moved.providerId, model: moved.model } : table;
  const tier = tierWord(settings[`${def.stage}.service_tier`]) ?? (def.tier === "writer" ? writerServiceTier(settings) : "standard");
  return {
    providerId: picked.providerId, model: picked.model, reasoningEffort: picked.effort, serviceTier: tier,
    source: (picked.source === "default" ? "role-default" : picked.source) as StepExecutor["source"], sourceKey: picked.sourceKey,
    issues: moved ? [moved.issue] : [],
  };
}

const none = (node: Raw, id: string, kind: string, label: string, extra: Partial<StepExecutor> = {}): StepExecutor => ({
  nodeId: id, kind, uses: text(node.uses), mode: "none", agent: { role: text(node.role), helper: null, label },
  providerId: null, model: null, reasoningEffort: null, serviceTier: null, source: "none", sourceKey: null, inherited: false, fallbacks: [], parts: [],
  settingsKey: null, costTier: "none", issues: [], ...extra,
});

type Offered = ((providerId: string, model: string) => boolean | null) | undefined;

function agentNode(node: Raw, id: string, settings: Settings, pm: PmPair | null, offered?: Offered, spent?: SpentProbe): StepExecutor {
  const role = text(node.role) ?? "worker";
  const helper = roleSpec(role).helper;
  // The same function the executor calls (withResolvedModel, workflow-agent.ts): the card says what will be spawned.
  const chosen = resolveAgentModel({ role, settings, pm, author: pmAuthorOf(role, pm), ...(offered ? { offered } : {}), ...(spent ? { spent } : {}) });
  return {
    nodeId: id, kind: "agent", uses: text(node.uses), mode: "model", agent: { role, helper, label: role },
    providerId: chosen.providerId, model: chosen.model, reasoningEffort: chosen.reasoningEffort, serviceTier: chosen.serviceTier,
    source: chosen.source, sourceKey: chosen.sourceKey, inherited: chosen.inherited,
    fallbacks: [], parts: [], settingsKey: roleModelKey(roleRowOf(role)), costTier: costTier(chosen.model), issues: chosen.issues,
  };
}

function stageNode(node: Raw, id: string, def: StageDef, settings: Settings, offered?: Offered, spent?: SpentProbe): StepExecutor {
  const picked = stageSelection(settings, def, offered, spent);
  return {
    nodeId: id, kind: "agent", uses: text(node.uses), mode: "model", agent: { role: text(node.role) ?? def.helper, helper: def.helper, label: def.label },
    providerId: picked.providerId, model: picked.model, reasoningEffort: picked.reasoningEffort, serviceTier: picked.serviceTier, source: picked.source, sourceKey: picked.sourceKey,
    inherited: picked.source !== "table", fallbacks: [], parts: [], settingsKey: roleModelKey(def.role), costTier: costTier(picked.model), issues: picked.issues,
  };
}

function codeTask(node: Raw, id: string, settings: Settings, pm: PmPair | null, offered?: Offered, spent?: SpentProbe): StepExecutor {
  const providerId = text(settings["writer.provider"]), model = text(settings["writer.model"]);
  const effort = text(settings["writer.reasoning_effort"]) ?? "medium";
  const tier = writerServiceTier(settings);
  const chain = providerId && model ? writerFallbackChain({ providerId, model }, writerFallbacks(settings), pm ?? { providerId: "", model: "" }) : [];
  const fallbacks: StepExecutor["fallbacks"] = chain.map((row) => ({ providerId: row.providerId, model: row.model, reasoningEffort: row.pm ? null : row.reasoningLevel || null, pm: row.pm }));
  if (!pm && providerId && model) fallbacks.push({ providerId: null, model: null, reasoningEffort: null, pm: true });
  const stages = Array.isArray(node.stages) ? node.stages.filter((item): item is string => typeof item === "string") : [];
  const parts: StepExecutor["parts"] = [];
  if (!stages.length || stages.includes("code-critique")) {
    const critic = stageSelection(settings, CODE_CRITIQUE, offered, spent);
    parts.push({ stage: "code-critique", providerId: critic.providerId, model: critic.model, reasoningEffort: critic.reasoningEffort, serviceTier: critic.serviceTier, source: critic.source, sourceKey: critic.sourceKey });
  }
  const issues: string[] = [];
  if (!providerId || !model) issues.push("no_selection");
  if (automaticEffortRoutingEnabled(settings)) issues.push("effort_auto");
  return {
    nodeId: id, kind: "lp-task", uses: text(node.uses), mode: "chain", agent: { role: "writer", helper: "writer", label: "writer" },
    providerId, model, reasoningEffort: effort, serviceTier: tier, source: providerId || model ? "writer" : "none", sourceKey: "writer.model", inherited: true,
    fallbacks, parts, settingsKey: "writer", costTier: costTier(model), issues,
  };
}

function stepOf(node: Raw, id: string, settings: Settings, pm: PmPair | null, offered?: Offered, spent?: SpentProbe): StepExecutor | null {
  const kind = text(node.type) ?? "agent";
  const uses = text(node.uses);
  switch (kind) {
    case "note": case "join": case "parallel": return null;
    case "agent": {
      const stage = uses ? STAGE_NODES[uses] : undefined;
      return stage ? stageNode(node, id, stage, settings, offered, spent) : agentNode(node, id, settings, pm, offered, spent);
    }
    case "lp-task": return codeTask(node, id, settings, pm, offered, spent);
    case "action": {
      const key = uses ?? text(node.action);
      if (key && (DELEGATED_ACTIONS as readonly string[]).includes(key)) {
        return { ...agentNode({ role: "errand" }, id, settings, pm, offered, spent), kind: "action", uses, mode: "helper", agent: { role: "errand", helper: "errand", label: key }, source: "helper" as const, sourceKey: "errand", inherited: true };
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
  /** The workflow the nodes belong to: a call back into it is not followed. */
  workflowId?: string;
  /** The workflows the subworkflow nodes call, by id: their steps are listed right after the call, with the fragment they belong to. */
  fragments?: ReadonlyMap<string, WorkflowShape>;
  /** Whether a provider's usage window is nearly spent, read from the cache without waiting (spawnUsageOf): a pick on it shows its move to the other family. Absent: the table's pick. */
  spent?: SpentProbe;
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
      ? { ...base, nodeId: own.nodeId, uses: own.uses, agent: own.agent, source: "session", sourceKey: from, inherited: true, settingsKey: null }
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

  const level = (shape: WorkflowShape, tag: StepExecutor["fragment"], path: readonly string[]): StepExecutor[] => {
    const raws = shape.nodes.filter(isRaw);
    const steps = new Map<string, StepExecutor>();
    const order: string[] = [];
    const calls = new Map<string, string>();
    for (const raw of raws) {
      const id = text(raw.id);
      if (!id) continue;
      const found = stepOf(raw, id, input.settings, input.pm, offered, input.spent);
      if (found) { steps.set(id, found); order.push(id); }
      if (text(raw.type) === "parallel" && isRaw(raw.child)) {
        const body = stepOf(raw.child, `${id}:child`, input.settings, input.pm, offered, input.spent);
        if (body) { steps.set(`${id}:child`, body); order.push(`${id}:child`); }
      }
      const callee = text(raw.type) === "subworkflow" ? text(raw.workflow) : null;
      if (callee) calls.set(id, callee);
    }
    withInheritedSessions(raws, shape, steps);
    const out: StepExecutor[] = [];
    for (const id of order) {
      const step = steps.get(id)!;
      // A step of a called workflow is not a node of this graph: it is listed after the call, with the fragment it belongs to.
      const marked = tag ? { ...step, fragment: tag } : step;
      out.push(input.catalog ? withCatalogIssues(marked, input.catalog) : marked);
      const callee = calls.get(id);
      const child = callee ? input.fragments?.get(callee) : undefined;
      if (callee && child && !path.includes(callee) && path.length <= MAX_FRAGMENT_DEPTH) {
        out.push(...level(child, { nodeId: tag?.nodeId ?? id, workflowId: callee }, [...path, callee]));
      }
    }
    return out;
  };
  return level(input, undefined, input.workflowId ? [input.workflowId] : []);
}
