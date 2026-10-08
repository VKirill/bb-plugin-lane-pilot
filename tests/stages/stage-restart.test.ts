import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRun, createTask, listStageReceipts, openDatabase } from "../../src/rooms/storage/database";
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
});
