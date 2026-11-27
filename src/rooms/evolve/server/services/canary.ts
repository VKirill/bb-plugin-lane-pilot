import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import { createDraftStore, type DraftStore, type RawDefinition } from "@lane-pilot/workflow-engine";
import type { LanePilotDatabase } from "../../../storage";
import type { EvolveLogSink } from "../repositories/case-repository";
import { openTrialFor, type EvolveLedgerDb } from "../repositories/ledger-repository";

export type CanaryCandidate = {
  trialId: string;
  definition: RawDefinition;
  share: number;
};

/**
 * Resolves the open canary trial and its candidate draft definition for a workflow.
 * Returns `null` when no trial is open or the candidate draft is missing.
 */
export function resolveCanary(
  db: EvolveLedgerDb & LanePilotDatabase,
  workflowId: string,
  options: { draftStore?: DraftStore; log?: EvolveLogSink } = {},
): CanaryCandidate | null {
  const trial = openTrialFor(db, workflowId);
  if (!trial) return null;
  const draftStore = options.draftStore ?? createDraftStore(db);
  const draft = draftStore.get(trial.candidateDraftId);
  if (!draft) {
    options.log?.warn?.(`evolve canary draft missing wf=${workflowId} trial=${trial.trialId} draft=${trial.candidateDraftId}`);
    return null;
  }
  const share = Number.isFinite(trial.share) && trial.share > 0 && trial.share <= 1
    ? trial.share
    : EVOLVE_THRESHOLDS.canaryShare;
  return {
    trialId: trial.trialId,
    definition: draft.definition,
    share,
  };
}
