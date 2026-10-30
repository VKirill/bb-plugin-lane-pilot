import { describe, expect, it } from "vitest";
import { runBenchCli } from "../../src/rooms/bench/cli";
import { releaseGate, type ReleaseGate } from "../../src/rooms/bench/reliability";
import type { BenchApi } from "../../src/rooms/bench/service";

const HOUR = 3_600_000;
const now = 100 * HOUR;
const run = (arm: string, state: "running" | "done" | "stopped_budget" | "failed", at: number, stopReason: string | null = null) => ({ arm, state, stopReason, startedAt: at - HOUR, finishedAt: state === "running" ? null : at });

describe("bench release gate", () => {
  it("allows a release only after a finished night run that is still fresh", () => {
    expect(releaseGate([], now).ok).toBe(false);
    expect(releaseGate([run("week-a", "done", now - HOUR)], now).reason).toMatch(/no nightly/);
    expect(releaseGate([run("night-0.1.389", "stopped_budget", now - HOUR)], now).ok).toBe(false);
    expect(releaseGate([run("night-0.1.389", "failed", now - HOUR)], now).ok).toBe(false);
    expect(releaseGate([run("night-0.1.389", "running", now)], now).ok).toBe(false);
    expect(releaseGate([run("night-0.1.389", "done", now - 40 * HOUR)], now).ok).toBe(false);
    const fresh = releaseGate([
      run("night-old", "done", now - 10 * HOUR),
      run("night-0.1.389", "done", now - 2 * HOUR),
      run("day-a", "failed", now - HOUR),
    ], now);
    expect(fresh).toMatchObject({ ok: true, arm: "night-0.1.389" });
    expect(releaseGate([run("night-0.1.389", "done", now - 20 * HOUR)], now, 10).ok).toBe(false);
  });

  it("one arm over several sets: every set must be done; a budget-skipped set is marked, not failed", () => {
    // Every set of the newest arm done: pass.
    const all = releaseGate([
      run("night-0.1.389-a", "done", now - 2 * HOUR),
      run("night-0.1.389-a", "done", now - 2 * HOUR),
      run("night-0.1.389-a", "done", now - 2 * HOUR),
    ], now);
    expect(all.ok).toBe(true);
    // One set failed: the whole night is not a pass.
    expect(releaseGate([
      run("night-0.1.389-a", "done", now - 2 * HOUR),
      run("night-0.1.389-a", "failed", now - 2 * HOUR),
    ], now).ok).toBe(false);
    // A set the shared budget never reached: marked in the reason, not failed.
    const marked = releaseGate([
      run("night-0.1.389-a", "done", now - 2 * HOUR),
      run("night-0.1.389-a", "stopped_budget", now - 2 * HOUR, "skipped: the night's shared token budget ended on an earlier set"),
    ], now);
    expect(marked.ok).toBe(true);
    expect(marked.reason).toMatch(/skipped by the night budget/);
    // A real budget stop is not a skip mark: it still fails the gate.
    expect(releaseGate([
      run("night-0.1.389-a", "done", now - 2 * HOUR),
      run("night-0.1.389-a", "stopped_budget", now - 2 * HOUR, "budget_tokens reached"),
    ], now).ok).toBe(false);
  });

  it("exits 0 only when the gate says the night passed", async () => {
    const bench = (answer: ReleaseGate) => ({ gate: () => answer }) as unknown as BenchApi;
    expect((await runBenchCli(bench({ ok: true, reason: "nightly bench night-0.1.389 passed 2.0h ago", arm: "night-0.1.389", at: 1 }), ["gate"])).exitCode).toBe(0);
    const blocked = await runBenchCli(bench({ ok: false, reason: "no nightly bench run", arm: null, at: null }), ["gate", "--hours", "12"]);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stdout).toMatch(/no nightly/);
  });
});
