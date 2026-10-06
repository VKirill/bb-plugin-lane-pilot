import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { HOST_JOB_KINDS, hostContract, type HostJobKind } from "./contracts";

/**
 * Background jobs on a host (B4). The host daemon cancels a call at its deadline and SIGKILLs the plugin worker five
 * seconds later with every other call in it; a long npm ci, a 40 s stack detect or a browser run must not be inside
 * that call. jobStart launches the work in its own detached process and answers at once; jobStatus and jobCancel are
 * ordinary short host calls. Nothing here changes the host-daemon protocol.
 *
 * A job lives in <root>/<jobId>/: job.json (what runs, its pid), input.json, log.txt (the process's output),
 * heartbeat (touched every few seconds), result.json (written last, by the process) and cancelled (a marker).
 */
export type JobOptions = {
  /** Folder of all jobs; ~/.lane-pilot/jobs by default. */
  root?: string;
  /** The module whose default export holds the host handlers: this bundle. A test passes a small module instead. */
  hostModuleUrl?: string;
};

export type JobState = "running" | "succeeded" | "failed" | "cancelled" | "lost";

export type JobStatus = {
  state: JobState;
  progress: { startedAt: number; updatedAt: number; elapsedSec: number; lastLine: string };
  result?: unknown;
  error: string | null;
};

type JobMeta = { jobId: string; kind: HostJobKind; startedAt: number; timeoutSec: number; pid: number | null };
type JobResult = { ok: true; value: unknown } | { ok: false; error: string };

const JOB_ID = /^job_[a-z0-9]{10,40}$/;
const HEARTBEAT_MS = 5_000;
/** A job whose heartbeat stopped this long ago is gone even if its pid was reused. */
const HEARTBEAT_STALE_MS = 120_000;
const KEEP_FINISHED_MS = 3 * 24 * 3600_000;

export const jobsRoot = (options: JobOptions = {}) => options.root ?? join(homedir(), ".lane-pilot", "jobs");

function jobDir(jobId: string, options: JobOptions): string {
  if (!JOB_ID.test(jobId)) throw new Error(`invalid job id: ${jobId}`);
  return join(jobsRoot(options), jobId);
}

/**
 * What the detached process runs: it loads the host handlers, runs the one the job names with the job's input and
 * writes result.json last. Plain JavaScript on purpose: it is handed to `node -e`, so it imports only node modules.
 */
const RUNNER = `
import { readFileSync, writeFileSync, renameSync } from "node:fs";
const [moduleUrl, dir] = process.argv.slice(1);
const job = JSON.parse(readFileSync(dir + "/job.json", "utf8"));
const input = JSON.parse(readFileSync(dir + "/input.json", "utf8"));
const beat = () => { try { writeFileSync(dir + "/heartbeat", String(Date.now())); } catch {} };
beat();
setInterval(beat, ${HEARTBEAT_MS}).unref();
const done = (body) => {
  writeFileSync(dir + "/result.json.tmp", JSON.stringify(body));
  renameSync(dir + "/result.json.tmp", dir + "/result.json");
};
setTimeout(() => {
  done({ ok: false, error: "job timed out after " + job.timeoutSec + " s" });
  try { process.kill(-process.pid, "SIGTERM"); } catch {}
  process.exit(1);
}, job.timeoutSec * 1000).unref();
try {
  const handler = (await import(moduleUrl)).default?.handlers?.[job.kind];
  if (typeof handler !== "function") throw new Error("the host module has no handler " + job.kind);
  const ac = new AbortController();
  done({ ok: true, value: await handler(input, { signal: ac.signal, lifecycle: { signal: ac.signal } }) });
} catch (cause) {
  console.error(cause);
  done({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
}
process.exit(0);
`;

async function readJson<T>(path: string): Promise<T | null> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch { return null; }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(`${path}.tmp`, JSON.stringify(value));
  await rename(`${path}.tmp`, path);
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function lastLine(path: string): Promise<string> {
  const handle = await open(path, "r").catch(() => null);
  if (!handle) return "";
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, 2048);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean).at(-1)?.slice(0, 300) ?? "";
  } finally { await handle.close(); }
}

/** Removes the folders of jobs that ended days ago; a running job's folder is never touched. */
async function pruneJobs(options: JobOptions): Promise<void> {
  for (const name of await readdir(jobsRoot(options)).catch(() => [] as string[])) {
    if (!JOB_ID.test(name)) continue;
    const dir = join(jobsRoot(options), name);
    const meta = await readJson<JobMeta>(join(dir, "job.json"));
    const started = meta?.startedAt ?? (await stat(dir).catch(() => null))?.mtimeMs ?? Date.now();
    if (Date.now() - started > KEEP_FINISHED_MS && !(meta?.pid && alive(meta.pid))) await rm(dir, { recursive: true, force: true });
  }
}

/** Starts the job and returns its id at once; the work runs in a detached process of its own. */
export async function startHostJob(
  request: { kind: HostJobKind; input: Record<string, unknown>; timeoutSec: number },
  options: JobOptions = {},
): Promise<string> {
  if (!HOST_JOB_KINDS.includes(request.kind)) throw new Error(`host job kind not supported: ${request.kind}`);
  // The same validation the daemon applies to a direct call: a malformed input fails here, not inside the process.
  const input = hostContract[request.kind].input.parse(request.input);
  await pruneJobs(options).catch(() => undefined);
  const jobId = `job_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
  const dir = jobDir(jobId, options);
  await mkdir(dir, { recursive: true });
  const meta: JobMeta = { jobId, kind: request.kind, startedAt: Date.now(), timeoutSec: request.timeoutSec, pid: null };
  await writeJson(join(dir, "job.json"), meta);
  await writeJson(join(dir, "input.json"), input);
  const log = openSync(join(dir, "log.txt"), "a");
  try {
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", RUNNER, options.hostModuleUrl ?? import.meta.url, dir], {
      cwd: dir, detached: true, stdio: ["ignore", log, log], windowsHide: true,
    });
    child.on("error", (cause) => {
      void writeJson(join(dir, "result.json"), { ok: false, error: `job process could not start: ${cause.message}` } satisfies JobResult);
    });
    child.unref();
    if (child.pid) await writeJson(join(dir, "job.json"), { ...meta, pid: child.pid });
  } finally { closeSync(log); }
  return jobId;
}

export async function hostJobStatus(jobId: string, options: JobOptions = {}): Promise<JobStatus> {
  const dir = jobDir(jobId, options);
  const meta = await readJson<JobMeta>(join(dir, "job.json"));
  if (!meta) return { state: "lost", progress: { startedAt: 0, updatedAt: 0, elapsedSec: 0, lastLine: "" }, error: "no such job" };
  const now = Date.now();
  const line = await lastLine(join(dir, "log.txt"));
  const progress = (updatedAt: number) => ({ startedAt: meta.startedAt, updatedAt, elapsedSec: Math.max(0, Math.round((updatedAt - meta.startedAt) / 1000)), lastLine: line });
  const result = await readJson<JobResult>(join(dir, "result.json"));
  if (result) {
    const finished = (await stat(join(dir, "result.json")).catch(() => null))?.mtimeMs ?? now;
    if (!result.ok) return { state: "failed", progress: progress(finished), error: result.error };
    // The daemon checks a direct call's output against the contract; a job's output gets the same check.
    const output = hostContract[meta.kind].output.safeParse(result.value);
    return output.success
      ? { state: "succeeded", progress: progress(finished), result: output.data, error: null }
      : { state: "failed", progress: progress(finished), error: `host output for ${meta.kind} is invalid: ${output.error.message.slice(0, 300)}` };
  }
  const beat = (await stat(join(dir, "heartbeat")).catch(() => null))?.mtimeMs ?? meta.startedAt;
  if (await stat(join(dir, "cancelled")).catch(() => null)) return { state: "cancelled", progress: progress(beat), error: "cancelled" };
  const running = meta.pid ? alive(meta.pid) : now - meta.startedAt < 10_000;
  if (running && now - beat < HEARTBEAT_STALE_MS) return { state: "running", progress: { ...progress(now), updatedAt: beat }, error: null };
  return { state: "lost", progress: progress(beat), error: "the job process is gone without a result" };
}

/** Stops a running job and everything it started (the job process leads its own process group). */
export async function cancelHostJob(jobId: string, options: JobOptions = {}): Promise<boolean> {
  const dir = jobDir(jobId, options);
  const meta = await readJson<JobMeta>(join(dir, "job.json"));
  const ended = await Promise.all(["result.json", "cancelled"].map((name) => stat(join(dir, name)).then(() => true, () => false)));
  if (!meta || ended.some(Boolean)) return false;
  await writeFile(join(dir, "cancelled"), String(Date.now()));
  const pid = meta.pid;
  if (!pid || pid <= 1) return true;
  const signal = (name: NodeJS.Signals) => { try { process.kill(-pid, name); } catch { /* already gone */ } };
  signal("SIGTERM");
  setTimeout(() => signal("SIGKILL"), 5_000).unref();
  return true;
}
