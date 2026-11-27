import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import { listSkillMetrics } from "../../src/rooms/storage";
import { calculateSkillSwitches } from "../../src/rooms/writer/models/skill-switch";
import { recordSkillSwitchMetric } from "../../src/rooms/writer/server/repositories/skill-switch-store";
import { extractSkillSequence } from "../../src/rooms/contracts";

describe("skill-switch metric (Item 3)", () => {
  it("extractSkillSequence extracts skills from tool events and falls back to provided skills", () => {
    const events = [
      { data: { item: { type: "toolCall", name: "skill", input: { id: "gitnexus" } } } },
      { data: { item: { type: "toolCall", name: "skill", arguments: { id: "gitnexus" } } } },
      { data: { item: { type: "toolCall", name: "skill", input: { name: "blender2" } } } },
      { data: { item: { type: "toolCall", name: "blender:render" } } },
    ];

    const seq = extractSkillSequence(events);
    expect(seq).toEqual(["gitnexus", "gitnexus", "blender2", "blender"]);

    const fallback = extractSkillSequence([], ["test-skill", "other-skill"]);
    expect(fallback).toEqual(["test-skill", "other-skill"]);
  });

  it("calculateSkillSwitches computes transitions between different skills", () => {
    expect(calculateSkillSwitches([])).toEqual({ uniqueSkills: [], switchCount: 0 });
    expect(calculateSkillSwitches(["a", "a", "a"])).toEqual({ uniqueSkills: ["a"], switchCount: 0 });
    // a -> b (1), b -> a (2), a -> c (3), c -> c (no switch)
    expect(calculateSkillSwitches(["a", "b", "a", "c", "c"])).toEqual({
      uniqueSkills: ["a", "b", "c"],
      switchCount: 3,
    });
  });

  it("recordSkillSwitchMetric stores switch counts and outcomes", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = Date.now();

    // Task 1: 0 switches, accepted
    recordSkillSwitchMetric(db, {
      attemptId: "att_1",
      taskId: "task_1",
      projectId: "proj_1",
      skills: ["gitnexus"],
      outcome: "accepted",
      now: now - 5000,
    });

    // Task 2: 1 switch, accepted
    recordSkillSwitchMetric(db, {
      attemptId: "att_2",
      taskId: "task_2",
      projectId: "proj_1",
      skills: ["gitnexus", "blender2"],
      outcome: "accepted",
      now: now - 4000,
    });

    // Task 3: 3 switches, failed
    recordSkillSwitchMetric(db, {
      attemptId: "att_3",
      taskId: "task_3",
      projectId: "proj_1",
      skills: ["gitnexus", "blender2", "blender", "gitnexus"],
      outcome: "failed",
      now: now - 3000,
    });

    // Task 4: 4 switches, failed
    recordSkillSwitchMetric(db, {
      attemptId: "att_4",
      taskId: "task_4",
      projectId: "proj_1",
      skills: ["a", "b", "c", "d", "e"],
      outcome: "failed",
      now: now - 2000,
    });

    const rows = listSkillMetrics(db as never, now - 10_000, now + 10_000);
    expect(rows).toEqual([
      { switch_count: 0, outcome: "accepted" },
      { switch_count: 1, outcome: "accepted" },
      { switch_count: 3, outcome: "failed" },
      { switch_count: 4, outcome: "failed" },
    ]);
  });
});
