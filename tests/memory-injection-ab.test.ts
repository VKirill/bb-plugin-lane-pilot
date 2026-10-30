import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { acceptancePerInjectedToken, injectedTokensOf, MEMORY_INJECTION_ARMS } from "../src/rooms/bench/memory-injection";
import { createAttempt, createRun, openDatabase } from "../src/rooms/storage/database";

// arXiv #18: paired arms differ only in memory injection, and the gain is priced per injected token.
describe("memory injection A/B", () => {
  it("the two arms differ only in memory settings", () => {
    expect(Object.keys({ ...MEMORY_INJECTION_ARMS.on, ...MEMORY_INJECTION_ARMS.off })).toEqual(["memory.enabled", "memory.inject", "memory.maintain"]);
    expect(MEMORY_INJECTION_ARMS.on["memory.inject"]).toBe(true);
    expect(MEMORY_INJECTION_ARMS.off["memory.enabled"]).toBe(false);
  });

  it("sums injected tokens from attempt traces and prices the acceptance delta", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    createRun(db, "r1", "P", "cli", "/repo");
    createAttempt(db, { id: "a1", runId: "r1", taskId: "k1" });
    const trace = JSON.stringify({ dispatchContext: { memoryText: "x".repeat(800) } });
    db.prepare("INSERT INTO lane_pilot_attempt_reasoning(attempt_id,trace_json) VALUES('a1',?)").run(trace);
    expect(injectedTokensOf(db, "r1")).toBe(200);
    const priced = acceptancePerInjectedToken([{ accepted: true }, { accepted: true }], [{ accepted: true }, { accepted: false }], 2000);
    expect(priced.delta).toBeCloseTo(0.5);
    expect(priced.perKiloToken).toBeCloseTo(0.25);
    expect(acceptancePerInjectedToken([], [], 0).perKiloToken).toBeNull();
  });
});
