import { z } from "zod";
import { modelFamily } from "@lane-pilot/models";
import { extractModelJson, helperExit } from "@lane-pilot/workflow-engine";
import { EVOLVE_THRESHOLDS, RUN_VERDICTS, type RunVerdict } from "@lane-pilot/contracts";

export const PAIRWISE_OUTCOMES = ["candidate_better", "reference_better", "tie", "not_run"] as const;
export type PairwiseOutcome = (typeof PAIRWISE_OUTCOMES)[number];

export type JudgeRef = { provider: string; model: string };

export const PAIRWISE_FIXED_INSTRUCTION =
  'Two outputs for the same task. Answer with JSON {"better": "A"|"B"|"tie", "reason": string}';

export const CALIBRATION_FIXED_INSTRUCTION =
  'Evaluate this output for the task. Answer with JSON {"verdict": "accept"|"reject", "reason": string}';

export const JUDGE_AGREEMENT_LOW = EVOLVE_THRESHOLDS.judgeAgreementLow;
export const JUDGE_CALIBRATION_MIN_CASES = 10;

export const pairwiseAnswerSchema = z.object({
  better: z.enum(["A", "B", "tie"]),
  reason: z.string().optional(),
});
export type PairwiseAnswer = z.infer<typeof pairwiseAnswerSchema>;

export const calibrationAnswerSchema = z.object({
  verdict: z.enum(RUN_VERDICTS),
  reason: z.string().optional(),
});
export type CalibrationAnswer = z.infer<typeof calibrationAnswerSchema>;

export function formatJudgeValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function formatRubricBlock(rubric?: string | readonly string[] | null): string | null {
  if (!rubric) return null;
  if (typeof rubric === "string") return rubric.trim() ? rubric.trim() : null;
  const lines = rubric.map((item) => item.trim()).filter(Boolean);
  return lines.length ? lines.map((item) => `- ${item}`).join("\n") : null;
}

/**
 * Self-enhancement exclusion: a judge may not share a model family with the candidate model.
 * Identical non-empty model ids are also treated as same-family when `modelFamily` returns null.
 */
export function isSameModelFamily(judgeModel: string, candidateModel: string): boolean {
  const jModel = judgeModel.trim();
  const cModel = candidateModel.trim();
  if (jModel && cModel && jModel === cModel) return true;
  const jFamily = modelFamily(jModel);
  const cFamily = modelFamily(cModel);
  return jFamily !== null && cFamily !== null && jFamily === cFamily;
}

export function buildPairwisePrompt(input: {
  outputA: unknown;
  outputB: unknown;
  task: unknown;
  rubric?: string | readonly string[] | null;
}): string {
  const parts = [
    PAIRWISE_FIXED_INSTRUCTION,
    `TASK:\n${formatJudgeValue(input.task)}`,
  ];
  const rubricText = formatRubricBlock(input.rubric);
  if (rubricText) parts.push(`RUBRIC:\n${rubricText}`);
  parts.push(`Output A:\n${formatJudgeValue(input.outputA)}`);
  parts.push(`Output B:\n${formatJudgeValue(input.outputB)}`);
  return parts.join("\n\n");
}

export function mapPairwiseBetter(
  better: PairwiseAnswer["better"],
  order: "ref_first" | "cand_first",
): Exclude<PairwiseOutcome, "not_run"> {
  if (better === "tie") return "tie";
  if (order === "ref_first") return better === "A" ? "reference_better" : "candidate_better";
  return better === "A" ? "candidate_better" : "reference_better";
}

export function parsePairwiseOrderAnswer(
  raw: string,
  order: "ref_first" | "cand_first",
): { ok: true; outcome: Exclude<PairwiseOutcome, "not_run">; reason: string } | { ok: false; outcome: "not_run"; reason: string } {
  const exit = helperExit(raw);
  if (exit) return { ok: false, outcome: "not_run", reason: exit };
  try {
    const extracted = extractModelJson(raw);
    const parsed = pairwiseAnswerSchema.safeParse(extracted);
    if (!parsed.success) {
      return { ok: false, outcome: "not_run", reason: parsed.error.issues[0]?.message ?? "invalid_pairwise_json" };
    }
    return {
      ok: true,
      outcome: mapPairwiseBetter(parsed.data.better, order),
      reason: parsed.data.reason ?? "",
    };
  } catch (cause) {
    return { ok: false, outcome: "not_run", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}

/** Dual-order settlement: any `not_run` stays `not_run`; disagreement collapses to `tie`. */
export function resolvePairwiseOrders(order1: PairwiseOutcome, order2: PairwiseOutcome): PairwiseOutcome {
  if (order1 === "not_run" || order2 === "not_run") return "not_run";
  return order1 === order2 ? order1 : "tie";
}

export function buildCalibrationPrompt(input: {
  output: unknown;
  task?: unknown;
  rubric?: string | readonly string[] | null;
}): string {
  const parts = [CALIBRATION_FIXED_INSTRUCTION];
  if (input.task !== undefined && input.task !== null) parts.push(`TASK:\n${formatJudgeValue(input.task)}`);
  const rubricText = formatRubricBlock(input.rubric);
  if (rubricText) parts.push(`RUBRIC:\n${rubricText}`);
  parts.push(`OUTPUT:\n${formatJudgeValue(input.output)}`);
  return parts.join("\n\n");
}

export function parseCalibrationAnswer(
  raw: string,
): { ok: true; verdict: RunVerdict; reason: string } | { ok: false; verdict: "not_run"; reason: string } {
  const exit = helperExit(raw);
  if (exit) return { ok: false, verdict: "not_run", reason: exit };
  try {
    const extracted = extractModelJson(raw);
    const parsed = calibrationAnswerSchema.safeParse(extracted);
    if (!parsed.success) {
      return { ok: false, verdict: "not_run", reason: parsed.error.issues[0]?.message ?? "invalid_calibration_json" };
    }
    return { ok: true, verdict: parsed.data.verdict, reason: parsed.data.reason ?? "" };
  } catch (cause) {
    return { ok: false, verdict: "not_run", reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
