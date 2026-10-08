import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createRun, createTask, openDatabase, saveStageReceipt } from "../src/rooms/storage/database";

const SHA = "a".repeat(64);

/** The screen must stay small however much history a project has: stage bodies and old runs load on demand. */
async function seeded(runs: number, stagesPerRun: number, bodyBytes: number) {
  const projectId = "proj_screen_payload";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  for (let r = 0; r < runs; r++) {
    const runId = `lprun_${String(r).padStart(3, "0")}`;
    createRun(db, runId, projectId);
    db.prepare("UPDATE lane_pilot_run SET created_at=?, updated_at=?, closed_at=? WHERE id=?").run(1_000 + r, 1_000 + r, r === 0 ? null : 2_000 + r, runId);
    createTask(db, { id: `task-${r}`, runId, kind: "bb", contract: {} });
    for (let s = 0; s < stagesPerRun; s++) {
      saveStageReceipt(db, {
        runId, taskId: `task-${r}`, stageId: s % 2 ? "verification" : "writer-agent", contractVersion: 1, state: "passed",
        inputSha256: SHA, outputSha256: SHA, attempt: 0, providerId: null, model: null, threadId: null,
        result: { body: "x".repeat(bodyBytes), at: s }, reason: null, updatedAt: 1,
      });
    }
  }
  await plugin(bb);
  return { harness, projectId };
}

describe("get_screen payload", () => {
  it("keeps stage result bodies out and caps the run history", async () => {
    const { harness, projectId } = await seeded(25, 2, 200_000);
    const raw = await harness.behavior.callRpc("get_screen", { projectId });
    const screen = raw as { runs: Array<{ id: string; stageCount: number }>; runsTotal: number; runsLimit: number };
    expect(JSON.stringify(raw).length).toBeLessThan(200_000);
    expect(screen.runsTotal).toBe(25);
    expect(screen.runs.length).toBe(screen.runsLimit + 1);
    expect(screen.runs.some((run) => run.id === "lprun_000")).toBe(true);
    expect(screen.runs.every((run) => run.stageCount === 2)).toBe(true);
    const listed = await harness.behavior.callRpc("list_run_stages", { runId: "lprun_024" }) as { stages: Array<Record<string, unknown>> };
    expect(listed.stages.map((stage) => stage.stageId)).toEqual(["verification", "writer-agent"]);
    for (const stage of listed.stages) {
      expect(stage).not.toHaveProperty("result");
      expect(stage.hasResult).toBe(true);
    }
    await harness.lifecycle.dispose();
  });

  it("returns one stage body on demand and pages older runs", async () => {
    const { harness, projectId } = await seeded(25, 2, 1_000);
    const loaded = await harness.behavior.callRpc("get_stage_result", { runId: "lprun_024", taskId: "task-24", stageId: "writer-agent" }) as { found: boolean; result: { body: string } | null };
    expect(loaded.found).toBe(true);
    expect(loaded.result?.body.length).toBe(1_000);
    expect(await harness.behavior.callRpc("get_stage_result", { runId: "lprun_024", taskId: "task-24", stageId: "browser-qa" })).toEqual({ found: false, result: null });
    const page = await harness.behavior.callRpc("list_runs", { projectId, offset: 10, limit: 20 }) as { runs: Array<{ id: string }>; total: number };
    expect(page.total).toBe(25);
    expect(page.runs.map((run) => run.id)).toEqual(Array.from({ length: 15 }, (_, i) => `lprun_${String(14 - i).padStart(3, "0")}`));
    await harness.lifecycle.dispose();
  });
});
