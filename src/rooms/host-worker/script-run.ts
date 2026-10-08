import { spawn } from "node:child_process";
import { redactSecrets } from "@lane-pilot/kit";

/** What a scheduled script may print and keep: the whole answer of one run, per stream. */
export const SCRIPT_OUTPUT_DEFAULT_BYTES = 64 * 1024;
export const SCRIPT_OUTPUT_MAX_BYTES = 512 * 1024;
const KILL_GRACE_MS = 5_000;

/** The beginning and the end of a stream, with a note for what fell between: a script that fails says why at its end, and how it started at its beginning. */
export function createCapture(cap: number) {
  const headMax = Math.floor(cap / 4), tailMax = cap - headMax;
  let head = Buffer.alloc(0), tail = Buffer.alloc(0), dropped = 0;
  return {
    push(chunk: Buffer): void {
      let rest = chunk;
      if (head.length < headMax) {
        const take = Math.min(headMax - head.length, rest.length);
        head = Buffer.concat([head, rest.subarray(0, take)]);
        rest = rest.subarray(take);
      }
      if (!rest.length) return;
      tail = Buffer.concat([tail, rest]);
      if (tail.length > tailMax) { dropped += tail.length - tailMax; tail = tail.subarray(tail.length - tailMax); }
    },
    get truncated(): boolean { return dropped > 0; },
    text(): string { return dropped ? `${head.toString("utf8")}\n[... ${dropped} bytes cut ...]\n${tail.toString("utf8")}` : Buffer.concat([head, tail]).toString("utf8"); },
  };
}

export type ScriptRunInput = { requestedHostId: string; command: string; cwd: string; timeoutSec: number; env?: Record<string, string> | undefined; maxOutputBytes?: number | undefined };
export type ScriptRunResult = { hostId: string; exitCode: number; stdout: string; stderr: string; truncated: boolean; timedOut: boolean; durationMs: number };

/**
 * A scheduled script on this machine (the host-job kind `runScript`): `bash -lc <command>` in `cwd`, in its own process group so a
 * timeout ends everything it started. The secrets a task named arrive in `env` and are masked in what it printed; the output is
 * kept up to a size cap. Not sandboxed: the script is owner-approved text stored in Lane Pilot, and a sync or a deploy needs the machine.
 */
export async function runScriptOnHost(input: ScriptRunInput): Promise<ScriptRunResult> {
  const cap = Math.min(input.maxOutputBytes ?? SCRIPT_OUTPUT_DEFAULT_BYTES, SCRIPT_OUTPUT_MAX_BYTES);
  const out = createCapture(cap), err = createCapture(Math.max(8 * 1024, Math.floor(cap / 2)));
  const started = Date.now();
  const secrets = Object.values(input.env ?? {});
  const hostId = process.env.BB_HOST_ID ?? input.requestedHostId;
  return await new Promise<ScriptRunResult>((resolve) => {
    let timedOut = false, settled = false, launchError = "";
    let killTimer: NodeJS.Timeout | null = null;
    const child = spawn("/bin/bash", ["-lc", input.command], { cwd: input.cwd, env: { ...process.env, ...input.env }, detached: true, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const signal = (name: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, name); } catch { /* gone */ } };
    const timer = setTimeout(() => {
      timedOut = true;
      signal("SIGTERM");
      killTimer = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
    }, input.timeoutSec * 1000);
    const finish = (status: number | null, killedBy: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      const note = [launchError, timedOut ? `timed out after ${input.timeoutSec} s` : "", killedBy && !timedOut ? `killed by ${killedBy}` : ""].filter(Boolean).join("; ");
      const stderr = redactSecrets([err.text(), note].filter(Boolean).join("\n"), secrets);
      resolve({
        hostId, exitCode: timedOut ? 124 : status ?? (killedBy ? 128 : 1), stdout: redactSecrets(out.text(), secrets), stderr,
        truncated: out.truncated || err.truncated, timedOut, durationMs: Date.now() - started,
      });
    };
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (cause) => { launchError = cause.message; if (child.pid === undefined) finish(null, null); });
    child.on("close", (status, killedBy) => finish(status, killedBy));
    // A background process the script left running may hold its pipes: do not wait for them once the shell is gone.
    child.on("exit", (status, killedBy) => { setTimeout(() => finish(status, killedBy), 2_000).unref(); });
  });
}
