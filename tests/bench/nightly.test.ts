import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nightArm } from "../../src/rooms/bench/runner";
import { OVH_BENCH_HOST, nightlyRepeats, nightlyRun } from "../../src/rooms/bench/server/weekly";

describe("bench nightly on OVH", () => {
  it("runs the whole set on the OVH host under a night arm", () => {
    const input = nightlyRun("v3", "0.1.389");
    expect(OVH_BENCH_HOST).toBe("host_rwrxyi39aw");
    expect(input).toEqual({ version: "v3", arm: nightArm("0.1.389"), wait: true, hostId: OVH_BENCH_HOST, noise: true });
    expect(input.arm.startsWith("night-")).toBe(true);
    expect(input).not.toHaveProperty("limit");
    expect(nightlyRepeats(0)).toBe(2);
    expect(nightlyRepeats(1)).toBe(2);
    expect(nightlyRepeats(3)).toBe(3);
    const weekly = readFileSync(new URL("../../src/rooms/bench/server/weekly.ts", import.meta.url), "utf8");
    const server = readFileSync(new URL("../../server.ts", import.meta.url), "utf8");
    expect(weekly).toContain("await bench().run({ version: newest.version, arm, wait: true, noise: true })");
    expect(weekly).toContain('scheduleIsolated(ctx.bb, "bench-nightly", "30 1 * * *"');
    expect(weekly).toContain('["bench.nightly"]');
    expect(server).toContain("mountBenchNightly");
  });
});
