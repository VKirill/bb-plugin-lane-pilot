import type { CostState } from "@lane-pilot/contracts";
import { costUsd as pricedCostUsd, priceFor } from "@lane-pilot/models";
import type { WorkflowEngine } from "./engine";

/** What a step spent. `unknown`: the provider reports no usage, so the numbers are a floor, not zero; the run records it per step and holds a token or money budget to a time and step limit. */
export type Usage = {
  tokens?: number;
  costUsd?: number;
  unknown?: boolean;
  /** Uncached input tokens only (cache reads excluded). */
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  requestedProvider?: string | null;
  requestedModel?: string | null;
  answeredProvider?: string | null;
  answeredModel?: string | null;
  costState?: CostState;
  requestId?: string | null;
  sessionId?: string | null;
};

/** Without usage events a run under a token or money budget stops at this many steps / seconds, unless the budget names its own. */
export const UNKNOWN_USAGE_MAX_WALL_SECONDS = 2 * 3600;

function mergeCostState(a: Usage, b: Usage): CostState | undefined {
  if (!a.costState && !b.costState) return undefined;
  const states = [a.costState, b.costState].filter((state): state is CostState => state !== undefined);
  if (states.every((state) => state === "measured")) return "measured";
  if (states.some((state) => state === "measured" || state === "partial")) return "partial";
  return "not_measured";
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}

/** Two spends as one: tokens and cost add up, and one unknown part makes the whole unknown. */
export function addSpend(a: Usage | undefined, b: Usage | undefined): Usage | undefined {
  if (!a) return b;
  if (!b) return a;
  const inputTokens = addOptional(a.inputTokens, b.inputTokens);
  const outputTokens = addOptional(a.outputTokens, b.outputTokens);
  const cacheReadTokens = addOptional(a.cacheReadTokens, b.cacheReadTokens);
  const cacheWriteTokens = addOptional(a.cacheWriteTokens, b.cacheWriteTokens);
  const requestedProvider = b.requestedProvider ?? a.requestedProvider;
  const requestedModel = b.requestedModel ?? a.requestedModel;
  const answeredProvider = b.answeredProvider ?? a.answeredProvider;
  const answeredModel = b.answeredModel ?? a.answeredModel;
  const costState = mergeCostState(a, b);
  const requestId = b.requestId ?? a.requestId;
  const sessionId = b.sessionId ?? a.sessionId;
  return {
    tokens: (a.tokens ?? 0) + (b.tokens ?? 0),
    costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
    ...(a.unknown || b.unknown ? { unknown: true } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
    ...(requestedProvider !== undefined ? { requestedProvider } : {}),
    ...(requestedModel !== undefined ? { requestedModel } : {}),
    ...(answeredProvider !== undefined ? { answeredProvider } : {}),
    ...(answeredModel !== undefined ? { answeredModel } : {}),
    ...(costState !== undefined ? { costState } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/** Keep step receipt JSON compact and compatible with existing receipt consumers. */
export function receiptUsage(usage: Usage | undefined): { tokens: number; costUsd: number; unknown?: true } | null {
  if (!usage) return null;
  return {
    tokens: usage.tokens ?? 0,
    costUsd: usage.costUsd ?? 0,
    ...(usage.unknown ? { unknown: true } : {}),
  };
}

/**
 * Price a step strictly via `packages/models/src/model-prices.ts`.
 * Unknown usage or an unpriced model produces `costState: "not_measured"` and `costMicroUsd: null` (never `0`).
 */
export function resolveStepCost(
  usage: Usage | undefined,
  hasAgentCall: boolean,
): { costMicroUsd: number | null; costState: CostState } {
  if (!usage) {
    return hasAgentCall ? { costMicroUsd: null, costState: "not_measured" } : { costMicroUsd: 0, costState: "measured" };
  }
  if (usage.unknown || usage.costState === "not_measured") {
    return { costMicroUsd: null, costState: "not_measured" };
  }
  const model = usage.answeredModel ?? usage.requestedModel ?? null;
  if (model) {
    if (!priceFor(model)) return { costMicroUsd: null, costState: "not_measured" };
    const hasBreakdown = usage.inputTokens !== undefined || usage.outputTokens !== undefined
      || usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined;
    if (hasBreakdown) {
      const usd = pricedCostUsd(model, {
        uncached: usage.inputTokens ?? 0,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        output: usage.outputTokens ?? 0,
      });
      return {
        costMicroUsd: usd === null ? null : Math.round(usd * 1_000_000),
        costState: usd === null ? "not_measured" : (usage.costState ?? "measured"),
      };
    }
    if ((usage.tokens ?? 0) === 0 && (usage.costUsd ?? 0) === 0) {
      return { costMicroUsd: 0, costState: usage.costState ?? "measured" };
    }
    if (usage.costUsd !== undefined) {
      return {
        costMicroUsd: Math.round(usage.costUsd * 1_000_000),
        costState: usage.costState ?? "measured",
      };
    }
    return { costMicroUsd: null, costState: "not_measured" };
  }
  // An agent call without a priced model is unknown spend, unless its executor says it measured the cost itself.
  if (hasAgentCall && usage.costState !== "measured") return { costMicroUsd: null, costState: "not_measured" };
  if ((usage.tokens ?? 0) === 0 && (usage.costUsd ?? 0) === 0) {
    return { costMicroUsd: 0, costState: usage.costState ?? "measured" };
  }
  if (usage.costUsd !== undefined && (usage.costState === "measured" || usage.costState === "partial")) {
    return { costMicroUsd: Math.round(usage.costUsd * 1_000_000), costState: usage.costState };
  }
  return { costMicroUsd: null, costState: "not_measured" };
}

/** A run with unknown provider spend records a `usage_unknown` marker once (used by token/money budget enforcement). */
export function noteUnknownUsage(engine: WorkflowEngine, runId: string, stepKey: string, usage: Usage | undefined): void {
  if (!usage?.unknown) return;
  const db = engine.journal.db;
  if (db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='usage_unknown' LIMIT 1").get(runId)) return;
  engine.journal.event(runId, stepKey, "usage_unknown", null, null, null);
}
