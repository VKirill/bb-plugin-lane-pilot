import { describe, expect, it } from "vitest";
import { recheckServiceModels, type ServiceRecheckBench } from "../../src/rooms/bench/server/service-pin";
import { SERVICE_JOBS, servicePair, serviceRole } from "../../src/rooms/workflow/service-models";

const bench = (verdict: "pass" | "fail" | "inconclusive"): ServiceRecheckBench & { arms: string[] } => {
  const arms: string[] = [];
  return {
    arms,
    status: () => [{ version: "set-1", createdAt: 2 }],
    run: async (input) => { arms.push(`${input.arm}:${input.writer?.model}`); },
    compare: () => ({ comparison: { verdict } }),
  };
};

describe("service model pins", () => {
  it("pins only the router, and the other four service jobs stay code", () => {
    expect(SERVICE_JOBS.map((job) => [job.id, job.role, job.previousRole])).toEqual([
      ["classify", "triager", "pm-reader"],
      ["coverage", null, null],
      ["plan-fact", null, null],
      ["run-goal", null, null],
      ["report", null, null],
    ]);
    expect(serviceRole("classify", {})).toBe("triager");
    expect(serviceRole("classify", { "service_model.classify": "previous" })).toBe("pm-reader");
    expect(serviceRole("coverage", {})).toBeNull();
    expect(servicePair("triager").model).toBe("router9/ag/gemini-3.8-flash-high");
    expect(servicePair("pm-reader").model).toBe("claude-haiku-5-5");
  });

  it("rolls the pin back when the cheap arm is worse, and leaves it when the compare does not fail", async () => {
    const worse = bench("fail");
    const pins: Array<[string, string]> = [];
    const rows = await recheckServiceModels({ bench: worse, now: Date.UTC(2026, 9, 1), writePin: (key, value) => pins.push([key, value]) });
    expect(rows).toEqual([
      { id: "classify", action: "rolled-back" },
      { id: "coverage", action: "code" },
      { id: "plan-fact", action: "code" },
      { id: "run-goal", action: "code" },
      { id: "report", action: "code" },
    ]);
    expect(pins).toEqual([["service_model.classify", "previous"]]);
    expect(worse.arms).toEqual([
      "svc-classify-prev-2026-10:claude-haiku-5-5",
      "svc-classify-cheap-2026-10:router9/ag/gemini-3.8-flash-high",
    ]);
    const held = bench("pass");
    const kept: Array<[string, string]> = [];
    expect((await recheckServiceModels({ bench: held, now: Date.UTC(2026, 9, 1), writePin: (key, value) => kept.push([key, value]) })).find((row) => row.id === "classify")).toEqual({ id: "classify", action: "kept" });
    expect(kept).toEqual([]);
  });
});
