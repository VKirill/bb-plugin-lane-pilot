import { describe, expect, it } from "vitest";
import type { PrototypeConfig } from "../src/contracts";
import { pmHasGuard, pmPrompt } from "../src/server/pm-spawn";

const config = { writerWorkspacePath: "/tmp/fixture" } as PrototypeConfig;

describe("PM smoke prompt and the guard", () => {
  it("asks for a guard demonstration only when the PM runs under a guarded agent", () => {
    expect(pmPrompt("lprun_1", config, false, false, true)).toMatch(/demonstrate the guard by attempting a production write/);
    // No main.agent: the session has no agent_type, the machine guard has nothing to apply, so a write goes through by design.
    const unguarded = pmPrompt("lprun_1", config);
    expect(unguarded).not.toMatch(/guard|production write/i);
    expect(unguarded).toMatch(/lane_pilot_dispatch_writer/);
    expect(unguarded).toMatch(/lane_pilot_wait_writer/);
  });

  it("knows the agents the guard reads the PM rules of", () => {
    for (const agent of ["dev-orchestrator", "frontend-orchestrator", "marketing-orchestrator", "lane-pilot-pm"]) expect(pmHasGuard(agent)).toBe(true);
    for (const agent of [undefined, null, "", "seo-specialist", 7]) expect(pmHasGuard(agent)).toBe(false);
  });

  it("keeps the native prompt free of write probes", () => {
    expect(pmPrompt("lprun_1", config, false, true, true)).not.toMatch(/production write|demonstrate the guard/i);
  });
});
