import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import {
  calculateSkillSwitches,
  extractSkillSequence,
  getSkillSwitchStats,
  recordSkillSwitchMetric,
  skillSwitchMorningLine,
} from "../../src/rooms/writer/skill-switch";

describe("skill-switch metric (Item 3)", () => {
  it("extractSkillSequence extracts skills from tool events and falls back to provided skills", () => {
    const events = [
      { data: { item: { type: "toolCall", name: "skill", input: { id: "gitnexus" } } } },
      { data: { item: { type: "toolCall", name: "skill", arguments: { id: "gitnexus" } } } },
      { data: { item: { type: "toolCall", name: "skill", input: { name: "agentmemory" } } } },
      { data: { item: { type: "toolCall", name: "blender:render" } } },
    ];

    const seq = extractSkillSequence(events);
    expect(seq).toEqual(["gitnexus", "gitnexus", "agentmemory", "blender"]);

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

  it("recordSkillSwitchMetric stores record and getSkillSwitchStats calculates correlation with outcome", () => {
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
      skills: ["gitnexus", "agentmemory"],
      outcome: "accepted",
      now: now - 4000,
    });

    // Task 3: 3 switches, failed
    recordSkillSwitchMetric(db, {
      attemptId: "att_3",
      taskId: "task_3",
      projectId: "proj_1",
      skills: ["gitnexus", "agentmemory", "blender", "gitnexus"],
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

    const stats = getSkillSwitchStats(db, now - 10_000, now + 10_000);
    expect(stats).not.toBeNull();
    expect(stats!.totalTasks).toBe(4);
    // 0 + 1 + 3 + 4 = 8 switches / 4 = 2.0 avg
    expect(stats!.avgSwitches).toBe(2);

    // low switch (<=1): 2 tasks (0 switches, 1 switch), 0 failed -> 0%
    expect(stats!.lowSwitchTotal).toBe(2);
    expect(stats!.lowSwitchFailures).toBe(0);
    expect(stats!.lowSwitchFailRate).toBe(0);

    // high switch (>=2): 2 tasks (3 switches, 4 switches), 2 failed -> 100%
    expect(stats!.highSwitchTotal).toBe(2);
    expect(stats!.highSwitchFailures).toBe(2);
    expect(stats!.highSwitchFailRate).toBe(1.0);

    const morningLine = skillSwitchMorningLine(db, now);
    expect(morningLine).toContain("Метрика переключения навыков: оценено 4 задач, в среднем 2 переключений");
    expect(morningLine).toContain("провал: 0% при 0-1 переключениях vs 100% при 2+");
  });

  it("skillSwitchMorningLine returns null when no metric rows in window", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(skillSwitchMorningLine(db)).toBeNull();
  });
});
