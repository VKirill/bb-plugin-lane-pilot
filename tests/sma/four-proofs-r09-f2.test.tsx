/** @vitest-environment jsdom */
// Region 9 · Person and window, batch f, second half (n926 … n933): the strip over the screens, the placeholder, the work board and the open task, rendered for
// real in jsdom. What a window drew or sent is also written down with observe(): the region scene sma_r09 compares those values with the cards.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride, t } from "@lane-pilot/i18n";
import { phaseStageCells } from "../../src/rooms/phase";
import { SCREENS } from "../../src/rooms/cockpit/ui/registry";
import { observe, recorder, type Table } from "./r09-world-f";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); localStorage.clear(); });

const text = (node: Element | null) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();
const phaseRow = (id: string, title: string, stage: string, state: string) => ({ id, title, goal: `goal of ${title}`, stage, state, next: { text: `Next for ${title}`, waitsForPm: false }, cells: phaseStageCells(stage, state) });

async function cockpit(table: Table, subPath: string) {
  const app = await loadPluginApp(() => import("../../app"));
  const panel = app.navPanels.find((row: { id: string }) => row.id === "lane-pilot-cockpit")!;
  const calls: Array<[string, unknown]> = [];
  const all: Table = { list_projects: () => ({ projects: [{ id: "proj_a", name: "Alpha" }, { id: "proj_b", name: "Beta" }] }), get_screen: () => ({ hostId: "h1", runs: [] }), first_run_get: () => ({ needed: false }),
    owner_waiting: () => ({ items: [] }), world_version: () => ({ version: "1" }), phase_list: () => [], cockpit_seen: () => ({}), ...table };
  const wrapped = Object.fromEntries(Object.entries(all).map(([name, handler]) => [name, (params: never) => { calls.push([name, params]); return handler(params); }]));
  const slot = renderSlot({ component: () => <panel.component subPath={subPath} /> } as never, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
  return { slot, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}

// ---- the strip over the screens: the hub does not answer ----
const DOOR_SILENT = "The hub does not answer — the screens show what they saw last.";
describe("region 9 · the hub strip", () => {
  it("[sma:m_ws_hub_banner] when the hub does not answer the window says so in one strip, and says nothing while it answers; when the hub answers again the strip goes", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let down = false;
    const view = await cockpit({ world_version: () => { if (down) throw new Error("hub down"); return { version: "1" }; } }, "phases");
    await view.slot.findByTestId("ck-phases");
    await waitFor(() => expect(view.of("world_version").length).toBeGreaterThan(0));
    const whileUp = view.slot.queryByTestId("ck-door-silent");
    expect(whileUp).toBeNull();
    down = true;
    // The pulse's only timed re-read is the 60 s safety poll (a live host's invalidations are the fast path):
    // the strip appears on the next fallback beat — detection residual up to ~60 s.
    await vi.advanceTimersByTimeAsync(61_000);
    const strip = await view.slot.findByTestId("ck-door-silent", {}, { timeout: 25_000 });
    expect(text(strip)).toBe(DOOR_SILENT);
    expect(view.slot.queryAllByTestId("ck-door-silent")).toHaveLength(1);
    down = false;
    await vi.advanceTimersByTimeAsync(61_000);
    await waitFor(() => expect(view.slot.queryByTestId("ck-door-silent")).toBeNull(), { timeout: 25_000 });
    observe("n927", { whileUp: whileUp === null ? null : "shown", said: text(strip), afterAnswer: view.slot.queryByTestId("ck-door-silent") === null ? "gone" : "shown" });
  }, 70_000);

  it("[sma:m_ws_link_lost] the strip stands above the nav and the screen, and the screen below keeps showing what it last read instead of going blank", async () => {
    const view = await cockpit({ world_version: () => { throw new Error("hub down"); }, phase_list: () => [phaseRow("ph1", "Footer", "execution", "active")] }, "phases");
    const row = await view.slot.findByTestId("ck-phase-ph1");
    const strip = await view.slot.findByTestId("ck-door-silent", {}, { timeout: 10_000 });
    const nav = view.slot.getByRole("navigation");
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(strip, nav)).toBe(true);
    expect(before(strip, row)).toBe(true);
    expect(before(strip, view.slot.getByTestId("ck-phases"))).toBe(true);
    expect(text(row.querySelector("button"))).toBe("executionFooteractive");
    expect(text(strip)).toBe(DOOR_SILENT);
    observe("n928", { aboveNav: before(strip, nav), aboveScreen: before(strip, view.slot.getByTestId("ck-phases")), screenKept: text(row.querySelector("button")) });
  });
});

// ---- the placeholder ----
describe("region 9 · the screen being built", () => {
  it("[sma:m_ws_placeholder] a path that names no screen shows the placeholder, never a blank page, and no screen of the registry shows it", async () => {
    const unknown = await cockpit({}, "nonsense");
    const placeholder = await unknown.slot.findByTestId("ck-building");
    const said = text(placeholder);
    expect(said).toBe("This screen is being built.This screen is being built.");
    cleanup();
    const event = await cockpit({}, "event/nothing");
    await event.slot.findByTestId("ck-building");
    cleanup();
    const shown: string[] = [];
    for (const row of SCREENS) {
      const view = await cockpit({ first_run_get: () => ({ needed: false, steps: [], draft: { answers: {}, done: true } }) }, row.id);
      await waitFor(() => expect((view.slot.getByTestId("ck-project") as HTMLSelectElement).value).toBe("proj_a"));
      expect(view.slot.queryByTestId("ck-building")).toBeNull();
      const marked = Array.from(view.slot.getByRole("navigation").querySelectorAll("button")).filter((line) => line.className.includes("lp-accent")).map((line) => text(line));
      expect(marked).toEqual([t(row.title)]);
      shown.push(row.id);
      cleanup();
    }
    expect(shown).toEqual(SCREENS.map((row) => row.id));
    observe("n932", { unknown: said, screensWithoutPlaceholder: shown.length });
  }, 120_000);
});

// ---- the work board and the open task ----
const MIN = 60_000;
const boardItem = (taskId: string, column: string, extra: Record<string, unknown> = {}) => ({
  kind: "task", key: `task:run:${taskId}`, runId: "run", taskId, title: `Title ${taskId}`, techTitle: null, taskKind: "feature", area: null, objective: "Cakekeeper UI", projectId: "proj_a", pmThreadId: "thr_pm", pmThreadTitle: "Coordinator", column,
  state: column === "done" ? "accepted" : column === "blocked" ? "blocked" : "running", phase: column === "done" ? "accepted" : column === "blocked" ? "blocked" : column === "queued" ? "queued" : "writing",
  stage: null, model: null, since: null, waitingFor: [], detail: null, attemptNo: 1, threadId: null, attemptId: `a-${taskId}`, updatedAt: Date.now() - 5 * MIN, held: false, gates: null, wave: null, ...extra,
});
const boardCard = (id: string, state: string) => ({
  kind: "task", title: `Title ${id}`, techTitle: null, taskKind: "feature", area: null, objective: "Cakekeeper UI", pmThreadId: "thr_pm", id, projectId: "proj_a", state, reason: null,
  contract: { objective: "Fix the form", acceptance: ["form saves", "date is kept"], ownsPaths: ["src/form.ts"], expectedOutputs: [], dependsOn: [], checks: ["npm test"] }, plan: null,
  stages: [], attempts: [{ id: `a-${id}`, no: 1, state, reason: null, threadId: "thr_w", createdAt: 1, updatedAt: 2 }], threads: null,
});
async function board(items: unknown[], extra: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
  const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui");
  const table: Table = {
    task_board: () => ({ items }), task_card: ({ taskId }: { taskId: string }) => boardCard(taskId, "running"), task_acceptance_card: () => null,
    work_graph_task: () => ({ cells: [], stages: [], summary: { returns: 0, seconds: null, costUsd: null, costState: "not_measured", models: [] } }), work_graph_strips: () => ({}),
    task_diff: () => ({ reason: "no merge" }), work_file_read: () => ({ content: "", truncated: false }), ...extra,
  };
  const r = recorder(table);
  const rpc = Object.fromEntries(Object.keys(table).map((name) => [name, (params: never) => r.rpc.call(name, params)]));
  const mountBoard = () => renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} serviceProjectIds={[]} locale="en" AcceptanceCard={AcceptanceCard} /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
  return { r, mountBoard };
}

describe("region 9 · the work board", () => {
  it("[sma:sc_board] the works stand in their columns by status — at work, checks, stuck, queue, done — each column counts its works, a queued work says what it waits for, a held one says «Held», a stuck one says why, and an empty column says so", async () => {
    const { mountBoard } = await board([
      boardItem("w1", "running", { stage: "writer-agent", model: "composer-2.5", since: Date.now() - 12 * MIN }), boardItem("c1", "checking", { phase: "checking" }),
      boardItem("b1", "blocked", { detail: "the check failed on src/a.ts" }), boardItem("q1", "queued", { phase: "waiting", waitingFor: ["ck-24-first", "t-2"] }), boardItem("q2", "queued", { held: true }), boardItem("d1", "done"),
    ]);
    const slot = mountBoard();
    await waitFor(() => expect(slot.getByTestId("board-col-running").textContent).toContain("Title w1"));
    const column = (id: string) => slot.getByTestId(`board-col-${id}`);
    const cards = (id: string) => Array.from(column(id).querySelectorAll("[data-testid^='board-card-']")).map((card) => card.getAttribute("data-testid"));
    const counts = Object.fromEntries(["queued", "running", "checking", "blocked", "done"].map((id) => [id, text(column(id).querySelector("span.font-normal"))]));
    expect(Array.from(slot.getByTestId("board-columns").children).map((section) => section.getAttribute("data-testid"))).toEqual(["board-col-queued", "board-col-running", "board-col-checking", "board-col-blocked", "board-col-done"]);
    expect(cards("running")).toEqual(["board-card-task:run:w1"]);
    expect(cards("checking")).toEqual(["board-card-task:run:c1"]);
    expect(cards("blocked")).toEqual(["board-card-task:run:b1"]);
    expect(cards("queued")).toEqual(["board-card-task:run:q1", "board-card-task:run:q2"]);
    expect(cards("done")).toEqual(["board-card-task:run:d1"]);
    expect(counts).toEqual({ queued: "2", running: "1", checking: "1", blocked: "1", done: "1" });
    const card = (id: string) => text(slot.getByTestId(`board-card-task:run:${id}`));
    const waits = card("q1");
    expect(waits).toContain("waits for ck-24, t-2");
    expect(waits).not.toContain("Held");
    expect(card("q2")).toContain("Held");
    for (const id of ["w1", "c1", "b1", "q1", "d1"]) expect(card(id)).not.toContain("Held");
    expect(card("b1")).toContain("the check failed on src/a.ts");
    expect(card("w1")).toContain("12 min");
    observe("n933", { counts, waits, held: card("q2").includes("Held"), heldElsewhere: ["w1", "c1", "b1", "q1", "d1"].some((id) => card(id).includes("Held")), stuck: card("b1").includes("the check failed on src/a.ts") });
    cleanup();
    const empty = (await board([])).mountBoard();
    await waitFor(() => expect(empty.getByTestId("board-col-running").textContent).toContain(t("boardEmptyColumn")));
    expect(Array.from(empty.getByTestId("board-columns").querySelectorAll("section")).map((section) => text(section.querySelector("div p")))).toEqual(Array(5).fill("Nothing here"));
  });

  it("[sma:m_ws_task_panel] pressing a work opens its own panel — the title, the goal, the words of what must be true, the return-to-a-stage form, the files it owns (a press reads the file), «Cancel» while it works — and «Back to the board» closes it", async () => {
    const { r, mountBoard } = await board([boardItem("w1", "running")], { work_file_read: () => ({ content: "export const form = 1;", truncated: false }) });
    const slot = mountBoard();
    fireEvent.click(await slot.findByTestId("board-card-task:run:w1"));
    const panel = await slot.findByTestId("task-card");
    await waitFor(() => expect(text(panel.querySelector("h1"))).toBe("Title w1"));
    expect(r.of("task_card")).toEqual([{ runId: "run", taskId: "w1" }]);
    expect(text(panel)).toContain("Goal");
    expect(text(panel)).toContain("Cakekeeper UI");
    const words = await slot.findByTestId("acceptance-card-fallback");
    expect(Array.from(words.querySelectorAll("li")).map((line) => text(line))).toEqual(["○form saves", "○date is kept"]);
    expect(text(words.querySelector("p"))).toBe("Fix the form");
    expect(slot.getByTestId("return-stage")).toBeTruthy();
    expect(slot.getByTestId("acc-stop")).toBeTruthy();
    expect(Array.from(panel.querySelectorAll("button")).some((button) => text(button) === "Cancel")).toBe(true);
    const files = slot.getByTestId("task-files");
    fireEvent.click(files.querySelector("button, summary") ?? files);
    fireEvent.click(await slot.findByTestId("work-file-src/form.ts"));
    await waitFor(() => expect(r.of("work_file_read")).toEqual([{ runId: "run", relativePath: "src/form.ts", offset: 0 }]));
    await waitFor(() => expect(text(slot.getByTestId("task-card").querySelector("pre"))).toBe("export const form = 1;"));
    const wordsSeen = Array.from(words.querySelectorAll("li")).map((line) => text(line));
    fireEvent.click(slot.getByTestId("board-back"));
    await waitFor(() => expect(slot.queryByTestId("task-card")).toBeNull());
    expect(slot.getByTestId("task-board")).toBeTruthy();
    observe("n929", { title: "Title w1", cardRead: r.of("task_card")[0], words: wordsSeen, fileRead: r.of("work_file_read")[0], back: slot.queryByTestId("task-card") === null });
  });
});

// ---- opening a screen by an event ----
describe("region 9 · opening a screen by an event", () => {
  it("[sma:m_ws_navigation] a path that names an event opens the screen the event belongs to, a plain path opens its screen, and an event nobody listens to opens the placeholder", async () => {
    const opened: Record<string, string> = {};
    for (const [path, shownId] of [["event/uat", "ck-phases"], ["event/queue", "ck-task-lookup"], ["event/day", "ck-today"], ["phases", "ck-phases"]] as const) {
      const view = await cockpit({ get_screen: () => ({ hostId: "h1", runs: [{ id: "run1", state: "running" }] }) }, path);
      const found = await view.slot.findByTestId(shownId);
      opened[path] = found.getAttribute("data-testid")!;
      expect(view.slot.queryByTestId("ck-building")).toBeNull();
      cleanup();
    }
    const nobody = await cockpit({}, "event/nobody-listens");
    await nobody.slot.findByTestId("ck-building");
    expect(opened).toEqual({ "event/uat": "ck-phases", "event/queue": "ck-task-lookup", "event/day": "ck-today", phases: "ck-phases" });
    observe("n930ui", { opened, nobody: "ck-building" });
  });
});
