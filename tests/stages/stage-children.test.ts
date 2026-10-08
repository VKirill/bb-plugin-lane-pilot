import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { claimStageSpawn, createRun, createTask, openDatabase } from "../../src/database";
import { createStageChildren } from "../../src/rooms/qa/server/children";
import { recordStage } from "../../src/server/stage-records";
import type { ServerCore } from "../../src/server/core";

// A project with more Lane Pilot threads than the scan reads (SelfyStudio passed 1000 on 2026-10-04).
async function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "project");
  createTask(db, { id:"task", runId:"run", kind:"bb", contract:{} });
  let listed = 0;
  const fakeBb = { sdk:{ threads:{
    list:async ({ limit, offset }:{limit:number;offset:number}) => { listed += 1; return Array.from({ length:limit }, (_, i) => ({ id:`thr_${offset + i}` })); },
    getPluginMetadata:async () => ({ role:"writer" }),
  } } };
  const children = createStageChildren({ bb:fakeBb, db } as unknown as ServerCore);
  return { db, children, harness, listed:() => listed };
}

describe("stage child reconcile", () => {
  it("does not scan the project's threads for a stage that never began spawning its child", async () => {
    const { db, children, harness, listed } = await setup();
    recordStage(db, { runId:"run", taskId:"task", stageId:"memory-maintenance", state:"pending", input:"{}" });
    recordStage(db, { runId:"run", taskId:"task", stageId:"memory-maintenance", state:"running", input:"{}", result:{ observing:"blocked" } });
    await expect(children.reconcileStageChild("project", "run", "task", "memory-maintenance", "memory-maintainer")).resolves.toEqual({ kind:"not_found" });
    expect(listed()).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("still scans for a child whose spawn began before its thread id was stored", async () => {
    const { db, children, harness, listed } = await setup();
    recordStage(db, { runId:"run", taskId:"task", stageId:"memory-maintenance", state:"pending", input:"{}" });
    recordStage(db, { runId:"run", taskId:"task", stageId:"memory-maintenance", state:"running", input:"{}" });
    expect(claimStageSpawn(db, "run", "task", "memory-maintenance")).toBe(true);
    await expect(children.reconcileStageChild("project", "run", "task", "memory-maintenance", "memory-maintainer")).resolves.toMatchObject({ kind:"blocked" });
    expect(listed()).toBeGreaterThan(0);
    await harness.lifecycle.dispose();
  });
});
