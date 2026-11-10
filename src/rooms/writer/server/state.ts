import { PROVIDER_CAPABILITIES, providerLimitNotice, usageProviderOf, zcodeBlock } from "@lane-pilot/models";
import { createProviderBreaker, createRunBudget, parseRunBudgetLimits, type RunBudget } from "@lane-pilot/resilience";
import { RunWriterPool } from "../../tasks";
import { createProviderUsage, parseBreakdown, tokenCursorRow, usageSkipPercent } from "../../usage/server";
import { attemptThreadsOfRun } from "../../storage";
import { createProviderRetryGuard } from "../../stability/server";
import { createConcurrencyLimit } from "./concurrency-limit";
import { CATALOG_WAIT_MS, modelCatalogOf, noteProviderLimit, registerSpawnUsage, threadModelOf, within, zcodeBusy, zcodeBusyPeek } from "../../platform/server";
import { onThreadFailure } from "@lane-pilot/thread-observe";
;
import type { ServerCore } from "../../contracts/server";
import { bestEffort } from "@lane-pilot/kit";

/** State shared by the writer modules: the live task set, the provider pool, the provider breaker and one budget per run. */
export function createWriterState(ctx: ServerCore) {
  const activeWriterTasks = new Set<string>();

  const runWriterPool = new RunWriterPool();

  /** Opens for a provider/model after repeated provider failures; poor work never trips it. */
  const providerBreaker = createProviderBreaker();

  /** Provider usage windows read from BB's usage sources; a writer pair whose window is nearly spent is skipped, never failed. */
  // ZCode (the Mac mini's app) has no usage window: it is held when the machine has no zcode provider, outside its free hours, or while one of our threads works on it.
  const providerUsage = createProviderUsage(ctx.bb, Date.now, async ({ hostId, settings }) => zcodeBlock({
    settings, hostId, now: Date.now(), busy: await zcodeBusy(ctx.bb),
    catalog: await bestEffort(ctx.log, "writer model catalog", within(modelCatalogOf(ctx).get(), CATALOG_WAIT_MS), null),
  }));
  // The helpers' resolver (resolveSpawnModel) reads the same cache, under the same threshold, to move a table pick off a nearly spent provider.
  // A usage source may list a provider's quota under a router's own id (Gemini through 9router on OpenCode v2), so both are read.
  registerSpawnUsage(ctx.bb, {
    peek: (query) => {
      const base = { model: query.model, hostId: query.hostId ?? "", threshold: usageSkipPercent(query.settings) };
      const router = usageProviderOf(query.providerId, query.model);
      return providerUsage.peek({ ...base, providerId: query.providerId }) ?? (router ? providerUsage.peek({ ...base, providerId: router }) : null);
    },
    zcodeBusy: () => zcodeBusyPeek(ctx.bb),
    warm: (query) => providerUsage.warm({
      providerIds: [...new Set([...query.providerIds, ...query.providerIds.flatMap((id) => {
        const router = PROVIDER_CAPABILITIES[id]?.usageProviderId;
        return router ? [router] : [];
      })])],
      hostId: query.hostId ?? "",
    }),
  });

  // Any helper thread Lane Pilot waits for that fails on its provider's limit takes that provider off every later pick for a while (spawn-model.ts).
  onThreadFailure(ctx.bb, (threadId, detail) => {
    const notice = providerLimitNotice(detail.replace(/^provider_error:/, "").slice(0, 400));
    const pair = notice ? threadModelOf(ctx.bb, threadId) : null;
    if (!notice || !pair) return;
    const hold = noteProviderLimit(ctx.bb, pair.providerId, pair.model, notice);
    ctx.bb.log.warn(`Lane Pilot: ${pair.providerId}/${pair.model} hit a provider limit (${notice}); helper picks skip it for ${hold / 60_000} min`);
  });

  /** Cancels the retry BB's provider-retry queued in a writer thread once the task moved on to another writer. */
  const providerRetry = createProviderRetryGuard(ctx.bb);

  /** BB's concurrency-limit plugin: how many writers a host may run; null without the plugin. */
  const concurrencyLimit = createConcurrencyLimit(ctx.bb);

  const runBudgets = new Map<string, RunBudget>();

  /** The budget of a run, created from its effective settings the first time a writer starts there. */
  function runBudgetFor(runId: string, settings: Record<string, unknown>): RunBudget {
    let limits = {};
    try { limits = parseRunBudgetLimits(settings); } catch (cause) { ctx.log(`Lane Pilot run ${runId}: budget settings ignored: ${cause instanceof Error ? cause.message : String(cause)}`); }
    let budget = runBudgets.get(runId);
    if (budget) {
      // A raised (or lowered) run.max_* applies to the live run, over the same recorded spend — without this the
      // limit of a stopped run could never be lifted (sma ac_pocket).
      if (JSON.stringify(budget.snapshot().limits) !== JSON.stringify(limits)) budget.setLimits(limits);
    } else {
      budget = createRunBudget(limits);
      // After a plugin reload the in-memory budget starts at zero while BB already settled spend on the run's
      // threads: re-seed each attempt thread's recorded total so the dispatch reserve counts real tokens
      // (sma as_effect_observe).
      for (const threadId of attemptThreadsOfRun(ctx.db, runId)) {
        const cursor = tokenCursorRow(ctx.db, threadId);
        if (cursor) budget.noteTokens(threadId, parseBreakdown(cursor.total_json).total);
      }
      runBudgets.set(runId, budget);
    }
    return budget;
  }

  return { activeWriterTasks, runWriterPool, providerBreaker, providerUsage, providerRetry, concurrencyLimit, runBudgets, runBudgetFor };
}

export type WriterStateApi = ReturnType<typeof createWriterState>;
