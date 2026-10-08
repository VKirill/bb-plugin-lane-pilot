import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { browserGoal } from "../../src/rooms/host-worker/host-handlers";
import { errandPrompt, errandVerdict } from "../../src/rooms/qa/server/errands";

describe("errands", () => {
  it("lets a helper change things only when the owner asked for the change", () => {
    const readOnly = errandPrompt({ task: "Read the OAuth scopes", browserHostId: "host_mini", authorized: false });
    expect(readOnly).toContain("Read and report only");
    expect(readOnly).toContain("--machine host_mini");
    expect(readOnly).toContain("`ERRAND: done` or `ERRAND: blocked: <why>`");
    expect(readOnly).not.toContain("done | blocked");
    expect(errandPrompt({ task: "Remove the analytics scope", browserHostId: "host_mini", authorized: true })).toContain("Authorization follows the owner's goal");
    expect(errandPrompt({ task: "x".repeat(20), browserHostId: null, authorized: false })).toContain("No browser machine is set");
  });
});

describe("browserGoal", () => {
  const saved = process.env.LANE_PILOT_JEV_RUNNER;
  afterEach(() => { if (saved === undefined) delete process.env.LANE_PILOT_JEV_RUNNER; else process.env.LANE_PILOT_JEV_RUNNER = saved; });

  it("passes the goal as an argument, never as shell text, and reads the runner's last JSON line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jev-"));
    const runner = join(dir, "run");
    const final = JSON.stringify({ status: "done", url: "https://console.example/auth", actions: 2, title: "Data Access", text: "Your non-sensitive scopes\n./auth/webmasters" });
    writeFileSync(runner, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\necho "  356 ms  0 actions  done"\ncat <<'JSON'\n${final}\nJSON\n`);
    chmodSync(runner, 0o755);
    process.env.LANE_PILOT_JEV_RUNNER = runner;
    const goal = "Open setup; then $(touch pwned) `id` and stop";
    const result = await (browserGoal as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ requestedHostId: "host_mini", url: "https://console.example/", goal });
    expect(result).toMatchObject({ exitCode: 0, status: "done", url: "https://console.example/auth", actions: 2, title: "Data Access", text: "Your non-sensitive scopes\n./auth/webmasters" });
    expect(result.log).not.toContain("{");
    expect(readFileSync(join(dir, "args"), "utf8").split("\n")).toEqual(["browser", "--url", "https://console.example/", "--goal", goal, ""]);
  });

  it("says so when the machine has no jev launcher", async () => {
    process.env.LANE_PILOT_JEV_RUNNER = "/nonexistent/run";
    const result = await (browserGoal as unknown as (input: unknown) => Promise<Record<string, unknown>>)({ requestedHostId: "h", url: "https://x.example/", goal: "look" });
    expect(result).toMatchObject({ status: "no_runner", exitCode: 127 });
    expect(result.log).toContain("/nonexistent/run");
  });
});
