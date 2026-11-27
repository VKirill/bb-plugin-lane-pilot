import { killProcessTree } from "@lane-pilot/kit";
import type { CostState } from "@lane-pilot/contracts";
import type { Compiled } from "./compiled";
import type { Journal, RunRow, StepRow } from "./journal";
import type { GraphNode as WorkflowNode } from "./schema";
import { addSpend, resolveStepCost } from "./usage";
import type { Usage } from "./usage";
import type { WorkflowEngine } from "./engine";

export const DEFAULT_STUCK_REPEAT_LIMIT = 10;

export type BudgetLimits = {
  maxTokens?: number;
  maxCostUsd?: number;
  maxWallSeconds?: number;
};

export type BudgetDefaults = {
  node?: BudgetLimits;
  run?: BudgetLimits;
  stuckRepeatLimit?: number;
};

export type ToolCallRecord = {
  tool: string;
  args?: unknown;
};

export type TurnCheckInput = {
  usage?: Usage;
  /** True when `usage` is cumulative for the current attempt so far; false/omitted treats it as incremental turn delta. */
  cumulative?: boolean;
  toolCalls?: readonly ToolCallRecord[];
};

export type StepStopDecision =
  | { stop: false }
  | {
    stop: true;
    reason: "budget_exhausted" | "stuck" | "unknown_cost";
    detail: string;
    kind?: "tokens" | "usd" | "wall";
    used?: number;
    cap?: number;
    call?: string;
    repeats?: number;
  };

export type StepHoldInfo = {
  runId: string;
  stepKey: string;
  nodeId: string;
  projectId: string | null;
  reason: "unknown_cost";
  costState: CostState;
  detail: string;
};

export type TrackedChild = {
  stepKey?: string;
  pid?: number;
  threadId?: string;
  stop?: () => Promise<number | void> | number | void;
};

const childrenByEngine = new WeakMap<WorkflowEngine, Map<string, Set<TrackedChild>>>();
const inFlightStopsByEngine = new WeakMap<WorkflowEngine, Map<string, Set<Promise<number>>>>();

function childMap(engine: WorkflowEngine): Map<string, Set<TrackedChild>> {
  let map = childrenByEngine.get(engine);
  if (!map) {
    map = new Map();
    childrenByEngine.set(engine, map);
  }
  return map;
}

function stopMap(engine: WorkflowEngine): Map<string, Set<Promise<number>>> {
  let map = inFlightStopsByEngine.get(engine);
  if (!map) {
    map = new Map();
    inFlightStopsByEngine.set(engine, map);
  }
  return map;
}

/** Registers a child process PID, helper thread, or cleanup callback for a run/step so stop kills the whole tree. */
export function trackRunChild(engine: WorkflowEngine, runId: string, child: TrackedChild): () => void {
  const map = childMap(engine);
  let set = map.get(runId);
  if (!set) {
    set = new Set();
    map.set(runId, set);
  }
  set.add(child);
  return () => {
    set?.delete(child);
    if (set && set.size === 0) map.delete(runId);
  };
}

/** Kills all tracked child processes and helper threads for a run (or one step) and logs the count. */
export async function stopRunChildren(engine: WorkflowEngine, runId: string, stepKey?: string): Promise<number> {
  const map = childMap(engine);
  const set = map.get(runId);
  const targets = set ? [...set].filter((entry) => stepKey === undefined || entry.stepKey === stepKey) : [];
  if (set) {
    for (const entry of targets) set.delete(entry);
    if (set.size === 0) map.delete(runId);
  }
  const active = stopMap(engine);
  const prior = stepKey === undefined ? [...(active.get(runId) ?? [])] : [];

  let killed = 0;
  if (targets.length > 0) {
    const work = (async () => {
      let localKilled = 0;
      for (const entry of targets) {
        if (typeof entry.pid === "number" && entry.pid > 0) {
          localKilled += await killProcessTree(entry.pid);
        }
        if (entry.threadId) {
          try {
            const res = await engine.options.stopThread?.(entry.threadId);
            localKilled += typeof res === "number" && res > 0 ? res : 1;
          } catch {
            // Best-effort thread stop.
          }
        }
        if (entry.stop) {
          try {
            const res = await entry.stop();
            if (typeof res === "number" && res > 0) localKilled += res;
          } catch {
            // Best-effort child cleanup.
          }
        }
      }
      engine.log(`INFO run stopped children_killed=${localKilled}`, "info");
      return localKilled;
    })();
    let runStops = active.get(runId);
    if (!runStops) {
      runStops = new Set();
      active.set(runId, runStops);
    }
    runStops.add(work);
    try {
      killed += await work;
    } finally {
      runStops.delete(work);
      if (runStops.size === 0) active.delete(runId);
    }
  }
  if (prior.length > 0) {
    const counts = await Promise.all(prior);
    for (const n of counts) killed += n;
  }
  return killed;
}

export function usageTokensWithCache(usage: Usage | undefined): number {
  if (!usage) return 0;
  const parts = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  return Math.max(usage.tokens ?? 0, parts);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export function canonicalToolCallKey(call: ToolCallRecord): string {
  return `${call.tool}\0${stableStringify(call.args ?? {})}`;
}

export function effectiveBudgetDefaults(engine: WorkflowEngine, run: RunRow): BudgetDefaults {
  return engine.options.resolveBudgetDefaults?.(run) ?? engine.options.budgetDefaults ?? {};
}

export function effectiveNodeLimits(node: WorkflowNode, defaults: BudgetDefaults): BudgetLimits {
  return {
    maxTokens: node.budget?.maxTokens ?? defaults.node?.maxTokens,
    maxCostUsd: node.budget?.maxCostUsd ?? defaults.node?.maxCostUsd,
    maxWallSeconds: node.budget?.maxWallSeconds ?? defaults.node?.maxWallSeconds,
  };
}

export function effectiveRunLimits(c: Compiled, defaults: BudgetDefaults): BudgetLimits {
  return {
    maxTokens: c.wf.budget.maxTokens ?? defaults.run?.maxTokens,
    maxCostUsd: c.wf.budget.maxCostUsd ?? defaults.run?.maxCostUsd,
    maxWallSeconds: c.wf.budget.maxWallSeconds ?? defaults.run?.maxWallSeconds,
  };
}

export class BudgetStopError extends Error {
  constructor(
    readonly decision: Extract<StepStopDecision, { stop: true }>,
    readonly usage?: Usage,
  ) {
    super(decision.detail);
    this.name = "BudgetStopError";
  }
}

export type StepBudgetGuard = {
  recordTurn(input: TurnCheckInput): StepStopDecision;
  checkCompleted(usage: Usage | undefined, hasAgentCall: boolean): StepStopDecision;
  lastUsage(): Usage | undefined;
  stopped(): Extract<StepStopDecision, { stop: true }> | null;
};

/**
 * Per-step budget & repeat guard enforced by the engine after every agent turn and on completion.
 * Tracks tokens (including cache), USD cost (rejecting unknown cost when USD cap is active), wall time, and repeated identical tool calls.
 */
export function createStepBudgetGuard(
  engine: WorkflowEngine,
  run: RunRow,
  c: Compiled,
  node: WorkflowNode,
  stepStartedAt: number,
  priorAttemptUsage?: Usage,
  onStop?: (decision: Extract<StepStopDecision, { stop: true }>) => void,
): StepBudgetGuard {
  const defaults = effectiveBudgetDefaults(engine, run);
  const nodeLimits = effectiveNodeLimits(node, defaults);
  const runLimits = effectiveRunLimits(c, defaults);
  const stuckLimit = node.maxRepeats ?? defaults.stuckRepeatLimit ?? DEFAULT_STUCK_REPEAT_LIMIT;

  let currentUsage: Usage | undefined;
  let lastToolKey: string | null = null;
  let repeatCount = 0;
  let latched: Extract<StepStopDecision, { stop: true }> | null = null;

  const latch = (decision: Extract<StepStopDecision, { stop: true }>): StepStopDecision => {
    if (!latched) {
      latched = decision;
      if (decision.reason === "budget_exhausted" && decision.kind) {
        engine.log(`WARN budget exhausted node=${node.id} kind=${decision.kind} used=${decision.used ?? 0} cap=${decision.cap ?? 0}`, "warn");
      } else if (decision.reason === "stuck" && decision.call) {
        engine.log(`WARN stuck node=${node.id} call=${decision.call} repeats=${decision.repeats ?? 0}`, "warn");
      }
      onStop?.(decision);
    }
    return decision;
  };

  const evaluateSpend = (stepUsage: Usage | undefined, checkRunCaps: boolean, isAgentLike: boolean): StepStopDecision => {
    const combinedStep = addSpend(priorAttemptUsage, stepUsage);
    const nodeTokens = usageTokensWithCache(combinedStep);
    if (nodeLimits.maxTokens !== undefined && nodeTokens > nodeLimits.maxTokens) {
      return latch({ stop: true, reason: "budget_exhausted", kind: "tokens", used: nodeTokens, cap: nodeLimits.maxTokens, detail: `budget_exhausted:tokens:${node.id}` });
    }
    const wallSec = Math.max(0, (engine.now() - stepStartedAt) / 1000);
    if (nodeLimits.maxWallSeconds !== undefined && wallSec > nodeLimits.maxWallSeconds) {
      return latch({ stop: true, reason: "budget_exhausted", kind: "wall", used: Math.round(wallSec * 100) / 100, cap: nodeLimits.maxWallSeconds, detail: `budget_exhausted:wall:${node.id}` });
    }

    const latestRun = engine.journal.getRun(run.id) ?? run;
    const runTokens = latestRun.tokens_used + nodeTokens;
    if (checkRunCaps && runLimits.maxTokens !== undefined && runTokens > runLimits.maxTokens) {
      return latch({ stop: true, reason: "budget_exhausted", kind: "tokens", used: runTokens, cap: runLimits.maxTokens, detail: `budget_exhausted:tokens:${node.id}` });
    }
    const runWallSec = Math.max(0, (engine.now() - latestRun.created_at - latestRun.wait_ms) / 1000);
    if (checkRunCaps && runLimits.maxWallSeconds !== undefined && runWallSec > runLimits.maxWallSeconds) {
      return latch({ stop: true, reason: "budget_exhausted", kind: "wall", used: Math.round(runWallSec * 100) / 100, cap: runLimits.maxWallSeconds, detail: `budget_exhausted:wall:${node.id}` });
    }

    const usdCap = nodeLimits.maxCostUsd ?? (checkRunCaps ? runLimits.maxCostUsd : undefined);
    if (usdCap !== undefined) {
      const cost = resolveStepCost(combinedStep, isAgentLike);
      const explicitFallbackUsd = !combinedStep?.unknown && typeof combinedStep?.costUsd === "number" && combinedStep.costUsd > 0;
      const isUnknownCost = (cost.costState === "not_measured" || cost.costMicroUsd === null || Boolean(combinedStep?.unknown)) && !explicitFallbackUsd;
      // Unknown/unmeasured cost on an agent step or node USD cap never counts as $0 against a USD cap: hold for the owner.
      if (isUnknownCost && (nodeLimits.maxCostUsd !== undefined || isAgentLike)) {
        return latch({ stop: true, reason: "unknown_cost", kind: "usd", detail: `unknown_cost: ${node.id} cost_state=${cost.costState} cannot count as 0 against USD cap` });
      }
      const stepUsd = cost.costMicroUsd !== null ? cost.costMicroUsd / 1_000_000 : (combinedStep?.costUsd ?? 0);
      if (nodeLimits.maxCostUsd !== undefined && stepUsd > nodeLimits.maxCostUsd) {
        return latch({ stop: true, reason: "budget_exhausted", kind: "usd", used: stepUsd, cap: nodeLimits.maxCostUsd, detail: `budget_exhausted:usd:${node.id}` });
      }
      const totalRunUsd = latestRun.cost_micro_usd / 1_000_000 + stepUsd;
      if (checkRunCaps && runLimits.maxCostUsd !== undefined && totalRunUsd > runLimits.maxCostUsd) {
        return latch({ stop: true, reason: "budget_exhausted", kind: "usd", used: totalRunUsd, cap: runLimits.maxCostUsd, detail: `budget_exhausted:usd:${node.id}` });
      }
    }
    return { stop: false };
  };

  return {
    recordTurn(input: TurnCheckInput): StepStopDecision {
      if (latched) return latched;
      if (input.toolCalls?.length) {
        for (const call of input.toolCalls) {
          const key = canonicalToolCallKey(call);
          repeatCount = key === lastToolKey ? repeatCount + 1 : 1;
          lastToolKey = key;
          if (repeatCount >= stuckLimit) {
            return latch({ stop: true, reason: "stuck", call: call.tool, repeats: repeatCount, detail: `stuck:${node.id}:${call.tool}:${repeatCount}` });
          }
        }
      }
      if (input.usage) {
        currentUsage = input.cumulative ? input.usage : addSpend(currentUsage, input.usage);
        return evaluateSpend(currentUsage, true, true);
      }
      return { stop: false };
    },
    checkCompleted(usage: Usage | undefined, hasAgentCall: boolean): StepStopDecision {
      if (latched) return latched;
      if (usage) currentUsage = usage;
      const checkRunUsdUnknownOnly = nodeLimits.maxCostUsd === undefined && runLimits.maxCostUsd !== undefined && hasAgentCall;
      if (checkRunUsdUnknownOnly) {
        const combined = addSpend(priorAttemptUsage, currentUsage);
        const cost = resolveStepCost(combined, hasAgentCall);
        const hasFallbackUsd = !combined?.unknown && typeof combined?.costUsd === "number" && combined.costUsd > 0;
        if ((cost.costState === "not_measured" || cost.costMicroUsd === null || Boolean(combined?.unknown)) && !hasFallbackUsd) {
          return latch({ stop: true, reason: "unknown_cost", kind: "usd", detail: `unknown_cost: ${node.id} cost_state=${cost.costState} cannot count as 0 against USD cap` });
        }
      }
      return evaluateSpend(currentUsage, false, hasAgentCall);
    },
    lastUsage: () => currentUsage,
    stopped: () => latched,
  };
}

/** Parks a step for the owner when USD spend cannot be measured (`cost_state = not_measured`) under an active USD cap. */
export function holdStepForUnknownCost(
  engine: WorkflowEngine,
  j: Journal,
  run: RunRow,
  step: StepRow,
  node: WorkflowNode,
  usage: Usage | undefined,
  cols: ReturnType<typeof import("./run-facts").buildStepFactColumns>,
  detail: string,
  extra: { threadId?: string | null; receiptJson: string },
): boolean {
  const waitPayload = { kind: "owner_approval", reason: "unknown_cost", nodeId: node.id, costState: cols.cost_state, detail };
  const parked = j.moveStep(run.id, step.step_key, "running", "waiting", {
    requested_provider: cols.requested_provider,
    requested_model: cols.requested_model,
    answered_provider: cols.answered_provider,
    answered_model: cols.answered_model,
    input_tokens: cols.input_tokens,
    output_tokens: cols.output_tokens,
    cache_read_tokens: cols.cache_read_tokens,
    cache_write_tokens: cols.cache_write_tokens,
    cost_micro_usd: cols.cost_micro_usd,
    cost_state: cols.cost_state,
    rework_visits: cols.rework_visits,
    graph_version: cols.graph_version,
    request_id: cols.request_id,
    attempt_id: cols.attempt_id,
    session_id: cols.session_id,
    form_used: cols.form_used,
    fallback_taken: cols.fallback_taken,
    environment_fingerprint: cols.environment_fingerprint,
    await_json: JSON.stringify(waitPayload),
    receipt_json: extra.receiptJson,
  });
  if (!parked) return false;
  if (usage) {
    j.db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=tokens_used+?, cost_micro_usd=cost_micro_usd+? WHERE id=?")
      .run(Math.round(usageTokensWithCache(usage)), Math.round((usage.costUsd ?? 0) * 1_000_000), run.id);
  }
  j.event(run.id, step.step_key, "usage", null, "unknown", node.id);
  j.event(run.id, step.step_key, "hold_owner", null, cols.cost_state, detail);
  const costState = cols.cost_state ?? "not_measured";
  engine.options.onHoldOwner?.({
    runId: run.id,
    stepKey: step.step_key,
    nodeId: node.id,
    projectId: run.project_id ?? null,
    reason: "unknown_cost",
    costState,
    detail,
  });
  engine.log(`wf.hold step=${run.id}/${step.step_key} reason=unknown_cost cost_state=${costState}`, "warn");
  return true;
}

