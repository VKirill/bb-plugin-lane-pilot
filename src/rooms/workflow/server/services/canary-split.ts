import { randomUUID } from "node:crypto";
import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";
import { loadWorkflow, type ResolveWorkflow, type Workflow, type WorkflowStore } from "@lane-pilot/workflow-engine";
import { prepareLoopWorkflow, type LoopHookManifest } from "../../models/loop-hooks";

export type CanaryTrialTarget = {
  trialId: string;
  definition: Record<string, unknown>;
  share?: number | null | undefined;
};

export type ResolveCanary = (workflowId: string) => CanaryTrialTarget | null;

export type CanarySplitResult = {
  workflow: Workflow;
  resolve: ResolveWorkflow;
  runId?: string | undefined;
  arm?: "old" | "new" | undefined;
  trialId?: string | undefined;
};

export type CanarySplitLog = {
  debug?: ((message: string) => void) | undefined;
  warn: (message: string) => void;
};

/** Picks `new` when `hash(runId) / max < share`, else `old`. */
export function pickCanaryArm(runId: string, share: number): "old" | "new" {
  if (share <= 0) return "old";
  if (share >= 1) return "new";
  const ratio = parseInt(sha256Hex(runId).slice(0, 8), 16) / 0xffffffff;
  return ratio < share ? "new" : "old";
}

/**
 * Resolves an active canary trial for a top-level workflow start and picks `old` vs `new`.
 * Failures in the port or invalid candidate definitions log a warning and start the baseline.
 */
export function resolveCanarySplit(input: {
  workflow: Workflow;
  resolve: ResolveWorkflow;
  resolveCanary?: ResolveCanary | undefined;
  store?: Pick<WorkflowStore, "get" | "resolve"> | undefined;
  loopHooks?: { manifest: LoopHookManifest | null; sha256: string | null } | undefined;
  log: CanarySplitLog;
}): CanarySplitResult {
  const { workflow, resolve, resolveCanary, store, loopHooks, log } = input;
  if (!resolveCanary) return { workflow, resolve };

  let trial: CanaryTrialTarget | null = null;
  try {
    trial = resolveCanary(workflow.id);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.warn(`wf.start canary port failed wf=${workflow.id}: ${message}`);
    return { workflow, resolve };
  }
  if (!trial) return { workflow, resolve };

  const runId = `wfrun_${randomUUID().replaceAll("-", "")}`;
  const rawShare = trial.share;
  const share = typeof rawShare === "number" && Number.isFinite(rawShare) ? rawShare : EVOLVE_THRESHOLDS.canaryShare;
  const arm = pickCanaryArm(runId, share);

  if (arm === "old") {
    log.debug?.(`wf.start canary wf=${workflow.id} trial=${trial.trialId} arm=old`);
    return { workflow, resolve, runId, arm: "old", trialId: trial.trialId };
  }

  try {
    const loaded = loadWorkflow(trial.definition, { resolve });
    if (!loaded.ok) {
      const detail = loaded.problems.filter((problem) => problem.level === "error").map((problem) => problem.message).join("; ") || "invalid definition";
      log.warn(`wf.start canary port failed wf=${workflow.id}: candidate invalid (${detail})`);
      return { workflow, resolve };
    }
    const prepared = loopHooks?.manifest && store
      ? prepareLoopWorkflow({
          workflow: loaded.workflow,
          manifest: loopHooks.manifest,
          manifestSha256: loopHooks.sha256,
          resolve: store.resolve,
          status: (id, version) => {
            const item = store.get(id);
            return item && (version === undefined || item.workflow.version === version)
              ? { status: item.workflow.status, internal: item.workflow.internal, startedBy: item.workflow.startedBy }
              : null;
          },
        })
      : { workflow: loaded.workflow, resolve };
    log.debug?.(`wf.start canary wf=${workflow.id} trial=${trial.trialId} arm=new`);
    return {
      workflow: prepared.workflow,
      resolve: prepared.resolve,
      runId,
      arm: "new",
      trialId: trial.trialId,
    };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log.warn(`wf.start canary port failed wf=${workflow.id}: ${message}`);
    return { workflow, resolve };
  }
}
