import { EVOLVE_THRESHOLDS, type ArmKind, type CostState } from "@lane-pilot/contracts";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  applyDraftOps,
  createDraftStore,
  createJournal,
  loadWorkflow,
  permissionDiff,
  replayCasesFromRuns,
  runDraftTest,
  type DraftStore,
  type DraftTestResult,
  type GraphNode,
  type NodeExecutor,
  type RawDefinition,
  type ReplayCase,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { HARNESS_VERSION, type LanePilotDatabase } from "../../../storage";
import { compareArms, computeNoise, costPerAccepted, summarizeArm, type Comparison } from "../../models/compare";
import { isJudgeLikeRole, isRecord } from "../../models/hypothesis";
import {
  emptyComparison,
  extractVerifierCases,
  isSettledByCode,
  pickCrossFamilyJudge,
  resolveCandidateModel,
  stepOutputOf,
  totalArmCost,
  type ReplayJudgeOutcome,
  type ReplayJudgeRef,
  type ReplayOutcome,
  type ReplayOutputVerifierCase,
  type ReplayPairwiseJudgeInput,
  type ReplayPairwiseJudgeResult,
  type ReplayPairwiseOutcome,
  type ReplayScorecard,
  type ReplayVerifierFn,
  type ReplayVerifierScore,
} from "../../models/replay";
import type { BenchResult, NoiseRecord } from "../../models/types";
import { parseEvolveSettings } from "../../settings";
import { heldOutCases, type EvolveCaseRow, type EvolveLogSink } from "../repositories/case-repository";
import { addNegative, getHypothesis, setHypothesisState } from "../repositories/ledger-repository";
import { makeLogSink, readMergedSettings } from "./context";

export type {
  ReplayJudgeOutcome,
  ReplayJudgeRef,
  ReplayOutcome,
  ReplayOutputVerifierCase,
  ReplayPairwiseJudgeInput,
  ReplayPairwiseJudgeResult,
  ReplayPairwiseOutcome,
  ReplayScorecard,
  ReplayVerifierFn,
  ReplayVerifierScore,
};

export type ReplayContext = {
  db: LanePilotDatabase;
  bb?: unknown;
  projectId?: string | null | undefined;
  hostId?: string | null | undefined;
  settings?: Record<string, unknown> | undefined;
  log?: EvolveLogSink | ((message: string) => void) | undefined;
};

export type ReplayDeps = {
  workflow?: RawDefinition | Workflow | null | undefined;
  loadWorkflow?: ((workflowId: string) => RawDefinition | Workflow | null | Promise<RawDefinition | Workflow | null>) | undefined;
  resolveWorkflow?: ((id: string, version?: number) => Workflow | null) | undefined;
  draftStore?: DraftStore | undefined;
  runDraftTest?: typeof runDraftTest | undefined;
  executors?: Record<string, NodeExecutor> | undefined;
  harnessVersion?: string | undefined;
  now?: (() => number) | undefined;
  timeoutMs?: number | undefined;
  k?: number | undefined;
  judge?: ReplayJudgeRef | ((candidateModel: string) => ReplayJudgeRef | null | undefined) | undefined;
  judgeTrusted?: ((workflowId: string, judge: ReplayJudgeRef) => boolean) | undefined;
  runPairwiseJudge?: ((input: ReplayPairwiseJudgeInput) => Promise<ReplayPairwiseJudgeResult> | ReplayPairwiseJudgeResult) | undefined;
  scoreVerifier?: ((
    verify: ReplayVerifierFn,
    cases: readonly ReplayOutputVerifierCase[],
    options?: {
      requiredFields?: readonly string[];
      kinds?: readonly ("drop_required_field" | "swap_number" | "empty_artifact" | "claim_done_without_artifact")[];
    },
  ) => ReplayVerifierScore) | undefined;
  verifierFn?: ReplayVerifierFn | undefined;
  verifierCases?: readonly ReplayOutputVerifierCase[] | undefined;
  verifierOptions?: {
    requiredFields?: readonly string[];
    kinds?: readonly ("drop_required_field" | "swap_number" | "empty_artifact" | "claim_done_without_artifact")[];
  } | undefined;
  isVerifierNode?: boolean | undefined;
  onPassed?: ((passed: {
    hypothesisId: string;
    workflowId: string;
    draftId: string;
    scorecard: ReplayScorecard;
    comparison: Comparison;
  }) => Promise<void> | void) | undefined;
};

function toBenchResult(
  db: LanePilotDatabase,
  replayCase: ReplayCase,
  res: DraftTestResult,
  accepted: boolean,
  hasControlledClock: boolean,
): BenchResult {
  const journal = createJournal(db);
  const run = res.runId ? journal.getRun(res.runId) : undefined;
  const steps = res.runId ? journal.steps(res.runId) : [];

  const stagesPassed = steps.filter((s) => s.state === "succeeded").length;
  const stagesFailed = steps.filter((s) => s.state === "failed" || s.state === "canceled" || s.state === "interrupted").length;
  const finished = steps.filter((s) => s.state === "succeeded" || s.state === "failed" || s.state === "skipped" || s.state === "canceled");

  const tokens = finished.reduce(
    (sum, s) => sum + (s.input_tokens ?? 0) + (s.output_tokens ?? 0) + (s.cache_read_tokens ?? 0) + (s.cache_write_tokens ?? 0),
    0,
  );
  const costStates = finished
    .map((s) => s.cost_state)
    .filter((cs): cs is CostState => cs !== null && cs !== undefined);

  let costState: CostState = "not_measured";
  let costUsd: number | null = null;
  if (costStates.length > 0 && costStates.every((cs) => cs === "measured")) {
    costState = "measured";
    costUsd = finished.reduce((sum, s) => sum + (s.cost_micro_usd ?? 0), 0) / 1_000_000;
  }

  const stepMs = steps.reduce((sum, s) => sum + (s.duration_ms ?? 0), 0);
  const runMs = run ? Math.max(0, run.updated_at - run.created_at) : stepMs;
  const rawMs = stepMs > 0 ? stepMs : runMs;
  const seconds = hasControlledClock ? rawMs / 1000 : Math.floor(rawMs / 10) / 100;

  const isError = res.status === "invalid" || res.status === "timeout";
  return {
    taskId: replayCase.runId,
    state: isError ? "error" : accepted ? "accepted" : "not_accepted",
    accepted: !isError && accepted,
    stagesPassed,
    stagesFailed,
    tokens: costState === "measured" ? tokens : null,
    costUsd,
    costState,
    seconds,
    ...(res.runId ? { runId: res.runId } : {}),
    ...(res.reason ? { reason: res.reason } : {}),
  };
}

/**
 * Runs offline paired replay on frozen held-out cases (`k >= 3` repeats per arm across
 * baseline, empty control, and candidate draft), enforcing Tier 1 hard checks, calibrated
 * cross-family Tier 2 judging, critic catch bar, and §5.2 acceptance rules.
 */
export async function replayHypothesis(
  ctx: ReplayContext,
  deps: ReplayDeps,
  input: { hypothesisId: string },
): Promise<ReplayOutcome> {
  const log = makeLogSink(ctx);
  const now = deps.now ?? Date.now;
  const hyp = getHypothesis(ctx.db, input.hypothesisId);

  const buildAborted = (
    reason: string,
    extra: { workflowId?: string; nodeId?: string; armKind?: ArmKind; cases?: number; k?: number; draftId?: string } = {},
  ): ReplayOutcome => {
    const wfId = extra.workflowId ?? hyp?.workflowId ?? "";
    const comparison = emptyComparison();
    const scorecard: ReplayScorecard = {
      hypothesisId: input.hypothesisId,
      workflowId: wfId,
      nodeId: extra.nodeId ?? hyp?.nodeId ?? "",
      armKind: extra.armKind ?? hyp?.armKind ?? "model",
      cases: extra.cases ?? 0,
      k: extra.k ?? Math.max(EVOLVE_THRESHOLDS.repeats, Math.floor(deps.k ?? EVOLVE_THRESHOLDS.repeats)),
      comparison,
      passK: comparison.passK,
      judgeOutcomes: [],
      judgeTrusted: null,
      verifierScore: null,
      costs: {
        baselineUsd: null,
        candidateUsd: null,
        baselinePerAcceptedUsd: null,
        candidatePerAcceptedUsd: null,
      },
      aborted: true,
      abortReason: reason,
    };
    log.warn(`evolve replay aborted hyp=${input.hypothesisId}: ${reason}`);
    if (hyp) {
      setHypothesisState(
        ctx.db,
        {
          id: hyp.id,
          state: "rejected",
          ...(extra.draftId ? { draftId: extra.draftId } : {}),
          scorecard,
          reason: "replay_error",
          now: now(),
        },
        log,
      );
    }
    return { pass: false, reasons: [reason], comparison, scorecard };
  };

  if (!hyp) return buildAborted("hypothesis_not_found");

  const baselineRaw = deps.workflow
    ?? (await Promise.resolve().then(() => deps.loadWorkflow?.(hyp.workflowId)).catch(() => null))
    ?? null;
  if (!baselineRaw) return buildAborted("workflow_not_found");

  const baselineLoaded = loadWorkflow(baselineRaw, { resolve: deps.resolveWorkflow });
  if (!baselineLoaded.ok) return buildAborted("invalid_baseline_workflow");
  const baselineWorkflow = baselineLoaded.workflow;

  let variant: Record<string, unknown>;
  try {
    const parsed = JSON.parse(hyp.variantJson) as unknown;
    if (!isRecord(parsed)) return buildAborted("invalid_variant_json");
    variant = parsed;
  } catch {
    return buildAborted("invalid_variant_json");
  }

  const archiveWidens = (wideningCount: number, draftId?: string): ReplayOutcome => {
    log.warn(`draft guard source=evolve draft=${draftId ?? hyp.workflowId} widening=${wideningCount}`);
    const out = buildAborted("widens_permissions", { draftId });
    setHypothesisState(ctx.db, { id: hyp.id, state: "rejected", ...(draftId ? { draftId } : {}), scorecard: out.scorecard, reason: "widens_permissions", now: now() }, log);
    addNegative(ctx.db, { workflowId: hyp.workflowId, nodeId: hyp.nodeId, variantSignature: hyp.variantSignature, graphVersion: hyp.graphVersion, reason: "widens_permissions", now: now() });
    return out;
  };
  const preCheck = applyDraftOps(baselineRaw as RawDefinition, [{ op: "update_node", id: hyp.nodeId, set: variant }], { evolutionGate: true, source: "evolve" });
  if (preCheck.ok) {
    const preDiffs = permissionDiff(baselineWorkflow, preCheck.definition);
    if (preDiffs.length > 0) return archiveWidens(preDiffs.length);
  } else if (preCheck.refused.some((r) => r.reason.includes("verify") || r.reason.includes("judge") || r.reason.includes("critic"))) {
    return archiveWidens(1);
  }

  const heldOutRows = heldOutCases(ctx.db, hyp.workflowId);
  const caseByRunId = new Map<string, EvolveCaseRow>(heldOutRows.map((row) => [row.runId, row]));
  const heldOutRunIds = heldOutRows.map((row) => row.runId);
  const replayCases = heldOutRunIds.length > 0
    ? replayCasesFromRuns(ctx.db, hyp.workflowId, {
        runIds: heldOutRunIds,
        workflow: baselineWorkflow,
        limit: Math.max(50, heldOutRunIds.length),
        log: { debug: log.debug },
      }).cases
    : [];

  const k = Math.max(EVOLVE_THRESHOLDS.repeats, Math.floor(deps.k ?? EVOLVE_THRESHOLDS.repeats));
  if (replayCases.length === 0) return buildAborted("no_cases", { cases: 0, k });

  const settings = readMergedSettings(ctx);
  const evolveCfg = parseEvolveSettings(settings);
  const plannedRuns = replayCases.length * k * 3;
  if (plannedRuns > evolveCfg.replayMaxRuns) {
    return buildAborted(`budget_exceeded (${plannedRuns} > ${evolveCfg.replayMaxRuns})`, { cases: replayCases.length, k });
  }

  const draftStore = deps.draftStore ?? createDraftStore(ctx.db, now);
  const draft = draftStore.create({
    projectId: ctx.projectId ?? GLOBAL_SETTINGS_PROJECT_ID,
    threadId: null,
    scope: "global",
    name: baselineWorkflow.name,
    description: baselineWorkflow.description,
    workflowId: hyp.workflowId,
    definition: baselineRaw as RawDefinition,
    metadata: { source: "evolve", hypothesisId: hyp.id },
  });
  const patched = draftStore.patch(
    draft.id,
    [{ op: "update_node", id: hyp.nodeId, set: variant }],
    { evolutionGate: true, source: "evolve", ...(deps.resolveWorkflow ? { validate: { resolve: deps.resolveWorkflow } } : {}) },
  );
  if (!patched.ok) {
    if (patched.reason === "refused" && patched.refused?.some((r) => r.reason === "widens_permissions")) {
      return archiveWidens(1, draft.id);
    }
    return buildAborted(`patch_refused:${patched.reason}`, { cases: replayCases.length, k, draftId: draft.id });
  }

  const candidateLoaded = loadWorkflow(patched.draft.definition, { resolve: deps.resolveWorkflow });
  if (!candidateLoaded.ok) {
    return buildAborted("invalid_candidate_workflow", { cases: replayCases.length, k, draftId: patched.draft.id });
  }
  const candidateWorkflow = candidateLoaded.workflow;
  const diffs = permissionDiff(baselineWorkflow, candidateWorkflow);
  if (diffs.length > 0) return archiveWidens(diffs.length, patched.draft.id);

  setHypothesisState(ctx.db, { id: hyp.id, state: "replaying", draftId: patched.draft.id, now: now() }, log);

  const baselineNode = baselineWorkflow.nodes.find((n): n is GraphNode => n.type !== "note" && n.id === hyp.nodeId);
  const candidateNode = candidateWorkflow.nodes.find((n): n is GraphNode => n.type !== "note" && n.id === hyp.nodeId);
  const settledByCode = isSettledByCode(candidateNode, hyp.armKind);
  const verifierNode = deps.isVerifierNode
    ?? Boolean(baselineNode && baselineNode.type === "agent" && isJudgeLikeRole(baselineNode.role) && hyp.armKind !== "check");

  const candidateModel = resolveCandidateModel(candidateNode, settings);
  const judgeRef = settledByCode
    ? null
    : (typeof deps.judge === "function" ? deps.judge(candidateModel) : deps.judge) ?? pickCrossFamilyJudge(candidateModel, settings);
  const trusted = settledByCode ? null : Boolean(judgeRef && deps.judgeTrusted?.(hyp.workflowId, judgeRef));

  const runDraftTestFn = deps.runDraftTest ?? runDraftTest;
  const harnessVersion = deps.harnessVersion ?? HARNESS_VERSION;
  const hasControlledClock = Boolean(deps.now);
  const makePorts = (resolveWf: (id: string, version?: number) => Workflow | null): Parameters<typeof runDraftTest>[0] => ({
    db: ctx.db,
    harnessVersion,
    resolveWorkflow: resolveWf,
    ...(deps.executors ? { executors: deps.executors } : {}),
    ...(deps.now ? { now: deps.now } : {}),
    ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
    log: { debug: log.debug },
  });

  const baselineResolve = (id: string, version?: number) => {
    if (id === baselineWorkflow.id && (version === undefined || version === baselineWorkflow.version)) return baselineWorkflow;
    return deps.resolveWorkflow?.(id, version) ?? null;
  };
  const candidateResolve = (id: string, version?: number) => {
    if (id === candidateWorkflow.id && (version === undefined || version === candidateWorkflow.version)) return candidateWorkflow;
    return deps.resolveWorkflow?.(id, version) ?? null;
  };

  const baselineByRepeat: BenchResult[][] = [];
  const controlByRepeat: BenchResult[][] = [];
  const candidateByRepeat: BenchResult[][] = [];
  const judgeOutcomes: ReplayJudgeOutcome[] = [];

  try {
    const runArm = async (
      wf: Workflow,
      resolveWf: (id: string, version?: number) => Workflow | null,
      isCandidate: boolean,
    ): Promise<BenchResult[][]> => {
      const out: BenchResult[][] = [];
      for (let repeat = 0; repeat < k; repeat += 1) {
        const rows: BenchResult[] = [];
        for (const rc of replayCases) {
          const result = await runDraftTestFn(makePorts(resolveWf), wf, rc);
          let accepted = result.green === true;
          const caseVerdict = rc.verdict ?? caseByRunId.get(rc.runId)?.verdict ?? null;
          if (isCandidate && accepted && !settledByCode && caseVerdict === "accept" && rc.recorded[hyp.nodeId] !== undefined) {
            if (deps.runPairwiseJudge && judgeRef) {
              const steps = result.runId ? createJournal(ctx.db).steps(result.runId) : [];
              const candOut = stepOutputOf(steps, hyp.nodeId, result.output);
              const judgeRes = await deps.runPairwiseJudge({
                reference: rc.recorded[hyp.nodeId],
                candidate: candOut,
                task: rc.inputs,
                judge: judgeRef,
                candidateModel,
                workflowId: hyp.workflowId,
              });
              const isTrusted = trusted === true;
              judgeOutcomes.push({
                caseId: rc.runId,
                repeat,
                outcome: judgeRes.outcome,
                orders: judgeRes.orders,
                judgeModel: judgeRes.judgeModel,
                trusted: isTrusted,
                advisory: !isTrusted,
                ...(judgeRes.reason ? { reason: judgeRes.reason } : {}),
              });
              if (isTrusted && judgeRes.outcome !== "candidate_better" && judgeRes.outcome !== "tie") {
                accepted = false;
              }
            } else if (trusted) {
              accepted = false;
            }
          }
          rows.push(toBenchResult(ctx.db, rc, result, accepted, hasControlledClock));
        }
        out.push(rows);
      }
      return out;
    };

    baselineByRepeat.push(...(await runArm(baselineWorkflow, baselineResolve, false)));
    controlByRepeat.push(...(await runArm(baselineWorkflow, baselineResolve, false)));
    candidateByRepeat.push(...(await runArm(candidateWorkflow, candidateResolve, true)));
  } catch (cause) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    return buildAborted(`runner_error: ${msg}`, { cases: replayCases.length, k, draftId: patched.draft.id });
  }

  const baselineSummary = summarizeArm("baseline", baselineByRepeat);
  const controlSummary = summarizeArm("control", controlByRepeat);
  const candidateSummary = summarizeArm("candidate", candidateByRepeat);
  const noise: NoiseRecord = { armA: "baseline", armB: "control", noise: computeNoise(baselineSummary, controlSummary) };
  const classOf = (runId: string) => caseByRunId.get(runId)?.taskClass ?? null;
  const comparison = compareArms(baselineSummary, candidateSummary, noise, {
    allowWriterMismatch: hyp.armKind === "model",
    classOf,
  });

  let verifierScore: ReplayVerifierScore | null = null;
  if (verifierNode) {
    const vCases = deps.verifierCases ?? extractVerifierCases(
      replayCases,
      baselineWorkflow,
      hyp.nodeId,
      (id) => caseByRunId.get(id)?.verdict ?? null,
    );
    if (deps.scoreVerifier && deps.verifierFn && vCases.length > 0) {
      verifierScore = deps.scoreVerifier(deps.verifierFn, vCases, deps.verifierOptions);
    }
  }

  const reasons: string[] = [];
  if (comparison.verdict !== "pass") reasons.push(`comparison:${comparison.verdict}`);
  if (!comparison.nonInferior) reasons.push("non_inferiority_failed");
  if (!comparison.noRegressionByClass) reasons.push("class_regression");
  if (comparison.gain !== "cost" && comparison.gain !== "time") reasons.push(`no_gain:${comparison.gain}`);
  if (!settledByCode) {
    if (!trusted) reasons.push("judge_untrusted");
    else if (judgeOutcomes.length === 0) reasons.push("judge_not_run");
  }
  if (verifierNode) {
    if (!verifierScore) reasons.push("verifier_unscored");
    else if (!verifierScore.passed || verifierScore.catchRate === null || verifierScore.catchRate < EVOLVE_THRESHOLDS.checkerCatch) {
      reasons.push(`checker_catch:${verifierScore.catchRate ?? "null"}`);
    }
  }

  const pass = reasons.length === 0;
  const scorecard: ReplayScorecard = {
    hypothesisId: hyp.id,
    workflowId: hyp.workflowId,
    nodeId: hyp.nodeId,
    armKind: hyp.armKind,
    cases: replayCases.length,
    k,
    comparison,
    passK: comparison.passK,
    judgeOutcomes,
    judgeTrusted: trusted,
    verifierScore,
    costs: {
      baselineUsd: totalArmCost(baselineSummary),
      candidateUsd: totalArmCost(candidateSummary),
      baselinePerAcceptedUsd: costPerAccepted(baselineSummary),
      candidatePerAcceptedUsd: costPerAccepted(candidateSummary),
    },
  };

  if (pass) {
    setHypothesisState(
      ctx.db,
      { id: hyp.id, state: "replaying", draftId: patched.draft.id, scorecard, reason: null, now: now() },
      log,
    );
    await deps.onPassed?.({
      hypothesisId: hyp.id,
      workflowId: hyp.workflowId,
      draftId: patched.draft.id,
      scorecard,
      comparison,
    });
  } else {
    const reasonText = reasons.join("; ");
    setHypothesisState(
      ctx.db,
      { id: hyp.id, state: "rejected", draftId: patched.draft.id, scorecard, reason: reasonText, now: now() },
      log,
    );
    addNegative(ctx.db, {
      workflowId: hyp.workflowId,
      nodeId: hyp.nodeId,
      variantSignature: hyp.variantSignature,
      graphVersion: hyp.graphVersion,
      reason: reasonText,
      now: now(),
    });
  }

  log.info(`evolve replay hyp=${hyp.id} cases=${replayCases.length} k=${k} pass=${pass} gain=${comparison.gain}`);
  return { pass, reasons, comparison, scorecard };
}
