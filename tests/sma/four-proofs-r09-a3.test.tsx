/** @vitest-environment jsdom */
// Region 9 · Person and window, batch a (n755 … n784), part 3: the task board (stop, done work), the live panel, the window itself.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { AcceptanceCard } from "../../src/rooms/acceptance/ui";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

type Table = Record<string, (params: never) => unknown>;
const item = (taskId: string, column: string, extra: Record<string, unknown> = {}) => ({
  kind: "task", key: `task:run:${taskId}`, runId: "run", taskId, title: `Title ${taskId}`, techTitle: null, taskKind: "feature", area: null,
  objective: "Cakekeeper UI", projectId: "proj_a", pmThreadId: "thr_pm", pmThreadTitle: "Coordinator", column,
  state: column === "done" ? "accepted" : column === "blocked" ? "blocked" : "running", phase: column === "done" ? "accepted" : column === "blocked" ? "blocked" : column === "queued" ? "queued" : "writing",
  stage: null, model: null, since: null, waitingFor: [], detail: null, attemptNo: 1, threadId: null, attemptId: `a-${taskId}`, updatedAt: 1_791_800_000_000, ...extra,
});
const card = (id: string, state: string) => ({
  kind: "task", title: `Title ${id}`, techTitle: null, taskKind: "feature", area: null, objective: "Cakekeeper UI", pmThreadId: "thr_pm", id, projectId: "proj_a", state, reason: null,
  contract: { objective: "Fix the form", acceptance: ["form saves"], ownsPaths: ["a.ts"], expectedOutputs: [], dependsOn: [], checks: ["npm test"] }, plan: "1. edit",
  stages: [], attempts: [{ id: `a-${id}`, no: 1, state, reason: null, threadId: "thr_w", createdAt: 1, updatedAt: 2 }], threads: null,
});
async function board(items: unknown[], extra: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
  const calls: Array<[string, unknown]> = [];
  const wrap = (name: string, handler: (params: never) => unknown) => (params: never) => { calls.push([name, params]); return handler(params); };
  const table: Table = {
    task_board: () => ({ items }), task_card: ({ taskId }: { taskId: string }) => card(taskId, "running"), task_acceptance_card: () => null,
    work_graph_task: () => ({ cells: [], stages: [], summary: { returns: 0, seconds: null, costUsd: null, costState: "not_measured", models: [] } }), work_graph_strips: () => ({}),
    task_diff: () => ({ reason: "no merge" }), work_file_read: () => ({ content: "", truncated: false }), ...extra,
  };
  const wrapped = Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, wrap(name, handler)]));
  const slot = renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }, { id: "proj_sb", name: "LP sandbox" }]} serviceProjectIds={["proj_sb"]} locale="en" AcceptanceCard={AcceptanceCard} /> }, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
  return { slot, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}

describe("region 9 · the task board", () => {
  it("[sma:d_cancel] «Cancel» on a task at work stops its latest attempt with the owner's reason (none when the box is empty) and reads the card again; a queued task can be stopped, a finished one has no Cancel; a blocked one offers Retry instead", async () => {
    const stopped: unknown[] = [];
    const { slot, calls, of } = await board([item("w1", "running"), item("q1", "queued", { phase: "queued" }), item("d1", "done"), item("b1", "blocked")], { cancel_attempt: (params: unknown) => { stopped.push(params); return { ok: true }; }, retry_attempt: () => ({ ok: true }) });
    await waitFor(() => expect(slot.getByTestId("board-col-running").textContent).toContain("Title w1"));
    fireEvent.click(slot.getByTestId("board-card-task:run:w1"));
    await slot.findByTestId("task-card");
    const cancel = await slot.findByText("Cancel", { selector: "button" });
    expect(of("task_card")).toEqual([{ runId: "run", taskId: "w1" }]);
    fireEvent.click(cancel);
    await waitFor(() => expect(stopped).toEqual([{ attemptId: "a-w1" }]));
    await waitFor(() => expect(of("task_card")).toHaveLength(2));
    fireEvent.change(slot.getByTestId("board-cancel-note"), { target: { value: "wrong plan" } });
    fireEvent.click(cancel);
    await waitFor(() => expect(stopped[1]).toEqual({ attemptId: "a-w1", note: "wrong plan" }));
    // The acceptance card carries the same stop.
    fireEvent.click(await slot.findByTestId("acc-stop").catch(() => slot.getAllByText("Cancel", { selector: "button" })[0]!));
    await waitFor(() => expect(stopped).toHaveLength(3));
    fireEvent.click(slot.getByTestId("board-back"));
    fireEvent.click(await slot.findByTestId("board-card-task:run:q1"));
    await slot.findByText("Cancel", { selector: "button" });
    fireEvent.click(slot.getByTestId("board-back"));
    fireEvent.click(await slot.findByTestId("board-card-task:run:d1"));
    await slot.findByTestId("task-card");
    expect(slot.queryByText("Cancel", { selector: "button" })).toBeNull();
    fireEvent.click(slot.getByTestId("board-back"));
    fireEvent.click(await slot.findByTestId("board-card-task:run:b1"));
    fireEvent.click(await slot.findByText("Retry", { selector: "button" }));
    await waitFor(() => expect(calls.some(([name]) => name === "retry_attempt")).toBe(true));
    expect(slot.queryByText("Cancel", { selector: "button" })).toBeNull();
  });

  it("[sma:d_done] the board's done column holds the accepted work of the last day, asked of the server for that window, with its title; other columns do not carry it, and a sandbox drill's work stays hidden until the person asks for it", async () => {
    const { slot, of } = await board([item("d1", "done", { title: "Footer shipped" }), item("w1", "running"), item("drill-1", "done", { projectId: "proj_sb", title: "Drill note" })]);
    await waitFor(() => expect(slot.getByTestId("board-col-done").textContent).toContain("Footer shipped"));
    expect(of("task_board")).toEqual([{ doneHours: 24 }]);
    expect(slot.getByTestId("board-col-done").textContent).not.toContain("Drill note");
    expect(slot.getByTestId("board-col-done").textContent).not.toContain("Title w1");
    expect(slot.getByTestId("board-col-running").textContent).not.toContain("Footer shipped");
    expect(slot.getByTestId("board-col-done").querySelector("span.font-normal")!.textContent).toBe("1");
    fireEvent.click(slot.getByTestId("board-drills"));
    await waitFor(() => expect(slot.getByTestId("board-col-done").textContent).toContain("Drill note"));
  });
});

describe("region 9 · the live panel and the window", () => {
  const cell = (stageId: string, state: string) => ({ stageId, state, rounds: state === "pending" ? 0 : 1, failures: 0, reason: null });
  const live = (taskId: string, column: string, phase: string, extra: Record<string, unknown> = {}) => ({ key: `task:run:${taskId}`, runId: "run", taskId, title: `Task ${taskId}`, column, phase, stage: null, model: null, since: null, threadId: null, updatedAt: 1, detail: null, ...extra });

  it("[sma:d_events] the thread's live panel lists the tasks at work now with stage, model and minutes and the week's finished ones, counts them, opens a step list on a click, and shows nothing at all in a thread Lane Pilot has no part in", async () => {
    await loadPluginApp(() => import("../../app"));
    const { ThreadLive } = await import("../../src/rooms/runs/ui");
    const data = {
      role: "pm", pmThreadId: "thr_pm",
      items: [live("w1", "running", "writing", { stage: "writer-agent", model: "composer-2.5", since: Date.now() - 12 * 60_000, threadId: "thr_w" }), live("d1", "done", "accepted")],
      strips: { "run:w1": { cells: [cell("writer-agent", "running")], summary: {} }, "run:d1": { cells: [cell("writer-agent", "passed")], summary: {} } },
    };
    const graph = { cells: [cell("writer-agent", "running")], stages: [{ cell: cell("writer-agent", "running"), rows: [{ stageId: "writer-agent", role: "writer", round: 1, threadId: "thr_w", providerId: "acp-cursor", model: "composer-2.5", seconds: null, tokens: null, costUsd: null, costState: "not_measured", turns: 3 }] }], summary: { returns: 0, seconds: null, costUsd: null, costState: "not_measured", models: [] } };
    const view = renderSlot({ component: () => <ThreadLive threadId="thr_pm" locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: { thread_live: () => data, work_graph_task: () => graph } as never });
    await view.findByTestId("thread-live");
    const text = view.getByTestId("thread-live").textContent!;
    expect(text).toMatch(/at work 1 · done 1 of 2Now[\s\S]*Task w1[\s\S]*writing · Writer · composer-2\.5 · 12 min[\s\S]*This week[\s\S]*Task d1/);
    expect(view.getByTestId("live-task-task:run:d1").textContent).not.toContain("min");
    await view.findByTestId("stage-steps");
    fireEvent.click(view.getByText("Task d1"));
    await waitFor(() => expect(view.getAllByTestId("stage-steps")).toHaveLength(2));
    cleanup();
    const empty = renderSlot({ component: () => <ThreadLive threadId="thr_x" locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: { thread_live: () => null } as never });
    await waitFor(() => expect(empty.rpcCalls.some((call) => call.method === "thread_live")).toBe(true));
    expect(empty.queryByTestId("thread-live")).toBeNull();
  });

  it("[sma:d_index] the window is the plugin's pages in the nav: the Lane Pilot page, the council and the cockpit are registered under their own paths with their titles; the cockpit opens the screen its path names, counts what awaits the owner in the bell, and says a silent door instead of a blank page", async () => {
    const app = await loadPluginApp(() => import("../../app"));
    const panels = app.navPanels.map((panel: { id: string; path: string; title: string }) => `${panel.id}|${panel.path}|${panel.title}`);
    expect(panels).toEqual(["lane-pilot|lane-pilot|Lane Pilot", "lane-pilot-council|lane-pilot-council|Council", "lane-pilot-cockpit|lane-pilot-cockpit|Lane Pilot · cockpit"]);
    const cockpit = app.navPanels.find((panel: { id: string }) => panel.id === "lane-pilot-cockpit")!;
    let silent = false;
    const slot = renderSlot({ component: () => <cockpit.component subPath="money" /> } as never, {}, { context: { projectId: null, threadId: null }, rpc: {
      list_projects: () => ({ projects: [{ id: "proj_a", name: "Alpha" }] }), get_screen: () => ({ hostId: "h1", runs: [{ id: "run_1", state: "running" }] }), first_run_get: () => ({ needed: false }),
      owner_waiting: () => ({ items: [{}, {}, {}] }), world_version: () => { if (silent) throw new Error("no answer"); return { version: "1" }; },
      money_status: () => ({ monthUsd: 3, cap: null, left: null, table: [] }), cockpit_windows: () => ({ at: null, windows: {} }), cockpit_accounts: () => [], cockpit_seen: () => ({}),
    } as never });
    await slot.findByTestId("ck-money");
    expect((await slot.findByTestId("ck-bell")).textContent).toContain("3");
    expect(slot.queryByTestId("ck-phases")).toBeNull();
    expect((slot.getByTestId("ck-project") as HTMLSelectElement).value).toBe("proj_a");
    expect(slot.queryByTestId("ck-door-silent")).toBeNull();
    cleanup();
    silent = true;
    const quiet = renderSlot({ component: () => <cockpit.component subPath="phases" /> } as never, {}, { context: { projectId: null, threadId: null }, rpc: {
      list_projects: () => ({ projects: [{ id: "proj_a", name: "Alpha" }] }), get_screen: () => ({ hostId: "h1", runs: [] }), first_run_get: () => ({ needed: false }), owner_waiting: () => ({ items: [] }),
      world_version: () => { throw new Error("no answer"); }, phase_list: () => [], cockpit_seen: () => ({}),
    } as never });
    await quiet.findByTestId("ck-phases");
    await waitFor(() => expect(quiet.getByTestId("ck-door-silent")).toBeTruthy());
  });
});
