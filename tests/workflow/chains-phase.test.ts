import { describe, expect, it } from "vitest";
import { runSim } from "./chain-harness";
import { out, pathOf } from "./chain-helpers";

/** The phase-support chains added for the d5 streams: backlog parking and external plan import. */
describe("backlog-add", () => {
  it("parks an item under the next 999.N and emits its number", async () => {
    const r = await runSim("backlog-add", { input: { name: "dark mode", goal: "owner asked" }, stubs: { "lp.roadmap_park": { ok: true, n: "999.1", path: ".agents/planning/ROADMAP.md" } } });
    expect(pathOf(r)).toBe("park done");
    expect(out(r)).toMatchObject({ status: "done", n: "999.1" });
  });
});

describe("plan-import", () => {
  it("a plan with one conflict stops at the owner's resolve step before pieces are cut", async () => {
    const r = await runSim("plan-import", { input: { plan: "step 1: cache", goal: "caching" },
      stubs: { "grill-plan": { open: ["conflicts with locked decision D3"], risk_register: [] }, pieces: { pieces: [{ id: "p1" }], waves: [["p1"]] } },
      humans: { resolve: { answer_kind: "resolved", answer: "keep D3" } } });
    expect(pathOf(r)).toBe("grill resolve pieces emit");
    expect(r.skipped).not.toContain("resolve");
    expect(out(r)).toMatchObject({ conflicts: ["conflicts with locked decision D3"] });
  });

  it("with no conflicts the resolve step is skipped", async () => {
    const r = await runSim("plan-import", { input: { plan: "step 1", goal: "g" },
      stubs: { "grill-plan": { open: [], risk_register: [] }, pieces: { pieces: [{ id: "p1" }], waves: [["p1"]] } } });
    expect(pathOf(r)).toBe("grill resolve pieces emit");
    expect(r.skipped).toContain("resolve");
    expect(out(r)).toMatchObject({ conflicts: [] });
  });
});
