import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, stat, readFile, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex } from "@lane-pilot/kit";
import { cancelHostJob, hostJobStatus, removeIfStill, startHostJob, type JobOptions, type JobStatus } from "../src/rooms/host-worker/jobs";

const execFileAsync = promisify(execFile);

/**
 * A stand-in for the host bundle: an executable runner like the real one (host-worker/job-runner.ts), whose
 * `detect` handler does what the workspace path asks. The job process runs it as `node <file> <arg> <dir>`.
 */
const FIXTURE = `
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
const HANDLERS = {
  detect: async (input, context) => {
    if (input.workspacePath === "/fail") throw new Error("boom: " + input.requestedHostId);
    if (input.workspacePath === "/slow") { console.log("waiting for the slow part"); await new Promise((wake) => setTimeout(wake, 60000)); }
    console.log("detect ran");
    return {
      hostId: input.requestedHostId, laneStack: { present: true, version: typeof context.signal, sourceSha: null }, openCode: { present: false, version: null },
      workspace: { path: input.workspacePath, present: true }, targetSha: "t", matchesTarget: false, scenario: "S3",
    };
  },
};
if (process.argv[2] === "--lane-pilot-host-job") {
const dir = process.argv[3];
const job = JSON.parse(readFileSync(dir + "/job.json", "utf8"));
const input = JSON.parse(readFileSync(dir + "/input.json", "utf8"));
if (job.scrubInput) { try { unlinkSync(dir + "/input.json"); } catch {} }
const beat = () => { try { writeFileSync(dir + "/heartbeat", String(Date.now())); } catch {} };
beat();
setInterval(beat, 5000).unref();
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
  const handler = HANDLERS[job.kind];
  if (typeof handler !== "function") throw new Error("the host module has no handler " + job.kind);
  const ac = new AbortController();
  done({ ok: true, value: await handler(input, { signal: ac.signal, lifecycle: { signal: ac.signal } }) });
} catch (cause) {
  console.error(cause);
  done({ ok: false, error: cause instanceof Error ? cause.message : String(cause) });
}
process.exit(0);
}
`;

/** A process that calls startHostJob once for a key and prints the job id it got — the racers in the claim test. */
const STARTER = `
import { startHostJob } from ${JSON.stringify(fileURLToPath(new URL("../src/rooms/host-worker/jobs.ts", import.meta.url)))};
const [root, entryFile, key] = process.argv.slice(2);
const jobId = await startHostJob(
  { kind: "detect", input: { requestedHostId: "h1", workspacePath: "/ok" }, timeoutSec: 30, key },
  { root, entryFile },
);
process.stdout.write(jobId);
`;

let dir = "";
let options: JobOptions = {};
const request = (workspacePath: string, timeoutSec = 30) =>
  ({ kind: "detect" as const, input: { requestedHostId: "h1", workspacePath }, timeoutSec });

async function until(jobId: string, done: (status: JobStatus) => boolean): Promise<JobStatus> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await hostJobStatus(jobId, options);
    if (done(status)) return status;
    await new Promise((wake) => setTimeout(wake, 50));
  }
  throw new Error("job did not reach the expected state");
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "lp-jobs-"));
  await writeFile(join(dir, "host.mjs"), FIXTURE);
  const source = join(dir, "start-job.mts");
  await writeFile(source, STARTER);
  await execFileAsync(join(import.meta.dirname, "../node_modules/.bin/esbuild"), [
    source, "--bundle", "--platform=node", "--format=esm", `--outfile=${join(dir, "start-job.mjs")}`,
  ]);
  options = { root: join(dir, "jobs"), entryFile: join(dir, "host.mjs") };
});
async function rmSettled(path: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await rm(path, { recursive: true, force: true }); return; }
    catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if ((code !== "ENOTEMPTY" && code !== "EBUSY") || attempt >= 50) throw cause;
      await new Promise((wake) => setTimeout(wake, 100));
    }
  }
}

afterAll(async () => { await rmSettled(dir); });

describe("host background jobs", () => {
  it("returns its id at once and runs the handler in a process of its own", async () => {
    const started = Date.now();
    const jobId = await startHostJob(request("/ok"), options);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(jobId).toMatch(/^job_[a-z0-9]+$/);
    const status = await until(jobId, (row) => row.state !== "running");
    expect(status).toMatchObject({ state: "succeeded", error: null, result: { hostId: "h1", laneStack: { version: "object" }, workspace: { path: "/ok" } } });
    expect(status.progress.lastLine).toBe("detect ran");
  });

  it("reports a failing handler with its own message", async () => {
    const jobId = await startHostJob(request("/fail"), options);
    expect(await until(jobId, (row) => row.state !== "running")).toMatchObject({ state: "failed", error: "boom: h1" });
  });

  it("shows progress while running and stops the job on cancel", async () => {
    const jobId = await startHostJob(request("/slow"), options);
    const running = await until(jobId, (row) => row.progress.lastLine.startsWith("waiting"));
    expect(running.state).toBe("running");
    expect(await cancelHostJob(jobId, options)).toBe(true);
    expect((await until(jobId, (row) => row.state !== "running")).state).toBe("cancelled");
    // Nothing to cancel once it has ended.
    expect(await cancelHostJob(jobId, options)).toBe(false);
  });

  it("ends a job at its own time limit and says so", async () => {
    const jobId = await startHostJob(request("/slow", 1), options);
    expect(await until(jobId, (row) => row.state !== "running")).toMatchObject({ state: "failed", error: "job timed out after 1 s" });
  });

  it("calls a job whose process died without a result lost, not running", async () => {
    const jobId = await startHostJob(request("/slow"), options);
    await until(jobId, (row) => row.progress.lastLine.startsWith("waiting"));
    const { readFile } = await import("node:fs/promises");
    const { pid } = JSON.parse(await readFile(join(options.root!, jobId, "job.json"), "utf8")) as { pid: number };
    process.kill(-pid, "SIGKILL");
    expect(await until(jobId, (row) => row.state !== "running")).toMatchObject({ state: "lost" });
  });

  it("keeps one job per key when rival processes race a stale claim", async () => {
    const starter = join(dir, "start-job.mjs");
    const keysDir = join(options.root!, "keys");
    await mkdir(keysDir, { recursive: true });
    const key = "concurrent-race";
    const file = join(keysDir, `${sha256Hex(key).slice(0, 32)}.id`);
    const winners = new Set<string>();
    for (let round = 0; round < 20; round += 1) {
      // A key file naming a job that no longer exists: every racer must free and re-claim it exactly once.
      await writeFile(file, "job_0000000000\n");
      const ids = await Promise.all(
        Array.from({ length: 4 }, async () => {
          const { stdout } = await execFileAsync(
            process.execPath, [starter, options.root!, options.entryFile!, key],
          );
          return stdout.trim();
        }),
      );
      expect(new Set(ids).size).toBe(1);
      winners.add(ids[0]);
      await until(ids[0], (row) => row.state !== "running");
    }
    expect(winners.size).toBe(20);
  }, 120_000);

  it("waits out an empty key file still being staged and frees one left by a crashed claimant", async () => {
    const { utimes } = await import("node:fs/promises");
    const keysDir = join(options.root!, "keys");
    await mkdir(keysDir, { recursive: true });
    const slowKey = "slow-claimant";
    const slowFile = join(keysDir, `${sha256Hex(slowKey).slice(0, 32)}.id`);
    const live = await startHostJob(request("/ok"), options);
    // A rival took the key and is still staging after the old 2 s grace: the caller must wait, not take the key.
    await writeFile(slowFile, "");
    const waiting = startHostJob({ ...request("/ok"), key: slowKey }, options);
    await new Promise((wake) => setTimeout(wake, 2_500));
    await writeFile(slowFile, live);
    expect(await waiting).toBe(live);
    // An empty key file older than a minute names no live claimant: it is freed and a new job starts.
    const deadKey = "dead-claimant";
    const deadFile = join(keysDir, `${sha256Hex(deadKey).slice(0, 32)}.id`);
    await writeFile(deadFile, "");
    const old = new Date(Date.now() - 120_000);
    await utimes(deadFile, old, old);
    const fresh = await startHostJob({ ...request("/ok"), key: deadKey }, options);
    expect(fresh).toMatch(/^job_[a-z0-9]+$/);
    expect(fresh).not.toBe(live);
  }, 30_000);

  it("does not delete a rival's fresh empty claim that replaced the stale file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lp-jobs-claim-"));
    try {
      const file = join(dir, "key.id");
      await writeFile(file, "job_0000000000\n");
      // The stale file the sweep observed was old (the claim grace had run out).
      const old = new Date(Date.now() - 120_000);
      await utimes(file, old, old);
      const before = await stat(file);
      // A deletes the stale file; C creates a fresh empty claim in its place.
      await rm(file);
      await writeFile(file, "");
      await removeIfStill(file, "", { mtimeMs: before.mtimeMs, ino: before.ino });
      expect(await readFile(file, "utf8")).toBe("");
    } finally { await rmSettled(dir); }
  });

  it("answers an unknown job as lost and refuses a malformed id or input", async () => {
    expect(await hostJobStatus("job_doesnotexist0", options)).toMatchObject({ state: "lost", error: "no such job" });
    await expect(hostJobStatus("../etc", options)).rejects.toThrow(/invalid job id/);
    await expect(startHostJob({ kind: "detect", input: { requestedHostId: "h1" }, timeoutSec: 30 }, options)).rejects.toThrow();
    await expect(startHostJob({ kind: "nope" as never, input: {}, timeoutSec: 30 }, options)).rejects.toThrow(/not supported/);
  });
});
