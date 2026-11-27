import type { ServerCore } from "../../../contracts/server";
import {
  buildPairwisePrompt,
  isSameModelFamily,
  mapPairwiseBetter,
  pairwiseAnswerSchema,
  parsePairwiseOrderAnswer,
  resolvePairwiseOrders,
  type JudgeRef,
  type PairwiseOutcome,
} from "../../models/pairwise-judge";
import { runJudge, type HelperRunOptions } from "./judge-runner";

export type { JudgeRef, PairwiseOutcome };

export type PairwiseJudgeContext = Pick<ServerCore, "bb" | "db"> & {
  projectId?: string;
  runId?: string;
  hostId?: string;
  workflowId?: string;
  effort?: string;
  tier?: "fast" | "standard";
  checkCatalog?: boolean;
  environment?: HelperRunOptions<unknown>["environment"];
  placement?: HelperRunOptions<unknown>["placement"];
  helperPolicy?: HelperRunOptions<unknown>["helperPolicy"];
  runJudge?: typeof runJudge;
};

export type PairwiseJudgeInput = {
  reference: unknown;
  candidate: unknown;
  task: unknown;
  rubric?: string | readonly string[] | null;
  judge: JudgeRef;
  candidateModel: string;
  workflowId?: string;
  effort?: string;
  tier?: "fast" | "standard";
};

export type PairwiseJudgeResult = {
  outcome: PairwiseOutcome;
  orders: [PairwiseOutcome, PairwiseOutcome];
  judgeModel: string;
  reason?: string;
};

type ParsedStep =
  | { ok: true; outcome: Exclude<PairwiseOutcome, "not_run">; reason: string }
  | { ok: false; outcome: "not_run"; reason: string };

function isParsedStep(value: unknown): value is ParsedStep {
  return Boolean(value && typeof value === "object" && "ok" in value && "outcome" in value);
}

async function runSingleOrder(
  ctx: PairwiseJudgeContext,
  input: PairwiseJudgeInput,
  order: "ref_first" | "cand_first",
  wf: string,
): Promise<PairwiseOutcome> {
  const judgeRunner = ctx.runJudge ?? runJudge;
  const hostId = ctx.hostId;
  const checkCatalog = ctx.checkCatalog ?? Boolean(hostId);
  const prompt = buildPairwisePrompt({
    outputA: order === "ref_first" ? input.reference : input.candidate,
    outputB: order === "ref_first" ? input.candidate : input.reference,
    task: input.task,
    rubric: input.rubric,
  });

  const warnFail = (reason: string): "not_run" => {
    ctx.bb.log?.warn?.(`judge pairwise order=${order} wf=${wf} outcome=not_run reason=${reason} model=${input.judge.model}`);
    return "not_run";
  };

  try {
    const res = await judgeRunner<ParsedStep>({
      bb: ctx.bb,
      db: ctx.db,
      projectId: ctx.projectId ?? "",
      runId: ctx.runId ?? "",
      ...(hostId ? { hostId } : {}),
      role: "pairwise-judge",
      policyRole: "auditor",
      taskTitle: `Pairwise judge (${wf}, ${order})`,
      pairs: [{ providerId: input.judge.provider, model: input.judge.model }],
      effort: input.effort ?? ctx.effort ?? "medium",
      tier: input.tier ?? ctx.tier ?? "standard",
      checkCatalog,
      ...(!checkCatalog ? { directServiceTier: "default" as const } : {}),
      errorPrefix: "pairwise_judge",
      timeoutCode: "pairwise_judge_timeout",
      ...(ctx.placement ? { placement: ctx.placement } : {}),
      ...(ctx.helperPolicy ? { helperPolicy: ctx.helperPolicy } : {}),
      environment: ctx.environment ?? { type: "sandbox" },
      stepsForRound: ({ helperPolicy }) => [{
        prompt,
        pluginMetadata: {
          role: "pairwise-judge",
          workflowId: wf,
          order,
          helperMode: helperPolicy.mode,
          helperRequired: helperPolicy.policy?.required === true,
        },
        parse: (_tid, raw) => parsePairwiseOrderAnswer(raw, order),
      }],
      toVerdict: (results) => (results[0]?.ok ? "pass" : "not_run"),
    });

    if (res.status !== "ok" || res.verdict === "not_run") {
      const reason = res.status === "exhausted"
        ? res.lastError
        : isParsedStep(res.results[0]) && !res.results[0].ok
          ? res.results[0].reason
          : "judge_not_run";
      return warnFail(reason);
    }

    const first = res.results[0] as unknown;
    if (isParsedStep(first)) {
      return first.ok ? first.outcome : warnFail(first.reason);
    }

    // Handle stubs that return raw text or a direct JSON object without calling step.parse.
    const rawCandidate = typeof res.raws?.[0] === "string" && res.raws[0].trim()
      ? res.raws[0]
      : typeof first === "string"
        ? first
        : null;
    if (rawCandidate !== null) {
      const parsed = parsePairwiseOrderAnswer(rawCandidate, order);
      return parsed.ok ? parsed.outcome : warnFail(parsed.reason);
    }

    const direct = pairwiseAnswerSchema.safeParse(first);
    if (direct.success) {
      return mapPairwiseBetter(direct.data.better, order);
    }
    return warnFail("unparsable_pairwise_output");
  } catch (cause) {
    return warnFail(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * Tier-2 dual-order pairwise judge: compares `reference` and `candidate` in both orders,
 * refuses same-family pairs, collapses order disagreement to `tie`, and never turns `not_run` into a pass.
 */
export async function runPairwiseJudge(
  ctx: PairwiseJudgeContext,
  input: PairwiseJudgeInput,
): Promise<PairwiseJudgeResult> {
  const wf = input.workflowId ?? ctx.workflowId ?? "unknown";
  if (isSameModelFamily(input.judge.model, input.candidateModel)) {
    ctx.bb.log?.warn?.(`judge pairwise refused wf=${wf} reason=same_family model=${input.judge.model} candidate=${input.candidateModel}`);
    return {
      outcome: "not_run",
      orders: ["not_run", "not_run"],
      judgeModel: input.judge.model,
      reason: "same_family",
    };
  }

  const o1 = await runSingleOrder(ctx, input, "ref_first", wf);
  const o2 = await runSingleOrder(ctx, input, "cand_first", wf);
  const outcome = resolvePairwiseOrders(o1, o2);
  ctx.bb.log?.info?.(`judge pairwise wf=${wf} outcome=${outcome} orders=${o1}/${o2} model=${input.judge.model}`);
  return { outcome, orders: [o1, o2], judgeModel: input.judge.model };
}
