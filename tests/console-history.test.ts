import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { insertMemoryRecord } from "@lane-pilot/memory-core";
import { rpcConsole } from "../src/rooms/contracts/rpc-console";
import { createCore } from "../src/rooms/core/server/core";
import { lessonForTask } from "../src/rooms/memory/server";
import { openDatabase } from "../src/rooms/plugin-db";
import { mergeShaOf, upsertAttemptChange } from "../src/rooms/rollback/server";
import { runsConsoleRpc, taskHistory } from "../src/rooms/runs/server";
import { specialistOverview } from "../src/rooms/specialist/server";
import { createAttempt, createRun, createTask, setRunSettingsScopes } from "../src/rooms/storage";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function setAttemptTimes(
  db: ReturnType<typeof openDatabase>,
  attemptId: string,
  state: string,
  createdAt: number,
  updatedAt: number,
  reason: string | null = null,
) {
  db.prepare("UPDATE lane_pilot_attempt SET state = ?, created_at = ?, updated_at = ?, reason = ? WHERE id = ?")
    .run(state, createdAt, updatedAt, reason, attemptId);
}

describe("taskHistory", () => {
  it("pages 45 seeded tasks cleanly with limit 20, handles ties, filters by outcome/project/section, and enriches fields", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    const baseNow = Date.parse("2026-11-27T12:00:00.000Z");
    createRun(db, "run-a", "proj-1");
    setRunSettingsScopes(db, "run-a", ["section:sec-a"]);
    createRun(db, "run-b", "proj-2");
    setRunSettingsScopes(db, "run-b", ["section:sec-b"]);

    // Seed 45 terminal tasks across outcomes:
    // index 1..45; tie finishedAt for pairs (44,45) to verify task_id DESC tie-breaking.
    const expectedOrder: string[] = [];
    for (let i = 1; i <= 45; i += 1) {
      const taskId = `task-${String(i).padStart(2, "0")}`;
      const runId = i % 5 === 4 ? "run-b" : "run-a";
      const finishedAt = baseNow - (46 - (i === 45 ? 44 : i)) * 60_000;
      const createdAt = finishedAt - 30_000;

      createTask(db, {
        id: taskId,
        runId,
        kind: "bb",
        contract: i === 45 ? { display_title: "Latest task display" } : { title: `Title ${taskId}` },
      });

      const mod = i % 4;
      if (mod === 0) {
        // Reworked (2 attempts -> accepted)
        createAttempt(db, { id: `att-${taskId}-1`, runId, taskId });
        setAttemptTimes(db, `att-${taskId}-1`, "validation_failed", createdAt, createdAt + 10_000, "lint failed");
        createAttempt(db, { id: `att-${taskId}-2`, runId, taskId });
        setAttemptTimes(db, `att-${taskId}-2`, "accepted", createdAt + 12_000, finishedAt, null);
        upsertAttemptChange(db, { attemptId: `att-${taskId}-2`, runId, taskId }, { mergeCommit: `sha-${taskId}` }, finishedAt);
      } else if (mod === 1) {
        // Accepted on first try
        createAttempt(db, { id: `att-${taskId}-1`, runId, taskId });
        setAttemptTimes(db, `att-${taskId}-1`, "accepted", createdAt, finishedAt, null);
        if (i === 45) {
          db.prepare("UPDATE lane_pilot_attempt SET thread_id = ? WHERE id = ?").run("thr-cost", `att-${taskId}-1`);
        }
        upsertAttemptChange(db, { attemptId: `att-${taskId}-1`, runId, taskId }, { mergeCommit: `sha-${taskId}` }, finishedAt);
      } else if (mod === 2) {
        // Canceled
        createAttempt(db, { id: `att-${taskId}-1`, runId, taskId });
        setAttemptTimes(db, `att-${taskId}-1`, "canceled", createdAt, finishedAt, "owner stopped");
      } else {
        // Failed
        createAttempt(db, { id: `att-${taskId}-1`, runId, taskId });
        setAttemptTimes(db, `att-${taskId}-1`, "blocked", createdAt, finishedAt, `boom-${taskId}`);
      }
      expectedOrder.push(taskId);
    }

    // Active task must be excluded from history.
    createTask(db, { id: "task-live", runId: "run-a", kind: "bb", contract: { display_title: "Still running" } });
    createAttempt(db, { id: "att-live", runId: "run-a", taskId: "task-live" });
    setAttemptTimes(db, "att-live", "running", baseNow - 5_000, baseNow - 1_000, null);

    // Cost measurement for task-45 via token cursor + model.
    db.prepare(
      "INSERT INTO lane_pilot_token_cursor(thread_id,project_id,provider_id,last_model,last_provider,total_json,updated_at) VALUES(?,?,?,?,?,?,?)",
    ).run(
      "thr-cost",
      "proj-1",
      "codex",
      "gpt-6-luna",
      "codex",
      JSON.stringify({ input: 1_000_000, output: 100_000, cached: 400_000, total: 1_100_000, cacheRead: 400_000, cacheWrite: 0 }),
      baseNow,
    );

    // Lesson memory record linked to task-43 via origin_task_id.
    insertMemoryRecord(db as never, {
      id: "mem-lesson-43",
      projectId: "proj-1",
      kind: "note",
      content: "Lesson learned from task-43",
      conceptsJson: JSON.stringify(["lesson"]),
      sourceSha256: "sha256-43",
      createdAt: baseNow,
      origin: "maintainer",
    });
    db.prepare("UPDATE lane_pilot_memory SET origin_task_id = ? WHERE id = ?").run("task-43", "mem-lesson-43");

    // Verify helper public APIs directly.
    expect(mergeShaOf(db, "att-task-45-1")).toBe("sha-task-45");
    expect(mergeShaOf(db, "att-task-42-1")).toBeNull();
    expect(lessonForTask(db, "task-43")).toBe("mem-lesson-43");
    expect(lessonForTask(db, "task-45")).toBeNull();

    // Expected order: (finished_at DESC, task_id DESC) => task-45 before task-44 (same ts), then 43..01.
    expectedOrder.reverse();

    const warnings: string[] = [];
    const debugs: string[] = [];
    const log = { warn: (m: string) => warnings.push(m), debug: (m: string) => debugs.push(m) };

    const p1 = taskHistory(db, { limit: 20 }, baseNow, { log });
    expect(p1.rows).toHaveLength(20);
    expect(p1.nextCursor).not.toBeNull();

    const p2 = taskHistory(db, { limit: 20, cursor: p1.nextCursor! }, baseNow, { log });
    expect(p2.rows).toHaveLength(20);
    expect(p2.nextCursor).not.toBeNull();

    const p3 = taskHistory(db, { limit: 20, cursor: p2.nextCursor! }, baseNow, { log });
    expect(p3.rows).toHaveLength(5);
    expect(p3.nextCursor).toBeNull();

    const allRows = [...p1.rows, ...p2.rows, ...p3.rows];
    expect(allRows.map((r) => r.taskId)).toEqual(expectedOrder);
    expect(new Set(allRows.map((r) => r.taskId)).size).toBe(45);
    expect(allRows.some((r) => r.taskId === "task-live")).toBe(false);

    // Check enriched fields on specific rows.
    const row45 = p1.rows[0]!;
    expect(row45).toMatchObject({
      runId: "run-a",
      taskId: "task-45",
      projectId: "proj-1",
      title: "Latest task display",
      outcome: "accepted",
      attempts: 1,
      durationMs: 30_000,
      mergeSha: "sha-task-45",
      failureReason: null,
      lessonMemoryId: null,
    });
    expect(row45.costUsd).toBeCloseTo(0.114, 6);

    const row44 = p1.rows[1]!;
    expect(row44).toMatchObject({
      taskId: "task-44",
      outcome: "reworked",
      attempts: 2,
      durationMs: 30_000,
      costUsd: null,
      mergeSha: "sha-task-44",
      failureReason: null,
    });

    const row43 = p1.rows[2]!;
    expect(row43).toMatchObject({
      taskId: "task-43",
      outcome: "failed",
      attempts: 1,
      mergeSha: null,
      failureReason: "boom-task-43",
      lessonMemoryId: "mem-lesson-43",
    });

    // Outcome filter keeps pages full across sparse batches (45 tasks, ~11 failed, limit 5 -> 5 + 5 + 1).
    const failedP1 = taskHistory(db, { outcome: "failed", limit: 5 }, baseNow, { log });
    expect(failedP1.rows).toHaveLength(5);
    expect(failedP1.rows.every((r) => r.outcome === "failed")).toBe(true);
    expect(failedP1.nextCursor).not.toBeNull();

    const failedP2 = taskHistory(db, { outcome: "failed", limit: 5, cursor: failedP1.nextCursor! }, baseNow, { log });
    expect(failedP2.rows).toHaveLength(5);
    expect(failedP2.rows.every((r) => r.outcome === "failed")).toBe(true);
    expect(failedP2.nextCursor).not.toBeNull();

    const failedP3 = taskHistory(db, { outcome: "failed", limit: 5, cursor: failedP2.nextCursor! }, baseNow, { log });
    expect(failedP3.rows).toHaveLength(1);
    expect(failedP3.nextCursor).toBeNull();
    expect([...failedP1.rows, ...failedP2.rows, ...failedP3.rows].map((r) => r.taskId)).toEqual(
      expectedOrder.filter((id) => Number(id.slice(5)) % 4 === 3),
    );

    // Project & section narrowing.
    const proj2 = taskHistory(db, { projectId: "proj-2", limit: 50 }, baseNow);
    expect(proj2.rows).toHaveLength(9);
    expect(proj2.rows.every((r) => r.projectId === "proj-2")).toBe(true);

    const secB = taskHistory(db, { sectionId: "sec-b", limit: 50 }, baseNow);
    expect(secB.rows).toHaveLength(9);

    // Bad cursor falls back to first page and logs warning.
    const bad1 = taskHistory(db, { limit: 5, cursor: "not-a-valid-cursor!" }, baseNow, { log });
    const bad2 = taskHistory(db, { limit: 5, cursor: Buffer.from("invalid:task-1", "utf8").toString("base64url") }, baseNow, { log });
    expect(bad1.rows.map((r) => r.taskId)).toEqual(p1.rows.slice(0, 5).map((r) => r.taskId));
    expect(bad2.rows.map((r) => r.taskId)).toEqual(p1.rows.slice(0, 5).map((r) => r.taskId));
    expect(warnings.filter((w) => w === "[console] task_history bad cursor")).toHaveLength(2);
    expect(debugs[0]).toMatch(/^\[console\] task_history rows=20 next=true ms=\d+$/);
  });

  it("offers a retry only where the stage return will take it: a failed task of an open run", () => {
    // The History button used to show on accepted, canceled and closed-run rows, and the server refused each one.
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const now = Date.parse("2026-11-27T12:00:00.000Z");
    createRun(db, "run-open", "proj-1");
    createRun(db, "run-closed", "proj-1");
    const seed = (runId: string, taskId: string, state: string, at: number) => {
      createTask(db, { id: taskId, runId, kind: "bb", contract: { title: taskId } });
      createAttempt(db, { id: `att-${taskId}`, runId, taskId });
      setAttemptTimes(db, `att-${taskId}`, state, at - 10_000, at, state === "accepted" ? null : "why");
    };
    seed("run-open", "t-failed-open", "validation_failed", now - 1_000);
    seed("run-closed", "t-failed-closed", "validation_failed", now - 2_000);
    seed("run-open", "t-accepted", "accepted", now - 3_000);
    seed("run-open", "t-canceled", "canceled", now - 4_000);
    db.prepare("UPDATE lane_pilot_run SET closed_at = ? WHERE id = ?").run(now - 1_000, "run-closed");

    const rows = taskHistory(db, { projectId: "proj-1" }, now).rows;
    expect(Object.fromEntries(rows.map((row) => [row.taskId, row.canRetry]))).toEqual({
      "t-failed-open": true, "t-failed-closed": false, "t-accepted": false, "t-canceled": false,
    });
  });

  it("registers task_history in runsConsoleRpc and conforms to rpcConsole.task_history.output", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    createRun(db, "run-1", "proj-1");
    createTask(db, { id: "t-1", runId: "run-1", kind: "bb", contract: { display_title: "RPC task" } });
    createAttempt(db, { id: "a-1", runId: "run-1", taskId: "t-1" });
    setAttemptTimes(db, "a-1", "accepted", 1_000, 5_000, null);

    const ctx = createCore(bb, db);
    const warnSpy = vi.spyOn(bb.log, "warn");
    const handlers = runsConsoleRpc(ctx, {
      money: { status: () => ({}) },
      specialistOverview,
    });

    const out = await handlers.task_history({ limit: 10, cursor: "bad" });
    expect(rpcConsole.task_history.output.safeParse(out).success).toBe(true);
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]?.taskId).toBe("t-1");
    expect(out.nextCursor).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("[console] task_history bad cursor"));
  });
});
