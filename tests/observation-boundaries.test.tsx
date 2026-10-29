/** @vitest-environment jsdom */
import { it, expect, afterEach, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createAttempt, createRun, createTask, openDatabase } from "../src/rooms/storage/database";
import { createCore } from "../src/rooms/core/server/core";
import { runsRpc } from "../src/rooms/runs/server/rpc/runs";
import { registerCli } from "../src/rooms/tools/server/cli";
import type { Services } from "../src/rooms/core/server/services";
import { setLocaleOverride } from "@lane-pilot/i18n";

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => { cleanup(); vi.useRealTimers(); });
function world() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const core = createCore(bb, db);
  registerCli(core, {} as Services);
  return { db, harness, handlers: runsRpc(core, {} as Services) };
}

it("follows the CLI's next cursor without skipping runs born in the same millisecond", async () => {
  const { db, harness } = world();
  try {
    for (const id of ["one", "two", "three"]) createRun(db, id, "p");
    db.prepare("UPDATE lane_pilot_run SET created_at=1000").run();
    const seen: string[] = [];
    let argv = ["state", "p", "--limit", "1"];
    for (let page = 0; page < 4; page++) {
      const result = await harness.behavior.runCli(argv);
      expect(result.exitCode).toBe(0);
      const body = JSON.parse(result.stdout!);
      seen.push(...body.runs.map((row: { id: string }) => row.id));
      if (!body.next) break;
      argv = body.next.split(" ").slice(2);
    }
    expect(seen.sort()).toEqual(["one", "three", "two"]);
    expect((await harness.behavior.runCli(["state", "p", "--before", "invalid"])).exitCode).not.toBe(0);
    // Existing timestamp-only cursors still mean strictly before that timestamp.
    const old = await harness.behavior.runCli(["state", "p", "--before", "1000"]);
    expect(JSON.parse(old.stdout!).runs).toEqual([]);
  } finally { await harness.lifecycle.dispose(); }
});

it("pages a large failure reason through the CLI without losing text or exceeding the bridge limit", async () => {
  const { db, harness } = world();
  try {
    createRun(db, "r", "p");
    createTask(db, { id: "t", runId: "r", kind: "bb", contract: {} });
    createAttempt(db, { id: "a", runId: "r", taskId: "t" });
    const reason = "Ошибка\n".repeat(150_000);
    db.prepare("UPDATE lane_pilot_attempt SET reason=? WHERE id='a'").run(reason);
    let argv = ["state", "p", "--attempt", "a"];
    let recovered = "";
    for (let page = 0; page < 100; page++) {
      const result = await harness.behavior.runCli(argv);
      expect(result.exitCode).toBe(0);
      expect(Buffer.byteLength(result.stdout!)).toBeLessThan(1_048_576);
      const body = JSON.parse(result.stdout!);
      expect(body.reason_chars).toBe(reason.length);
      expect(body.reason_offset).toBe(recovered.length);
      recovered += body.reason;
      if (!body.reason_next) break;
      expect(body.reason_truncated).toBe(true);
      argv = body.reason_next.split(" ").slice(2);
    }
    expect(recovered).toBe(reason);
    const bad = await harness.behavior.runCli(["state", "p", "--attempt", "a", "--reason-offset", "-1"]);
    expect(bad.exitCode).not.toBe(0);
  } finally { await harness.lifecycle.dispose(); }
});

it("shows the 201st unfinished task and the true progress after Show all", async () => {
  const { db, harness, handlers } = world();
  try {
    createRun(db, "many", "p");
    for (let i = 0; i < 201; i++) {
      createTask(db, { id: `t${i}`, runId: "many", kind: "bb", contract: { title: `Task ${i}` } });
      createAttempt(db, { id: `a${i}`, runId: "many", taskId: `t${i}` });
      db.prepare("UPDATE lane_pilot_task SET created_at=? WHERE id=?").run(i, `t${i}`);
      db.prepare("UPDATE lane_pilot_attempt SET state=? WHERE id=?").run(i < 200 ? "accepted" : "running", `a${i}`);
    }
    const app = await loadPluginApp(() => import("../app"));
    setLocaleOverride("en");
    const directive = app.messageDirectives.find((row) => row.id === "lane-run")!;
    const slot = renderSlot({ component: directive.component }, {
      attributes: { id: "many" }, source: '::lane-run{id="many"}',
      message: { id: "m", threadId: "th", turnId: null, projectId: "p" }, openWorkspaceFile: null,
    }, { rpc: { get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }), get_run_card: () => handlers.get_run_card({ runId: "many" }) } as never });
    const card = await slot.findByTestId("run-card");
    expect(card.textContent).toContain("200 of 201 tasks accepted");
    fireEvent.click(slot.getByTestId("run-card-toggle"));
    expect(card.querySelectorAll("li")).toHaveLength(201);
    expect(card.textContent).toContain("Task 200In progress");
  } finally { await harness.lifecycle.dispose(); }
});

it("selects the latest attempt by sequence when creation timestamps collide", async () => {
  const { db, harness, handlers } = world();
  try {
    createRun(db, "r", "p");
    createTask(db, { id: "t", runId: "r", kind: "bb", contract: {} });
    createAttempt(db, { id: "z_old", runId: "r", taskId: "t" });
    createAttempt(db, { id: "a_new", runId: "r", taskId: "t" });
    db.prepare("UPDATE lane_pilot_attempt SET created_at=1000,state=?,attempt_no=?,thread_id=? WHERE id=?").run("blocked", 1, "old-thread", "z_old");
    db.prepare("UPDATE lane_pilot_attempt SET created_at=1000,state=?,attempt_no=?,thread_id=? WHERE id=?").run("running", 2, "new-thread", "a_new");
    expect((await handlers.get_run_card({ runId: "r" }))!.tasks[0]).toMatchObject({ state: "running", threadId: "new-thread" });
  } finally { await harness.lifecycle.dispose(); }
});

it("shows a board read error, recovers, marks stale data and recovers again", async () => {
  await loadPluginApp(() => import("../app"));
  setLocaleOverride("en");
  const { TaskBoard } = await import("../src/rooms/runs/ui/task-board");
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let fail = true;
  const slot = renderSlot({ component: () => <TaskBoard locale="en" /> }, {}, { rpc: {
    task_board: () => { if (fail) throw new Error("fixture_offline"); return { items: [] }; },
    work_graph_strips: () => ({}),
  } as never });
  expect((await slot.findByTestId("board-offline")).textContent).toContain("Could not load tasks");
  expect(slot.getByTestId("task-board").textContent).not.toContain("Loading…");
  fail = false;
  await vi.advanceTimersByTimeAsync(8_100);
  await waitFor(() => expect(slot.queryByTestId("board-offline")).toBeNull());
  expect(slot.getByTestId("board-columns")).toBeTruthy();
  fail = true;
  await vi.advanceTimersByTimeAsync(8_100);
  await waitFor(() => expect(slot.getByTestId("board-offline").textContent).toContain("last known states"));
  fail = false;
  await vi.advanceTimersByTimeAsync(8_100);
  await waitFor(() => expect(slot.queryByTestId("board-offline")).toBeNull());
});

it("does not hide the 121st board card behind a count of 121", async () => {
  await loadPluginApp(() => import("../app"));
  setLocaleOverride("en");
  const { TaskBoard } = await import("../src/rooms/runs/ui/task-board");
  const items = Array.from({ length: 121 }, (_, i) => ({
    kind: "task", key: `k${i}`, runId: "r", taskId: `t${i}`, title: `Task ${i}`, projectId: "p", column: "queued",
    state: "queued", phase: "queued", waitingFor: [], taskKind: "feature", updatedAt: 1, attemptNo: 1,
  }));
  const slot = renderSlot({ component: () => <TaskBoard locale="en" /> }, {}, { rpc: { task_board: () => ({ items }), work_graph_strips: () => ({}) } as never });
  await slot.findByTestId("board-card-k120");
  expect(slot.getByTestId("board-col-queued").querySelectorAll("button")).toHaveLength(121);
});
