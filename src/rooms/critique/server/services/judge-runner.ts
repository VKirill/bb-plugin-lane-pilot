import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { bestEffort, isNotFound, orMiss, stringAt } from "@lane-pilot/kit";
import { bbServiceTier, findModelIn, listedServiceTier, writerExecutionSelection } from "@lane-pilot/models";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import type { Pair } from "../../models/critic-pair";
import type { JudgeVerdict } from "../../models/judge-verdict";
import { fullAccessSpawn } from "../../../platform/server";
import { helperChildPlacement, requireHelperSpawn, requiredPolicyField } from "../../../runs/server";
import type { openDatabase } from "../../../storage";

export type JudgeStepInput<TResult> = {
  prompt: string;
  pluginMetadata: Record<string, unknown>;
  /** Custom wait+read hook for threads (like browser-qa) that observe via observeStageChild with a deadline. */
  awaitCustom?: (threadId: string) => Promise<TResult>;
  parse?: (threadId: string, raw: string) => Promise<TResult> | TResult;
};

export type HelperRunOptions<TResult> = {
  bb: BbPluginApi;
  db: ReturnType<typeof openDatabase>;
  projectId: string;
  runId: string;
  hostId?: string;
  role: string;
  /** Role passed to requiredPolicyField when different from role (e.g. code-verifier -> code-critic). */
  policyRole?: Parameters<typeof requiredPolicyField>[3];
  /** Role passed to helperChildPlacement when different from role. */
  placementRole?: string;
  taskTitle: string;
  pairs: readonly Pair[];
  effort: string;
  tier: "fast" | "standard";
  /** Bypass providers.list / providers.models checks when the caller already validated the execution agent. */
  checkCatalog?: boolean;
  /** Default true when checkCatalog is true. */
  checkEffort?: boolean;
  /** Drop unsupported service tier to null instead of throwing (verifier peer compatibility). */
  coerceUnsupportedTier?: boolean;
  /** Direct service tier passed to writerExecutionSelection when checkCatalog is false. */
  directServiceTier?: Parameters<typeof writerExecutionSelection>[3];
  errorPrefix: string;
  timeoutCode: string;
  stopLabel?: string;
  /** Default true: stop still-active spawned threads on error. Browser QA handles thread stops inside awaitQaVerdict so reloads leave live threads alone. */
  stopOnError?: boolean;
  extraCapabilities?: Parameters<typeof requiredPolicyField>[4];
  placement?: Awaited<ReturnType<typeof helperChildPlacement>>;
  helperPolicy?: ReturnType<typeof requireHelperSpawn>;
  environment:
    | { type: "host"; hostId: string; workspace: { type: "unmanaged"; path: string } }
    | { type: "sandbox" }
    | { type: "reuse"; environmentId: string }
    | Record<string, unknown>;
  stepsForRound: (ctx: {
    pair: Pair;
    round: number;
    helperPolicy: ReturnType<typeof requireHelperSpawn>;
  }) => Array<JudgeStepInput<TResult>>;
  onAttemptStart?: (ctx: { pair: Pair; round: number }) => void;
  onThreadSpawned?: (ctx: { threadId: string; pair: Pair; round: number; stepIndex: number }) => void;
  isRetryable?: (cause: unknown, message: string) => boolean;
  onAbort?: (ctx: { cause: unknown; reason: string; pair: Pair; round: number; threadId: string | null }) => void | Promise<void>;
};

export type HelperRunResult<TResult> =
  | {
    status: "ok";
    pair: Pair;
    round: number;
    threadIds: string[];
    raws: string[];
    results: TResult[];
    placement: Awaited<ReturnType<typeof helperChildPlacement>>;
    helperPolicy: ReturnType<typeof requireHelperSpawn>;
  }
  | {
    status: "exhausted";
    lastError: string;
    lastPair: Pair;
    pairs: readonly Pair[];
  };

export type JudgeRunResult<TResult> =
  | (Extract<HelperRunResult<TResult>, { status: "ok" }> & { verdict: JudgeVerdict; ms: number })
  | (Extract<HelperRunResult<TResult>, { status: "exhausted" }> & { verdict: "not_run"; ms: number });

/** Log one structured debug line per judge invocation with its normalized closed verdict and elapsed runtime. */
export function logJudgeVerdict(bb: BbPluginApi, role: string, verdict: JudgeVerdict, startMs: number): number {
  const ms = Math.max(0, Date.now() - startMs);
  const log = bb.log as { debug?: (msg: string) => void } | undefined;
  log?.debug?.(`judge.run role=${role} verdict=${verdict} ms=${ms}`);
  return ms;
}

/** Best-effort stop for a spawned judge/helper thread that is still starting or active on failure. */
export async function stopActiveThread(bb: BbPluginApi, threadId: string | null, stopLabel = "critique thread stop"): Promise<void> {
  if (!threadId) return;
  const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound);
  const status = stringAt(thread, "status");
  if (status === "active" || status === "starting") {
    await bestEffort(bb.log, stopLabel, bb.sdk.threads.stop({ threadId }), undefined);
  }
}

async function resolvePairServiceTier<TResult>(options: HelperRunOptions<TResult>, pair: Pair): Promise<Parameters<typeof writerExecutionSelection>[3]> {
  if (options.checkCatalog === false) return options.directServiceTier ?? null;
  if (!options.hostId) throw new Error(`${options.errorPrefix}_host_id_missing`);
  const [providers, catalog] = await Promise.all([
    options.bb.sdk.providers.list({ hostId: options.hostId }),
    options.bb.sdk.providers.models({ providerId: pair.providerId, hostId: options.hostId }),
  ]);
  const provider = providers.find((row) => row.id === pair.providerId && row.available);
  const model = findModelIn(catalog.models, pair.model);
  if (!provider || !model) throw new Error(`${options.errorPrefix}_provider_or_model_unavailable`);
  if (options.checkEffort !== false && !model.supportedReasoningEfforts.some((item) => item.reasoningEffort === options.effort)) {
    throw new Error(`${options.errorPrefix}_reasoning_effort_unsupported:${options.effort}`);
  }
  const listed = listedServiceTier(provider, bbServiceTier(options.tier));
  if (listed && !(provider.serviceTiers ?? []).some((item) => item.id === listed)) {
    if (options.coerceUnsupportedTier) return null;
    throw new Error(`${options.errorPrefix}_service_tier_unsupported:${listed}`);
  }
  return listed;
}

/**
 * Shared spawn + wait + output reader for critic, verifier, browser-QA and pm-read helper threads.
 * Checks model availability/effort/tier, allocates child placement, runs each sequential step, stops live threads on failure, and rotates across fallback pairs on retryable errors.
 */
export async function runHelperPrompt<TResult>(options: HelperRunOptions<TResult>): Promise<HelperRunResult<TResult>> {
  let lastError = "critic pool exhausted";
  let lastPair = options.pairs[0]!;
  for (const [round, pair] of options.pairs.entries()) {
    lastPair = pair;
    options.onAttemptStart?.({ pair, round });
    let activeThreadId: string | null = null;
    try {
      const serviceTier = await resolvePairServiceTier(options, pair);
      const helperPolicy = options.helperPolicy ?? requireHelperSpawn({
        bb: options.bb,
        db: options.db,
        projectId: options.projectId,
        runId: options.runId,
      });
      const placement = options.placement ?? await helperChildPlacement({
        bb: options.bb,
        db: options.db,
        projectId: options.projectId,
        runId: options.runId,
        role: options.placementRole ?? options.role,
        taskTitle: options.taskTitle,
      });
      const steps = options.stepsForRound({ pair, round, helperPolicy });
      const threadIds: string[] = [];
      const raws: string[] = [];
      const results: TResult[] = [];
      const policyRole = (options.policyRole ?? options.placementRole ?? options.role) as Parameters<typeof requiredPolicyField>[3];
      for (const [stepIndex, step] of steps.entries()) {
        const spawned = await fullAccessSpawn(options.bb, {
          ...placement,
          ...requiredPolicyField(options.bb, helperPolicy, pair.providerId, policyRole, options.extraCapabilities),
          ...writerExecutionSelection(pair.providerId, pair.model, options.effort, serviceTier),
          prompt: step.prompt,
          environment: options.environment,
          pluginMetadata: step.pluginMetadata,
        } as Parameters<typeof fullAccessSpawn>[1]);
        const threadId = stringAt(spawned, "id");
        if (!threadId) throw new Error(`${options.errorPrefix}_thread_id_missing`);
        activeThreadId = threadId;
        threadIds.push(threadId);
        options.onThreadSpawned?.({ threadId, pair, round, stepIndex });
        if (step.awaitCustom) {
          results.push(await step.awaitCustom(threadId));
          raws.push("");
        } else {
          await waitThreadIdle(options.bb, threadId, options.timeoutCode);
          const raw = (await options.bb.sdk.threads.output({ threadId })).output;
          if (typeof raw !== "string" || !raw.trim()) throw new Error(`${options.errorPrefix}_output_empty`);
          raws.push(raw);
          results.push(step.parse ? await step.parse(threadId, raw) : (raw as TResult));
        }
        activeThreadId = null;
      }
      return { status: "ok", pair, round, threadIds, raws, results, placement, helperPolicy };
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      if (options.stopOnError !== false) await stopActiveThread(options.bb, activeThreadId, options.stopLabel);
      if (options.isRetryable?.(cause, reason)) {
        lastError = reason;
        continue;
      }
      await options.onAbort?.({ cause, reason, pair, round, threadId: activeThreadId });
      throw cause;
    }
  }
  return { status: "exhausted", lastError, lastPair, pairs: options.pairs };
}

/**
 * The one judge runner used by every critic, specialist reviewer, code verifier and browser QA judge.
 * Runs through `runHelperPrompt`, maps outcomes to `JUDGE_VERDICTS` (`pass|rework|block|not_run`), and emits `judge.run role=… verdict=… ms=…`.
 */
export async function runJudge<TResult>(
  options: HelperRunOptions<TResult> & {
    toVerdict: (results: TResult[], raws: string[]) => JudgeVerdict;
  },
): Promise<JudgeRunResult<TResult>> {
  const startMs = Date.now();
  try {
    const out = await runHelperPrompt(options);
    if (out.status === "exhausted") {
      const ms = logJudgeVerdict(options.bb, options.role, "not_run", startMs);
      return { ...out, verdict: "not_run", ms };
    }
    const verdict = options.toVerdict(out.results, out.raws);
    const ms = logJudgeVerdict(options.bb, options.role, verdict, startMs);
    return { ...out, verdict, ms };
  } catch (cause) {
    logJudgeVerdict(options.bb, options.role, "not_run", startMs);
    throw cause;
  }
}
