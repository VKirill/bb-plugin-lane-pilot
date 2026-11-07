import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync } from "node:fs";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_JOB_KINDS, hostContract, type HostJobKind } from "../contracts";
import { bestEffort, isFsAbsent, orMiss, readTextOrNull, sha256Hex, statOrNull } from "@lane-pilot/kit";
import { HOST_JOB_ARG } from "./job-runner";

/**
 * Background jobs on a host (B4). The host daemon cancels a call at its deadline and SIGKILLs the plugin worker five
 * seconds later with every other call in it; a long npm ci, a 40 s stack detect or a browser run must not be inside
 * that call. jobStart launches the work in its own detached process and answers at once; jobStatus and jobCancel are
 * ordinary short host calls. Nothing here changes the host-daemon protocol.
 *
 * A job lives in <root>/<jobId>/: job.json (what runs, its pid), input.json, log.txt (the process's output),
 * heartbeat (touched every few seconds), result.json (written last, by the process) and cancelled (a marker).
 * The process is the host bundle itself run as `node <bundle> --lane-pilot-host-job <dir>`; job-runner.ts holds
 * the protocol and the handler table.
 */
export type JobOptions = {
  /** Folder of all jobs; ~/.lane-pilot/jobs by default. */
  root?: string;
  /** The file the job process executes: this bundle in production; a test passes its own runner file. */
  entryFile?: string;
};

export type JobState = "running" | "succeeded" | "failed" | "cancelled" | "lost";

export type JobStatus = {
  state: JobState;
  progress: { startedAt: number; updatedAt: number; elapsedSec: number; lastLine: string };
  result?: unknown;
  error: string | null;
};

type JobMeta = { jobId: string; kind: HostJobKind; startedAt: number; timeoutSec: number; pid: number | null; key?: string; scrubInput?: boolean };
/** Kinds whose input carries secret values: the runner deletes input.json once it has read it. */
const SCRUB_INPUT: readonly HostJobKind[] = ["runScript"];
type JobResult = { ok: true; value: unknown } | { ok: false; error: string };

const JOB_ID = /^job_[a-z0-9]{10,40}$/;
/** A job whose heartbeat stopped this long ago is gone even if its pid was reused. */
const HEARTBEAT_STALE_MS = 120_000;
const KEEP_FINISHED_MS = 3 * 24 * 3600_000;

export const jobsRoot = (options: JobOptions = {}) => options.root ?? join(homedir(), ".lane-pilot", "jobs");

function jobDir(jobId: string, options: JobOptions): string {
  if (!JOB_ID.test(jobId)) throw new Error(`invalid job id: ${jobId}`);
  return join(jobsRoot(options), jobId);
}

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
  const handle = await orMiss(open(path, "r"), null, isFsAbsent);
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
  for (const name of await orMiss(readdir(jobsRoot(options)), [] as string[], isFsAbsent)) {
    if (!JOB_ID.test(name)) continue;
    const dir = join(jobsRoot(options), name);
    try {
      const meta = await readJson<JobMeta>(join(dir, "job.json"));
      const started = meta?.startedAt ?? (await statOrNull(dir))?.mtimeMs ?? Date.now();
      if (Date.now() - started > KEEP_FINISHED_MS && !(meta?.pid && alive(meta.pid))) await rm(dir, { recursive: true, force: true });
    } catch (cause) {
      console.warn(`lane-pilot: job prune skipped ${dir}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
}

/** Starts the job and returns its id at once; the work runs in a detached process of its own. */
export async function startHostJob(
  request: { kind: HostJobKind; input: Record<string, unknown>; timeoutSec: number; key?: string },
  options: JobOptions = {},
): Promise<string> {
  if (!HOST_JOB_KINDS.includes(request.kind)) throw new Error(`host job kind not supported: ${request.kind}`);
  if (!request.key) {
    const jobId = await stageJob(request, options);
    await spawnJob(jobId, options);
    return jobId;
  }
  return await startKeyedJob({ ...request, key: request.key }, options);
}

const EMPTY_CLAIM_STALE_MS = 60_000;

const keyFile = (key: string, options: JobOptions) => join(jobsRoot(options), "keys", `${sha256Hex(key).slice(0, 32)}.id`);

/**
 * The id a key file holds, or null to retry the claim: the file is absent, or held a stale id and is now removed.
 * A winner that took the file but has not written its id yet gets a short grace; a stale file is removed only when
 * it still holds the same id a rival could not have claimed in the meantime — never a rival's fresh claim.
 */
async function keyedJobId(file: string, options: JobOptions): Promise<string | null> {
  // An empty file is a claim still staging; under load staging can take seconds, so it is waited out until it is
  // older than EMPTY_CLAIM_STALE_MS (a crashed claimant) — never removed just because the wait ran out.
  let content = "";
  let seen: FileId | null = null;
  for (;;) {
    content = (await readTextOrNull(file) ?? "").trim();
    const info = await statOrNull(file);
    if (info) seen = { mtimeMs: info.mtimeMs, ino: info.ino };
    if (content) break;
    const age = info ? Date.now() - info.mtimeMs : Infinity;
    // Absent: a rival removed the stale file and the next `open` claims it. Removing "the empty file" here would
    // race that rival's fresh empty claim (it can appear between the read and the remove) and lose its job.
    if (age === Infinity) return null;
    if (age >= EMPTY_CLAIM_STALE_MS) break;
    await new Promise((wake) => setTimeout(wake, 100));
  }
  if (JOB_ID.test(content) && await stat(jobDir(content, options)).then(() => true, () => false)) return content;
  await removeIfStill(file, content, seen);
  return null;
}

const STALE_LOCK_MS = 30_000;
/** Which file a removal decision was made about: content alone cannot tell a stale empty claim from a rival's fresh one. */
type FileId = { mtimeMs: number; ino: number };

/**
 * Removes the key file only while it is still the file `seen` (same mtime and inode) and still holds `stale`.
 * Removal happens under a per-key lock directory, so no other remover can swap the file between the check and the
 * rm; the identity check is what tells a stale empty claim from a rival's fresh empty claim that replaced it.
 */
export async function removeIfStill(file: string, stale: string, seen: FileId | null): Promise<void> {
  const lock = `${file}.lock`;
  for (;;) {
    try { await mkdir(lock); break; } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
      const age = await stat(lock).then((info) => Date.now() - info.mtimeMs, () => 0);
      if (age >= STALE_LOCK_MS) await rm(lock, { recursive: true, force: true });
      else await new Promise((wake) => setTimeout(wake, 20));
    }
  }
  try {
    const info = await statOrNull(file);
    const same = seen !== null && info !== null && info.mtimeMs === seen.mtimeMs && info.ino === seen.ino;
    if (same && (await readTextOrNull(file))?.trim() === stale) await rm(file, { force: true });
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/**
 * One logical job per key: the first start takes the key file exclusively, then stages, writes its id and launches;
 * a second start with the same key, also after a crash between the launch and the caller recording the id, gets the
 * first job's id. A key whose job folder was pruned is free again.
 */
async function startKeyedJob(
  request: { kind: HostJobKind; input: Record<string, unknown>; timeoutSec: number; key: string },
  options: JobOptions,
): Promise<string> {
  const file = keyFile(request.key, options);
  await mkdir(join(jobsRoot(options), "keys"), { recursive: true });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const handle = await open(file, "wx").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "EEXIST") return null;
      throw cause;
    });
    if (handle) {
      const jobId = await stageJob(request, options).catch(async (cause) => {
        await handle.close();
        await rm(file, { force: true });
        throw cause;
      });
      await handle.writeFile(jobId);
      await handle.close();
      await spawnJob(jobId, options);
      return jobId;
    }
    const existing = await keyedJobId(file, options);
    if (existing) return existing;
  }
  throw new Error(`could not claim job key ${request.key}`);
}

/** Writes the job's folder: job.json and input.json. The same validation as a direct call, here not inside the process. */
async function stageJob(
  request: { kind: HostJobKind; input: Record<string, unknown>; timeoutSec: number; key?: string },
  options: JobOptions,
): Promise<string> {
  const input = hostContract[request.kind].input.parse(request.input);
  await bestEffort(console.warn, "host job prune", pruneJobs(options), undefined);
  const jobId = `job_${Date.now().toString(36)}${randomBytes(5).toString("hex")}`;
  const dir = jobDir(jobId, options);
  await mkdir(dir, { recursive: true });
  const meta: JobMeta = { jobId, kind: request.kind, startedAt: Date.now(), timeoutSec: request.timeoutSec, pid: null,
    ...(request.key ? { key: request.key } : {}), ...(SCRUB_INPUT.includes(request.kind) ? { scrubInput: true } : {}) };
  await writeJson(join(dir, "job.json"), meta);
  await writeJson(join(dir, "input.json"), input);
  return jobId;
}

/** Detaches the job process on a staged folder: the host bundle run as its own job runner. */
async function spawnJob(jobId: string, options: JobOptions): Promise<void> {
  const dir = jobDir(jobId, options);
  const log = openSync(join(dir, "log.txt"), "a");
  try {
    const child = spawn(process.execPath, ["--no-warnings", options.entryFile ?? fileURLToPath(import.meta.url), HOST_JOB_ARG, dir], {
      cwd: dir, detached: true, stdio: ["ignore", log, log], windowsHide: true,
    });
    child.on("error", (cause) => {
      void writeJson(join(dir, "result.json"), { ok: false, error: `job process could not start: ${cause.message}` } satisfies JobResult);
    });
    child.unref();
    const meta = await readJson<JobMeta>(join(dir, "job.json"));
    if (child.pid && meta) await writeJson(join(dir, "job.json"), { ...meta, pid: child.pid });
  } finally { closeSync(log); }
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
    const finished = (await statOrNull(join(dir, "result.json")))?.mtimeMs ?? now;
    if (!result.ok) return { state: "failed", progress: progress(finished), error: result.error };
    // The daemon checks a direct call's output against the contract; a job's output gets the same check.
    const output = hostContract[meta.kind].output.safeParse(result.value);
    return output.success
      ? { state: "succeeded", progress: progress(finished), result: output.data, error: null }
      : { state: "failed", progress: progress(finished), error: `host output for ${meta.kind} is invalid: ${output.error.message.slice(0, 300)}` };
  }
  const beat = (await statOrNull(join(dir, "heartbeat")))?.mtimeMs ?? meta.startedAt;
  if (await statOrNull(join(dir, "cancelled"))) return { state: "cancelled", progress: progress(beat), error: "cancelled" };
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
