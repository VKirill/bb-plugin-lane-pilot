import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelHostJob, hostJobStatus, startHostJob, type JobOptions, type JobStatus } from "../src/jobs";

/**
 * A stand-in for the host bundle: its `detect` handler does what the workspace path asks. The job process loads it
 * the way it loads the real bundle, through the default export's handlers.
 */
const FIXTURE = `
export default { handlers: {
  detect: async (input, context) => {
    if (input.workspacePath === "/fail") throw new Error("boom: " + input.requestedHostId);
    if (input.workspacePath === "/slow") { console.log("waiting for the slow part"); await new Promise((wake) => setTimeout(wake, 60000)); }
    console.log("detect ran");
    return {
      hostId: input.requestedHostId, laneStack: { present: true, version: typeof context.signal, sourceSha: null }, openCode: { present: false, version: null },
      workspace: { path: input.workspacePath, present: true }, targetSha: "t", matchesTarget: false, scenario: "S3",
    };
  },
} };
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
  options = { root: join(dir, "jobs"), hostModuleUrl: pathToFileURL(join(dir, "host.mjs")).href };
});
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

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

  it("answers an unknown job as lost and refuses a malformed id or input", async () => {
    expect(await hostJobStatus("job_doesnotexist0", options)).toMatchObject({ state: "lost", error: "no such job" });
    await expect(hostJobStatus("../etc", options)).rejects.toThrow(/invalid job id/);
    await expect(startHostJob({ kind: "detect", input: { requestedHostId: "h1" }, timeoutSec: 30 }, options)).rejects.toThrow();
    await expect(startHostJob({ kind: "nope" as never, input: {}, timeoutSec: 30 }, options)).rejects.toThrow(/not supported/);
  });
});
