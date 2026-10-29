import { describe, expect, it } from "vitest";
import { CAPABILITIES, capabilityTable, dueProbes, type CapabilityReceipt } from "../../src/rooms/capability/logic";
import { FREE_CLASSES, failureClass, nextStep } from "../../src/rooms/runs/failure-class";
import { WORKER_ENVELOPE } from "../../src/rooms/tasks/rails";
import { WORKER_USER, asWorker, grantCommands, workerReachable } from "../../src/rooms/verification/worker-user";

describe("worker gates", () => {
  it("[sma:wr_windows] an exhausted window is a limit: it spends no attempt and the next step is to wait", () => {
    expect(failureClass("failed", "writer_provider_limit: usage window")).toBe("limit");
    expect(failureClass("failed", "writer_provider_unavailable:usage_window")).toBe("limit");
    expect(FREE_CLASSES.has("limit")).toBe(true);
    expect(nextStep("failed", "writer_provider_limit: usage window")).toBe("moves down the writer chain by itself; do nothing");
    expect(failureClass("failed", "checks failed: npm test")).toBe("task");
  });

  it("[sma:wb_envelope] the envelope has eight dimensions and each one names how it is enforced", () => {
    const dimensions = Object.entries(WORKER_ENVELOPE);
    expect(dimensions).toHaveLength(8);
    expect(Object.keys(WORKER_ENVELOPE).sort()).toEqual(["files", "git", "network", "secrets", "shell", "time", "tokens", "tools"]);
    for (const [, law] of dimensions) expect(law.length).toBeGreaterThan(20);
    expect(WORKER_ENVELOPE.files).toMatch(/owns_paths/);
    expect(WORKER_ENVELOPE.git).toMatch(/push/);
    expect(WORKER_ENVELOPE.git).toMatch(/merge/);
    expect(WORKER_ENVELOPE.tools).toMatch(/MCP|skills/);
    expect(WORKER_ENVELOPE.network).toMatch(/sandbox/);
    expect(WORKER_ENVELOPE.secrets).toMatch(/secret/);
    expect(WORKER_ENVELOPE.tokens).toMatch(/budget/);
    expect(WORKER_ENVELOPE.time).toMatch(/turn|minutes|wall/);
  });

  it("[sma:wc_table] [sma:wc_status] [sma:wc_receipt] [sma:wc_probe] a missing receipt is unproven and is probed; a receipt for this version is the state", () => {
    const inUse = new Map([["claude", "opus"], ["codex", "gpt"]]);
    const versions = new Map([["claude", "1.2.0"], ["codex", "9.0.0"]]);
    const receipt: CapabilityReceipt = { providerId: "claude", version: "1.2.0", capability: "pause", state: "supported", model: "opus", detail: "paused and resumed", at: 1 };
    const absent: CapabilityReceipt = { ...receipt, capability: "answers", state: "not_supported", detail: "no answer" };
    const stale: CapabilityReceipt = { ...receipt, version: "0.9.0", capability: "documentary" };
    expect(capabilityTable(inUse, versions, [receipt, absent, stale])).toEqual([
      { providerId: "claude", version: "1.2.0", capabilities: { answers: "not_supported", documentary: "unproven", pause: "supported" } },
      { providerId: "codex", version: "9.0.0", capabilities: { answers: "unproven", documentary: "unproven", pause: "unproven" } },
    ]);
    const due = dueProbes(inUse, versions, [receipt, absent, stale]);
    expect(due.map((row) => row.providerId).sort()).toEqual(["claude", "codex"]);
    expect(dueProbes(inUse, versions, CAPABILITIES.flatMap((capability) => [
      { providerId: "claude", version: "1.2.0", capability, state: "supported" as const, model: "opus", detail: null, at: 1 },
      { providerId: "codex", version: "9.0.0", capability, state: "supported" as const, model: "gpt", detail: null, at: 1 },
    ]))).toEqual([]);
  });

  it.todo("[sma:wc_mandatory] four mandatory cells — pause, call accounting, progress saving, pre-effect gate — each have a receipt");

  it("[sma:wi_probe] a name that is not a worker user is not a pass, and a user sudo cannot reach is not a pass", async () => {
    await expect(workerReachable("")).resolves.toBe(false);
    await expect(workerReachable("Not A User")).resolves.toBe(false);
    await expect(workerReachable("../root")).resolves.toBe(false);
    expect(WORKER_USER.test("lp-worker")).toBe(true);
    await expect(workerReachable("lp-worker-no-such-user")).resolves.toBe(false);
  });

  it("[sma:wi_grant] [sma:m_sp_grants] the grant commands name only the run folder that was passed", () => {
    const dir = "/tmp/lp-run-only";
    for (const platform of ["linux", "darwin"]) {
      const commands = grantCommands(platform, "lp-worker", "owner", dir);
      expect(commands.length).toBeGreaterThan(0);
      for (const step of commands) {
        expect(step.args).toContain(dir);
        expect(step.args.filter((arg) => arg.startsWith("/"))).toEqual([dir]);
      }
    }
  });

  it("[sma:wi_runner] the worker launch is sudo as that user and keeps only the named variables", () => {
    expect(asWorker("lp-worker", "/usr/bin/true", ["--check"], ["PATH", "SECRET", "PATH"])).toEqual({
      program: "/usr/bin/sudo",
      args: ["-n", "-u", "lp-worker", "--preserve-env=PATH,SECRET", "/usr/bin/true", "--check"],
    });
    expect(() => asWorker("bad user", "/usr/bin/true", [], [])).toThrow(/worker_user_invalid/);
  });
});
