import { describe, expect, it } from "vitest";
import type { HostPort } from "../../src/rooms/bench/ports";
import { formatProbeReplays, runHarnessProbe } from "../../src/rooms/harness/server/probe-run";

const tree = { "always-on.md": "Run the check.\n" };

function fakeHost(script: (command: string) => { exitCode: number; stdout: string } = () => ({ exitCode: 0, stdout: "" })) {
  const commands: string[] = [];
  const host: HostPort = {
    run: async (_hostId, _cwd, command) => {
      commands.push(command);
      const result = script(command);
      return { ...result, stderr: "" };
    },
  };
  return { host, commands };
}

const task = (id: string, command = "echo probe-tokens: 4000") => ({
  attemptId: id, sha: "abc123", tokens: 100, verification: [{ command, cwd: "/repo" }],
});

describe("runHarnessProbe", () => {
  it("checks the candidate out on a bench worktree and runs the saved task's verification on a fake host", async () => {
    const { host, commands } = fakeHost((command) => command.includes("probe-tokens") ? { exitCode: 0, stdout: "probe-tokens: 4000\n" } : { exitCode: 0, stdout: "" });
    const rows = await runHarnessProbe({
      host, hostId: "fake", checkout: "/tmp/probe", repo: "/repo",
      candidates: [{ label: "inv", tree }], tasks: [task("a1")],
      budget: { maxAttempts: 2, tokenBudget: 24_000, timeBudgetSec: 60, enabled: true },
    });
    expect(commands.some((command) => command.includes("lp-bench"))).toBe(true);
    expect(commands.some((command) => command.includes("always-on.md"))).toBe(true);
    expect(commands.some((command) => command.includes("probe-tokens"))).toBe(true);
    expect(rows).toEqual([expect.objectContaining({ attemptId: "a1", candidate: "inv", passed: true, tokens: 4000 })]);
    const text = formatProbeReplays(rows);
    expect(text).toContain("checks: passed");
    expect(text).toContain("4000");
  });

  it("stops when the next replay would pass the token budget, and records a failed check", async () => {
    const { host, commands } = fakeHost((command) => {
      if (command.includes("FAIL")) return { exitCode: 1, stdout: "probe-tokens: 4000\n" };
      if (command.includes("probe-tokens")) return { exitCode: 0, stdout: "probe-tokens: 4000\n" };
      return { exitCode: 0, stdout: "" };
    });
    const rows = await runHarnessProbe({
      host, hostId: "fake", checkout: "/tmp/probe", repo: "/repo",
      candidates: [{ label: "inv", tree }, { label: "dom", tree }],
      tasks: [task("a1", "FAIL"), task("a2")],
      budget: { maxAttempts: 2, tokenBudget: 4_000, timeBudgetSec: 60, enabled: true },
    });
    expect(rows).toEqual([expect.objectContaining({ candidate: "inv", passed: false, detail: expect.stringContaining("exited 1") })]);
    expect(commands.filter((command) => command.includes("probe-tokens") || command.includes("FAIL"))).toHaveLength(1);
  });

  it("does not call the host when the probe is switched off", async () => {
    const { host, commands } = fakeHost();
    const rows = await runHarnessProbe({
      host, hostId: "fake", checkout: "/tmp/probe", repo: "/repo",
      candidates: [{ label: "inv", tree }], tasks: [task("a1")],
      budget: { maxAttempts: 2, tokenBudget: 24_000, timeBudgetSec: 60, enabled: false },
    });
    expect(rows).toEqual([]);
    expect(commands).toEqual([]);
  });

  it("stops on the time budget before a second candidate", async () => {
    let calls = 0;
    const { host } = fakeHost((command) => command.includes("probe-tokens") ? { exitCode: 0, stdout: "probe-tokens: 10\n" } : { exitCode: 0, stdout: "" });
    const rows = await runHarnessProbe({
      host, hostId: "fake", checkout: "/tmp/probe", repo: "/repo",
      candidates: [{ label: "inv", tree }, { label: "dom", tree }], tasks: [task("a1")],
      budget: { maxAttempts: 2, tokenBudget: 24_000, timeBudgetSec: 5, enabled: true },
      // The first candidate's clock reads stay inside the budget; the next check is past it.
      clock: { now: () => { calls += 1; return calls < 5 ? 0 : 10_000; } },
    });
    expect(rows.map((row) => row.candidate)).toEqual(["inv"]);
  });
});
