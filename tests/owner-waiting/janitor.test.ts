import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { closeRun, createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";
import {
  closeOwnerItem, collectOwnerWaiting, OWNER_FACT_TTL_MS, OWNER_NOTE_TTL_MS, ownerWaitingCounts, postOwnerItem, sweepOwnerItems,
} from "../../src/rooms/owner-waiting";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import { ownerWaitingRpc } from "../../src/rooms/owner-waiting/server/rpc";
import { writerQuestionSweep } from "../../src/rooms/writer/server";
import { runGoalSweep } from "../../src/rooms/run-goal/server";
import { phaseWordSweep } from "../../src/rooms/phase/server";
import { scheduleFailureSweep } from "../../src/rooms/schedule/server";
import type { PostOwnerItem } from "../../src/rooms/owner-waiting";

const T = Date.UTC(2026, 9, 30, 10, 0, 0);

function db() {
  return openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
}
function item(key: string, extra: Partial<PostOwnerItem> = {}): PostOwnerItem {
  return { key, source: "writer", kind: "question", what: `what of ${key}`, why: `why of ${key}`, ...extra };
}
const OWNER_ITEM_SWEEPS = [writerQuestionSweep, runGoalSweep, phaseWordSweep, scheduleFailureSweep];
const openKeys = (database: ReturnType<typeof db>, now: number) => collectOwnerWaiting(database, now, OWNER_ITEM_SWEEPS).items.map((row) => row.key);
const rowOf = (database: ReturnType<typeof db>, key: string) =>
  database.prepare("SELECT * FROM lane_pilot_owner_item WHERE key=?").get(key) as
    { state: string; what: string; created_at: number; closed_at: number | null; closed_by: string | null } | undefined;

describe("the owner-list janitor", () => {
  it("[SWE-2 F-005, Gemini F-006.2] a writer's question dies with the task it asked about, and only then", () => {
    const database = db();
    createRun(database, "run1", "proj_1");
    createTask(database, { id: "task1", runId: "run1", kind: "bb", contract: {} });
    createAttempt(database, { id: "att1", runId: "run1", taskId: "task1" });
    transitionAttempt(database, "att1", "blocked", { reason: "waits for the owner" });
    database.prepare("UPDATE lane_pilot_attempt SET created_at=? WHERE id=?").run(T - 1_000, "att1");
    postOwnerItem(database, item("writer-question:run1:task1"), T);
    // The latest attempt is still the blocked one the row was born from: it stays.
    expect(openKeys(database, T + 1_000)).toEqual(["writer-question:run1:task1"]);

    // A newer attempt for the same task: the question was superseded.
    createAttempt(database, { id: "att2", runId: "run1", taskId: "task1" });
    database.prepare("UPDATE lane_pilot_attempt SET created_at=? WHERE id=?").run(T + 1_000, "att2");
    expect(openKeys(database, T + 2_000)).toEqual([]);
    expect(rowOf(database, "writer-question:run1:task1")?.closed_by).toBe("janitor:task moved on");
  });

  it("[SWE-2 F-005, Gemini F-006.2] a writer's question dies when the blocked attempt moved on", () => {
    const database = db();
    createRun(database, "run2", "proj_1");
    createTask(database, { id: "task2", runId: "run2", kind: "bb", contract: {} });
    createAttempt(database, { id: "att3", runId: "run2", taskId: "task2" });
    transitionAttempt(database, "att3", "blocked", { reason: "waits" });
    database.prepare("UPDATE lane_pilot_attempt SET created_at=? WHERE id=?").run(T - 1_000, "att3");
    postOwnerItem(database, item("writer-question:run2:task2"), T);
    // The owner answered: the same attempt left `blocked` — no newer row needed for the sweep.
    transitionAttempt(database, "att3", "running", { reason: "owner answered" });
    expect(openKeys(database, T + 1_000)).toEqual([]);
  });

  it("[SWE-2 F-006, Gemini F-006.3] a run goal dies with its run", () => {
    const database = db();
    createRun(database, "run3", "proj_1");
    postOwnerItem(database, item("run-goal:run3", { source: "run-goal" }), T);
    expect(openKeys(database, T + 1_000)).toEqual(["run-goal:run3"]);
    closeRun(database, "run3", "sweep");
    expect(openKeys(database, T + 2_000)).toEqual([]);
    expect(rowOf(database, "run-goal:run3")?.closed_by).toBe("janitor:run closed");
  });

  it("[Gemini F-006.1] a phase's word dies when the phase stops or disappears, and lives while it is active", () => {
    const database = db();
    insertPhase(database, { id: "ph1", projectId: "proj_1", pmThreadId: "thr_pm", title: "Phase one", goal: "ship it", at: T });
    postOwnerItem(database, item("phase-word:ph1:7", { source: "phase" }), T);
    postOwnerItem(database, item("phase-word:ph2:3", { source: "phase" }), T);
    // Only the live phase keeps its word: ph2 has no row at all and is closed on the first read.
    expect(openKeys(database, T + 1_000)).toEqual(["phase-word:ph1:7"]);
    savePhase(database, "ph1", { state: "stopped", at: T + 1_000 });
    expect(openKeys(database, T + 2_000)).toEqual([]);
    insertPhase(database, { id: "ph3", projectId: "proj_1", pmThreadId: "thr_pm", title: "Phase three", goal: "ship it", at: T + 3_000 });
    savePhase(database, "ph3", { state: "closed", at: T + 3_500 });
    postOwnerItem(database, item("phase-word:ph3:1", { source: "phase" }), T + 4_000);
    // [Gemini F-006.1 remainder, 0.1.462] the lesson draft is asked as the phase closes: a closed phase is its normal state, the janitor leaves it.
    postOwnerItem(database, item("phase-word:ph3:lesson", { source: "phase" }), T + 4_000);
    expect(openKeys(database, T + 5_000)).toEqual(["phase-word:ph3:lesson"]);
  });

  it("[SWE-2 F-004, Gemini F-006.4] a row without actions dies after its term, a row with actions never does", () => {
    const database = db();
    postOwnerItem(database, item("fact:1", { kind: "acted" }), T);                    // a fact: 3 days
    postOwnerItem(database, item("note:1", { kind: "question" }), T);                 // another notice: 7 days
    postOwnerItem(database, item("act:1", { actions: [{ id: "yes", label: "Yes", cli: "echo yes" }] }), T);
    expect(sweepOwnerItems(database, T + OWNER_FACT_TTL_MS)).toBe(0);                 // a day before the fact's term: nothing
    expect(sweepOwnerItems(database, T + OWNER_FACT_TTL_MS + 1)).toBe(1);             // the fact is closed
    expect(openKeys(database, T + OWNER_FACT_TTL_MS + 1).sort()).toEqual(["act:1", "note:1"]);
    expect(rowOf(database, "fact:1")?.closed_by).toBe("janitor:term");
    sweepOwnerItems(database, T + OWNER_NOTE_TTL_MS + 1);
    expect(rowOf(database, "note:1")?.closed_by).toBe("janitor:term");
    expect(rowOf(database, "act:1")?.state).toBe("open");                             // a row with a button is never timed out
  });

  it("[SWE-2 N-002] a janitor-closed key reopens on a new post; an owner-closed key is a tombstone", () => {
    const database = db();
    for (const by of ["janitor:term", "run-goal:passed"]) {
      const key = `k:${by}`;
      postOwnerItem(database, item(key, { what: "old text" }), T);
      closeOwnerItem(database, key, by, T + 1);
      const posted = postOwnerItem(database, item(key, { what: "new text" }), T + 2);
      expect(posted.created, by).toBe(true);
      const row = rowOf(database, key)!;
      expect(row).toMatchObject({ state: "open", what: "new text", created_at: T + 2, closed_at: null, closed_by: null });
    }
    for (const by of ["owner", "screen", "agent"]) {
      const key = `k:${by}`;
      postOwnerItem(database, item(key, { what: "old text" }), T);
      closeOwnerItem(database, key, by, T + 1);
      expect(postOwnerItem(database, item(key, { what: "new text" }), T + 2).created).toBe(false);
      expect(rowOf(database, key)).toMatchObject({ state: "closed", what: "old text", closed_by: by });
    }
  });

  it("[SWE-2 F-004 counts] ownerWaitingCounts runs the sweep: an expired fact is not counted in inbox", () => {
    const database = db();
    postOwnerItem(database, item("fact:2", { kind: "acted" }), T);
    expect(ownerWaitingCounts(database, T + 1_000).inbox).toBe(1);
    expect(ownerWaitingCounts(database, T + OWNER_FACT_TTL_MS + 1).inbox).toBe(0);
    expect(rowOf(database, "fact:2")?.state).toBe("closed");
  });

  it("[Astra U-001] a row with no action gets «Прочитано» closing it as the screen's; one with actions keeps them", async () => {
    const database = db();
    postOwnerItem(database, item("read:1"), T);
    postOwnerItem(database, item("kept:1", { actions: [{ id: "yes", label: "Yes", cli: "echo yes" }] }), T);
    const waiting = collectOwnerWaiting(database, T + 1);
    const bare = waiting.items.find((row) => row.key === "read:1")!;
    expect(bare.actions).toHaveLength(1);
    expect(bare.actions[0]).toMatchObject({ id: "read", label: "Прочитано", rpc: { method: "owner_waiting_close", input: { key: "read:1" } } });
    const kept = waiting.items.find((row) => row.key === "kept:1")!;
    expect(kept.actions.map((action) => action.id)).toEqual(["yes"]);

    const rpc = ownerWaitingRpc(database);
    await expect(rpc.owner_waiting_close({ key: "read:1" })).resolves.toEqual({ closed: true });
    expect(rowOf(database, "read:1")).toMatchObject({ state: "closed", closed_by: "screen" });
    await expect(rpc.owner_waiting_close({ key: "read:1" })).resolves.toEqual({ closed: false });
  });
});
