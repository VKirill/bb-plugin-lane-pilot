/** Shared vocabulary, field names, and verdict mapping for per-step run facts and node census. */

export const CHECK_VERDICTS = ["pass", "product_fail", "environment_error", "not_run"] as const;
export type CheckVerdict = (typeof CHECK_VERDICTS)[number];

export const COST_STATES = ["measured", "partial", "not_measured"] as const;
export type CostState = (typeof COST_STATES)[number];

export const FACT_VERDICTS = ["pass", "fail", "not_run"] as const;
export type FactVerdict = (typeof FACT_VERDICTS)[number];

export const NODE_CENSUS_CLASSES = ["code", "stable_agent", "open_agent"] as const;
export type NodeCensusClass = (typeof NODE_CENSUS_CLASSES)[number];

export const NODE_FORMS = ["agent", "plan", "script"] as const;
export type NodeForm = (typeof NODE_FORMS)[number];

export const NODE_FORM_FALLBACKS = ["plan", "agent"] as const;
export type NodeFormFallback = (typeof NODE_FORM_FALLBACKS)[number];

/** OpenTelemetry GenAI semantic attribute names used when recording or exporting step facts. */
export const OTEL_GENAI_ATTRIBUTES = {
  operationName: "gen_ai.operation.name",
  providerName: "gen_ai.provider.name",
  requestModel: "gen_ai.request.model",
  responseModel: "gen_ai.response.model",
  responseId: "gen_ai.response.id",
  conversationId: "gen_ai.conversation.id",
  inputTokens: "gen_ai.usage.input_tokens",
  outputTokens: "gen_ai.usage.output_tokens",
  cacheReadInputTokens: "gen_ai.usage.cache_read.input_tokens",
  cacheCreationInputTokens: "gen_ai.usage.cache_creation.input_tokens",
} as const;

/** Column names on `lane_pilot_wf_step` storing per-step execution facts. */
export const STEP_FACT_FIELDS = [
  "run_id",
  "requested_provider",
  "requested_model",
  "answered_provider",
  "answered_model",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "cost_micro_usd",
  "cost_state",
  "duration_ms",
  "verdict",
  "failure_class",
  "rework_visits",
  "graph_version",
  "request_id",
  "attempt_id",
  "session_id",
  "form_used",
  "fallback_taken",
  "environment_fingerprint",
] as const;

export type StepFactField = (typeof STEP_FACT_FIELDS)[number];

export interface StepFact {
  runId: string;
  stepId: string;
  nodeId: string;
  nodeKind: string;
  requestedProvider: string | null;
  requestedModel: string | null;
  answeredProvider: string | null;
  answeredModel: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costMicroUsd: number | null;
  costState: CostState;
  durationMs: number;
  verdict: FactVerdict;
  failureClass: string | null;
  reworkVisits: number;
  graphVersion: string;
  requestId: string | null;
  attemptId: string | null;
  sessionId: string | null;
  formUsed: NodeForm | null;
  fallbackTaken: string | null;
  environmentFingerprint: string | null;
}

export interface NodeCensusEntry {
  nodeId: string;
  nodeKind: string;
  classification: NodeCensusClass;
  steps: number;
  passed: number;
  failed: number;
  notRun: number;
  totalReworkVisits: number;
  measuredCostMicroUsd: number;
  costShare: number;
  durationShare: number;
  formArmCandidate: boolean;
}

export interface FallbackRateEntry {
  nodeId: string;
  graphVersion: number;
  form: Exclude<NodeForm, "agent">;
  n: number;
  fallbacks: number;
  rate: number | null;
}

/** Map a structured CheckVerdict to a step fact verdict and optional failure class. */
export function factVerdictFromCheck(check: CheckVerdict): {
  verdict: FactVerdict;
  failureClass: Exclude<CheckVerdict, "pass" | "not_run"> | null;
} {
  switch (check) {
    case "pass":
      return { verdict: "pass", failureClass: null };
    case "not_run":
      return { verdict: "not_run", failureClass: null };
    case "product_fail":
      return { verdict: "fail", failureClass: "product_fail" };
    case "environment_error":
      return { verdict: "fail", failureClass: "environment_error" };
  }
}
