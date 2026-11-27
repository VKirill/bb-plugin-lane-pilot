import type { CostState, FactVerdict, NodeForm } from "@lane-pilot/contracts";
import type { RunRow, StepRow, StepState } from "./journal";
import { stepFactVerdict } from "./step-output";
import { resolveStepCost } from "./usage";
import type { Usage } from "./usage";
import type { WorkflowEngine } from "./engine";

/** Columns appended to `lane_pilot_wf_step` for per-step evolution facts (append-only migrations). */
export const workflowStepFactsMigrations: string[] = [
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN requested_provider TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN requested_model TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN answered_provider TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN answered_model TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN cost_micro_usd INTEGER",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN cost_state TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN verdict TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN failure_class TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN rework_visits INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN graph_version INTEGER",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN request_id TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN attempt_id TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN session_id TEXT",
];

/** Columns appended to `lane_pilot_wf_step` for node form execution and fallback facts (Task 29). */
export const workflowNodeFormMigrations: string[] = [
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN form_used TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN fallback_taken TEXT",
  "ALTER TABLE lane_pilot_wf_step ADD COLUMN environment_fingerprint TEXT",
];

export type StepFactColumns = {
  requested_provider: string | null;
  requested_model: string | null;
  answered_provider: string | null;
  answered_model: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_micro_usd: number | null;
  cost_state: CostState | null;
  duration_ms: number;
  verdict: FactVerdict | null;
  failure_class: string | null;
  rework_visits: number;
  graph_version: number | null;
  request_id: string | null;
  attempt_id: string | null;
  session_id: string | null;
  form_used: NodeForm | null;
  fallback_taken: string | null;
  environment_fingerprint: string | null;
};

export type StepFactBuildOptions = {
  usage?: Usage;
  nodeType?: string | null;
  output?: Record<string, unknown> | null;
  detail?: unknown;
  error?: string | null;
  errorCode?: string | null;
  threadId?: string | null;
  hasAgentCall?: boolean;
  formUsed?: NodeForm | null;
  fallbackTaken?: string | null;
  environmentFingerprint?: string | null;
};

export function stepHadAgentCall(
  to: Extract<StepState, "succeeded" | "failed" | "skipped" | "canceled">,
  options: StepFactBuildOptions,
): boolean {
  if (options.hasAgentCall !== undefined) return options.hasAgentCall;
  if (to === "skipped") return false;
  const usage = options.usage;
  const hasModelEvidence = Boolean(options.threadId || usage?.requestedModel || usage?.answeredModel || usage?.requestId || usage?.sessionId);
  if (options.formUsed === "script") return hasModelEvidence;
  if (options.nodeType === "agent") return true;
  return hasModelEvidence;
}

/** Build the persisted step-fact column patch when a step moves to a finished state. */
export function buildStepFactColumns(
  run: RunRow,
  step: StepRow,
  to: Extract<StepState, "succeeded" | "failed" | "skipped" | "canceled">,
  nowMs: number,
  options: StepFactBuildOptions = {},
): StepFactColumns {
  const usage = options.usage;
  const hasAgent = stepHadAgentCall(to, options);
  const { costMicroUsd, costState } = resolveStepCost(usage, hasAgent);
  const { verdict, failureClass } = stepFactVerdict({
    state: to,
    output: options.output ?? null,
    detail: options.detail,
    error: options.error ?? null,
    errorCode: options.errorCode ?? null,
  });
  const startedAt = step.started_at;
  return {
    requested_provider: usage?.requestedProvider ?? null,
    requested_model: usage?.requestedModel ?? null,
    answered_provider: usage?.answeredProvider ?? null,
    answered_model: usage?.answeredModel ?? null,
    input_tokens: Math.max(0, Math.round(usage?.inputTokens ?? 0)),
    output_tokens: Math.max(0, Math.round(usage?.outputTokens ?? 0)),
    cache_read_tokens: Math.max(0, Math.round(usage?.cacheReadTokens ?? 0)),
    cache_write_tokens: Math.max(0, Math.round(usage?.cacheWriteTokens ?? 0)),
    cost_micro_usd: costMicroUsd,
    cost_state: costState,
    duration_ms: startedAt !== null && startedAt !== undefined ? Math.max(0, nowMs - startedAt) : 0,
    verdict,
    failure_class: failureClass,
    rework_visits: Math.max(0, step.visit - 1),
    graph_version: run.workflow_version,
    request_id: usage?.requestId ?? null,
    attempt_id: run.link_attempt_id ?? null,
    session_id: usage?.sessionId ?? options.threadId ?? null,
    form_used: options.formUsed ?? null,
    fallback_taken: options.fallbackTaken ?? null,
    environment_fingerprint: options.environmentFingerprint ?? null,
  };
}

/** Emit the DEBUG step-fact summary and WARN alerts for model mismatch or unmeasured agent cost. */
export function emitStepFactLogs(
  engine: WorkflowEngine,
  runId: string,
  stepKey: string,
  nodeId: string,
  to: Extract<StepState, "succeeded" | "failed" | "skipped" | "canceled">,
  columns: StepFactColumns,
  hasAgentCall: boolean,
): void {
  engine.log(
    `wf.step_fact run=${runId} step=${stepKey} node=${nodeId} state=${to}`
      + ` verdict=${columns.verdict ?? "-"} failure=${columns.failure_class ?? "none"}`
      + ` form=${columns.form_used ?? "-"} fallback=${columns.fallback_taken ?? "none"}`
      + ` req=${columns.requested_provider ?? "-"}:${columns.requested_model ?? "-"}`
      + ` ans=${columns.answered_provider ?? "-"}:${columns.answered_model ?? "-"}`
      + ` tokens=in:${columns.input_tokens}/out:${columns.output_tokens}/cr:${columns.cache_read_tokens}/cw:${columns.cache_write_tokens}`
      + ` cost_micro_usd=${columns.cost_micro_usd ?? "null"} cost_state=${columns.cost_state ?? "-"}`
      + ` duration_ms=${columns.duration_ms} rework=${columns.rework_visits} graph_version=${columns.graph_version ?? "-"}`,
    "debug",
  );
  if (columns.requested_model && columns.answered_model && columns.requested_model !== columns.answered_model) {
    engine.log(
      `wf.step_fact model_mismatch run=${runId} step=${stepKey} node=${nodeId}`
        + ` requested=${columns.requested_provider ?? "-"}:${columns.requested_model}`
        + ` answered=${columns.answered_provider ?? "-"}:${columns.answered_model}`,
      "warn",
    );
  }
  if (hasAgentCall && columns.cost_state === "not_measured") {
    engine.log(
      `wf.step_fact cost_not_measured run=${runId} step=${stepKey} node=${nodeId}`
        + ` model=${columns.answered_model ?? columns.requested_model ?? "unknown"}`,
      "warn",
    );
  }
}

/** Reconstruct Usage stored on a waiting step row so settling merges cleanly with arrival usage. */
export function usageFromStepRow(step: StepRow): Usage | undefined {
  if (!step.cost_state && !step.requested_model && !step.answered_model
    && !step.input_tokens && !step.output_tokens && !step.cache_read_tokens && !step.cache_write_tokens) {
    return undefined;
  }
  return {
    ...(step.input_tokens ? { inputTokens: step.input_tokens } : {}),
    ...(step.output_tokens ? { outputTokens: step.output_tokens } : {}),
    ...(step.cache_read_tokens ? { cacheReadTokens: step.cache_read_tokens } : {}),
    ...(step.cache_write_tokens ? { cacheWriteTokens: step.cache_write_tokens } : {}),
    ...(step.requested_provider !== undefined ? { requestedProvider: step.requested_provider } : {}),
    ...(step.requested_model !== undefined ? { requestedModel: step.requested_model } : {}),
    ...(step.answered_provider !== undefined ? { answeredProvider: step.answered_provider } : {}),
    ...(step.answered_model !== undefined ? { answeredModel: step.answered_model } : {}),
    ...(step.cost_state ? { costState: step.cost_state, ...(step.cost_state === "not_measured" ? { unknown: true } : {}) } : {}),
    ...(step.cost_micro_usd !== null && step.cost_micro_usd !== undefined ? { costUsd: step.cost_micro_usd / 1_000_000 } : {}),
    ...(step.request_id !== undefined ? { requestId: step.request_id } : {}),
    ...(step.session_id !== undefined ? { sessionId: step.session_id } : {}),
  };
}
