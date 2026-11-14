/** @vitest-environment jsdom */
// Region 9 · Person and window, batch c (n820 … n849), the screens: the tasks, forge, phase, owner-waiting, day, board and live screens rendered for real in jsdom.
// Each test drives what the person types and presses and checks which call goes out (the whole parameter list) or what the screen then shows. The server halves of
// the same cards are in four-proofs-r09-c.test.ts.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, useEffect } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride, t } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); vi.useRealTimers(); vi.restoreAllMocks(); });

type Table = Record<string, (params: never) => unknown>;
/** The rpc handle the cockpit screens take as a prop: it records every call and answers from the table. */
function recorder(table: Table) {
  const calls: Array<[string, unknown]> = [];
  const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); const handler = table[name]; if (!handler) return Promise.resolve(undefined); try { return Promise.resolve(handler(params as never)); } catch (cause) { return Promise.reject(cause); } } };
  return { rpc: rpc as never, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}
async function mount(component: () => React.ReactElement, rpc: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}
const button = (view: { getByText: (text: string, options: { selector: string }) => HTMLElement }, text: string) => view.getByText(text, { selector: "button" }) as HTMLButtonElement;
const type = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });
const inPanel = (panel: HTMLElement, text: string) => Array.from(panel.querySelectorAll("button")).find((node) => node.textContent === text) as HTMLButtonElement;

describe("region 9 · the tasks screen (new task, promote, words)", () => {
  async function tasks(table: Table = {}, runId: string | null = null) {
    const { TasksScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder(table);
    const slot = await mount(() => <TasksScreen rpc={r.rpc} projectId="p1" runId={runId} hostId={null} />);
    return { slot, r };
  }

  it("[sma:d_enqueue] one phrase fills the title, the description and the promise; Send is off until the description has five letters and the title passes the words check, and sends the task to the PM as «title, what, promise» for this project; a refusal is shown as said", async () => {
    const { slot, r } = await tasks({ cockpit_request: () => { throw new Error("no Lane Pilot PM chat is open in this project"); } });
    const panel = slot.getByTestId("ck-new-task");
    const send = inPanel(panel, t("ckSend"));
    type(slot.getByTestId("ck-new-task-phrase"), "Fix the footer overlap, so that the cart stays visible");
    expect((slot.getByTestId("ck-new-task-title") as HTMLInputElement).value).toBe("Fix the footer overlap");
    expect((slot.getByTestId("ck-new-task-promise") as HTMLTextAreaElement).value).toBe("Then the cart stays visible");
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText(t("ckNewTaskWhat")), "The footer covers the cart button");
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(r.of("cockpit_request")).toEqual([{ projectId: "p1", kind: "task", text: "Fix the footer overlap\n\nThe footer covers the cart button\n\nОбещание:\nThen the cart stays visible" }]));
    await waitFor(() => expect(slot.container.textContent).toContain("no Lane Pilot PM chat is open in this project"));
    // Without a promise the text is the title and the description only.
    type(slot.getByTestId("ck-new-task-promise"), "");
    fireEvent.click(send);
    await waitFor(() => expect(r.of("cockpit_request")[1]).toEqual({ projectId: "p1", kind: "task", text: "Fix the footer overlap\n\nThe footer covers the cart button" }));
  });

  it("[sma:d_backlog_promote] «promote» sends the item's words as their own request kind, only from three letters up, and says it was sent", async () => {
    const { slot, r } = await tasks({ cockpit_request: () => ({ sent: true }) });
    const panel = slot.getByTestId("ck-promote");
    const send = inPanel(panel, t("ckSend"));
    expect(send.disabled).toBe(true);
    type(panel.querySelector("input")!, "t7");
    expect(send.disabled).toBe(true);
    type(panel.querySelector("input")!, "t-07 the footer fix");
    fireEvent.click(send);
    await waitFor(() => expect(r.of("cockpit_request")).toEqual([{ projectId: "p1", kind: "promote", text: "t-07 the footer fix" }]));
    await waitFor(() => expect(slot.container.textContent).toContain(t("ckSent")));
  });

  it("[sma:d_task_suggest] the task standard is said while the title is typed — empty, over sixty letters, a path or an id in it — and the Send stays off; a good title shows no hint; typing a phrase asks the server for nothing", async () => {
    const { taskWords } = await import("../../src/rooms/cockpit/ui/screens-work");
    expect(taskWords("   ")).toBe("Опишите, что изменится для человека");
    expect(taskWords("x".repeat(60))).toBeNull();
    expect(taskWords("x".repeat(61))).toBe(`короче: ${"x".repeat(59)}…`);
    expect(taskWords("Fix src/form.ts")).toBe("без путей и id: что увидит человек");
    expect(taskWords("Close ck-12 first")).toBe("без путей и id: что увидит человек");
    expect(taskWords("snake_case title")).toBe("без путей и id: что увидит человек");
    expect(taskWords("Make the form save")).toBeNull();
    const { slot, r } = await tasks();
    const hint = () => slot.queryByTestId("ck-task-words")?.textContent ?? null;
    type(slot.getByTestId("ck-new-task-title"), "Fix src/form.ts");
    expect(hint()).toContain("без путей и id: что увидит человек");
    type(slot.getByLabelText(t("ckNewTaskWhat")), "The form loses its data");
    expect(inPanel(slot.getByTestId("ck-new-task"), t("ckSend")).disabled).toBe(true);
    type(slot.getByTestId("ck-new-task-title"), "The form keeps its data");
    expect(hint()).toBeNull();
    expect(inPanel(slot.getByTestId("ck-new-task"), t("ckSend")).disabled).toBe(false);
    type(slot.getByTestId("ck-new-task-phrase"), "When the owner saves, then the form keeps its data");
    expect(r.calls).toEqual([]);
  });

  it("[sma:d_priority] a task opened by its id offers its place in the queue: the select sends the chosen priority for that task of that run, the button holds or releases it, and the card is read again after each", async () => {
    let view = { displayTitle: "Fix the form", objective: "o", area: null, clarify: null, promise: null, ownsPaths: [], expectedOutputs: [], outOfScope: [], blockers: [], drawing: [], drawingOk: null, priority: "normal", heldUntil: null as number | null, approach: null };
    const { slot, r } = await tasks({ cockpit_task: () => view, cockpit_queue: ({ action, priority }: { action: string; priority?: string }) => { if (action === "priority") view = { ...view, priority: priority! }; if (action === "hold") view = { ...view, heldUntil: Date.now() + 1e9 }; if (action === "release") view = { ...view, heldUntil: null }; return { changed: ["t1"], refused: [] }; } }, "run1");
    type(slot.getByPlaceholderText(t("ckTaskLookup")), " t1 ");
    fireEvent.click(button(slot, t("ckTaskOpen")));
    await slot.findByTestId("ck-task-detail");
    expect(r.of("cockpit_task")).toEqual([{ runId: "run1", taskId: "t1" }]);
    const select = slot.getByLabelText(t("ckPriority")) as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["low", "normal", "high", "urgent"]);
    fireEvent.change(select, { target: { value: "urgent" } });
    await waitFor(() => expect(r.of("cockpit_queue")).toEqual([{ runId: "run1", taskIds: ["t1"], action: "priority", priority: "urgent" }]));
    await waitFor(() => expect((slot.getByLabelText(t("ckPriority")) as HTMLSelectElement).value).toBe("urgent"));
    fireEvent.click(button(slot, t("ckHold")));
    await waitFor(() => expect(r.of("cockpit_queue")[1]).toEqual({ runId: "run1", taskIds: ["t1"], action: "hold" }));
    fireEvent.click(await slot.findByText(t("ckRelease"), { selector: "button" }));
    await waitFor(() => expect(r.of("cockpit_queue")[2]).toEqual({ runId: "run1", taskIds: ["t1"], action: "release" }));
    await waitFor(() => expect(r.of("cockpit_task")).toHaveLength(4));
  });
});

describe("region 9 · the forge order form", () => {
  it("[sma:d_forge] the order is off until the name is kebab-case and the brief has twenty letters, goes with the chosen kind, name and brief (the body only when the owner wrote one), and a refusal is shown as said", async () => {
    const { ForgeScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const r = recorder({ cockpit_forge_list: () => [], helpers_list: () => [], cockpit_forge_order: () => { throw new Error("no Lane Pilot PM chat is open in this project"); } });
    const slot = await mount(() => <ForgeScreen rpc={r.rpc} projectId="p1" runId={null} />);
    const panel = await slot.findByTestId("ck-forge-order");
    const send = inPanel(panel, t("ckSend"));
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText(t("ckForgeName")), "Bad Name");
    type(slot.getByLabelText(t("ckForgeBrief")), "Fixes one red check for the catalog.");
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText(t("ckForgeName")), "fixer");
    type(slot.getByLabelText(t("ckForgeBrief")), "too short");
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText(t("ckForgeBrief")), "Fixes one red check for the catalog.");
    expect(send.disabled).toBe(false);
    fireEvent.click(inPanel(panel, "role"));
    expect(slot.queryByLabelText(t("ckForgeBody"))).toBeNull();
    fireEvent.click(send);
    await waitFor(() => expect(r.of("cockpit_forge_order")).toEqual([{ projectId: "p1", kind: "role", name: "fixer", brief: "Fixes one red check for the catalog." }]));
    await waitFor(() => expect(panel.textContent).toContain("no Lane Pilot PM chat is open in this project"));
    fireEvent.click(inPanel(panel, "skill"));
    type(slot.getByLabelText(t("ckForgeBody")), "Use loading=lazy.");
    fireEvent.click(send);
    await waitFor(() => expect(r.of("cockpit_forge_order")[1]).toEqual({ projectId: "p1", kind: "skill", name: "fixer", brief: "Fixes one red check for the catalog.", body: "Use loading=lazy." }));
  });
});

describe("region 9 · the phase card: the word at a gate and the plan lines", () => {
  const status = (key: string, record: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
    phase: { id: "ph1", title: "Footer", goal: "Ship the footer", stage: "execution", state: "active", record: { ownerWords: true, ...record } },
    withdrawable: [], next: { text: "Waiting", key }, ownerWord: {}, gates: {}, book: "", facts: {}, ...extra,
  });
  async function phase(over: Record<string, unknown>) {
    const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder({ phase_list: () => [{ id: "ph1", title: "Footer", goal: "g", stage: "execution", state: "active" }], phase_get: () => over, phase_files: () => ({ files: [] }), phase_control: () => ({ notice: "now say «issue»" }), phase_act: () => ({}) });
    const slot = await mount(() => <PhasesScreen rpc={r.rpc} projectId="p1" />);
    fireEvent.click(await slot.findByTestId("ck-phase-ph1").then((row) => row.querySelector("button")!));
    await slot.findByTestId("ck-phase-card");
    return { slot, r };
  }

  it("[sma:d_stage_confirm] the owner's word at the turn the phase waits on: «yes» sends the turn with «да» (or his words), «no» is off until he writes why; at acceptance both checks come first and the word carries the package key; a phase whose owner words are off shows no word box", async () => {
    const { slot, r } = await phase(status("ph1:word:context"));
    expect(slot.getByTestId("ck-word").textContent).toContain(`${t("ckPhaseWord")} · context`);
    const no = button(slot, t("ckNo"));
    expect(no.disabled).toBe(true);
    fireEvent.click(button(slot, t("ckYes")));
    await waitFor(() => expect(r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "word", turn: "context", decision: "yes", note: "да" }]));
    type(slot.getByLabelText(`${t("ckPhaseWord")} · context`), "the appetite is too big");
    fireEvent.click(button(slot, t("ckNo")));
    await waitFor(() => expect(r.of("phase_control")[1]).toEqual({ phaseId: "ph1", action: "word", turn: "context", decision: "no", note: "the appetite is too big" }));
    cleanup();
    const accept = await phase(status("ph1:word:acceptance", {}, { acceptancePackage: { key: "pk-77", verdict: null, diffStat: null } }));
    const yes = button(accept.slot, t("ckYes"));
    expect(yes.disabled).toBe(true);
    fireEvent.click(accept.slot.getByTestId("ck-useful"));
    expect(yes.disabled).toBe(true);
    fireEvent.click(accept.slot.getByTestId("ck-limits"));
    expect(yes.disabled).toBe(false);
    expect(accept.slot.getByTestId("ck-package-key").textContent).toBe("package pk-77");
    fireEvent.click(yes);
    await waitFor(() => expect(accept.r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "word", turn: "acceptance", decision: "yes", note: "да", useful: true, limits: true, key: "pk-77" }]));
    cleanup();
    const quiet = await phase(status("ph1:word:context", { ownerWords: false }));
    expect(quiet.slot.queryByTestId("ck-word")).toBeNull();
  });

  it("[sma:m_sw_piece_line] each piece of the plan is one line «w<wave> · title — promise» with the task it became and its state; only a piece issued as a task (queued or at work) can be stopped, a blocked one retried, a piece not yet issued trimmed with the owner's note, and the trim's notice is shown", async () => {
    const record = { plan: { items: [
      { id: "a", title: "Footer", wave: 1, promise: { then: "the footer shows" } }, { id: "b", title: "Header", wave: 2, promise: { then: "the header shows" } },
      { id: "c", title: "Cart", wave: 2, promise: { then: "the cart shows" } }, { id: "d", title: "Search", wave: 3, promise: { then: "search shows" } } ] } };
    const facts = { a: { taskId: "t-a", attemptId: "at-a", state: "running" }, c: { taskId: "t-c", attemptId: "at-c", state: "blocked" }, d: { taskId: "t-d", attemptId: "at-d", state: "queued" } };
    const { slot, r } = await phase(status("ph1:execute", record, { withdrawable: ["b"], facts }));
    const line = (id: string) => slot.getByTestId(`ck-plan-${id}`);
    expect(line("a").textContent).toBe(`w1 · Footer — the footer shows t-a running${t("cancel")}`);
    expect(line("b").textContent).toBe(`w2 · Header — the header shows ${t("ckPieceWithdraw")}`);
    expect(line("c").textContent).toBe(`w2 · Cart — the cart shows t-c blocked${t("retry")}`);
    expect(line("d").textContent).toBe(`w3 · Search — search shows t-d queued${t("cancel")}`);
    const withdraw = inPanel(line("b"), t("ckPieceWithdraw"));
    expect(withdraw.disabled).toBe(true);
    type(slot.getByLabelText(t("ckContextNote")), "drop it");
    fireEvent.click(withdraw);
    await waitFor(() => expect(r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "withdraw", piece: "b", note: "drop it" }]));
    await waitFor(() => expect(slot.getByTestId("ck-withdraw-notice").textContent).toBe("now say «issue»"));
    fireEvent.click(inPanel(line("a"), t("cancel")));
    await waitFor(() => expect(r.of("phase_control")[1]).toEqual({ phaseId: "ph1", action: "cancel_piece", piece: "a", note: "drop it" }));
    fireEvent.click(inPanel(line("c"), t("retry")));
    await waitFor(() => expect(r.of("phase_control")[2]).toEqual({ phaseId: "ph1", action: "decide", piece: "c", choice: "retry", note: "drop it" }));
  });
});

describe("region 9 · what waits for the owner", () => {
  const NOW = Date.now();
  const lead = { key: "lead:r1", source: "lead", kind: "proposal", projectId: "p1", what: "Make the cart its own phase", why: "The lead proposes a direction; the owner takes it.", since: NOW, wake: false, tier: "now", evidence: [],
    actions: [{ id: "yes", label: "Yes", cli: "x yes", rpc: { method: "lead_decide", input: { roadId: "r1", decision: "yes" } } }, { id: "later", label: "Later", cli: "x later", rpc: { method: "lead_decide", input: { roadId: "r1", decision: "later" } } }, { id: "no", label: "No", cli: "x no", rpc: { method: "lead_decide", input: { roadId: "r1", decision: "no" } } }] };
  const phaseItem = { key: "phase:ph1:context", source: "phase", kind: "word", projectId: "p1", what: "Phase «Footer» waits for your word: context", why: "Say yes or no on the phase card.", since: NOW, wake: false, tier: "now", evidence: [], actions: [] };
  const overnight = { windowMs: 86_400_000, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 };
  async function board(table: Table) {
    await loadPluginApp(() => import("../../app"));
    const { OwnerWaitingBoard } = await import("../../src/rooms/owner-waiting/ui");
    const calls: Array<[string, unknown]> = [];
    const wrapped = Object.fromEntries(Object.entries({ owner_waiting_config: () => ({ enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" }), ...table }).map(([name, handler]) => [name, (params: never) => { calls.push([name, params]); return (handler as (p: never) => unknown)(params); }]));
    const slot = renderSlot({ component: () => <OwnerWaitingBoard projects={[{ id: "p1", name: "Shop" }]} /> }, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
    return { slot, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
  }

  it("[sma:m_sw_decision_prop] a decision the lead names is a card with its project, what and why, and a button per answer; a press sends that answer for that road, the list is read again, and a card that is gone after the answer disappears", async () => {
    let items: unknown[] = [lead];
    const { slot, of } = await board({ owner_waiting: () => ({ generatedAt: NOW, counts: {}, overnight, items }), lead_decide: () => { items = []; return { ok: true }; } });
    const card = await slot.findByTestId("owner-item-lead:r1");
    expect(card.textContent).toContain("Make the cart its own phase");
    expect(card.textContent).toContain("Shop");
    expect(card.textContent).toContain("The lead proposes a direction; the owner takes it.");
    expect(Array.from(card.querySelectorAll("button[data-testid^='owner-run-']")).map((node) => node.textContent)).toEqual(["Yes", "Later", "No"]);
    fireEvent.click(slot.getByTestId("owner-run-lead:r1-no"));
    await waitFor(() => expect(of("lead_decide")).toEqual([{ roadId: "r1", decision: "no" }]));
    await waitFor(() => expect(slot.queryByTestId("owner-item-lead:r1")).toBeNull());
    expect(of("owner_waiting").length).toBeGreaterThanOrEqual(2);
    expect(slot.getByTestId("owner-empty")).toBeTruthy();
  });

  it("[sma:m_sw_awaiting] a phase that waits for the owner's word is listed under «Phases waiting for your word» with what it waits for and no button (the word is given on the phase card); the counts say how many wait; with nothing waiting the screen says so", async () => {
    let items: unknown[] = [phaseItem, lead];
    const { slot } = await board({ owner_waiting: () => ({ generatedAt: NOW, counts: {}, overnight, items }) });
    const section = await slot.findByTestId("owner-section-phase");
    expect(section.querySelector("h3")!.textContent).toBe(`${t("ow_section_phase")} 1`);
    const card = slot.getByTestId("owner-item-phase:ph1:context");
    expect(card.textContent).toContain("Phase «Footer» waits for your word: context");
    expect(card.querySelector("button[data-testid^='owner-run-']")).toBeNull();
    expect(slot.getByTestId("owner-count").textContent).toBe("2");
    expect(slot.getByTestId("owner-section-lead").querySelector("h3")!.textContent).toBe(`${t("ow_section_lead")} 1`);
    items = [];
    cleanup();
    const none = await board({ owner_waiting: () => ({ generatedAt: NOW, counts: {}, overnight, items }) });
    expect((await none.slot.findByTestId("owner-empty")).textContent).toBe(t("ow_empty"));
    expect(none.slot.queryByTestId("owner-section-phase")).toBeNull();
  });
});

describe("region 9 · the live panel and the seen time", () => {
  const cell = (stageId: string, state: string) => ({ stageId, state, rounds: state === "pending" ? 0 : 1, failures: 0, reason: null });
  const item = (taskId: string, column: string, phase: string) => ({ key: `task:run:${taskId}`, runId: "run", taskId, title: `Task ${taskId}`, column, phase, stage: null, model: null, since: null, threadId: null, updatedAt: 1, detail: null });
  const graph = { cells: [cell("writer-agent", "running")], stages: [{ cell: cell("writer-agent", "running"), rows: [] }], summary: { returns: 0, seconds: null, costUsd: null, costState: "not_measured", models: [] } };

  async function live(role: "pm" | "writer", items: unknown[]) {
    await loadPluginApp(() => import("../../app"));
    const { ThreadLive } = await import("../../src/rooms/runs/ui");
    const calls: Array<[string, unknown]> = [];
    const rpc = { thread_live: () => ({ role, pmThreadId: "thr_pm", items, strips: {} }), work_graph_task: (params: unknown) => { calls.push(["work_graph_task", params]); return graph; } };
    const slot = renderSlot({ component: () => <ThreadLive threadId="thr_pm" locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
    return { slot, steps: () => calls.map(([, params]) => params) };
  }

  it("[sma:m_sw_workbook_panel] in a PM chat one task at work opens its step list by itself, two at work stay folded until pressed, a press opens exactly that task's steps from the server, and in a writer's thread the task's steps are open at once", async () => {
    const one = await live("pm", [item("w1", "running", "writing"), item("d1", "done", "accepted")]);
    await one.slot.findByTestId("thread-live");
    await waitFor(() => expect(one.steps()).toEqual([{ runId: "run", taskId: "w1" }]));
    expect(one.slot.getAllByTestId("stage-steps")).toHaveLength(1);
    fireEvent.click(one.slot.getByText("Task d1"));
    await waitFor(() => expect(one.steps()).toContainEqual({ runId: "run", taskId: "d1" }));
    cleanup();
    const two = await live("pm", [item("w1", "running", "writing"), item("w2", "running", "writing")]);
    await two.slot.findByTestId("thread-live");
    expect(two.slot.queryAllByTestId("stage-steps")).toHaveLength(0);
    expect(two.steps()).toEqual([]);
    fireEvent.click(two.slot.getByText("Task w2"));
    await waitFor(() => expect(two.steps()).toEqual([{ runId: "run", taskId: "w2" }]));
    fireEvent.click(two.slot.getByText("Task w2"));
    await waitFor(() => expect(two.slot.queryAllByTestId("stage-steps")).toHaveLength(0));
    cleanup();
    const writer = await live("writer", [item("w1", "running", "writing"), item("w2", "running", "writing")]);
    await writer.slot.findByTestId("thread-live");
    await waitFor(() => expect(writer.slot.getAllByTestId("stage-steps")).toHaveLength(2));
  });

  it("[sma:m_sw_visible_time] a screen reports how long it stayed in view when it is left — the screen's name and the milliseconds between mount and leave — and a refused report is swallowed", async () => {
    const { useSeen } = await import("../../src/rooms/cockpit/ui/kit");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_800_000_000_000);
    const calls: Array<[string, unknown]> = [];
    const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); return Promise.reject(new Error("offline")); } };
    function Probe({ screen }: { screen: string }) { useSeen(rpc as never, screen); useEffect(() => undefined, []); return null; }
    const view = render(createElement(Probe, { screen: "today" }));
    vi.setSystemTime(1_800_000_001_500);
    view.unmount();
    expect(calls).toEqual([["cockpit_seen", { screen: "today", ms: 1500 }]]);
    // A change of screen reports the one left, and the new one counts from then.
    const next = render(createElement(Probe, { screen: "money" }));
    vi.setSystemTime(1_800_000_004_000);
    next.rerender(createElement(Probe, { screen: "forge" }));
    vi.setSystemTime(1_800_000_004_250);
    next.unmount();
    expect(calls.slice(1)).toEqual([["cockpit_seen", { screen: "money", ms: 2500 }], ["cockpit_seen", { screen: "forge", ms: 250 }]]);
  });
});

describe("region 9 · the day screen", () => {
  const AT = new Date(2026, 10, 14, 9, 30).getTime();
  const today = (over: Record<string, unknown> = {}) => ({ kpi: { accepted: 3, blocked: 1, running: 2, tokens: 12345, actions: 7 }, feed: [
    { at: AT, kind: "task_accepted", text: "t1 accepted", runId: "run1", taskId: "t1", title: "Footer shipped" }, { at: AT - 60_000, kind: "task_blocked", text: "t2 blocked on tests" },
    { at: AT - 120_000, kind: "task_running", text: "t3 started" }, { at: AT - 180_000, kind: "phase_closed", text: "phase closed" } ], ...over });
  async function day(read: () => unknown, extra: Table = {}) {
    const { TodayScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
    const r = recorder({ cockpit_today: read, ...extra });
    const slot = await mount(() => <TodayScreen rpc={r.rpc} projectId="p1" />);
    await slot.findByTestId("ck-kpi");
    return { slot, r };
  }

  it("[sma:m_sw_kpi] the strip says how much was accepted, is blocked, is at work, the tokens of the day (grouped) and the actions — in that order, each under its name — and names the sources that did not answer", async () => {
    const { slot, r } = await day(() => today({ partial: ["usage", "wall"] }));
    expect(r.of("cockpit_today")).toEqual([{ projectId: "p1" }]);
    expect(Array.from(slot.getByTestId("ck-kpi").children).map((cell) => cell.textContent)).toEqual([`${t("ckKpiAccepted")}3`, `${t("ckKpiBlocked")}1`, `${t("ckKpiRunning")}2`, `${t("ckKpiTokens")}${(12345).toLocaleString()}`, `${t("ckKpiActions")}7`]);
    expect(slot.getByTestId("ck-partial").textContent).toBe(`${t("ckPartialNote")}: usage, wall`);
    cleanup();
    const whole = await day(() => today());
    expect(whole.slot.queryByTestId("ck-partial")).toBeNull();
  });

  it("[sma:m_sw_dayfeed] the feed lists the day's events newest first as «time · kind in words · text», the kinds of task events in the person's words and the others without their prefix, and an empty day says it is empty", async () => {
    const { slot } = await day(() => today());
    const rows = Array.from(slot.getByTestId("ck-feed").querySelectorAll("li")).map((row) => row.textContent);
    const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    expect(rows).toEqual([`${time(AT)}${t("ckKind_accepted")}t1 accepted`, `${time(AT - 60_000)}${t("ckKind_blocked")}t2 blocked on tests`, `${time(AT - 120_000)}${t("ckKind_running")}t3 started`, `${time(AT - 180_000)}closedphase closed`]);
    cleanup();
    const empty = await day(() => today({ feed: [] }));
    expect(empty.slot.queryByTestId("ck-feed")).toBeNull();
    expect(empty.slot.getAllByText(t("ckEmpty")).length).toBeGreaterThan(0);
  });

  it("[sma:m_sw_done_unfold] only accepted rows are listed under «Done today»; a press loads that task's acceptance card for its run and task, shows what was promised and each line with its verdict and why, and a second press folds it", async () => {
    const card = { contract: { objective: "Make the footer fit", acceptance: ["footer fits"] }, planFact: { items: [{ item: 1, acceptance: "the footer fits", verdict: "proven", why: "seen at 375px" }, { item: 2, acceptance: "the cart shows", verdict: "claimed", why: null }] } };
    const { slot, r } = await day(() => today(), { task_acceptance_card: () => card });
    const rows = slot.container.querySelectorAll("button[aria-expanded]");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("Footer shipped");
    expect(r.of("task_acceptance_card")).toEqual([]);
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(slot.getByTestId("ck-accepted-card")).toBeTruthy());
    expect(r.of("task_acceptance_card")).toEqual([{ runId: "run1", taskId: "t1" }]);
    const shown = slot.getByTestId("ck-accepted-card");
    expect(shown.querySelector("p")!.textContent).toBe(`${t("ckPromised")}: Make the footer fit`);
    expect(Array.from(shown.querySelectorAll("li")).map((line) => line.textContent)).toEqual(["✓ the footer fits — seen at 375px", "· the cart shows"]);
    fireEvent.click(rows[0]!);
    await waitFor(() => expect(slot.queryByTestId("ck-accepted-card")).toBeNull());
  });
});

describe("region 9 · the task list and the artifact", () => {
  const MIN = 60_000;
  const item = (taskId: string, column: string, over: Record<string, unknown> = {}) => ({
    kind: "task", key: `task:run:${taskId}`, runId: "run", taskId, title: `Title ${taskId}`, techTitle: null, taskKind: "fix", area: null, objective: "The cart goal", projectId: "proj_a", pmThreadId: "thr_pm", pmThreadTitle: "Coordinator", column,
    state: column === "done" ? "accepted" : "running", phase: column === "done" ? "accepted" : column === "blocked" ? "blocked" : column === "queued" ? "queued" : "writing", stage: null, model: null, since: null, waitingFor: [], detail: null, attemptNo: 1, threadId: null, attemptId: `a-${taskId}`,
    updatedAt: Date.now() - 2 * MIN, ...over,
  });
  async function list(items: unknown[]) {
    await loadPluginApp(() => import("../../app"));
    const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
    const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui");
    const calls: Array<[string, unknown]> = [];
    const wrap = (name: string, handler: (params: never) => unknown) => (params: never) => { calls.push([name, params]); return handler(params); };
    const table: Table = { task_board: () => ({ items }), task_card: ({ taskId }: { taskId: string }) => ({ kind: "task", title: `Title ${taskId}`, techTitle: null, taskKind: "fix", area: null, objective: "o", pmThreadId: "thr_pm", id: taskId, projectId: "proj_a", state: "accepted", reason: null,
      contract: { objective: "o", acceptance: ["a"], ownsPaths: [], expectedOutputs: [], dependsOn: [], checks: [] }, plan: null, stages: [], attempts: [], threads: null }),
      task_acceptance_card: () => null, work_graph_task: () => ({ cells: [], stages: [], summary: { returns: 0, seconds: null, costUsd: null, costState: "not_measured", models: [] } }), work_graph_strips: () => ({}), task_diff: () => ({ reason: "no merge" }), work_file_read: () => ({ content: "", truncated: false }) };
    const wrapped = Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, wrap(name, handler)]));
    const slot = renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} serviceProjectIds={[]} locale="en" AcceptanceCard={AcceptanceCard} /> }, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
    await waitFor(() => expect(calls.some(([name]) => name === "task_board")).toBe(true));
    fireEvent.click(await slot.findByTestId("board-view-list"));
    await slot.findByTestId("board-list");
    return { slot, calls };
  }

  it("[sma:m_sw_done_list] in the list the accepted and the closed works are rows under the work that is not finished — running first, then blocked, queued, and the done ones last (the newest done first) — each group saying how many of its works are done and stuck", async () => {
    const { slot } = await list([item("d-old", "done", { updatedAt: Date.now() - 90 * MIN }), item("q1", "queued"), item("d-new", "done"), item("b1", "blocked"), item("w1", "running"), item("d-can", "done", { phase: "canceled", state: "canceled", updatedAt: Date.now() - 200 * MIN })]);
    const rows = Array.from(slot.getByTestId("board-list").querySelectorAll("[data-testid^='board-row-']")).map((row) => row.getAttribute("data-testid"));
    expect(rows).toEqual(["board-row-task:run:w1", "board-row-task:run:b1", "board-row-task:run:q1", "board-row-task:run:d-new", "board-row-task:run:d-old", "board-row-task:run:d-can"]);
    expect(slot.getByTestId("board-group-goal:run").textContent).toContain(t("boardGroupSummary").replace("{n}", "6").replace("{done}", "3").replace("{stuck}", "1"));
    expect(slot.getByTestId("board-row-task:run:d-can").querySelector("[data-status-icon]")!.getAttribute("data-status-icon")).toBe("done");
  });

  it("[sma:m_sw_unit_row] a row is the work in one line — its status ring, short id, title, where it is (the phase in words), kind and age — and a press opens that work's own page; a work of another project shows its project's name when all projects are listed", async () => {
    const { slot, calls } = await list([item("ck-24-ui-pages.2", "done", { title: "Footer shipped" }), item("other", "running", { projectId: "proj_b", title: "Elsewhere" })]);
    const row = slot.getByTestId("board-row-task:run:ck-24-ui-pages.2");
    expect(row.querySelector("[data-status-icon]")!.getAttribute("data-status-icon")).toBe("done");
    expect(row.textContent).toContain("ck-24.2");
    expect(row.textContent).toContain("Footer shipped");
    expect(row.textContent).toContain(t("phase_accepted"));
    expect(row.textContent).toContain(t("kind_fix"));
    expect(row.textContent).toContain(t("boardMinAgo").replace("{n}", "2"));
    expect(row.textContent).toContain("Alpha");
    expect(row.getAttribute("title")).toBe("ck-24-ui-pages.2");
    expect(slot.getByTestId("board-row-task:run:other").textContent).toContain("proj_b");
    fireEvent.click(row);
    await slot.findByTestId("task-card");
    expect(calls.filter(([name]) => name === "task_card").map(([, params]) => params)).toEqual([{ runId: "run", taskId: "ck-24-ui-pages.2" }]);
  });

  it("[sma:m_sw_artifact] a stage's result body is read only when the owner opens it (for that run, task and stage), is shown as the receipt's text, says there is no evidence for an empty one, and says so when the read failed", async () => {
    await loadPluginApp(() => import("../../app"));
    const { StageResult } = await import("../../src/rooms/runs/ui/stage-result");
    const reads: unknown[] = [];
    const open = (testId: string) => { const node = document.querySelector(`[data-testid='${testId}']`) as HTMLDetailsElement; node.open = true; };
    const results: Record<string, () => unknown> = { s1: () => ({ result: { verdict: "passed", files: ["a.ts"] } }), s2: () => ({ result: null }), s3: () => { throw new Error("gone"); } };
    const rpc = { get_stage_result: (params: { stageId: string }) => { reads.push(params); return results[params.stageId]!(); } };
    const slot = renderSlot({ component: () => <div>{["s1", "s2", "s3"].map((id) => <StageResult key={id} runId="run" taskId="t1" stageId={id} />)}</div> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
    expect(reads).toEqual([]);
    expect(slot.container.textContent).toContain(t("stageResultLoading"));
    open("stage-result-run-t1-s1");
    await waitFor(() => expect(slot.getByTestId("stage-result-run-t1-s1").textContent).toContain('"verdict": "passed"'));
    expect(reads).toEqual([{ runId: "run", taskId: "t1", stageId: "s1" }]);
    open("stage-result-run-t1-s2");
    await waitFor(() => expect(slot.getByTestId("stage-result-run-t1-s2").textContent).toContain(t("stageNoEvidence")));
    open("stage-result-run-t1-s3");
    await waitFor(() => expect(slot.getByTestId("stage-result-run-t1-s3").textContent).toContain(t("stageResultFailed")));
    expect(reads).toEqual([{ runId: "run", taskId: "t1", stageId: "s1" }, { runId: "run", taskId: "t1", stageId: "s2" }, { runId: "run", taskId: "t1", stageId: "s3" }]);
  });
});
