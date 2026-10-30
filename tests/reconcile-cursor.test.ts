import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { reconcile, reconcileCursor } from "../src/rooms/stability";
import type { IdempotencyTriple, ReconcilePort } from "../src/rooms/stability/reconcile";
import { closeOrphanWriterStages, recordStage } from "../src/rooms/runs/server/stage-records";
import { createAttempt, createRun, getAttempt, openDatabase, saveTaskPlan, transitionAttempt } from "../src/rooms/storage/database";

const key: IdempotencyTriple = { lanePilotRunId: "run", lanePilotTaskId: "T1", attemptId: "a1" };

/** Pages of one thread id each. The match sits on the last full page, past a scan that dies on page 1. */
function pages(ids: string[]): ReconcilePort["list"] {
  return async ({ offset, limit }) => {
    const start = offset;
    const slice = ids.slice(start, start + limit);
    return slice.map((id) => ({ id }));
  };
}

describe("reconcile cursor", () => {
  it("continues from the saved page on a new connection to the same database and does not drop the retry", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1)").run();
    saveTaskPlan(db, "T1", "Fix the hero");
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
      recordStage(db, { runId: "run", taskId: "T1", stageId, state: "pending", input: "Fix the hero" });
    }
    recordStage(db, { runId: "run", taskId: "T1", stageId: "writer-agent", state: "running", input: "Fix the hero" });
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running");
    transitionAttempt(db, "a1", "empty_output", { reason: "writer changed no files" });

    const ids = ["t0", "t1", "t2", "t3", "t4"];
    let calls = 0;
    const dying: ReconcilePort = {
      list: async (query) => {
        calls += 1;
        if (calls === 2) throw new Error("plugin reload");
        return pages(ids)(query);
      },
      metadata: async (id) => (id === "t4" ? key : {}),
    };
    const first = await reconcile(dying, key, { limit: 1, maxPages: 10, cursor: reconcileCursor(db, "a1", "writer") });
    expect(first).toEqual({ kind: "error", message: "plugin reload" });
    const saved = (db.prepare("SELECT page FROM lane_pilot_reconcile_cursor WHERE attempt_id=?").get("a1") as { page: number }).page;
    expect(saved).toBeGreaterThan(0);

    const db2 = new Database(db.name, { readonly: false });
    expect(closeOrphanWriterStages(db2 as never, new Set())).toBe(0);
    expect(getAttempt(db, "a1")?.state).toBe("empty_output");
    expect(getAttempt(db, "a1")?.reason ?? "").not.toContain("lost in a plugin reload");

    const seen: number[] = [];
    const again = await reconcile({
      list: async (query) => { seen.push(query.offset); return pages(ids)(query); },
      metadata: async (id) => (id === "t4" ? key : {}),
    }, key, { limit: 1, maxPages: 10, cursor: reconcileCursor(db2 as never, "a1", "writer") });
    expect(seen[0]).toBe(saved);
    expect(again).toEqual({ kind: "found", threadId: "t4" });
    expect(db2.prepare("SELECT page FROM lane_pilot_reconcile_cursor WHERE attempt_id=?").get("a1")).toBeUndefined();
    db2.close();
  });
});
