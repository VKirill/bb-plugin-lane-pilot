/** Workflow engine per-node & per-run budget defaults and stuck-detector settings keys (single owner). */
export const WORKFLOW_NODE_BUDGET_TOKENS_KEY = "workflow.node_budget_tokens";
export const WORKFLOW_NODE_BUDGET_USD_KEY = "workflow.node_budget_usd";
export const WORKFLOW_NODE_BUDGET_WALL_SECONDS_KEY = "workflow.node_budget_wall_seconds";
export const WORKFLOW_RUN_BUDGET_TOKENS_KEY = "workflow.run_budget_tokens";
export const WORKFLOW_RUN_BUDGET_USD_KEY = "workflow.run_budget_usd";
export const WORKFLOW_RUN_BUDGET_WALL_SECONDS_KEY = "workflow.run_budget_wall_seconds";
export const WORKFLOW_STUCK_REPEAT_LIMIT_KEY = "workflow.stuck_repeat_limit";

export const WORKFLOW_BUDGET_SETTING_KEYS: ReadonlySet<string> = new Set([
  WORKFLOW_NODE_BUDGET_TOKENS_KEY,
  WORKFLOW_NODE_BUDGET_USD_KEY,
  WORKFLOW_NODE_BUDGET_WALL_SECONDS_KEY,
  WORKFLOW_RUN_BUDGET_TOKENS_KEY,
  WORKFLOW_RUN_BUDGET_USD_KEY,
  WORKFLOW_RUN_BUDGET_WALL_SECONDS_KEY,
  WORKFLOW_STUCK_REPEAT_LIMIT_KEY,
]);

export const DEFAULT_NODE_BUDGET_TOKENS = 400_000;
export const DEFAULT_NODE_BUDGET_USD: number | null = null;
export const DEFAULT_NODE_BUDGET_WALL_SECONDS = 1800;
export const DEFAULT_RUN_BUDGET_TOKENS = 2_000_000;
export const DEFAULT_RUN_BUDGET_USD: number | null = null;
export const DEFAULT_RUN_BUDGET_WALL_SECONDS = 7200;
export const DEFAULT_STUCK_REPEAT_LIMIT = 10;

export type WorkflowBudgetSettingsValues = {
  node: { maxTokens: number; maxCostUsd?: number; maxWallSeconds: number };
  run: { maxTokens: number; maxCostUsd?: number; maxWallSeconds: number };
  stuckRepeatLimit: number;
};

function optionalPositiveNumber(raw: unknown, fallback: number | null): number | undefined {
  if (raw === null || raw === undefined || raw === "") return fallback ?? undefined;
  const parsed = typeof raw === "string" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isFinite(parsed) && parsed > 0 ? parsed : (fallback ?? undefined);
}

function positiveInt(raw: unknown, fallback: number): number {
  const parsed = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : fallback;
}

/** Resolves effective workflow engine budget defaults from typed project/hub settings. */
export function workflowBudgetDefaults(settings: Record<string, unknown> = {}): WorkflowBudgetSettingsValues {
  const nodeUsd = optionalPositiveNumber(settings[WORKFLOW_NODE_BUDGET_USD_KEY], DEFAULT_NODE_BUDGET_USD);
  const runUsd = optionalPositiveNumber(settings[WORKFLOW_RUN_BUDGET_USD_KEY], DEFAULT_RUN_BUDGET_USD);
  return {
    node: {
      maxTokens: positiveInt(settings[WORKFLOW_NODE_BUDGET_TOKENS_KEY], DEFAULT_NODE_BUDGET_TOKENS),
      ...(nodeUsd !== undefined ? { maxCostUsd: nodeUsd } : {}),
      maxWallSeconds: positiveInt(settings[WORKFLOW_NODE_BUDGET_WALL_SECONDS_KEY], DEFAULT_NODE_BUDGET_WALL_SECONDS),
    },
    run: {
      maxTokens: positiveInt(settings[WORKFLOW_RUN_BUDGET_TOKENS_KEY], DEFAULT_RUN_BUDGET_TOKENS),
      ...(runUsd !== undefined ? { maxCostUsd: runUsd } : {}),
      maxWallSeconds: positiveInt(settings[WORKFLOW_RUN_BUDGET_WALL_SECONDS_KEY], DEFAULT_RUN_BUDGET_WALL_SECONDS),
    },
    stuckRepeatLimit: positiveInt(settings[WORKFLOW_STUCK_REPEAT_LIMIT_KEY], DEFAULT_STUCK_REPEAT_LIMIT),
  };
}
