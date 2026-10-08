import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hostJobStatus, startHostJob, type JobOptions, type JobStatus } from "../../src/jobs";
import { createCapture, runScriptOnHost } from "../../src/script-run";

const run = (command: string, extra: Partial<Parameters<typeof runScriptOnHost>[0]> = {}) =>
  runScriptOnHost({ requestedHostId: "h1", command, cwd: tmpdir(), timeoutSec: 20, ...extra });

describe("a scheduled script on the host", () => {
  it("runs a command in its folder and reports its exit code and output", async () => {
    const ok = await run("echo out; echo err 1>&2; pwd");
    expect(ok).toMatchObject({ exitCode: 0, timedOut: false, truncated: false });
    expect(ok.stdout).toContain("out");
    expect(ok.stdout.trim().split("\n").at(-1)).toMatch(/\/?tmp|var|private/);
    expect(ok.stderr).toContain("err");
    expect(await run("exit 3")).toMatchObject({ exitCode: 3 });
  });

  it("gives the secrets only to this run and masks them in what it printed", async () => {
    const result = await run("echo token=$MY_TOKEN; echo user=$LOGIN_USERNAME 1>&2", { env: { MY_TOKEN: "s3cr3t-value-123", LOGIN_USERNAME: "kirill-login-name" } });
    expect(result.stdout).toBe("token=***\n");
    expect(result.stderr).toBe("user=***\n");
    expect(JSON.stringify(result)).not.toContain("s3cr3t-value-123");
  });

  it("stops a script at its time limit with everything it started", async () => {
    const started = Date.now();
    const result = await run("sleep 30 & sleep 30; echo never", { timeoutSec: 1 });
    expect(result).toMatchObject({ timedOut: true, exitCode: 124 });
    expect(result.stderr).toContain("timed out after 1 s");
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it("keeps the beginning and the end of a long output, up to the cap", async () => {
    const result = await run("seq 1 200000", { maxOutputBytes: 4096 });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(5000);
    expect(result.stdout.startsWith("1\n2\n")).toBe(true);
    expect(result.stdout.trimEnd().endsWith("200000")).toBe(true);
    expect(result.stdout).toMatch(/\[\.\.\. \d+ bytes cut \.\.\.\]/);
  });

  it("a capture under the cap is the text unchanged", () => {
    const capture = createCapture(100);
    capture.push(Buffer.from("hello "));
    capture.push(Buffer.from("world"));
    expect(capture.text()).toBe("hello world");
    expect(capture.truncated).toBe(false);
  });
});

/** A host bundle stand-in whose runScript answers with what the job received, to see what survives on disk. */
const FIXTURE = `
export default { handlers: {
  runScript: async (input) => ({ hostId: input.requestedHostId, exitCode: 0, stdout: Object.keys(input.env ?? {}).join(","), stderr: "", truncated: false, timedOut: false, durationMs: 1 }),
} };
`;
let dir = "";
let options: JobOptions = {};
const request = (key?: string) => ({ kind: "runScript" as const, input: { requestedHostId: "h1", command: "true", cwd: "/tmp", timeoutSec: 30, env: { SECRET_NAME: "very-secret-value" } }, timeoutSec: 30, ...(key ? { key } : {}) });
async function until(jobId: string): Promise<JobStatus> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await hostJobStatus(jobId, options);
    if (status.state !== "running") return status;
    await new Promise((wake) => setTimeout(wake, 50));
  }
  throw new Error("job did not end");
}

describe("script jobs on the host", () => {
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lp-script-jobs-"));
    await writeFile(join(dir, "host.mjs"), FIXTURE);
    options = { root: join(dir, "jobs"), hostModuleUrl: pathToFileURL(join(dir, "host.mjs")).href };
  });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("one key is one job, also when the start is repeated at once or after the job ended", async () => {
    const [a, b] = await Promise.all([startHostJob(request("run:1"), options), startHostJob(request("run:1"), options)]);
    expect(b).toBe(a);
    await until(a);
    expect(await startHostJob(request("run:1"), options)).toBe(a);
    expect(await startHostJob(request("run:2"), options)).not.toBe(a);
    expect(await startHostJob(request(), options)).not.toBe(a);
  });

  it("does not keep the secret values of the input on disk once the job has read them", async () => {
    const jobId = await startHostJob(request("run:3"), options);
    const status = await until(jobId);
    expect(status).toMatchObject({ state: "succeeded", result: { stdout: "SECRET_NAME" } });
    const files = await readdir(join(dir, "jobs", jobId));
    expect(files).not.toContain("input.json");
    for (const file of files) expect(await stat(join(dir, "jobs", jobId, file))).toBeTruthy();
  });

  it("a key whose job folder was pruned is free again", async () => {
    const first = await startHostJob(request("run:4"), options);
    await until(first);
    await rm(join(dir, "jobs", first), { recursive: true, force: true });
    const second = await startHostJob(request("run:4"), options);
    expect(second).not.toBe(first);
  });
});
