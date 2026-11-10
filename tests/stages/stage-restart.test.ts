import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRun, createTask, listStageReceipts, openDatabase } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server/stage-records";

describe("stage restart", () => {
  it("starts a blocked stage over only when asked, and never a passed one", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "bb", "/p");
    createTask(db, { id:"t", runId:"run", kind:"bb", contract:{} as never });
    const base = { runId:"run", taskId:"t", stageId:"browser-qa" as const, input:"{}" };
    recordStage(db, { ...base, state:"blocked", reason:"browser_qa_host_required" });
    expect(() => recordStage(db, { ...base, state:"pending" })).toThrow(/illegal stage transition/);
    recordStage(db, { ...base, state:"pending", restart:true });
    expect(listStageReceipts(db, "run", "t").find((row) => row.stageId === "browser-qa")?.state).toBe("pending");
    recordStage(db, { ...base, state:"running" });
    recordStage(db, { ...base, state:"passed" });
    expect(() => recordStage(db, { ...base, state:"pending", restart:true })).toThrow(/illegal stage transition/);
    await harness.lifecycle.dispose();
  });

  // feed-gen 2026-11-10: the first writer's session died, every other writer was held, and the wait threw «running -> pending».
  it("lets the writer's stage wait again after a session, and no other stage", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "bb", "/p");
    createTask(db, { id:"t", runId:"run", kind:"bb", contract:{} as never });
    const writer = { runId:"run", taskId:"t", stageId:"writer-agent" as const, input:"plan" };
    recordStage(db, { ...writer, state:"pending" });
    recordStage(db, { ...writer, state:"running" });
    recordStage(db, { ...writer, state:"pending", reason:"waiting_writer: every writer is held" });
    expect(listStageReceipts(db, "run", "t").find((row) => row.stageId === "writer-agent")?.state).toBe("pending");
    const other = { runId:"run", taskId:"t", stageId:"verification" as const, input:"{}" };
    recordStage(db, { ...other, state:"pending" });
    recordStage(db, { ...other, state:"running" });
    expect(() => recordStage(db, { ...other, state:"pending" })).toThrow(/illegal stage transition/);
    await harness.lifecycle.dispose();
  });
});
