import { describe, expect, it } from "vitest";
import { LANE_PILOT_SURFACE } from "@lane-pilot/harness-core";
import { HARNESS_DEFAULTS, runStage } from "../../src/rooms/harness/server/harness";
import { graphEditProblems } from "../../src/rooms/harness/server/graph-edit";
import { TRIAL_DEFAULTS, decideTrial } from "../../src/rooms/harness/server/trial";
import type { ArmAttempt } from "../../src/rooms/harness/server/store";
import { workflow } from "../workflow/fixtures";

const surface = { ...LANE_PILOT_SURFACE, graphFiles: true };
const valid = JSON.stringify({ ...workflow(), test: { id: "sim", sim: { expect_path: ["search", "write"] } } });
const shaped = JSON.stringify({ id: "lp.example", nodes: [{ id: "a" }], edges: [] });

const row = (arm: "new" | "old", state: string, n: number): ArmAttempt =>
  ({ attemptId: `${arm}${n}${state}`, taskId: `${arm}${n}`, state, attemptNo: 1, arm, blockingFindings: 0, createdAt: 1 });

describe("graph edits", () => {
  it("stays off unless the project turns the flag on", () => {
    expect(HARNESS_DEFAULTS.graphEdits).toBe(false);
  });

  it("accepts a workflow the engine accepts when it names test.sim.expect_path, and refuses the rest", () => {
    expect(graphEditProblems({ "always-on.md": "x", "workflows/lp.example.json": valid })).toEqual([]);
    expect(graphEditProblems({ "workflows/lp.example.json": shaped }).join("\n")).toMatch(/engine accepts/);
    const noPath = JSON.stringify({ ...workflow(), test: { id: "sim", sim: {} } });
    expect(graphEditProblems({ "workflows/lp.example.json": noPath }).join("\n")).toMatch(/test\.sim\.expect_path/);
  });

  it("sends an engine rejection back to the editor when graph edits are on", async () => {
    const bad = { threadId: "thr_g", text: "<notes>x</notes>", tree: { "workflows/lp.example.json": shaped }, error: null };
    const missions: string[] = [];
    const result = await runStage({ mission: "M", fallback: {}, title: "t", surface }, async (mission) => { missions.push(mission); return bad; }, () => undefined, 0);
    expect(missions).toHaveLength(2);
    expect(missions[1]).toContain("engine accepts");
    expect(result.keptBase).toBe(true);
  });

  it("keeps a graph candidate on the same bench gate as any other tree", () => {
    const rows = [...Array.from({ length: 6 }, (_, n) => row("new", "accepted", n)), ...Array.from({ length: 4 }, (_, n) => row("old", "accepted", n)), ...Array.from({ length: 2 }, (_, n) => row("old", "blocked", n + 4))];
    const live = decideTrial(rows, 1, 2, TRIAL_DEFAULTS);
    expect(live.action).toBe("adopt");
    const gated = decideTrial(rows, 1, 2, TRIAL_DEFAULTS, { adoptBy: "bench", verdict: null });
    expect(gated.action).toBe("wait");
    expect(gated.reason).toMatch(/bench/);
  });
});
