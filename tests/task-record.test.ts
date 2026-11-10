import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../src/rooms/plugin-db";
import { recordStage } from "../src/rooms/runs/server";
import { blindRecord, readsBlind, renderTaskRecord, taskRecord } from "../src/rooms/tools/server/task-record";
import { contractSections } from "../src/rooms/writer/server/writer-task";

const contract = {
  schema_version: 2, id: "t1", title: "t", display_title: "Pay screen", kind: "feature", area: "a", risk: "low", lane: "writer",
  project_cwd: "/ws", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["a.txt"],
  owns_paths: ["a.txt"], never_touch: [], depends_on: ["t0"], objective: "show the card button", acceptance: ["the button is there"], verify: "none", verification: [],
};

describe("bb lane-pilot task: a task's record another agent reads (the read side of the hand-off standard)", () => {
  const seed = () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run-1", "P");
    createTask(db, { id: "t1", runId: "run-1", kind: "bb", contract });
    recordStage(db, { runId: "run-1", taskId: "t1", stageId: "plan-critique", state: "passed", input: "plan", threadId: "thr-critic", reason: "looks fine" } as never);
    createAttempt(db, { id: "a1", runId: "run-1", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr-w" });
    return db;
  };

  it("says what the task asked for, what is on record as done and what is left", () => {
    const record = taskRecord(seed(), "t1")!;
    const text = renderTaskRecord(record);
    expect(text).toContain("## What it asked for\nshow the card button\nacceptance:\n- the button is there\nowns_paths: a.txt");
    expect(text).toContain("depends_on: t0 (read each with bb lane-pilot task <id>)");
    expect(text).toContain("no change of an attempt is on record");
    expect(text).toContain("- plan-critique: passed");
    expect(text).toMatch(/## What is left\nthe task is \w+/);
    expect(text).toContain("@thread:thr-w");
    expect(taskRecord(seed(), "ghost")).toBeNull();
    const db = seed();
    createTask(db, { id: "t1.2", runId: "run-1", kind: "bb", contract: { ...contract, id: "t1.2" } });
    expect(renderTaskRecord(taskRecord(db, "t1")!)).toContain("This task was sent again as t1.2: its work is there (bb lane-pilot task t1.2).");
    expect(taskRecord(db, "t1.2")!.resentAs).toBeNull();
  });

  it("a judge of this task reads it blind: no other judge's verdict, no pointer to the writer's words", () => {
    const record = taskRecord(seed(), "t1")!;
    expect(readsBlind(record, "thr-w")).toBe(false);
    expect(readsBlind(record, undefined)).toBe(false);
    expect(readsBlind(record, "thr-critic")).toBe(true);
    const text = renderTaskRecord(blindRecord(record));
    expect(text).toContain("show the card button");
    expect(text).not.toMatch(/plan-critique|looks fine|thr-w|Acceptance against fact/);
  });

  it("the writer's brief names a dependency as a record to read, not a bare id", () => {
    const { inputs, boundaries } = contractSections(contract as never, false);
    expect(inputs).toContain("depends_on: t0 — accepted and merged into your workspace before you start.");
    expect(inputs).toContain("`bb lane-pilot task <id>`");
    expect(boundaries).not.toContain("depends_on");
  });
});
