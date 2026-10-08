import { HOST_JOB_KINDS, type HostJobKind } from "@lane-pilot/contracts";
import { sha256Hex } from "@lane-pilot/kit";

type RawCall = (method: string, input: unknown, options: { hostId: string; timeoutMs?: number; signal?: AbortSignal }) => Promise<unknown>;
type JobKv = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void>; delete(key: string): Promise<void> };
type JobStatusReply = { state: "running" | "succeeded" | "failed" | "cancelled" | "lost"; result?: unknown; error: string | null; progress: { updatedAt: number } };
type JobEntry = { jobId: string; hostId: string; startedAt: number };

export const isHostJobKind = (method: string): method is HostJobKind => (HOST_JOB_KINDS as readonly string[]).includes(method);

/** The least a job may be waited for: its caller's own call timeout was sized for a call, not for the work behind it. */
const MIN_WAIT_MS: Partial<Record<HostJobKind, number>> = {
  detect: 180_000, install: 600_000, rollback: 600_000, snapshot: 600_000, importConfig: 600_000, connectOpencode: 600_000,
  coexistenceOperation: 600_000, coexistenceInventory: 180_000, gitIntegrate: 900_000, gitPrepareWorktree: 900_000, gateRun: 600_000, gateBisect: 600_000,
};
/** Slack on top of a caller's own limit (runSandboxedCommand, runBrowserQa): the job's start-up is not the check's time. */
const START_SLACK_MS = 60_000;
/** A job that ended this long ago is not the answer to a call made now (a restart finds the entry of an old check). */
const REUSE_FINISHED_MS = 10 * 60_000;
const POLL_FIRST_MS = 500;
const POLL_MAX_MS = 10_000;

/**
 * A host call run as a background job: jobStart returns at once, jobStatus is polled with backoff, and the job's id
 * is kept in KV until the answer is taken. A plugin reload or restart loses the poll loop, not the job: the same
 * call made again finds the id and carries on from there. `directCall` is the ordinary host call, used when the host
 * runs an older plugin build without jobs.
 */
export function createHostJobs(deps: {
  call: RawCall; kv: JobKv; disposed: () => boolean; log?: (message: string) => void;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((wake) => setTimeout(wake, ms)));
  const status = async (hostId: string, jobId: string) => await deps.call("jobStatus", { requestedHostId: hostId, jobId }, { hostId, timeoutMs: 20_000 }) as JobStatusReply;

  return {
    async run(kind: HostJobKind, input: unknown, options: { hostId: string; timeoutMs?: number; signal?: AbortSignal }, directCall: () => Promise<unknown>, jobKey?: string): Promise<unknown> {
      const { hostId } = options;
      const key = `host-job:${kind}:${hostId}:${sha256Hex(JSON.stringify(input)).slice(0, 24)}${jobKey ? `:${sha256Hex(jobKey).slice(0, 16)}` : ""}`;
      // A check's verdict is of one moment: a finished one is taken again only by the call that named it (same jobKey, e.g. after
      // a reload), never by a later call whose input happens to be identical (a second merge's post-merge check).
      const takeFinished = kind !== "runSandboxedCommand" || Boolean(jobKey);
      const minWait = MIN_WAIT_MS[kind] ?? 0;
      const waitMs = Math.max(options.timeoutMs ?? 0, minWait) + (minWait ? 0 : START_SLACK_MS);
      let entry = await deps.kv.get<JobEntry>(key);
      let last: JobStatusReply | null = null;
      if (entry) {
        // A host that cannot answer keeps the entry: the caller's retry finds the job again instead of starting a second one.
        last = await status(entry.hostId, entry.jobId);
        const reusable = last.state === "running" || (takeFinished && (last.state === "succeeded" || last.state === "failed") && now() - last.progress.updatedAt <= REUSE_FINISHED_MS);
        if (!reusable) { await deps.kv.delete(key); entry = undefined; last = null; }
        else deps.log?.(`lane-pilot: host ${kind} picked up job ${entry.jobId} (${last.state})`);
      }
      if (!entry) {
        let jobId: string;
        try {
          ({ jobId } = await deps.call("jobStart", { requestedHostId: hostId, kind, input, timeoutSec: Math.ceil(waitMs / 1000) + 30 }, { hostId, timeoutMs: 30_000 }) as { jobId: string });
        } catch (cause) {
          if (/unknown host method/i.test(cause instanceof Error ? cause.message : String(cause))) return await directCall();
          throw cause;
        }
        entry = { jobId, hostId, startedAt: now() };
        await deps.kv.set(key, entry);
      }
      const deadline = entry.startedAt + waitMs;
      let delay = POLL_FIRST_MS;
      for (;;) {
        if (deps.disposed()) throw new Error(`host ${kind} job ${entry.jobId} is still running; the plugin is reloading`);
        // The caller's run was aborted: stop polling. The job goes on at the host, and the same call made again finds it by its key.
        options.signal?.throwIfAborted();
        const reply = last ?? await status(entry.hostId, entry.jobId);
        last = null;
        if (reply.state !== "running") {
          await deps.kv.delete(key);
          if (reply.state === "succeeded") return reply.result;
          // A failed job keeps the handler's own message: callers classify failures by it.
          throw new Error(reply.state === "failed" ? reply.error ?? `host ${kind} failed` : `host ${kind} job ${reply.state}: ${reply.error ?? "no detail"}`);
        }
        if (now() > deadline) {
          await deps.call("jobCancel", { requestedHostId: hostId, jobId: entry.jobId }, { hostId, timeoutMs: 20_000 }).catch(() => undefined);
          await deps.kv.delete(key);
          throw new Error(`host ${kind} timed out after ${Math.round(waitMs / 1000)} s (job ${entry.jobId} cancelled)`);
        }
        await sleep(delay);
        delay = Math.min(Math.round(delay * 1.5), POLL_MAX_MS);
      }
    },
  };
}
