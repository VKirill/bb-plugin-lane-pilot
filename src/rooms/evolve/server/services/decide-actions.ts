import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import { createDraftStore } from "@lane-pilot/workflow-engine";
import { caseCounts } from "../repositories/case-repository";
import {
  addNegative,
  closeTrial,
  getHypothesis,
  listHypotheses,
  openTrial,
  openTrialFor,
  setHypothesisState,
} from "../repositories/ledger-repository";
import { makeLogSink } from "./context";
import { syncEvolveOwnerItem } from "./decide-owner-item";
import {
  POST_PROMOTION_WINDOW_MS,
  grantOwnerForEvolve,
  runPublishPort,
  type DecideContext,
  type DecideDeps,
  type OwnerDecisionResult,
  type PostPromotionResult,
  type PostPromotionVerdictInput,
  type RollbackEvolutionResult,
} from "./decide-shared";

/**
 * Rolls back a promoted hypothesis on the first owner `reject` verdict on a run of the promoted version
 * within 14 days of promotion, retiring the hypothesis and archiving `post_promotion_reject`.
 */
export async function onPostPromotionVerdict(
  ctx: DecideContext,
  deps: DecideDeps,
  input: PostPromotionVerdictInput,
): Promise<PostPromotionResult> {
  if (input.verdict !== "reject" || input.source !== "owner") {
    return { rolledBack: false, reason: "not_owner_reject" };
  }

  const log = makeLogSink(ctx);
  const verdictAt = input.decidedAt ?? (deps.now ?? Date.now)();
  const promoted = listHypotheses(ctx.db, { workflowId: input.workflowId, state: "promoted" })
    .slice()
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  if (promoted.length === 0) return { rolledBack: false, reason: "no_promoted_hypothesis" };

  const draftStore = deps.draftStore ?? createDraftStore(ctx.db, deps.now);
  const match = promoted.find((hyp) => {
    if (hyp.decidedAt === null) return false;
    if (verdictAt < hyp.decidedAt || verdictAt > hyp.decidedAt + POST_PROMOTION_WINDOW_MS) return false;
    const draft = hyp.draftId ? draftStore.get(hyp.draftId) : null;
    if (draft?.publishedVersion != null) return input.graphVersion === draft.publishedVersion;
    return input.graphVersion >= hyp.graphVersion;
  });

  if (!match) return { rolledBack: false, reason: "outside_window_or_version_mismatch" };
  if (!match.draftId || !deps.rollbackDraft) {
    return { rolledBack: false, reason: "rollback_port_or_draft_missing" };
  }

  let rb: RollbackEvolutionResult;
  try {
    rb = await deps.rollbackDraft({ draftId: match.draftId });
  } catch (cause) {
    rb = { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
  if (!rb.ok) {
    log.error(`evolve publish failed hyp=${match.id}: rollback failed: ${rb.message}`);
    return { rolledBack: false, reason: rb.message };
  }

  setHypothesisState(ctx.db, { id: match.id, state: "retired", reason: "post_promotion_reject", now: verdictAt }, log);
  addNegative(ctx.db, {
    workflowId: match.workflowId,
    nodeId: match.nodeId,
    variantSignature: match.variantSignature,
    graphVersion: match.graphVersion,
    reason: "post_promotion_reject",
    now: verdictAt,
  });
  log.warn(`evolve rollback wf=${match.workflowId} reason=post_promotion_reject`);
  return { rolledBack: true, hypothesisId: match.id };
}

/** Owner approval path (`bb lane-pilot evolve approve <hypothesisId>`): opens canary if counts allow, else publishes directly. */
export async function approveHypothesis(
  ctx: DecideContext,
  deps: DecideDeps,
  input: { hypothesisId: string },
): Promise<OwnerDecisionResult> {
  const log = makeLogSink(ctx);
  const now = (deps.now ?? Date.now)();
  const hyp = getHypothesis(ctx.db, input.hypothesisId);
  if (!hyp) return { ok: false, reason: "hypothesis_not_found" };
  if (hyp.state === "promoted" || hyp.state === "retired" || hyp.state === "rejected") {
    return { ok: false, reason: `already_${hyp.state}` };
  }
  if (hyp.state === "canary") return { ok: false, reason: "already_in_canary" };
  if (!hyp.draftId) return { ok: false, reason: "missing_draft" };

  const counts = caseCounts(ctx.db, hyp.workflowId);
  const countsAllowCanary = counts.heldOut >= EVOLVE_THRESHOLDS.heldOutMin && counts.working >= EVOLVE_THRESHOLDS.workingMin;
  if (countsAllowCanary) {
    const existing = openTrialFor(ctx.db, hyp.workflowId);
    if (existing && existing.hypothesisId !== hyp.id) {
      return { ok: false, reason: "trial_already_open" };
    }
    const trial = existing ?? openTrial(ctx.db, {
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
    return { ok: true, mode: "canary", trialId: trial.trialId };
  }

  grantOwnerForEvolve(ctx.db, hyp.draftId, "cli", { now, log });
  const pub = await runPublishPort(deps, { draftId: hyp.draftId, ownerGrant: true });
  if (!pub.ok) {
    log.error(`evolve publish failed hyp=${hyp.id}: ${pub.message}`);
    return { ok: false, reason: pub.message };
  }
  setHypothesisState(ctx.db, { id: hyp.id, state: "promoted", reason: "owner_approve", now }, log);
  syncEvolveOwnerItem(ctx.db, hyp.workflowId, { projectId: ctx.projectId, now, log });
  return { ok: true, mode: "promoted", version: pub.version };
}

/** Owner rejection path (`bb lane-pilot evolve reject <hypothesisId>`): marks rejected and archives `owner_reject`. */
export function rejectHypothesis(
  ctx: DecideContext,
  deps: Pick<DecideDeps, "now">,
  input: { hypothesisId: string },
): OwnerDecisionResult {
  const log = makeLogSink(ctx);
  const now = (deps.now ?? Date.now)();
  const hyp = getHypothesis(ctx.db, input.hypothesisId);
  if (!hyp) return { ok: false, reason: "hypothesis_not_found" };
  if (hyp.state === "promoted" || hyp.state === "retired" || hyp.state === "rejected") {
    return { ok: false, reason: `already_${hyp.state}` };
  }
  if (hyp.state === "canary") {
    const existing = openTrialFor(ctx.db, hyp.workflowId);
    if (existing && existing.hypothesisId === hyp.id) {
      closeTrial(ctx.db, { trialId: existing.trialId, state: "rolled_back", reason: "owner_reject", now });
    }
  }
  setHypothesisState(ctx.db, { id: hyp.id, state: "rejected", reason: "owner_reject", now }, log);
  addNegative(ctx.db, {
    workflowId: hyp.workflowId,
    nodeId: hyp.nodeId,
    variantSignature: hyp.variantSignature,
    graphVersion: hyp.graphVersion,
    reason: "owner_reject",
    now,
  });
  syncEvolveOwnerItem(ctx.db, hyp.workflowId, { projectId: ctx.projectId, now, log });
  return { ok: true, mode: "rejected" };
}
