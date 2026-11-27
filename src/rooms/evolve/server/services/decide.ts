import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  createDraftStore,
  finalRuleOf,
  loadWorkflow,
  wfLastGoalAudit,
  wfStepsOfRun,
  wfTrialRuns,
  workflowFinish,
  type GraphNode,
  type RawDefinition,
  type RunRow,
  type TrialRunRow,
} from "@lane-pilot/workflow-engine";
import { postOwnerItem } from "../../../owner-waiting";
import type { LanePilotDatabase } from "../../../storage";
import { decideCanary, type CanaryRow } from "../../models/trial";
import { caseCounts } from "../repositories/case-repository";
import {
  addNegative,
  closeTrial,
  getHypothesis,
  getTrial,
  openTrial,
  openTrialFor,
  setHypothesisState,
} from "../repositories/ledger-repository";
import { makeLogSink } from "./context";
import { approveHypothesis, onPostPromotionVerdict, rejectHypothesis } from "./decide-actions";
import { evolveOwnerItemKey, ownerProjectId, parseJsonObj, syncEvolveOwnerItem } from "./decide-owner-item";
import {
  currentLoopAllows,
  issueEvolutionReceipt,
  runPublishPort,
  type CanaryRunResult,
  type DecideContext,
  type DecideDeps,
  type DecideHypothesisResult,
  type OwnerDecisionResult,
  type PostPromotionResult,
  type PostPromotionVerdictInput,
  type PublishEvolutionResult,
  type RollbackEvolutionResult,
} from "./decide-shared";

export {
  approveHypothesis,
  evolveOwnerItemKey,
  issueEvolutionReceipt,
  onPostPromotionVerdict,
  rejectHypothesis,
  syncEvolveOwnerItem,
  type CanaryRunResult,
  type DecideContext,
  type DecideDeps,
  type DecideHypothesisResult,
  type OwnerDecisionResult,
  type PostPromotionResult,
  type PostPromotionVerdictInput,
  type PublishEvolutionResult,
  type RollbackEvolutionResult,
};

/**
 * Applies a demotion hypothesis (`source = "fallback"`, >20% fallback rate) immediately without case thresholds,
 * archives the brittle script/plan variant as `fallback_over_20pct`, and posts a non-waking desk notice.
 */
export async function applyDemotion(
  ctx: DecideContext,
  deps: DecideDeps,
  input: { hypothesisId: string },
): Promise<DecideHypothesisResult> {
  const log = makeLogSink(ctx);
  const now = (deps.now ?? Date.now)();
  const hyp = getHypothesis(ctx.db, input.hypothesisId);
  if (!hyp) return { ok: false, mode: "not_found", reason: "hypothesis_not_found" };

  // «Ручной режим»: never auto-demote and publish workflow/skill files while manual.
  if (ctx.manualMode?.on()) {
    log.info(`evolve demotion skipped hyp=${hyp.id}: manual mode`);
    return { ok: false, mode: "manual_mode", reason: "manual_mode" };
  }

  const allows = currentLoopAllows(ctx, deps);
  if (!allows.run) return { ok: false, mode: "disabled", reason: "loop_off" };
  if (!allows.publish) return { ok: false, mode: "report_only", reason: "loop_report_mode" };

  const baselineRaw = deps.workflow
    ?? (await Promise.resolve().then(() => deps.loadWorkflow?.(hyp.workflowId)).catch(() => null))
    ?? null;
  if (!baselineRaw) return { ok: false, mode: "error", reason: "workflow_not_found" };

  const baselineLoaded = loadWorkflow(baselineRaw, { resolve: deps.resolveWorkflow });
  if (!baselineLoaded.ok) return { ok: false, mode: "error", reason: "invalid_baseline_workflow" };
  const baselineWorkflow = baselineLoaded.workflow;

  const variant = parseJsonObj(hyp.variantJson);
  if (!variant) return { ok: false, mode: "error", reason: "invalid_variant_json" };

  const currentNode = baselineWorkflow.nodes.find((n): n is GraphNode => n.type !== "note" && n.id === hyp.nodeId);
  const currentForm = currentNode && currentNode.type === "agent" ? (currentNode.form ?? "agent") : "agent";
  const draftStore = deps.draftStore ?? createDraftStore(ctx.db, deps.now);

  let draft = hyp.draftId ? draftStore.get(hyp.draftId) : null;
  if (!draft) {
    draft = draftStore.create({
      projectId: ctx.projectId ?? GLOBAL_SETTINGS_PROJECT_ID,
      threadId: null,
      scope: "global",
      name: baselineWorkflow.name,
      description: baselineWorkflow.description,
      workflowId: hyp.workflowId,
      definition: baselineRaw as RawDefinition,
      metadata: { source: "evolve", hypothesisId: hyp.id },
    });
  }

  const patched = draftStore.patch(
    draft.id,
    [{ op: "update_node", id: hyp.nodeId, set: variant }],
    { evolutionGate: true, source: "evolve", ...(deps.resolveWorkflow ? { validate: { resolve: deps.resolveWorkflow } } : {}) },
  );
  if (!patched.ok) {
    return { ok: false, mode: "error", reason: `patch_refused:${patched.reason}` };
  }

  issueEvolutionReceipt(ctx.db, {
    draftId: patched.draft.id,
    trialId: hyp.id,
    decision: "demote",
    now,
    log,
  });
  const pub = await runPublishPort(deps, { draftId: patched.draft.id });
  if (!pub.ok) {
    log.error(`evolve publish failed hyp=${hyp.id}: ${pub.message}`);
    return { ok: false, mode: "error", reason: pub.message };
  }

  setHypothesisState(
    ctx.db,
    { id: hyp.id, state: "promoted", draftId: patched.draft.id, reason: "demotion_fallback_over_20pct", now },
    log,
  );

  // Archive the brittle form variant that triggered >20% fallback so proposeHypotheses never re-proposes it.
  if (currentNode && currentNode.type === "agent" && (currentForm === "script" || currentForm === "plan")) {
    const brittleVariant: Record<string, unknown> = currentForm === "script"
      ? {
          form: "script",
          fallback: currentNode.fallback ?? (currentNode.plan !== undefined ? "plan" : "agent"),
          ...(currentNode.script !== undefined ? { script: currentNode.script } : {}),
        }
      : {
          form: "plan",
          fallback: currentNode.fallback ?? "agent",
          ...(currentNode.plan !== undefined ? { plan: currentNode.plan } : {}),
        };
    addNegative(ctx.db, {
      workflowId: hyp.workflowId,
      nodeId: hyp.nodeId,
      armKind: "form",
      variant: brittleVariant,
      graphVersion: hyp.graphVersion,
      reason: "fallback_over_20pct",
      now,
    });
    if (pub.version !== undefined && pub.version !== hyp.graphVersion) {
      addNegative(ctx.db, {
        workflowId: hyp.workflowId,
        nodeId: hyp.nodeId,
        armKind: "form",
        variant: brittleVariant,
        graphVersion: pub.version,
        reason: "fallback_over_20pct",
        now,
      });
    }
  }

  const nextForm = typeof variant.form === "string" ? variant.form : "agent";
  postOwnerItem(
    ctx.db,
    {
      key: `evolve:demote:${hyp.workflowId}:${hyp.nodeId}:${hyp.id}`,
      source: "evolve",
      kind: "evolve_demotion",
      reason: "decision",
      projectId: ownerProjectId(ctx.projectId),
      wake: false,
      what: `Шаг ${hyp.nodeId} в ${hyp.workflowId} возвращён на ${nextForm}: запасной путь срабатывал >20%`,
      why: `Fallback rate exceeded 20% for ${hyp.workflowId}.${hyp.nodeId}; demoted ${currentForm} -> ${nextForm} and archived brittle variant.`,
      evidence: [{ kind: "note", ref: hyp.id, label: `${hyp.workflowId}.${hyp.nodeId}: ${currentForm} -> ${nextForm}` }],
      actions: [],
    },
    now,
    log.warn,
  );
  log.info(`evolve decide hyp=${hyp.id} mode=demoted form=${nextForm}`);
  return { ok: true, mode: "demoted", draftId: patched.draft.id, version: pub.version };
}

/**
 * Decides the post-replay disposition for a hypothesis:
 * below 20/10 cases -> `report_only` with one owner item per graph;
 * above threshold -> open live canary trial (20% share).
 */
export async function decideHypothesis(
  ctx: DecideContext,
  deps: DecideDeps,
  input: { hypothesisId: string },
): Promise<DecideHypothesisResult> {
  const log = makeLogSink(ctx);
  const now = (deps.now ?? Date.now)();
  const hyp = getHypothesis(ctx.db, input.hypothesisId);
  if (!hyp) return { ok: false, mode: "not_found", reason: "hypothesis_not_found" };

  if (hyp.source === "fallback") {
    return applyDemotion(ctx, deps, input);
  }
  if (hyp.state === "promoted" || hyp.state === "retired" || hyp.state === "rejected") {
    return { ok: false, mode: hyp.state, reason: "already_terminal" };
  }

  const allows = currentLoopAllows(ctx, deps);
  if (!allows.run) return { ok: false, mode: "disabled", reason: "loop_off" };

  const counts = caseCounts(ctx.db, hyp.workflowId);
  const aboveThreshold = counts.heldOut >= EVOLVE_THRESHOLDS.heldOutMin && counts.working >= EVOLVE_THRESHOLDS.workingMin;

  if (!aboveThreshold || !allows.openTrials) {
    setHypothesisState(ctx.db, { id: hyp.id, state: "report_only", now }, log);
    syncEvolveOwnerItem(ctx.db, hyp.workflowId, { projectId: ctx.projectId, now, log });
    log.info(`evolve decide hyp=${hyp.id} mode=report_only counts=${counts.heldOut}/${counts.working}`);
    return { ok: true, mode: "report_only", counts };
  }

  if (!hyp.draftId) {
    return { ok: false, mode: "error", reason: "missing_draft" };
  }
  const existing = openTrialFor(ctx.db, hyp.workflowId);
  if (existing) {
    if (existing.hypothesisId === hyp.id) {
      return { ok: true, mode: "canary", trialId: existing.trialId, counts };
    }
    log.warn(`evolve decide deferred hyp=${hyp.id}: trial ${existing.trialId} already open for ${hyp.workflowId}`);
    return { ok: false, mode: "deferred", reason: "trial_already_open" };
  }

  const trial = openTrial(ctx.db, {
    hypothesisId: hyp.id,
    workflowId: hyp.workflowId,
    baselineVersion: hyp.graphVersion,
    candidateDraftId: hyp.draftId,
    share: EVOLVE_THRESHOLDS.canaryShare,
    now,
  });
  setHypothesisState(ctx.db, { id: hyp.id, state: "canary", now }, log);
  syncEvolveOwnerItem(ctx.db, hyp.workflowId, { projectId: ctx.projectId, now, log });
  log.info(`evolve decide hyp=${hyp.id} mode=canary counts=${counts.heldOut}/${counts.working}`);
  return { ok: true, mode: "canary", trialId: trial.trialId, counts };
}

function buildCanaryRow(
  db: LanePilotDatabase,
  row: TrialRunRow,
  deps: Pick<DecideDeps, "getRunVerdict" | "isHardRed">,
): CanaryRow {
  const verdictRow = deps.getRunVerdict?.(row.id) ?? null;
  const steps = wfStepsOfRun(db, row.id);
  const goalAudit = wfLastGoalAudit(db, row.id);
  const output = parseJsonObj(row.output_json);
  const finish = workflowFinish(output, finalRuleOf(row.definition_json));

  const stepHardFail = steps.some((s) => s.state === "failed" || s.verdict === "fail");
  const runHardFail = row.status === "failed" || row.status === "not_verified" || row.status === "blocked" || row.status === "interrupted";
  const goalHardFail = goalAudit?.verdict === "fail" || goalAudit?.verdict === "block";
  const verdictReject = verdictRow?.verdict === "reject";
  const hardRed = Boolean(deps.isHardRed?.(row) || verdictReject || stepHardFail || runHardFail || goalHardFail);
  const accepted = !hardRed && (verdictRow ? verdictRow.verdict === "accept" : row.status === "succeeded" && finish.ok);

  const costStates = steps.map((s) => s.cost_state).filter((cs): cs is string => typeof cs === "string" && cs.length > 0);
  let costMicroUsd: number | null = null;
  if (costStates.length > 0) {
    if (costStates.every((cs) => cs === "measured")) {
      costMicroUsd = steps.reduce((sum, s) => sum + (typeof s.cost_micro_usd === "number" ? s.cost_micro_usd : 0), 0);
    }
  } else if (row.cost_micro_usd > 0) {
    costMicroUsd = row.cost_micro_usd;
  }

  const stepMs = steps.reduce((sum, s) => sum + (typeof s.duration_ms === "number" ? s.duration_ms : 0), 0);
  const runMs = Math.max(0, row.updated_at - row.created_at);
  const seconds = (stepMs > 0 ? stepMs : runMs) / 1000;

  return {
    arm: row.arm === "new" ? "new" : "old",
    accepted,
    costMicroUsd,
    seconds,
    hardRed,
  };
}

/**
 * Evaluates an open canary trial on `WORKFLOW_RUN_FINISHED` (or verdict update) using anytime-valid
 * `decideCanary`, handling immediate rollback, retirement, and automatic promotion through the publish gate.
 */
export async function onCanaryRun(
  ctx: DecideContext,
  deps: DecideDeps,
  run: Pick<RunRow, "id" | "trial_id">,
): Promise<CanaryRunResult> {
  const trialId = run.trial_id?.trim();
  if (!trialId) return { handled: false, reason: "no_trial" };

  const trial = getTrial(ctx.db, trialId);
  if (!trial || trial.state !== "open") {
    return { handled: false, reason: trial ? `trial_${trial.state}` : "trial_not_found" };
  }

  const runs = wfTrialRuns(ctx.db, trial.trialId);
  if (runs.length === 0) return { handled: false, reason: "no_finished_runs" };

  const log = makeLogSink(ctx);
  const now = (deps.now ?? Date.now)();
  const rows = runs.map((r) => buildCanaryRow(ctx.db, r, deps));
  const decision = decideCanary(rows, deps.canaryConfig);
  log.info(`evolve canary trial=${trial.trialId} action=${decision.action} e=${decision.e.toFixed(2)}`);

  if (decision.action === "continue") {
    return { handled: true, action: "continue", trialId: trial.trialId, decision };
  }

  const hyp = getHypothesis(ctx.db, trial.hypothesisId);
  const detail = decision.notes.join("; ");

  if (decision.action === "rollback") {
    closeTrial(ctx.db, { trialId: trial.trialId, state: "rolled_back", reason: detail, now });
    if (hyp) {
      setHypothesisState(ctx.db, { id: hyp.id, state: "retired", reason: "canary_reject", now }, log);
      addNegative(ctx.db, {
        workflowId: hyp.workflowId,
        nodeId: hyp.nodeId,
        variantSignature: hyp.variantSignature,
        graphVersion: hyp.graphVersion,
        reason: "canary_reject",
        now,
      });
    }
    log.warn(`evolve rollback wf=${trial.workflowId} reason=canary_reject`);
    return { handled: true, action: "rollback", trialId: trial.trialId, decision };
  }

  if (decision.action === "retire") {
    closeTrial(ctx.db, { trialId: trial.trialId, state: "retired", reason: detail, now });
    if (hyp) {
      setHypothesisState(ctx.db, { id: hyp.id, state: "retired", reason: detail || "canary_retired", now }, log);
      addNegative(ctx.db, {
        workflowId: hyp.workflowId,
        nodeId: hyp.nodeId,
        variantSignature: hyp.variantSignature,
        graphVersion: hyp.graphVersion,
        reason: "canary_retired",
        now,
      });
    }
    return { handled: true, action: "retire", trialId: trial.trialId, decision };
  }

  // «Ручной режим»: never auto-promote a canary trial or write workflows/skills while manual.
  if (ctx.manualMode?.on()) {
    log.info(`evolve canary promote skipped trial=${trial.trialId}: manual mode`);
    return { handled: false, reason: "manual_mode" };
  }

  const allows = currentLoopAllows(ctx, deps);
  if (!allows.publish) {
    return { handled: false, reason: "publish_disabled_by_loop_mode" };
  }

  issueEvolutionReceipt(ctx.db, {
    draftId: trial.candidateDraftId,
    trialId: trial.trialId,
    decision: "promote",
    now,
    log,
  });
  const pub = await runPublishPort(deps, { draftId: trial.candidateDraftId });
  if (!pub.ok) {
    // Keep hypothesis in `canary` while closing the trial `retired` so no further canary traffic routes to it.
    log.error(`evolve publish failed hyp=${trial.hypothesisId}: ${pub.message}`);
    closeTrial(ctx.db, { trialId: trial.trialId, state: "retired", reason: `publish_failed: ${pub.message}`, now });
    return { handled: true, action: "promote_failed", trialId: trial.trialId, decision, error: pub.message };
  }

  closeTrial(ctx.db, { trialId: trial.trialId, state: "promoted", reason: detail, now });
  if (hyp) {
    setHypothesisState(ctx.db, { id: hyp.id, state: "promoted", reason: detail, now }, log);
  }
  return { handled: true, action: "promote", trialId: trial.trialId, decision, version: pub.version };
}
