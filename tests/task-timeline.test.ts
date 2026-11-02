import { timelineArgs } from "../src/rooms/tools/server/cli";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { appendGateEvaluation, createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/storage/database";
import { recordStage } from "../src/rooms/runs/server";
import { renderTimeline, taskTimeline } from "../src/rooms/runs";

const contract = {
  schema_version: 2, id: "t1", title: "t", display_title: "t", kind: "feature", area: "a", risk: "low", lane: "writer",
  project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.txt"],
  owns_paths: ["a.txt"], never_touch: [], depends_on: [], objective: "o", acceptance: ["a"], verify: "none", verification: [],
};

describe("bb lane-pilot timeline: one task's record in time order (post-mortem of cab-unslop, 2026-10-31)", () => {
  it("merges the task, its attempts, every state move with its reason, stage and gate events, and names the current receipts", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-1", "P");
    createTask(db, { id: "t1", runId: "run-1", kind: "bb", contract });
    recordStage(db, { runId: "run-1", taskId: "t1", stageId: "plan-critique", state: "passed", input: "plan" });
    createAttempt(db, { id: "a1", runId: "run-1", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "spawn_rejected", { reason: "writer_provider_unavailable:owner_present:claude-code used by the owner 1 min ago on OVH" });
    transitionAttempt(db, "a1", "blocked", { reason: "writer_provider_unavailable:owner_present:claude-code used by the owner 1 min ago on OVH" });
    createAttempt(db, { id: "a2", runId: "run-1", taskId: "t1" });
    transitionAttempt(db, "a2", "spawn_requested");
    transitionAttempt(db, "a2", "running", { threadId: "thr-w" });
    appendGateEvaluation(db, { projectId: "P", runId: "run-1", taskId: "t1", gate: "validate", status: "passed", inputSha256: "x", outputSha256: null, attempt: 2, occurredAt: Date.now() });
    transitionAttempt(db, "a2", "accepted");

    const timeline = taskTimeline(db, "t1");
    expect(timeline.runId).toBe("run-1");
    const texts = timeline.entries.map((entry) => entry.text);
    expect(texts[0]).toBe("task arrived (pm)");
    expect(texts).toContain("attempt 1 created");
    expect(texts).toContain("attempt 1: spawn_requested → spawn_rejected: writer_provider_unavailable:owner_present:claude-code used by the owner 1 min ago on OVH");
    expect(texts).toContain("attempt 2: running → accepted");
    expect(texts).toContain("stage plan-critique passed");
    expect(texts).toContain("gate validate passed (attempt 2)");
    expect(timeline.entries.map((entry) => entry.at)).toEqual([...timeline.entries.map((entry) => entry.at)].sort((a, b) => a - b));
    expect(timeline.receipts).toEqual([expect.objectContaining({ stageId: "plan-critique", state: "passed" })]);

    const text = renderTimeline(timeline);
    expect(text).toMatch(/^task t1 · run run-1 · times UTC\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}  task     task arrived \(pm\)/);
    expect(text).toContain("stages now:\n  plan-critique      passed");
    expect(text).toContain("plugin.log");
  });

  it("answers for a task it does not know, and picks the run asked for", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(renderTimeline(taskTimeline(db, "ghost"))).toBe("no task ghost on record");
    createRun(db, "run-1", "P");
    createTask(db, { id: "t1", runId: "run-1", kind: "bb", contract });
    expect(taskTimeline(db, "t1", "run-2").runId).toBeNull();
    expect(taskTimeline(db, "t1", "run-1").runId).toBe("run-1");
  });
});

describe("bb lane-pilot timeline arguments", () => {
  it("takes the task id with and without --run", () => {
    expect(timelineArgs(["task-a"])).toEqual({ taskId: "task-a", runId: undefined });
    expect(timelineArgs(["task-a", "--json"])).toEqual({ taskId: "task-a", runId: undefined });
    expect(timelineArgs(["--run", "run-1", "task-a"])).toEqual({ taskId: "task-a", runId: "run-1" });
    expect(timelineArgs(["task-a", "--run", "run-1"])).toEqual({ taskId: "task-a", runId: "run-1" });
  });
});
