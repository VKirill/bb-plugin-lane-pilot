/** @vitest-environment jsdom */
// Region 9 · Person and window, batch f (n917 … n933): the parts of the window's frame rendered for real in jsdom — the phase header, the contract summary,
// the live timer, the sidebar and project selector, the status strips, the screen registry, the open task and the work board. Each test presses what the
// person presses or reads and checks the whole text, call or screen. What a window drew or sent is also written down with observe(): the region scene
// sma_r09 compares those values with the cards.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
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
async function mount(component: () => React.ReactElement, table: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: table as never });
}
const states = (box: Element) => Array.from(box.querySelectorAll("[data-stage]")).map((cell) => `${cell.getAttribute("data-stage")}:${cell.getAttribute("data-state")}`);

// ---- the phase header, the stage graph, the one open phase ----
const phaseRow = (id: string, title: string, stage: string, state: string) => ({ id, title, goal: `goal of ${title}`, stage, state, next: { text: `Next for ${title}`, waitsForPm: false }, cells: phaseStageCells(stage, state) });
const phaseGet = (id: string) => ({ phase: { id, title: `T-${id}`, goal: "g", stage: "execution", state: "active", record: {} }, withdrawable: [], next: { text: `Next step of ${id}` }, ownerWord: {}, gates: {}, book: "", facts: {} });

describe("region 9 · the phase header", () => {
  it("[sma:m_ws_entity_summary] a phase is one header — its stage, the picture of its stages, its title and its state — and opening it says what is next", async () => {
    const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder({ phase_list: () => [phaseRow("ph1", "Footer", "execution", "active"), phaseRow("ph2", "Cart", "planning", "stopped")], phase_get: ({ phaseId }: { phaseId: string }) => phaseGet(phaseId), phase_files: () => ({ files: [] }) });
    const slot = await mount(() => <PhasesScreen rpc={r.rpc as never} projectId="p1" />);
    const first = await slot.findByTestId("ck-phase-ph1");
    const second = slot.getByTestId("ck-phase-ph2");
    const header = (box: HTMLElement) => text(box.querySelector("button"));
    expect(header(first)).toBe("executionFooteractive");
    expect(header(second)).toBe("planningCartstopped");
    expect(r.of("phase_list")).toEqual([{ projectId: "p1" }]);
    expect(first.querySelector("[data-testid='ck-phase-card']")).toBeNull();
    fireEvent.click(first.querySelector("button")!);
    const next = await slot.findByTestId("ck-phase-card");
    expect(text(next.querySelector("p"))).toBe("Next: Next step of ph1");
    expect(r.of("phase_get")).toEqual([{ phaseId: "ph1" }]);
    observe("n917", { headers: [header(first), header(second)], next: text(next.querySelector("p")) });
  });

  it("[sma:m_ws_stage_graph] the stages of a phase are one picture: eight squares in the pipeline's order, the ones before the current stage passed, the current one running (failed when the phase is stopped), the rest pending", async () => {
    const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder({ phase_list: () => [phaseRow("ph1", "Footer", "execution", "active"), phaseRow("ph2", "Cart", "design", "stopped"), phaseRow("ph3", "Done", "closed", "closed")] });
    const slot = await mount(() => <PhasesScreen rpc={r.rpc as never} projectId="p1" />);
    const running = await slot.findByTestId("ck-phase-strip-ph1");
    const stopped = slot.getByTestId("ck-phase-strip-ph2");
    const closed = slot.getByTestId("ck-phase-strip-ph3");
    const ids = phaseStageCells("execution", "active").map((cell) => cell.stageId);
    expect(ids).toHaveLength(8);
    const expectRow = (box: Element, row: string[]) => expect(states(box)).toEqual(ids.map((id, index) => `${id}:${row[index]}`));
    expectRow(running, ["passed", "passed", "passed", "running", "pending", "pending", "pending", "pending"]);
    expectRow(stopped, ["passed", "passed", "failed", "pending", "pending", "pending", "pending", "pending"]);
    expectRow(closed, Array(8).fill("passed"));
    expect(phaseStageCells("design", "active").map((cell) => cell.state)).toEqual(["passed", "passed", "running", "pending", "pending", "pending", "pending", "pending"]);
    expect(phaseStageCells("design", "paused").map((cell) => cell.state)[2]).toBe("pending");
    observe("n921", { running: states(running), stopped: states(stopped), closed: states(closed) });
  });

  it("[sma:m_ws_open_task] one phase is open at a time: opening a second one closes the first, pressing the open one closes it, and the card that opens is that phase's", async () => {
    const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder({ phase_list: () => [phaseRow("ph1", "Footer", "execution", "active"), phaseRow("ph2", "Cart", "planning", "active")], phase_get: ({ phaseId }: { phaseId: string }) => phaseGet(phaseId), phase_files: () => ({ files: [] }) });
    const slot = await mount(() => <PhasesScreen rpc={r.rpc as never} projectId="p1" />);
    const first = await slot.findByTestId("ck-phase-ph1");
    const second = slot.getByTestId("ck-phase-ph2");
    const open = () => slot.queryAllByTestId("ck-phase-card").map((card) => text(card.querySelector("p")));
    fireEvent.click(first.querySelector("button")!);
    await waitFor(() => expect(open()).toEqual(["Next: Next step of ph1"]));
    const afterFirst = open();
    expect(first.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(second.querySelector("button")!);
    await waitFor(() => expect(open()).toEqual(["Next: Next step of ph2"]));
    const afterSecond = open();
    expect(first.querySelector("[data-testid='ck-phase-card']")).toBeNull();
    expect(first.querySelector("button")!.getAttribute("aria-expanded")).toBe("false");
    expect(second.querySelector("button")!.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(second.querySelector("button")!);
    await waitFor(() => expect(open()).toEqual([]));
    observe("n931", { afterFirst, afterSecond, afterSecondPress: open() });
  });
});

// ---- the contract summary ----
describe("region 9 · the contract summary", () => {
  const view = (extra: Record<string, unknown> = {}) => ({ displayTitle: "The form saves", objective: "Make the form save", area: null, clarify: null, promise: { then: "the form keeps what was typed", given: "a filled form", when: "Save is pressed" }, ownsPaths: [], expectedOutputs: [], outOfScope: [], blockers: [], drawing: [], drawingOk: null, priority: "normal", heldUntil: null, approach: null, ...extra });
  async function open(table: Table) {
    const { TasksScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder(table);
    const slot = await mount(() => <TasksScreen rpc={r.rpc as never} projectId="p1" runId="run1" hostId={null} />);
    fireEvent.change(slot.getByPlaceholderText(t("ckTaskLookup")), { target: { value: "t-7" } });
    fireEvent.click(slot.getByText(t("ckTaskOpen"), { selector: "button" }));
    await slot.findByTestId("ck-task-detail");
    return { slot, r };
  }
  // «Correct» is both the confirm button and the fix button in English: the first is the confirm, the second the fix.
  const confirmButton = (slot: ReturnType<typeof renderSlot>) => slot.getAllByText(t("ckCorrect_yes"), { selector: "button" })[0]!;
  const fixButton = (slot: ReturnType<typeof renderSlot>) => slot.getAllByText(t("ckFix"), { selector: "button" })[1]! as HTMLButtonElement;

  it("[sma:m_ws_contract_summary] the task's promise is shown with how to repeat it, «Correct» confirms it (or releases a held task), and a correction of three letters or more goes to the PM with the task and the words, never around him", async () => {
    const { slot, r } = await open({ cockpit_task: () => view(), cockpit_task_correct: () => ({}), cockpit_queue: () => ({}) });
    const promise = slot.getByTestId("ck-promise");
    expect(text(promise.querySelectorAll("p")[0]!)).toBe("Promise: the form keeps what was typed");
    expect(text(promise.querySelectorAll("p")[1]!)).toBe("How to repeat: a filled form · Save is pressed");
    expect(r.of("cockpit_task")).toEqual([{ runId: "run1", taskId: "t-7" }]);
    fireEvent.click(confirmButton(slot));
    expect(text(slot.getByTestId("ck-task-said"))).toBe("Confirmed.");
    expect(r.of("cockpit_queue")).toEqual([]);
    const fix = fixButton(slot);
    expect(fix.disabled).toBe(true);
    fireEvent.change(slot.getByTestId("ck-correction"), { target: { value: "no" } });
    expect(fix.disabled).toBe(true);
    fireEvent.change(slot.getByTestId("ck-correction"), { target: { value: "it must also keep the date" } });
    expect(fix.disabled).toBe(false);
    fireEvent.click(fix);
    await waitFor(() => expect(r.of("cockpit_task_correct")).toEqual([{ runId: "run1", taskId: "t-7", text: "it must also keep the date" }]));
    await waitFor(() => expect(text(slot.getByTestId("ck-task-said"))).toBe("Sent"));
    expect((slot.getByTestId("ck-correction") as HTMLInputElement).value).toBe("");
    observe("n918", { promise: [text(promise.querySelectorAll("p")[0]!), text(promise.querySelectorAll("p")[1]!)], confirmed: "Confirmed.", sent: r.of("cockpit_task_correct")[0], queueCalls: r.of("cockpit_queue").length });
  });

  it("[sma:m_ws_contract_summary] a refused correction says why instead of «Sent», «Correct» on a held task releases it, and a task with no promise shows no summary", async () => {
    const { slot, r } = await open({ cockpit_task: () => view({ heldUntil: 9_999_999_999_999 }), cockpit_task_correct: () => { throw new Error("the PM is not in this run"); }, cockpit_queue: () => ({}) });
    fireEvent.click(confirmButton(slot));
    await waitFor(() => expect(r.of("cockpit_queue")).toEqual([{ runId: "run1", taskIds: ["t-7"], action: "release" }]));
    expect(slot.queryByTestId("ck-task-said")).toBeNull();
    fireEvent.change(slot.getByTestId("ck-correction"), { target: { value: "other words" } });
    fireEvent.click(fixButton(slot));
    await waitFor(() => expect(text(slot.getByTestId("ck-task-said"))).toBe("Error: the PM is not in this run"));
    cleanup();
    const none = await open({ cockpit_task: () => view({ promise: null }) });
    expect(none.slot.queryByTestId("ck-promise")).toBeNull();
  });
});

// ---- the live timer ----
describe("region 9 · the live timer", () => {
  const MIN = 60_000;
  async function live(since: number | null, locale: string) {
    await loadPluginApp(() => import("../../app"));
    const { ThreadLive } = await import("../../src/rooms/runs/ui");
    const items = [{ key: "task:run:w1", runId: "run", taskId: "w1", title: "Task w1", column: "running", phase: "writing", stage: null, model: null, since, threadId: null, updatedAt: 1, detail: null }];
    const view = renderSlot({ component: () => <ThreadLive threadId="thr_pm" locale={locale} /> }, {}, { context: { projectId: null, threadId: null }, rpc: { thread_live: () => ({ role: "pm", pmThreadId: "thr_pm", items, strips: {} }), work_graph_task: () => ({ cells: [], stages: [] }) } as never });
    await view.findByTestId("thread-live");
    return view;
  }
  const line = (view: ReturnType<typeof renderSlot>) => text(view.getByTestId("live-task-task:run:w1").querySelector("span.truncate"));

  it("[sma:m_ws_live_timer] how long a work has run is said in minutes under an hour and in hours and minutes from the hour, in the window's language, and not at all for a work with no start", async () => {
    const out: Record<string, string> = {};
    for (const [minutes, locale] of [[0, "en"], [12, "en"], [59, "en"], [60, "en"], [135, "en"], [135, "ru"], [12, "ru"]] as const) {
      const view = await live(Date.now() - minutes * MIN, locale);
      out[`${minutes} ${locale}`] = line(view);
      cleanup();
    }
    expect(out).toEqual({ "0 en": "writing · 0 min", "12 en": "writing · 12 min", "59 en": "writing · 59 min", "60 en": "writing · 1h 0m", "135 en": "writing · 2h 15m", "135 ru": "writing · 2 ч 15 мин", "12 ru": "writing · 12 мин" });
    const none = await live(null, "en");
    const noStart = line(none);
    expect(noStart).toBe("writing");
    observe("n920", { ...out, noStart });
  });

  it("[sma:m_ws_live_timer] the timer ticks on its own: the same work, read again by the window's poll a few minutes later, says the longer time", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = Date.now();
    const view = await live(start - 10 * MIN, "en");
    expect(line(view)).toBe("writing · 10 min");
    // Three minutes go by on the fake clock; the read's 60 s safety poll (the fallback — a live host's
    // invalidations are the fast path) re-reads and the line moves without a press. Detection residual
    // up to ~60 s when no invalidation arrives.
    await vi.advanceTimersByTimeAsync(3 * MIN + 1_000);
    await waitFor(() => expect(line(view)).toBe("writing · 13 min"), { timeout: 20_000 });
    observe("n920tick", { before: "writing · 10 min", after: line(view) });
  }, 40_000);
});

// ---- the window itself: sidebar, project selector ----
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

describe("region 9 · the sidebar and the project choice", () => {
  it("[sma:m_ws_sidebar] the window lists every screen in the registry's order, marks the open one, opens a screen by its line and counts what awaits a decision in the bell", async () => {
    const view = await cockpit({ owner_waiting: () => ({ items: [{ key: "a" }, { key: "b" }, { key: "c" }] }) }, "money");
    await view.slot.findByTestId("ck-bell");
    const nav = view.slot.getByRole("navigation");
    const lines = Array.from(nav.querySelectorAll("button"));
    expect(lines.map((line) => text(line))).toEqual(SCREENS.map((row) => t(row.title)));
    expect(lines).toHaveLength(14);
    const marked = lines.filter((line) => line.className.includes("lp-accent")).map((line) => text(line));
    expect(marked).toEqual([t("ckScreen_money")]);
    await waitFor(() => expect(text(view.slot.getByTestId("ck-bell"))).toBe("Awaits a decision: 3"));
    for (const row of SCREENS) fireEvent.click(lines[SCREENS.indexOf(row)]!);
    expect(view.slot.navigateCalls.map((call) => (call.method === "toPluginPanel" ? [call.path, call.options?.subPath] : call))).toEqual(SCREENS.map((row) => ["lane-pilot-cockpit", row.id]));
    await waitFor(() => expect(Array.from(nav.querySelectorAll("button")).filter((line) => line.className.includes("lp-accent")).map((line) => text(line))).toEqual([t("ckScreen_registry")]));
    observe("n923", { lines: lines.map((line) => text(line)), marked, bell: "Awaits a decision: 3", opened: view.slot.navigateCalls.length });
  });

  it("[sma:m_ws_project_selector] choosing another project rereads the whole picture for it — the screen, the first-run state and the open screen's own read — and the choice is remembered only after the server answered for it; a refused project keeps the old one and says so", async () => {
    const refused = new Set(["proj_x"]);
    const view = await cockpit({
      list_projects: () => ({ projects: [{ id: "proj_a", name: "Alpha" }, { id: "proj_b", name: "Beta" }, { id: "proj_x", name: "Broken" }] }),
      get_screen: ({ projectId }: { projectId: string }) => { if (refused.has(projectId)) throw new Error("no such project"); return { hostId: "h1", runs: [] }; },
    }, "phases");
    const select = (await view.slot.findByTestId("ck-project")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("proj_a"));
    expect(Array.from(select.options).map((option) => option.textContent)).toEqual(["Alpha", "Beta", "Broken"]);
    await waitFor(() => expect(localStorage.getItem("lane-pilot:cockpit:project")).toBe("proj_a"));
    fireEvent.change(select, { target: { value: "proj_b" } });
    await waitFor(() => expect(select.value).toBe("proj_b"));
    await waitFor(() => expect(localStorage.getItem("lane-pilot:cockpit:project")).toBe("proj_b"));
    const reread = { screen: view.of("get_screen").at(-1), firstRun: view.of("first_run_get").at(-1), phases: view.of("phase_list").at(-1) };
    expect(reread).toEqual({ screen: { projectId: "proj_b", runsLimit: 5 }, firstRun: { projectId: "proj_b" }, phases: { projectId: "proj_b" } });
    fireEvent.change(select, { target: { value: "proj_x" } });
    const alert = await view.slot.findByTestId("ck-project-error");
    expect(text(alert)).toBe("Could not open the project");
    expect(select.value).toBe("proj_b");
    expect(localStorage.getItem("lane-pilot:cockpit:project")).toBe("proj_b");
    observe("n924", { options: Array.from(select.options).map((option) => option.textContent), reread, refused: text(alert), stored: localStorage.getItem("lane-pilot:cockpit:project") });
  });
});

// keep the unused-import guard quiet for helpers the second half uses
void render; void createElement;
