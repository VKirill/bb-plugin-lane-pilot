import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runJobProcess, HOST_JOB_HANDLERS, type HostJobHandlers } from "../src/rooms/host-worker/job-runner";

let dir = "";
const stage = async (meta: Record<string, unknown>, input: Record<string, unknown>) => {
  const job = await mkdtemp(join(dir, "job_"));
  await writeFile(join(job, "job.json"), JSON.stringify({ jobId: "job_x", kind: "detect", startedAt: Date.now(), timeoutSec: 30, pid: null, ...meta }));
  await writeFile(join(job, "input.json"), JSON.stringify(input));
  return job;
};
const handlers = (detect: (input: Record<string, unknown>, context: { signal: AbortSignal }) => Promise<unknown>) =>
  ({ detect }) as unknown as HostJobHandlers;
const result = async (job: string) => JSON.parse(await readFile(join(job, "result.json"), "utf8")) as { ok: boolean; value?: unknown; error?: string };

beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "lp-job-runner-")); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

describe("the host job process (job-runner.ts)", () => {
  it("the explicit table answers every job kind the wire accepts", () => {
    expect(Object.keys(HOST_JOB_HANDLERS).sort()).toEqual([
      "coexistenceInventory", "coexistenceOperation", "connectOpencode", "detect", "gateAttribute", "gateBisect",
      "gateRun", "gitIntegrate", "gitPrepareWorktree", "install", "rollback", "runBrowserQa",
      "runSandboxedCommand", "runScript", "snapshot",
    ]);
  });

  it("runs the kind's handler and writes result.json last", async () => {
    const job = await stage({}, { n: 1 });
    expect(await runJobProcess(job, handlers(async (input) => ({ got: input.n })))).toBe(0);
    expect(await result(job)).toEqual({ ok: true, value: { got: 1 } });
    expect(await stat(join(job, "heartbeat")).then(() => true, () => false)).toBe(true);
  });

  it("a handler's throw lands in result.json as the error", async () => {
    const job = await stage({}, {});
    expect(await runJobProcess(job, handlers(() => Promise.reject(new Error("boom"))))).toBe(0);
    expect(await result(job)).toEqual({ ok: false, error: "boom" });
  });

  it("an unknown kind is an error, not a crash", async () => {
    const job = await stage({ kind: "nope" }, {});
    expect(await runJobProcess(job, handlers(async () => ({})))).toBe(0);
    expect(await result(job)).toEqual({ ok: false, error: "the host module has no handler nope" });
  });

  it("the job's own time limit ends it and kills its process group", async () => {
    const job = await stage({ timeoutSec: 1 }, {});
    const signals: string[] = [];
    const code = await runJobProcess(job, handlers(async () => new Promise((wake) => setTimeout(wake, 60_000))), { killGroup: (signal) => signals.push(signal) });
    expect(code).toBe(1);
    expect(await result(job)).toEqual({ ok: false, error: "job timed out after 1 s" });
    expect(signals).toEqual(["SIGTERM"]);
  });

  it("scrubs input.json for a kind that carries secrets", async () => {
    const job = await stage({ scrubInput: true }, { secret: "x" });
    expect(await runJobProcess(job, handlers(async () => ({})))).toBe(0);
    expect(await readdir(job)).not.toContain("input.json");
  });
});
