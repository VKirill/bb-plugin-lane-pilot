import { closeRun, getAttempt, getRun, listOpenAttempts, openDatabase, releaseActivation } from "../database";
import { stringAt } from "./values";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
export function cancelRejection(db: ReturnType<typeof openDatabase>, attempt: NonNullable<ReturnType<typeof getAttempt>>): string | null {
  const run = getRun(db, attempt.run_id);
  if (!run || run.closed_at || (run.state !== "pending" && run.state !== "running")) {
    return `cancel is not legal for ${run?.state ?? "missing"} run`;
  }
  if (!["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(attempt.state)) {
    return `cancel is not legal from ${attempt.state}`;
  }
  return null;
}

export async function finishRunSafely(
  bb: BbPluginApi,
  db: ReturnType<typeof openDatabase>,
  projectId: string,
  runId: string,
  closedBy: "rpc" | "cli",
): Promise<void> {
  const run = getRun(db, runId);
  if (!run || run.project_id !== projectId) throw new Error("run does not belong to this project");
  if (run.closed_at) {
    releaseActivation(db, projectId, runId);
    return;
  }
  if (listOpenAttempts(db).some((attempt) => attempt.run_id === runId)) {
    throw new Error("running attempts remain; cancel them before finishing the run");
  }
  if (run.pm_thread_id) {
    const threads = bb.sdk.threads as typeof bb.sdk.threads & {
      listRunning?: (query?: Record<string, unknown>) => Promise<Array<{ id: string }>>;
    };
    if (typeof threads.listRunning !== "function") throw new Error("cannot verify PM status: threads.listRunning is unavailable");
    // A PM thread the user deleted has nothing left to observe; the run must still be closable.
    const isGone = (cause: unknown) => /\b404\b|not found/i.test(cause instanceof Error ? cause.message : String(cause));
    const existing = await threads.get({ threadId: run.pm_thread_id }).catch((cause: unknown) => { if (isGone(cause)) return null; throw cause; });
    if (existing !== null) {
      await threads.stop({ threadId: run.pm_thread_id });
      const info = await threads.get({ threadId: run.pm_thread_id });
      const status = stringAt(info, "status");
      if (status !== "idle" && status !== "error") {
        throw new Error(`cannot finish PM run: PM thread status is ${status ?? "unknown"}`);
      }
      const running = await threads.listRunning({});
      if (running.some((thread) => thread.id === run.pm_thread_id)) {
        throw new Error("cannot finish PM run: PM thread is still listed as running");
      }
    }
  }
  if (!closeRun(db, runId, closedBy)) throw new Error("running attempts remain; cancel them before finishing the run");
  releaseActivation(db, projectId, runId);
}
