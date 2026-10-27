import { waitThreadIdle } from "@lane-pilot/thread-observe";
import type { StepContext } from "@lane-pilot/workflow-engine";
import { findThreadsByMetadata, graphStepMetadata, keyedSpawnSupported } from "../../core/server";
import type { ServerCore } from "../../core/server";
import { withUsage } from "../../usage/server";
import { outputText } from "../../writer/server";
import type { ChainRuntime } from "./workflow-runtime";

/**
 * One helper thread of a graph step, for the executors that wrap a night job (rules scan, wall hunt, harness edit): the spawn is a journal
 * effect (a step a reload cut off finds its thread again instead of starting a second one), the wait ends on BB's thread events, and the
 * thread is hidden and parentless unless the caller says otherwise, so it never wakes a PM chat. What the thread spent is returned in the
 * shape a step result carries.
 */
export type GraphHelperRun = { threadId: string; text: string; usage: Awaited<ReturnType<typeof withUsage>> };

export async function runGraphHelper(ctx: ServerCore, c: StepContext<ChainRuntime>, input: {
  /** Names the spawn within the step: one step may start several helpers, each with its own key. */
  key: string;
  /** Starts the thread with the metadata that ties it to this step; returns its id. */
  spawn: (graph: { spawnId: string; metadata: Record<string, unknown> }) => Promise<string>;
  /** The longest the thread may run before the step gives up on it (default: no limit, BB's events decide). */
  waitMs?: number;
  label: string;
  projectId: string | null;
  /** The thread is a record, not a conversation: archive it once its answer is read (or it failed), so it leaves the project's list. */
  archive?: boolean;
}): Promise<GraphHelperRun> {
  const { bb } = ctx;
  const spawnId = `${c.spawnKey}:${input.key}`;
  const stop = (): string | null => (ctx.isDisposed() ? "plugin_stopped" : c.signal.aborted ? "aborted" : null);
  const metadata = { ...graphStepMetadata({ runId: c.runId, stepKey: c.stepKey, nodeId: c.nodeId }), lanePilotWorkflowSpawn: spawnId };
  const started = await c.effect<{ threadId: string }>(`spawn:${input.key}`, "night.spawn", async () => ({ threadId: await input.spawn({ spawnId, metadata }) }), {
    intent: { spawnId },
    // A spawn the process died in is found again by its key (or by the metadata where the core has no keys); one that never happened is made.
    reconcile: async () => {
      if (keyedSpawnSupported(bb)) return { happened: false };
      const found = await findThreadsByMetadata(bb, { lanePilotWorkflowRunId: c.runId, lanePilotWorkflowStep: c.stepKey, lanePilotWorkflowSpawn: spawnId }, input.projectId ?? undefined);
      if (!found) return null;
      return found[0] ? { happened: true, result: { threadId: found[0].id } } : { happened: false };
    },
  });
  try {
    await waitThreadIdle(bb, started.threadId, input.label, input.waitMs, undefined, stop);
    const text = outputText(await bb.sdk.threads.output({ threadId: started.threadId }));
    return { threadId: started.threadId, text, usage: await withUsage(bb, started.threadId) };
  } catch (cause) {
    await bb.sdk.threads.stop({ threadId: started.threadId }).catch(() => undefined);
    // A helper that failed or was cut off still spent: the error carries what, and the engine charges the run for it.
    const spent = await withUsage(bb, started.threadId).catch(() => ({} as Awaited<ReturnType<typeof withUsage>>));
    if (spent.usage && cause instanceof Error) (cause as Error & { usage?: unknown }).usage = spent.usage;
    throw cause;
  } finally {
    // A reload ends the step where it stands and the next instance reads the thread again: only a step that ends here archives it.
    if (input.archive && !ctx.isDisposed()) await bb.sdk.threads.archive({ threadId: started.threadId }).catch(() => undefined);
  }
}

/** What several helper runs of one step spent, as the step result carries it (`unknown` when any of them reported none). */
export function sumUsage(runs: ReadonlyArray<Pick<GraphHelperRun, "threadId" | "usage">>): Awaited<ReturnType<typeof withUsage>> {
  const usages = runs.flatMap((run) => (run.usage.usage ? [run.usage.usage] : []));
  if (!runs.length || !usages.length) return {};
  return {
    usage: { tokens: usages.reduce((sum, row) => sum + row.tokens, 0), costUsd: usages.reduce((sum, row) => sum + row.costUsd, 0), ...(usages.some((row) => row.unknown) ? { unknown: true as const } : {}) },
    threadId: runs[0]!.threadId,
  };
}
