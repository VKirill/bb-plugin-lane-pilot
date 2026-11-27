import type { ArmKind } from "@lane-pilot/contracts";
import { ROLE_MODEL_OPTIONS, modelFamily, resolveRoleModel } from "@lane-pilot/models";
import type { GraphNode, ReplayCase, StepRow, Workflow } from "@lane-pilot/workflow-engine";
import { compareArms, summarizeArm, type ArmSummary, type Comparison } from "./compare";
import { hasMechanicalVerify, isRecord } from "./hypothesis";

export type ReplayJudgeRef = { provider: string; model: string };
export type ReplayPairwiseOutcome = "candidate_better" | "reference_better" | "tie" | "not_run";

export type ReplayPairwiseJudgeInput = {
  reference: unknown;
  candidate: unknown;
  task: unknown;
  rubric?: string | readonly string[] | null;
  judge: ReplayJudgeRef;
  candidateModel: string;
  workflowId?: string;
};

export type ReplayPairwiseJudgeResult = {
  outcome: ReplayPairwiseOutcome;
  orders: [ReplayPairwiseOutcome, ReplayPairwiseOutcome];
  judgeModel: string;
  reason?: string;
};

export type ReplayVerifierFn = (output: Record<string, unknown>) => boolean | { ok: boolean };

export type ReplayOutputVerifierCase =
  | Record<string, unknown>
  | { output: Record<string, unknown>; kinds?: readonly ("drop_required_field" | "swap_number" | "empty_artifact" | "claim_done_without_artifact")[] };

export type ReplayVerifierScore = {
  planted: number;
  caught: number;
  catchRate: number | null;
  controls: number;
  falseAlarms: number;
  falseAlarmRate: number | null;
  bar: number;
  passed: boolean;
};

export type ReplayJudgeOutcome = {
  caseId: string;
  repeat: number;
  outcome: ReplayPairwiseOutcome;
  orders: [ReplayPairwiseOutcome, ReplayPairwiseOutcome];
  judgeModel: string;
  trusted: boolean;
  advisory: boolean;
  reason?: string;
};

export type ReplayScorecard = {
  hypothesisId: string;
  workflowId: string;
  nodeId: string;
  armKind: ArmKind;
  cases: number;
  k: number;
  comparison: Comparison;
  passK: Comparison["passK"];
  judgeOutcomes: ReplayJudgeOutcome[];
  judgeTrusted: boolean | null;
  verifierScore: ReplayVerifierScore | null;
  costs: {
    baselineUsd: number | null;
    candidateUsd: number | null;
    baselinePerAcceptedUsd: number | null;
    candidatePerAcceptedUsd: number | null;
  };
  aborted?: boolean;
  abortReason?: string;
};

export type ReplayOutcome = {
  pass: boolean;
  reasons: string[];
  comparison: Comparison;
  scorecard: ReplayScorecard;
};

/** Returns true when a node's output is settled deterministically by code rather than needing an LLM judge. */
export function isSettledByCode(node: GraphNode | undefined, armKind: ArmKind): boolean {
  if (armKind === "check") return true;
  if (!node || node.type !== "agent") return true;
  return hasMechanicalVerify(node);
}

/** Picks a cross-family judge ref from role defaults / model catalog options. */
export function pickCrossFamilyJudge(candidateModel: string, settings: Record<string, unknown>): ReplayJudgeRef | null {
  const candFamily = modelFamily(candidateModel);
  for (const role of ["auditor", "code-critic", "plan-critic"] as const) {
    const resolved = resolveRoleModel(role, settings);
    if (resolved.model && (!candFamily || modelFamily(resolved.model) !== candFamily)) {
      return { provider: resolved.providerId, model: resolved.model };
    }
  }
  const opt = ROLE_MODEL_OPTIONS.find((item) => !candFamily || item.family !== candFamily);
  return opt ? { provider: opt.providerId, model: opt.id } : null;
}

/** Resolves the effective model ID of a candidate agent node. */
export function resolveCandidateModel(node: GraphNode | undefined, settings: Record<string, unknown>): string {
  if (!node || node.type !== "agent") return "";
  if (node.model && !node.model.includes("{{")) return node.model;
  return resolveRoleModel(node.role, settings).model;
}

/** Extracts the last succeeded step output for `nodeId`, falling back to workflow output. */
export function stepOutputOf(steps: readonly StepRow[], nodeId: string, fallback: Record<string, unknown> | null): unknown {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i]!;
    if (step.node_id !== nodeId || step.state !== "succeeded") continue;
    if (step.output_json) {
      try {
        return JSON.parse(step.output_json) as unknown;
      } catch {
        return step.output_json;
      }
    }
  }
  return fallback;
}

/** Computes total measured USD spend across all repeats of an arm, or `null` when any task is unmeasured. */
export function totalArmCost(summary: ArmSummary): number | null {
  if (summary.tasks.size === 0) return null;
  let total = 0;
  for (const stat of summary.tasks.values()) {
    if (stat.costState !== "measured" || stat.costUsd === null) return null;
    total += stat.costUsd * stat.repeats;
  }
  return total;
}

/** Builds clean verifier test cases from accepted held-out replay runs. */
export function extractVerifierCases(
  replayCases: readonly ReplayCase[],
  workflow: Workflow,
  targetNodeId: string,
  verdictOf?: (runId: string) => "accept" | "reject" | null,
): ReplayOutputVerifierCase[] {
  const upstreamIds = workflow.edges
    .filter((edge) => edge.to === targetNodeId && edge.from !== "start" && edge.from !== "$start")
    .map((edge) => edge.from);
  const cases: ReplayOutputVerifierCase[] = [];
  for (const rc of replayCases) {
    const verdict = rc.verdict ?? verdictOf?.(rc.runId) ?? null;
    if (verdict !== "accept") continue;
    let payload: Record<string, unknown> | null = null;
    for (const up of upstreamIds) {
      if (isRecord(rc.recorded[up])) {
        payload = rc.recorded[up] as Record<string, unknown>;
        break;
      }
    }
    if (!payload && isRecord(rc.recorded[targetNodeId])) {
      payload = rc.recorded[targetNodeId] as Record<string, unknown>;
    }
    if (payload && Object.keys(payload).length > 0) cases.push(payload);
  }
  return cases;
}

export function emptyComparison(armA = "baseline", armB = "candidate"): Comparison {
  return compareArms(summarizeArm(armA, []), summarizeArm(armB, []));
}
