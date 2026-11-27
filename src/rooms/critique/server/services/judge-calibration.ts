import type { RunVerdict } from "@lane-pilot/contracts";
import type { ServerCore } from "../../../contracts/server";
import { wilsonInterval } from "../../../evolve";
import type { LanePilotDatabase } from "../../../storage";
import {
  JUDGE_AGREEMENT_LOW,
  JUDGE_CALIBRATION_MIN_CASES,
  buildCalibrationPrompt,
  calibrationAnswerSchema,
  parseCalibrationAnswer,
  type JudgeRef,
} from "../../models/pairwise-judge";
import { readJudgeTrusted, upsertJudgeCalibration } from "../repositories/judge-calibration-repository";
import { runJudge, type HelperRunOptions } from "./judge-runner";

export { JUDGE_AGREEMENT_LOW, JUDGE_CALIBRATION_MIN_CASES };

export type JudgeCalibrationContext = Pick<ServerCore, "bb" | "db"> & {
  projectId?: string;
  runId?: string;
  hostId?: string;
  effort?: string;
  tier?: "fast" | "standard";
  checkCatalog?: boolean;
  environment?: HelperRunOptions<unknown>["environment"];
  placement?: HelperRunOptions<unknown>["placement"];
  helperPolicy?: HelperRunOptions<unknown>["helperPolicy"];
  runJudge?: typeof runJudge;
};

export type CalibrationCase = {
  caseId?: string;
  runId?: string;
  task?: unknown;
  output: unknown;
  verdict: RunVerdict;
  rubric?: string | readonly string[] | null;
};

export type CalibrationResult = {
  workflowId: string;
  judgeProvider: string;
  judgeModel: string;
  n: number;
  agree: number;
  wilsonLow: number;
  trusted: boolean;
  at: number;
};

type ParsedCalibrationStep =
  | { ok: true; verdict: RunVerdict; reason: string }
  | { ok: false; verdict: "not_run"; reason: string };

function isParsedCalibrationStep(value: unknown): value is ParsedCalibrationStep {
  return Boolean(value && typeof value === "object" && "ok" in value && "verdict" in value);
}

function hasRecordedOutput(output: unknown): boolean {
  if (output === null || output === undefined) return false;
  if (typeof output === "string") return output.trim().length > 0;
  return true;
}

async function judgeSingleCase(
  ctx: JudgeCalibrationContext,
  workflowId: string,
  judge: JudgeRef,
  item: CalibrationCase,
  index: number,
): Promise<RunVerdict | "not_run"> {
  const judgeRunner = ctx.runJudge ?? runJudge;
  const hostId = ctx.hostId;
  const checkCatalog = ctx.checkCatalog ?? Boolean(hostId);
  const caseLabel = item.caseId ?? item.runId ?? String(index);
  const prompt = buildCalibrationPrompt({ output: item.output, task: item.task, rubric: item.rubric });

  const warnFail = (reason: string): "not_run" => {
    ctx.bb.log?.warn?.(`judge calibration case=${caseLabel} wf=${workflowId} outcome=not_run reason=${reason} model=${judge.model}`);
    return "not_run";
  };

  try {
    const res = await judgeRunner<ParsedCalibrationStep>({
      bb: ctx.bb,
      db: ctx.db,
      projectId: ctx.projectId ?? "",
      runId: ctx.runId ?? item.runId ?? "",
      ...(hostId ? { hostId } : {}),
      role: "judge-calibration",
      policyRole: "auditor",
      taskTitle: `Judge calibration (${workflowId}, case ${caseLabel})`,
      pairs: [{ providerId: judge.provider, model: judge.model }],
      effort: ctx.effort ?? "medium",
      tier: ctx.tier ?? "standard",
      checkCatalog,
      ...(!checkCatalog ? { directServiceTier: "default" as const } : {}),
      errorPrefix: "judge_calibration",
      timeoutCode: "judge_calibration_timeout",
      ...(ctx.placement ? { placement: ctx.placement } : {}),
      ...(ctx.helperPolicy ? { helperPolicy: ctx.helperPolicy } : {}),
      environment: ctx.environment ?? { type: "sandbox" },
      stepsForRound: ({ helperPolicy }) => [{
        prompt,
        pluginMetadata: {
          role: "judge-calibration",
          workflowId,
          caseId: caseLabel,
          helperMode: helperPolicy.mode,
          helperRequired: helperPolicy.policy?.required === true,
        },
        parse: (_tid, raw) => parseCalibrationAnswer(raw),
      }],
      toVerdict: (results) => (results[0]?.ok ? "pass" : "not_run"),
    });

    if (res.status !== "ok" || res.verdict === "not_run") {
      const reason = res.status === "exhausted"
        ? res.lastError
        : isParsedCalibrationStep(res.results[0]) && !res.results[0].ok
          ? res.results[0].reason
          : "judge_not_run";
      return warnFail(reason);
    }

    const first = res.results[0] as unknown;
    if (isParsedCalibrationStep(first)) {
      return first.ok ? first.verdict : warnFail(first.reason);
    }

    const rawCandidate = typeof res.raws?.[0] === "string" && res.raws[0].trim()
      ? res.raws[0]
      : typeof first === "string"
        ? first
        : null;
    if (rawCandidate !== null) {
      const parsed = parseCalibrationAnswer(rawCandidate);
      return parsed.ok ? parsed.verdict : warnFail(parsed.reason);
    }

    const direct = calibrationAnswerSchema.safeParse(first);
    if (direct.success) return direct.data.verdict;
    return warnFail("unparsable_calibration_output");
  } catch (cause) {
    return warnFail(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Calibrates a judge once per workflow against owner-labelled cases with recorded outputs.
 * A judge with fewer than 10 cases or Wilson lower bound below 70% stays untrusted (advisory only).
 */
export async function calibrateJudge(
  ctx: JudgeCalibrationContext,
  input: {
    workflowId: string;
    judge: JudgeRef;
    cases: readonly CalibrationCase[];
    minAgreement?: number;
    now?: number;
  },
): Promise<CalibrationResult> {
  const labelled = input.cases.filter(
    (item) => (item.verdict === "accept" || item.verdict === "reject") && hasRecordedOutput(item.output),
  );
  let n = 0;
  let agree = 0;
  for (const [index, item] of labelled.entries()) {
    const verdict = await judgeSingleCase(ctx, input.workflowId, input.judge, item, index);
    n += 1;
    if (verdict === item.verdict) agree += 1;
  }

  const wilsonLow = n > 0 ? wilsonInterval(agree, n).low : 0;
  const minAgreement = input.minAgreement ?? JUDGE_AGREEMENT_LOW;
  const trusted = n >= JUDGE_CALIBRATION_MIN_CASES && wilsonLow >= minAgreement;
  const at = input.now ?? Date.now();

  const result: CalibrationResult = {
    workflowId: input.workflowId,
    judgeProvider: input.judge.provider,
    judgeModel: input.judge.model,
    n,
    agree,
    wilsonLow,
    trusted,
    at,
  };

  upsertJudgeCalibration(ctx.db, result);
  ctx.bb.log?.info?.(
    `judge calibration wf=${input.workflowId} n=${n} agree=${agree} low=${wilsonLow.toFixed(3)} trusted=${trusted}`,
  );
  return result;
}

/** Reads whether a calibrated judge is trusted for `workflowId`. Returns false when uncalibrated. */
export function judgeTrusted(db: LanePilotDatabase, workflowId: string, judge: JudgeRef): boolean {
  return readJudgeTrusted(db, workflowId, judge);
}
