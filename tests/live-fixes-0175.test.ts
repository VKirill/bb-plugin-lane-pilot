import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createRun, createTask, listStageReceipts, openDatabase } from "../src/rooms/storage/database";
import { recordStage } from "../src/server/stage-records";
import { previousAttemptBrief } from "../src/server/writer-task";

// Fixes found by the live scenario matrix in the sandbox on 2026-10-07.

it("D5: an updated task records plan critique again over its finished receipt", () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb", "/repo");
  for (const state of ["skipped", "passed", "blocked"] as const) {
    const taskId = `t-${state}`;
    createTask(db, { id: taskId, runId: "run", kind: "bb", contract: { id: taskId } as never });
    recordStage(db, { runId: "run", taskId, stageId: "plan-critique", state: "pending", input: "old plan" });
    if (state === "passed") recordStage(db, { runId: "run", taskId, stageId: "plan-critique", state: "running", input: "old plan" });
    recordStage(db, { runId: "run", taskId, stageId: "plan-critique", state, input: "old plan" });
    expect(() => recordStage(db, { runId: "run", taskId, stageId: "plan-critique", state: "pending", input: "new plan", replaceOnNewInput: true, restart: true })).not.toThrow();
    expect(listStageReceipts(db, "run", taskId).find((row) => row.stageId === "plan-critique")?.state).toBe("pending");
  }
});

it("C2: a stray file that was clean before the attempt is named for deletion or checkout", () => {
  const brief = previousAttemptBrief({ status: "validation_failed", reason: "writer changed paths outside owns_paths or inside never_touch: notes/side.md, src/owner.js" },
    { owns_paths: ["notes/mine.md"], never_touch: [] }, [{ path: "src/owner.js" }]);
  expect(brief).toContain("notes/side.md had no uncommitted changes before your attempt → delete it you created");
  expect(brief).not.toMatch(/src\/owner\.js had no uncommitted/);
  expect(brief).toContain("do not git checkout/restore the file");
});
