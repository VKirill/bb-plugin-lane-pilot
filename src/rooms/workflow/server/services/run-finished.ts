import { LP_EVENTS } from "@lane-pilot/contracts";
import { TERMINAL_RUN, wfCountRunEvents, wfRunRow, type RunRow } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../../contracts/server";
import { isInternalUpkeep } from "../../models/internal-workflows";
import type { WorkflowTriggersApi } from "./workflow-triggers-live";

export type RunFinishedSubscriber = (run: RunRow) => void | Promise<void>;

type TriggersLike = Pick<WorkflowTriggersApi["workflowTriggers"], "emitEvent">;

export interface RunFinishedDeps {
  triggers: TriggersLike | (() => TriggersLike | undefined);
  subscribers: ReadonlyArray<RunFinishedSubscriber>;
}

type RunFinishedCtx = Pick<ServerCore, "db" | "log"> & {
  bb?: { log?: { debug?: (message: string) => void; warn?: (message: string) => void } };
};

/**
 * Emits `LP_EVENTS.WORKFLOW_RUN_FINISHED` once per terminal transition of a non-upkeep top-level run
 * and fans out fire-and-forget subscriber callbacks (including upkeep runs) without failing the run.
 */
export function createRunFinished(ctx: RunFinishedCtx, deps: RunFinishedDeps) {
  const handled = new Set<string>();
  const logDebug = (message: string) => {
    if (ctx.bb?.log?.debug) ctx.bb.log.debug(message);
    else ctx.log(message);
  };
  const logWarn = (message: string) => {
    if (ctx.bb?.log?.warn) ctx.bb.log.warn(message);
    else ctx.log(message);
  };

  return function onRunEvent(runId: string): Promise<void> {
    const run = wfRunRow(ctx.db, runId);
    if (!run || run.parent_run_id || !TERMINAL_RUN.includes(run.status)) return Promise.resolve();
    const transition = wfCountRunEvents(ctx.db, run.id, "run");
    const transitionKey = `${run.id}:${transition}`;
    if (handled.has(transitionKey)) return Promise.resolve();
    if (handled.size >= 2000) handled.delete(handled.values().next().value!);
    handled.add(transitionKey);

    const subscriberPromises = deps.subscribers.map((subscriber) =>
      Promise.resolve()
        .then(() => subscriber(run))
        .catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          logWarn(`wf.finished subscriber failed run=${run.id}: ${message}`);
        }),
    );

    const triggers = typeof deps.triggers === "function" ? deps.triggers() : deps.triggers;
    const shouldEmit = !isInternalUpkeep(run.workflow_id) && Boolean(triggers);
    logDebug(`wf.finished run=${run.id} wf=${run.workflow_id} status=${run.status} emitted=${shouldEmit}`);

    let emitPromise: Promise<unknown> = Promise.resolve();
    if (shouldEmit && triggers) {
      try {
        emitPromise = Promise.resolve(
          triggers.emitEvent(
            LP_EVENTS.WORKFLOW_RUN_FINISHED,
            {
              runId: run.id,
              workflowId: run.workflow_id,
              status: run.status,
              graphVersion: run.workflow_version,
              projectId: run.project_id,
            },
            {
              id: `wf-finished:${run.id}:${transition}`,
              key: run.workflow_id,
              projectId: run.project_id ?? undefined,
            },
          ),
        ).catch((cause: unknown) => {
          const message = cause instanceof Error ? cause.message : String(cause);
          logWarn(`wf.finished emit failed run=${run.id}: ${message}`);
        });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        logWarn(`wf.finished emit failed run=${run.id}: ${message}`);
      }
    }

    return Promise.all([...subscriberPromises, emitPromise]).then(() => undefined);
  };
}
