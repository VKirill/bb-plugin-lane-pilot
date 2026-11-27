import {
  EVOLVE_THRESHOLDS,
  evolveLoopAllows,
  type EvolutionReceipt,
  type EvolutionReceiptDecision,
  type LoopMode,
  type PublishGrant,
  type PublishGrantVia,
  type RunVerdict,
} from "@lane-pilot/contracts";
import type { ManualMode } from "../../../contracts";
import {
  insertEvolutionPublishReceipt,
  insertOwnerPublishGrant,
  type DraftStore,
  type RawDefinition,
  type RunRow,
  type TrialRunRow,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { readLoopMode, type LanePilotDatabase } from "../../../storage";
import type { CanaryConfig, CanaryDecision } from "../../models/trial";
import type { CaseCounts, EvolveLogSink } from "../repositories/case-repository";

export const POST_PROMOTION_WINDOW_MS = 14 * 86_400_000;
export { EVOLVE_THRESHOLDS };

export type DecideContext = {
  db: LanePilotDatabase;
  bb?: unknown;
  projectId?: string | null | undefined;
  settings?: Record<string, unknown> | undefined;
  log?: EvolveLogSink | ((message: string) => void) | undefined;
  manualMode?: Pick<ManualMode, "on"> | undefined;
};

export type PublishEvolutionResult = {
  ok: boolean;
  projectId?: string | undefined;
  message: string;
  version?: number | undefined;
};

export type RollbackEvolutionResult = {
  ok: boolean;
  projectId?: string | undefined;
  message: string;
};

export type DecideDeps = {
  draftStore?: DraftStore | undefined;
  now?: (() => number) | undefined;
  workflow?: RawDefinition | Workflow | null | undefined;
  loadWorkflow?: ((workflowId: string) => RawDefinition | Workflow | null | Promise<RawDefinition | Workflow | null>) | undefined;
  resolveWorkflow?: ((id: string, version?: number) => Workflow | null) | undefined;
  publishDraft?: ((input: { draftId: string; ownerGrant?: boolean; threadId?: string }) => Promise<PublishEvolutionResult> | PublishEvolutionResult) | undefined;
  rollbackDraft?: ((input: { draftId: string; threadId?: string }) => Promise<RollbackEvolutionResult> | RollbackEvolutionResult) | undefined;
  getRunVerdict?: ((runId: string) => { verdict: RunVerdict; source: string; reason: string | null; decidedAt: number } | null) | undefined;
  isHardRed?: ((run: TrialRunRow | RunRow) => boolean) | undefined;
  canaryConfig?: Partial<CanaryConfig> | undefined;
  loopMode?: LoopMode | undefined;
};

export type DecideHypothesisResult =
  | { ok: true; mode: "report_only"; counts: CaseCounts }
  | { ok: true; mode: "canary"; trialId: string; counts: CaseCounts }
  | { ok: true; mode: "demoted"; draftId: string; version?: number | undefined }
  | { ok: false; mode: string; reason: string };

export type CanaryRunResult =
  | { handled: false; reason: string }
  | { handled: true; action: CanaryDecision["action"] | "promote_failed"; trialId: string; decision: CanaryDecision; version?: number | undefined; error?: string | undefined };

export type PostPromotionVerdictInput = {
  runId: string;
  workflowId: string;
  graphVersion: number;
  verdict: RunVerdict;
  source: string;
  decidedAt?: number | undefined;
};

export type PostPromotionResult =
  | { rolledBack: true; hypothesisId: string }
  | { rolledBack: false; reason: string };

export type OwnerDecisionResult =
  | { ok: true; mode: "promoted" | "canary" | "rejected"; trialId?: string | undefined; version?: number | undefined }
  | { ok: false; reason: string };

export function currentLoopAllows(ctx: DecideContext, deps: DecideDeps) {
  const mode = deps.loopMode ?? readLoopMode(ctx.db, "evolve", ctx.projectId);
  const allows = evolveLoopAllows(mode);
  // «Ручной режим»: automatic promotion/demotion/trial opening never runs on its own while manual.
  if (ctx.manualMode?.on()) {
    return { mode, ...allows, publish: false, openTrials: false };
  }
  return { mode, ...allows };
}

export function issueEvolutionReceipt(
  db: LanePilotDatabase,
  input: {
    draftId: string;
    trialId: string;
    decision: EvolutionReceiptDecision;
    now?: number;
    log?: EvolveLogSink | ((message: string) => void);
  },
): EvolutionReceipt | null {
  const receipt = insertEvolutionPublishReceipt(db, input);
  if (receipt) {
    const line = `publish authority kind=evolution draft=${input.draftId} sha=${receipt.draftSha256.slice(0, 8)}`;
    if (typeof input.log === "function") input.log(`INFO ${line}`);
    else input.log?.info?.(line);
  }
  return receipt;
}

export function grantOwnerForEvolve(
  db: LanePilotDatabase,
  draftId: string,
  via: PublishGrantVia,
  options: { now?: number; log?: EvolveLogSink | ((message: string) => void) } = {},
): PublishGrant | null {
  const grant = insertOwnerPublishGrant(db, draftId, via, { now: options.now });
  if (grant) {
    const line = `publish authority kind=owner draft=${draftId} sha=${grant.draftSha256.slice(0, 8)}`;
    if (typeof options.log === "function") options.log(`INFO ${line}`);
    else options.log?.info?.(line);
  }
  return grant;
}

export async function runPublishPort(
  deps: DecideDeps,
  input: { draftId: string; ownerGrant?: boolean },
): Promise<PublishEvolutionResult> {
  if (!deps.publishDraft) {
    return { ok: false, message: "publishDraft port is not configured" };
  }
  try {
    return await deps.publishDraft(input);
  } catch (cause) {
    return { ok: false, message: cause instanceof Error ? cause.message : String(cause) };
  }
}
