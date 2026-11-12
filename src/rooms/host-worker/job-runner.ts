import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExperimentalHostRpcHandlers } from "@get-bb/plugin-sdk";
import type { hostContract, HostJobKind } from "../contracts";
import { coexistenceInventory, coexistenceOperation, connectOpencode, detect, install, rollback, snapshot } from "./handlers/stack";
import { gateAttribute, gateBisect, gateRun, gitIntegrate, gitPrepareWorktree } from "./handlers/git";
import { runSandboxedCommand, runScript } from "./handlers/exec";
import { runBrowserQa } from "./handlers/desktop";

/**
 * What a detached host job is: `node <host bundle> --lane-pilot-host-job <job dir>` (jobs.ts spawns it).
 * The bundle is the entry file because the plugin ships as one host.mjs on the machine.
 */
export const HOST_JOB_ARG = "--lane-pilot-host-job";

const HEARTBEAT_MS = 5_000;

export type HostJobHandlers = { [K in HostJobKind]: ExperimentalHostRpcHandlers<typeof hostContract>[K] };
type JobHandler = (input: Record<string, unknown>, context: { signal: AbortSignal; lifecycle: { signal: AbortSignal } }) => Promise<unknown>;

/** The work a host job can run: the same functions the host entry answers the wire with, one per job kind. */
export const HOST_JOB_HANDLERS: HostJobHandlers = {
  detect,
  install,
  rollback,
  snapshot,
  connectOpencode,
  coexistenceOperation,
  coexistenceInventory,
  gitIntegrate,
  gitPrepareWorktree,
  runSandboxedCommand,
  runBrowserQa,
  gateRun,
  gateBisect,
  gateAttribute,
  runScript,
};

type JobMeta = { kind: string; timeoutSec: number; scrubInput?: boolean };
type JobResult = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * The job process's whole protocol: read the folder jobs.ts staged, run the kind's handler, write result.json
 * last. The heartbeat file tells jobStatus it is alive; the timeout ends the process group and the exit code.
 * Returns the exit code (the caller does process.exit): 1 only when the job's own time ran out.
 */
export async function runJobProcess(
  dir: string,
  handlers: HostJobHandlers = HOST_JOB_HANDLERS,
  deps: { killGroup?: (signal: NodeJS.Signals) => unknown } = {},
): Promise<number> {
  const killGroup = deps.killGroup ?? ((signal: NodeJS.Signals) => { try { process.kill(-process.pid, signal); } catch { /* already gone */ } });
  const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")) as JobMeta;
  const input = JSON.parse(readFileSync(join(dir, "input.json"), "utf8")) as Record<string, unknown>;
  if (job.scrubInput) { try { unlinkSync(join(dir, "input.json")); } catch { /* best effort */ } }
  const beat = () => { try { writeFileSync(join(dir, "heartbeat"), String(Date.now())); } catch { /* best effort */ } };
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();
  const done = (body: JobResult) => {
    writeFileSync(join(dir, "result.json.tmp"), JSON.stringify(body));
    renameSync(join(dir, "result.json.tmp"), join(dir, "result.json"));
  };
  return await new Promise<number>((resolve) => {
    const limit = setTimeout(() => {
      done({ ok: false, error: `job timed out after ${job.timeoutSec} s` });
      killGroup("SIGTERM");
      resolve(1);
    }, job.timeoutSec * 1000);
    limit.unref();
    (async () => {
      try {
        const handler = (handlers as unknown as Record<string, JobHandler>)[job.kind];
        if (typeof handler !== "function") throw new Error(`the host module has no handler ${job.kind}`);
        const ac = new AbortController();
        done({ ok: true, value: await handler(input, { signal: ac.signal, lifecycle: { signal: ac.signal } }) });
      } catch (cause) {
        console.error(cause);
        done({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
      }
      clearTimeout(limit);
      resolve(0);
    })();
  });
}
