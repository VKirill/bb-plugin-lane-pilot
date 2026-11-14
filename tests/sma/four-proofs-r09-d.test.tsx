/** @vitest-environment jsdom */
// Region 9 · Person and window, batch d (n850 … n881): the screens of the window rendered for real in jsdom — the phase card's wave question, the owner's
// question, the workers, money, rules, coordination, ship and backlog screens, the live row, the phone frame and the window's own plumbing (root, live
// channel, signed out, waiting). Each test drives what the person presses or reads and checks the whole call that goes out or the text the screen shows.
// What a window sent or drew is also written down with observe(): the region scene sma_r09 compares those values with the cards.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, waitFor, act } from "@testing-library/react";
import { createElement } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride, t } from "@lane-pilot/i18n";
import { controllableMedia, observe, recorder, type Table } from "./r09-world-d";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
const realMatchMedia = window.matchMedia;
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); window.matchMedia = realMatchMedia; localStorage.clear(); });

async function mount(component: () => React.ReactElement, table: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: table as never });
}
const button = (slot: ReturnType<typeof renderSlot>, text: string) => slot.getByText(text, { selector: "button" }) as HTMLButtonElement;
const text = (node: Element | null) => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

// ---- the wave question and the question to the owner ----
const phaseStatus = (): Record<string, unknown> => ({
  phase: { id: "ph1", title: "Footer", goal: "Ship the footer", stage: "execution", state: "active", record: {
    plan: { items: [{ id: "a", title: "Footer piece", wave: 1, promise: { then: "the footer shows" } }] }, ownerWords: true,
    execution: { issued: {}, waves: { "2": { lines: [{ id: "w1", ok: true, detail: "checks green" }, { id: "w2", ok: false, detail: "header missing" }], review: { state: "ok", by: "codex", summary: "reads fine" } } } } } },
  withdrawable: [], next: { text: "Waiting for your word on wave 2", key: "ph1:word:wave:2" }, ownerWord: {}, gates: {}, book: "", facts: {},
});

describe("region 9 · the wave question and the question to the owner", () => {
  it("[sma:m_sw_batch_hold] a wave that waits for the owner is asked with its basis — the wave number, its acceptance lines and the other model's review — and «Hold the wave» sends the no for THAT wave with the owner's words, «Accept the wave» the yes", async () => {
    const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder({ phase_list: () => [{ id: "ph1", title: "Footer", goal: "Ship the footer", stage: "execution", state: "active" }], phase_get: phaseStatus, phase_files: () => ({ files: [] }), phase_control: () => ({}) });
    const slot = await mount(() => <PhasesScreen rpc={r.rpc as never} projectId="p1" />);
    fireEvent.click((await slot.findByTestId("ck-phase-ph1")).querySelector("button")!);
    const question = (await slot.findByTestId("ck-wave-question")).textContent;
    expect(question).toBe("Wave 2 is done. Accept or hold?✓ w1: checks green✗ w2: header missingcodex: reads fine");
    expect(text(slot.getByTestId("ck-wave-review"))).toBe("codex: reads fine");
    expect(button(slot, "Hold the wave").disabled).toBe(true);
    fireEvent.change(slot.getByLabelText(/Your word/), { target: { value: "the header is missing" } });
    fireEvent.click(button(slot, "Hold the wave"));
    await waitFor(() => expect(r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "word", turn: "wave", wave: 2, decision: "no", note: "the header is missing" }]));
    fireEvent.click(button(slot, "Accept the wave"));
    await waitFor(() => expect(r.of("phase_control")[1]).toEqual({ phaseId: "ph1", action: "word", turn: "wave", wave: 2, decision: "yes", note: "the header is missing" }));
    observe("n850", { question, review: text(slot.getByTestId("ck-wave-review")), sent: r.of("phase_control")[0] });
  });

  it("[sma:m_sw_question] the owner's question is shown whole, a tapped answer goes with the id of the option (and the typed words), free words go alone, an empty box sends nothing and «Dismiss» withdraws the question", async () => {
    const { OwnerAsk } = await import("../../src/rooms/relay/ui/owner-ask");
    const sent: unknown[] = [];
    let dismissed = 0;
    const payload = { v: 1, question: "Run the migration now?", detail: "It locks the table for a minute.", options: [{ id: "yes_now", label: "Run it now" }, { id: "later", label: "Tonight" }], allowText: true, source: "pm", kind: "decision" };
    const props = { interaction: { payload }, submit: async (response: unknown) => { sent.push(response); }, cancel: async () => { dismissed += 1; } };
    const view = render(createElement(OwnerAsk as never, props as never));
    expect(text(view.getByTestId("owner-ask-question"))).toBe("Run the migration now?");
    expect(text(view.getByTestId("owner-ask-detail"))).toContain("It locks the table for a minute.");
    fireEvent.click(view.getByText("Tonight"));
    await waitFor(() => expect(sent).toEqual([{ choice: "later" }]));
    fireEvent.change(view.getByLabelText(t("ownerAskPlaceholder")), { target: { value: "  after the release  " } });
    fireEvent.click(view.getByText("Run it now"));
    await waitFor(() => expect(sent[1]).toEqual({ choice: "yes_now", text: "after the release" }));
    fireEvent.click(view.getByText(t("ownerAskSend")));
    await waitFor(() => expect(sent[2]).toEqual({ text: "after the release" }));
    fireEvent.change(view.getByLabelText(t("ownerAskPlaceholder")), { target: { value: "   " } });
    expect((view.getByText(t("ownerAskSend")) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByText(t("ownerAskDismiss")));
    await waitFor(() => expect(dismissed).toBe(1));
    observe("n851", { question: text(view.getByTestId("owner-ask-question")), sent });
  });
});

// ---- who works: the worker cards, the lane table ----
const cap = (capability: string, state: string) => ({ capability, state, version: "1" });
const WORKERS = [
  { providerId: "claude-code", model: "opus", tokens: 1200, days: [], capabilities: [cap("documentary.hooks", "supported"), cap("gate", "supported")], running: 2, runningTasks: ["t1", "t2"], lastAt: Date.UTC(2026, 10, 12, 9, 0) },
  { providerId: "codex", model: "gpt-6-luna", tokens: 50, days: [], capabilities: [cap("answers", "supported"), cap("pause", "not_supported")], running: 0, runningTasks: [], lastAt: Date.UTC(2026, 10, 11, 10, 30) },
  { providerId: "codex", model: "gpt-6-mini", tokens: 5, days: [], capabilities: [cap("answers", "supported")], running: 0, runningTasks: [], lastAt: null },
];
const WINDOWS = { at: null, windows: { five_hour: { utilization: 85.4, resetsAt: null }, seven_day: { utilization: 8, resetsAt: null } } };
async function workers(extra: Table = {}, hostId: string | null = "h1") {
  const { WorkersScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
  const r = recorder({ cockpit_workers: () => WORKERS, cockpit_windows: () => WINDOWS, cockpit_designer: () => ({ readiness: "none", conditions: [], ratios: {} }), ...extra });
  const slot = await mount(() => <WorkersScreen rpc={r.rpc as never} projectId="p1" hostId={hostId} />);
  const cards = await slot.findAllByTestId("ck-worker-card");
  return { slot, r, cards };
}

describe("region 9 · who works", () => {
  it("[sma:m_sw_team] the team screen says who is on what and who is free: a worker holding tasks names them, a worker with none shows only when it last worked, a worker never seen shows no presence line", async () => {
    const { cards } = await workers();
    const presence = (card: HTMLElement) => card.querySelector("[data-testid=ck-worker-presence]");
    expect(text(presence(cards[0]!))).toMatch(/^holds 2 \(t1, t2\) · /);
    const free = text(presence(cards[1]!));
    expect(free.startsWith("· ")).toBe(true);
    expect(free).not.toContain("t1");
    expect(free).not.toMatch(/holds/);
    expect(presence(cards[2]!)).toBeNull();
    observe("n853", { models: cards.map((card) => text(card.querySelector("p"))), onWhat: text(presence(cards[0]!)).split(" · ")[0], free: free.startsWith("· "), never: presence(cards[2]!) === null });
  });

  it("[sma:m_sw_worker_card] the worker card names the model, the provider with its tokens, what it holds now, and — on a claude-code card only — the subscription windows in words with the percentage the vendor sent", async () => {
    const { cards } = await workers();
    expect(text(cards[0]!.querySelectorAll("p")[0]!)).toBe("opus");
    expect(text(cards[0]!.querySelectorAll("p")[1]!)).toBe("claude-code · 1,200 tokens in 30 days");
    expect(text(cards[0]!.querySelector("[data-testid=ck-worker-window]"))).toBe("5 часов 85% · 7 дней 8%");
    expect(cards[1]!.querySelector("[data-testid=ck-worker-window]")).toBeNull();
    expect(cards[2]!.querySelector("[data-testid=ck-worker-window]")).toBeNull();
    observe("n854", { header: text(cards[0]!.querySelectorAll("p")[1]!), windows: text(cards[0]!.querySelector("[data-testid=ck-worker-window]")), codexWindows: cards[1]!.querySelector("[data-testid=ck-worker-window]") !== null });
  });

  it("[sma:m_sw_lane_table] the lane table has one row per provider (two models of one provider are one row) with a mark per capability: ✓ supported, ✗ not, · not reported", async () => {
    const { slot } = await workers();
    const rows = Array.from(slot.getByTestId("ck-lanes").querySelectorAll("tbody tr")).map((row) => Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent));
    expect(rows).toEqual([
      ["claude-code", "·", "·", "·", "✓", "·", "·", "·", "·", "✓"],
      ["codex", "✓", "·", "·", "·", "·", "✗", "·", "·", "·"],
    ]);
    observe("n862", rows);
  });
});

// ---- money: spend, the cap, the table, the windows, the accounts ----
const MONEY = { monthUsd: 12.5, estimatedUsd: 2.25, cap: 50, left: 37.5, byProvider: { codex: 10.25, "claude-code": 2.25 }, table: [
  { day: "2026-11-12", usd: 3.5, byProvider: { codex: 3.5 } }, { day: "2026-11-13", usd: 4, byProvider: { codex: 1.25, opencode: 2.75 } }, { day: "2026-11-11", usd: 0, byProvider: {} }] };
const ACCOUNTS = [{ hostId: "h1", name: "Mac mini", at: null, windows: { five_hour: { utilization: 61.6 }, seven_day: { utilization: 8 } }, reason: null }, { hostId: "h2", name: null, at: null, windows: null, reason: "signed out" }];
async function money(extra: Table = {}, hostId: string | null = "h1") {
  const { MoneyScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
  const r = recorder({ money_status: () => MONEY, cockpit_windows: () => WINDOWS, cockpit_accounts: () => ACCOUNTS, save_setting: () => ({ ok: true }), ...extra });
  const slot = await mount(() => <MoneyScreen rpc={r.rpc as never} hostId={hostId} />);
  await slot.findByTestId("ck-money-cap");
  return { slot, r };
}

describe("region 9 · money", () => {
  it("[sma:m_sw_costs] the spend screen is where money appears: the month's spend against the cap, the estimated part apart, each paid provider's share, and below them the subscription windows and the accounts", async () => {
    const { slot } = await money();
    const month = text(slot.getByTestId("ck-money").querySelector("p.text-lg"));
    expect(month).toBe("Spent this month: $12.50 / $50");
    const lines = Array.from(slot.getByTestId("ck-money").querySelectorAll("ul.text-xs li")).map(text);
    expect(lines).toEqual(["codex: $10.25", "claude-code: $2.25"]);
    expect(text(slot.getByTestId("ck-money").querySelectorAll("p.text-xs")[0]!)).toContain("2.25");
    expect(slot.getByTestId("ck-windows")).toBeTruthy();
    expect(slot.getByTestId("ck-accounts")).toBeTruthy();
    observe("n856", { month, providers: lines, estimated: text(slot.getByTestId("ck-money").querySelectorAll("p.text-xs")[0]!) });
  });

  it("[sma:m_sw_budget_dialog] the cap dialog saves the number typed (cents kept) as the global money.monthly_cap_usd, keeps «unlimited» as the word, refuses a non-number and says Sent when it is saved", async () => {
    const { GLOBAL_SETTINGS_PROJECT_ID } = await import("@lane-pilot/settings-catalog");
    const { slot, r } = await money();
    const input = slot.getByLabelText(t("ckMoneyCap")) as HTMLInputElement;
    const save = button(slot, t("ckMoneyCapSave"));
    expect(input.placeholder).toBe("50");
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "12x" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "62.5" } });
    fireEvent.click(save);
    await waitFor(() => expect(r.of("save_setting")).toEqual([{ projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "money.monthly_cap_usd", value: 62.5, expectedVersion: 0 }]));
    await waitFor(() => expect(slot.getByText(t("ckSent"))).toBeTruthy());
    fireEvent.change(input, { target: { value: "unlimited" } });
    fireEvent.click(save);
    await waitFor(() => expect(r.of("save_setting")[1]).toEqual({ projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "money.monthly_cap_usd", value: "unlimited", expectedVersion: 0 }));
    observe("n857", { sent: r.of("save_setting") });
  });

  it("[sma:m_sw_spend_table] the spend table has one row per day that spent, one column per provider with «·» where the provider did not spend, the day's total last; a day with no spend is not a row", async () => {
    const { slot } = await money();
    const table = slot.getByTestId("ck-money-table");
    const head = Array.from(table.querySelectorAll("thead th")).map(text);
    const rows = Array.from(table.querySelectorAll("tbody tr")).map((row) => Array.from(row.querySelectorAll("td")).map(text));
    expect(head).toEqual([t("ckMoneyDay"), "codex", "opencode", t("ckMoneyTotal")]);
    expect(rows).toEqual([["2026-11-12", "$3.50", "·", "$3.50"], ["2026-11-13", "$1.25", "$2.75", "$4.00"]]);
    observe("n858", { head, rows });
  });

  it("[sma:m_sw_terminal_window] the accounts panel has one line per machine: the subscription its own terminal spends in words with the percentage, or «no data» for a machine that sent none; a machine without a name is shown by its id", async () => {
    const { slot } = await money();
    const lines = Array.from(slot.getByTestId("ck-account-list").querySelectorAll("li")).map(text);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Mac mini");
    expect(lines[0]).toContain("5 часов 62%, 7 дней 8%");
    expect(lines[1]).toContain("h2");
    expect(lines[1]).not.toContain("%");
    observe("n859", { lines });
  });

  it("[sma:m_sw_window_bars] each window is a bar with the percentage the vendor sent, amber from 80, red from 98, the reset time only when it came; with no windows the screen says so and shows no percentage", async () => {
    const full = { at: null, windows: { five_hour: { utilization: 42.4, resetsAt: null }, seven_day: { utilization: 85, resetsAt: "2026-11-20T10:00:00Z" }, seven_day_opus: { utilization: 99.5, resetsAt: null } } };
    const { slot } = await money({ cockpit_windows: () => full });
    await slot.findByTestId("ck-window-five_hour");
    const bar = (name: string) => slot.getByTestId(`ck-window-${name}`).querySelector(".bg-primary, .bg-amber-500, .bg-destructive")!;
    expect(text(slot.getByTestId("ck-window-five_hour").querySelector(".tabular-nums"))).toBe("42%");
    expect(text(slot.getByTestId("ck-window-seven_day").querySelector(".tabular-nums"))).toContain("85% · ");
    expect(text(slot.getByTestId("ck-window-seven_day_opus").querySelector(".tabular-nums"))).toBe("100%");
    expect(bar("five_hour").className).toContain("bg-primary");
    expect(bar("seven_day").className).toContain("bg-amber-500");
    expect(bar("seven_day_opus").className).toContain("bg-destructive");
    expect((bar("five_hour") as HTMLElement).style.width).toBe("42.4%");
    expect((bar("seven_day_opus") as HTMLElement).style.width).toBe("99.5%");
    const shown = { five: text(slot.getByTestId("ck-window-five_hour").querySelector(".tabular-nums")), colours: ["five_hour", "seven_day", "seven_day_opus"].map((name) => bar(name).className.match(/bg-(primary|amber-500|destructive)/)![0]) };
    cleanup();
    const none = await money({ cockpit_windows: () => ({ at: null, windows: {} }) });
    await waitFor(() => expect(text(none.slot.getByTestId("ck-windows"))).toContain(t("ckEmpty")));
    expect(text(none.slot.getByTestId("ck-windows"))).not.toContain("%");
    observe("n860", { ...shown, empty: text(none.slot.getByTestId("ck-windows")) });
  });
});

// ---- rules, coordination, ship, backlog ----
describe("region 9 · rules, coordination, ship and the backlog", () => {
  it("[sma:m_sw_rules] the rules screen draws every protection as a disabled switch — ticked unless it is disarmed — with its hazard, the value in force and the days left of a term; the switches are drawn disabled too, an enum shows its value", async () => {
    const { RulesScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const r = recorder({ cockpit_rules: () => ({
      rules: [{ key: "plan_critique.mode", hazard: "h1", armed: "block", current: "warn", disarmed: true, term: { daysLeft: 3 } }, { key: "owner.words", hazard: "h2", armed: "sensitive", current: "sensitive", disarmed: false, term: null }],
      switches: [{ key: "conveyor", kind: "flag", value: true }, { key: "protection.rearm", kind: "flag", value: false }, { key: "writer.fallback_on_provider_failure", kind: "enum", value: "after_retry" }] }) });
    const slot = await mount(() => <RulesScreen rpc={r.rpc as never} projectId="p1" />);
    const first = await slot.findByTestId("ck-rule-plan_critique.mode");
    const box = (id: string) => slot.getByTestId(id).querySelector("input") as HTMLInputElement;
    expect([box("ck-rule-plan_critique.mode").checked, box("ck-rule-owner.words").checked, box("ck-rule-plan_critique.mode").disabled, box("ck-rule-owner.words").disabled]).toEqual([false, true, true, true]);
    expect(text(first)).toContain("warn");
    expect(text(first)).toContain(`${t("ckRuleUntil")} 3 ${t("ckDaysShort")}`);
    expect(text(slot.getByTestId("ck-rule-owner.words"))).not.toContain(t("ckRuleUntil"));
    expect([box("ck-switch-conveyor").checked, box("ck-switch-protection.rearm").checked, box("ck-switch-conveyor").disabled]).toEqual([true, false, true]);
    expect(text(slot.getByTestId("ck-switch-conveyor"))).toContain(t("ckOn"));
    expect(text(slot.getByTestId("ck-switch-protection.rearm"))).toContain(t("ckOff"));
    expect(slot.getByTestId("ck-switch-writer.fallback_on_provider_failure").querySelector("input")).toBeNull();
    expect(text(slot.getByTestId("ck-switch-writer.fallback_on_provider_failure"))).toContain(t("ckFallback_after_retry"));
    expect(r.calls).toEqual([["cockpit_rules", { projectId: "p1" }]]);
    observe("n861", { planCritiqueTicked: box("ck-rule-plan_critique.mode").checked, ownerWordsTicked: box("ck-rule-owner.words").checked, allDisabled: box("ck-rule-plan_critique.mode").disabled, until: text(first).includes(`${t("ckRuleUntil")} 3 ${t("ckDaysShort")}`), writes: r.calls.length - 1 });
  });

  it("[sma:m_sw_coordination] the coordination screen shows what the checkout answered as it is (an empty answer says so) and offers the claim clear only inside a run", async () => {
    const { CoordScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const output = "t-1  src/a.ts  claimed 12:01\nt-2  src/a.ts  claimed 12:09  OVERLAP";
    const r = recorder({ coord_status: () => ({ output }) });
    const slot = await mount(() => <CoordScreen rpc={r.rpc as never} runId="run_1" />);
    await waitFor(() => expect(slot.getByTestId("ck-coord").querySelector("pre")!.textContent).toBe(output));
    expect(r.of("coord_status")).toEqual([{ runId: "run_1" }]);
    expect(slot.getByText(t("ckCoordClear"))).toBeTruthy();
    cleanup();
    const none = recorder({});
    const bare = await mount(() => <CoordScreen rpc={none.rpc as never} runId={null} />);
    await waitFor(() => expect(bare.getByTestId("ck-coord").querySelector("pre")!.textContent).toBe(t("ckEmpty")));
    expect(bare.queryByText(t("ckCoordClear"))).toBeNull();
    expect(none.calls).toEqual([]);
    observe("n864", { shown: output, noRunClear: bare.queryByText(t("ckCoordClear")) !== null, noRunReads: none.calls.length });
  });

  it("[sma:m_sw_ship] the ship screen offers the gate and the two publish workflows as their own buttons, off until a phase id is typed, each starting its own workflow for this project with that phase; the update buttons exist only when the project has a machine", async () => {
    const { ShipScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const r = recorder({ workflow_run: () => ({ started: true }) });
    const slot = await mount(() => <ShipScreen rpc={r.rpc as never} projectId="p1" hostId={null} />);
    const labels = ["validate-phase", "pr-branch", "ship"];
    const buttons = labels.map((id) => button(slot, t("ckShipRun").replace("{w}", id)));
    const offBeforePhase = buttons.map((node) => node.disabled);
    expect(offBeforePhase).toEqual([true, true, true]);
    expect(slot.queryByText(t("ckUpdateCheck"))).toBeNull();
    fireEvent.change(slot.getByLabelText("phase_id"), { target: { value: "ph_7" } });
    for (const node of buttons) fireEvent.click(node);
    await waitFor(() => expect(r.of("workflow_run")).toEqual(labels.map((id) => ({ id, projectId: "p1", inputs: { phase_id: "ph_7" } }))));
    observe("n866", { started: (r.of("workflow_run") as Array<{ id: string }>).map((call) => call.id), phase: (r.of("workflow_run")[0] as { inputs: { phase_id: string } }).inputs.phase_id, offBeforePhase });
  });

  it("[sma:m_sw_backlog] the backlog board lists the four lanes the scanner returned with their counts, each work with its priority and estimate; «Issue» on a ready work sends that work and re-reads, nothing else is written; an empty board and a read error say so", async () => {
    const { BacklogBoardPanel } = await import("../../src/rooms/backlog/ui/backlog-board");
    const todo = (id: string, title: string, priority: string, estimate: number | null) => ({ id, title, priority, estimate });
    let board = { issuable: [todo("t-01", "Fix footer", "high", 3)], needsEstimate: [todo("t-03", "Add export", "normal", null)], decompose: [todo("t-02", "Rewrite billing", "low", 13)], blocked: [todo("t-04", "Ship docs", "normal", 2)] };
    const r = recorder({ backlog_board: () => board, backlog_issue: () => ({ ok: true }) });
    const via = Object.fromEntries(["backlog_board", "backlog_issue"].map((name) => [name, (params: never) => r.rpc.call(name, params)]));
    const slot = await mount(() => <BacklogBoardPanel projectId="p1" />, via as Table);
    await slot.findByTestId("backlog-lane-issuable");
    const lanes = Array.from(slot.getByTestId("backlog-board").querySelectorAll("[data-testid^=backlog-lane-]")).map((lane) => text(lane.firstElementChild));
    expect(lanes).toEqual([`${t("backlogIssuable")} (1)`, `${t("backlogEstimate")} (1)`, `${t("backlogDecompose")} (1)`, `${t("backlogBlocked")} (1)`]);
    expect(text(slot.getByTestId("backlog-issuable-t-01"))).toContain("Fix footer");
    expect(text(slot.getByTestId("backlog-issuable-t-01"))).toContain("high · 3");
    expect(text(slot.getByTestId("backlog-needsEstimate-t-03"))).toContain("normal");
    board = { ...board, issuable: [] };
    fireEvent.click(slot.getByTestId("backlog-issue-t-01"));
    await waitFor(() => expect(r.of("backlog_issue")).toEqual([{ projectId: "p1", todoId: "t-01" }]));
    await waitFor(() => expect(slot.queryByTestId("backlog-issue-t-01")).toBeNull());
    expect(r.calls.map(([name]) => name)).toEqual(["backlog_board", "backlog_issue", "backlog_board"]);
    cleanup();
    const empty = await mount(() => <BacklogBoardPanel projectId="p1" />, { backlog_board: () => ({ issuable: [], needsEstimate: [], decompose: [], blocked: [], error: "no todos folder" }) });
    await waitFor(() => expect(text(empty.getByTestId("backlog-board"))).toContain("no todos folder"));
    observe("n863", { lanes, issued: r.of("backlog_issue"), calls: r.calls.map(([name]) => name) });
  });
});

// ---- the live row ----
describe("region 9 · the live stream row", () => {
  it("[sma:m_sw_event_row] one work is one row in words — phase, stage, model and minutes while it is at work (only the phase once it is done), the task id short, a blocked one with the reason", async () => {
    await loadPluginApp(() => import("../../app"));
    const { ThreadLive } = await import("../../src/rooms/runs/ui");
    const live = (taskId: string, column: string, phase: string, extra: Record<string, unknown> = {}) => ({ key: `task:run:${taskId}`, runId: "run", taskId, title: `Task ${taskId}`, column, phase, stage: null, model: null, since: null, threadId: null, updatedAt: 1, detail: null, ...extra });
    const items = [live("w1", "running", "writing", { stage: "writer-agent", model: "composer-2.5", since: Date.now() - 12 * 60_000 }), live("d1", "done", "accepted", { stage: "writer-agent", model: "composer-2.5", since: Date.now() - 60_000 }), live("b1", "blocked", "blocked", { detail: "the check failed on src/a.ts" })];
    const view = renderSlot({ component: () => <ThreadLive threadId="thr_pm" locale="en" /> }, {}, { context: { projectId: null, threadId: null }, rpc: { thread_live: () => ({ role: "pm", pmThreadId: "thr_pm", items, strips: {} }), work_graph_task: () => ({ cells: [], stages: [] }) } as never });
    await view.findByTestId("thread-live");
    const row = (id: string) => view.getByTestId(`live-task-task:run:${id}`);
    const line = (id: string) => text(row(id).querySelector("span.truncate"));
    expect(line("w1")).toBe("writing · Writer · composer-2.5 · 12 min");
    expect(line("d1")).toBe("done");
    expect(line("b1")).toBe("blocked");
    expect(text(row("b1"))).toContain("the check failed on src/a.ts");
    expect(text(row("w1"))).toContain("Task w1");
    observe("n867", { running: line("w1"), done: line("d1"), blocked: text(row("b1")).includes("the check failed on src/a.ts") });
  });
});

// ---- the phone frame ----
async function board(narrow: boolean) {
  const media = controllableMedia((query) => narrow && query.includes("max-width: 639px"));
  window.matchMedia = media.stub;
  await loadPluginApp(() => import("../../app"));
  const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui");
  const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
  const task = (taskId: string, column: string) => ({ kind: "task", key: `task:run:${taskId}`, runId: "run", taskId, title: `Title ${taskId}`, techTitle: null, taskKind: "feature", area: null, objective: null,
    projectId: "proj_a", pmThreadId: null, pmThreadTitle: null, column, state: "running", phase: "writing", stage: null, model: null, since: null, waitingFor: [], detail: null, attemptNo: 1, threadId: null, attemptId: `a-${taskId}`, updatedAt: 1_791_800_000_000, held: false, gates: null, wave: null });
  const slot = renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} serviceProjectIds={[]} locale="en" AcceptanceCard={AcceptanceCard} /> }, {}, { context: { projectId: null, threadId: null }, rpc: { task_board: () => ({ items: [task("w1", "running"), task("q1", "queued")] }) } as never });
  return { slot, media };
}

describe("region 9 · the phone frame", () => {
  it("[sma:m_wnr_tasks] on a phone the works are one narrow column that opens as the list, not fixed columns; on a wide window the same works stand in their columns", async () => {
    const narrow = await board(true);
    await waitFor(() => expect(narrow.slot.container.textContent).toContain("Title w1"));
    const narrowHasColumns = narrow.slot.queryByTestId("board-columns") !== null;
    expect(narrowHasColumns).toBe(false);
    const narrowListSelected = narrow.slot.getByTestId("board-view-list").getAttribute("aria-selected") === "true";
    expect(narrowListSelected).toBe(true);
    cleanup();
    const wide = await board(false);
    const columns = await wide.slot.findByTestId("board-columns");
    expect(columns.getAttribute("data-narrow")).toBeNull();
    expect(text(wide.slot.getByTestId("board-col-running"))).toContain("Title w1");
    expect(text(wide.slot.getByTestId("board-col-queued"))).toContain("Title q1");
    observe("n871", { narrowList: narrowListSelected, narrowColumns: narrowHasColumns, wideColumns: columns.getAttribute("data-narrow") === null, wideRunning: text(wide.slot.getByTestId("board-col-running")).includes("Title w1") });
  });

  it("[sma:m_wnr_card] an open task survives a frame switch: opened on the wide board it stays open when the window turns narrow, and Back returns to the works in the narrow layout", async () => {
    const { slot, media } = await board(false);
    fireEvent.click(await slot.findByTestId("board-card-task:run:w1"));
    const openedWide = (await slot.findByTestId("board-back")) !== null;
    act(() => media.flip((query) => query.includes("max-width: 639px")));
    await waitFor(() => expect(slot.getByTestId("board-back")).toBeTruthy());
    const afterSwitch = slot.queryByTestId("board-back") !== null;
    expect(slot.queryByTestId("board-columns")).toBeNull();
    fireEvent.click(slot.getByTestId("board-back"));
    const columns = await slot.findByTestId("board-columns");
    expect(columns.getAttribute("data-narrow")).toBe("true");
    cleanup();
    // The other way: opened on a phone, the card is there.
    const phone = await board(true);
    fireEvent.click(await phone.slot.findByText("Title w1"));
    await waitFor(() => expect(phone.slot.getByTestId("board-back")).toBeTruthy());
    observe("n872", { openedWide, afterSwitch, backLayoutNarrow: columns.getAttribute("data-narrow") === "true", openedOnPhone: phone.slot.queryByTestId("board-back") !== null });
  });

  const rail = (extra: Record<string, unknown> = {}) => {
    const chosen: string[] = []; const scopes: string[] = []; const sections: string[] = [];
    const projects = [{ id: "p_a", name: "Alpha" }, { id: "p_b", name: "Beta" }];
    const page = { compactChrome: true, activeScope: "projects", setActiveScope: (scope: string) => scopes.push(scope), projectListError: null, projectsLoaded: true, projects, projectGroups: { main: projects, service: [{ id: "p_sb", name: "LP sandbox" }] },
      projectId: "p_b", selectedSectionId: null, setSelectedSectionId: (id: string) => sections.push(id), sections: [], flatSections: [{ id: "s1", name: "Web", depth: 0 }, { id: "s2", name: "Api", depth: 1 }], mobileNavValue: "project:p_b",
      chooseProject: (id: string) => chosen.push(id), hiddenProjects: new Set<string>(), showProject: () => undefined, ...extra };
    return { page, chosen, scopes, sections };
  };

  it("[sma:m_wnr_shell] the narrow frame is another frame: with a compact chrome the wide rail is hidden and the one-select menu stands in its place; with a wide chrome the rail is shown", async () => {
    const { ScopeRail } = await import("../../src/rooms/pages/project-nav");
    const narrow = rail();
    const a = await mount(() => <ScopeRail page={narrow.page as never} />);
    const hiddenNarrow = a.getByTestId("scope-rail").className.split(" ").includes("hidden");
    expect(hiddenNarrow).toBe(true);
    cleanup();
    const wide = rail({ compactChrome: false });
    const b = await mount(() => <ScopeRail page={wide.page as never} />);
    const wideHidden = b.getByTestId("scope-rail").className.split(" ").includes("hidden");
    expect(wideHidden).toBe(false);
    expect(b.getByTestId("scope-rail").className).toContain("w-[14.5rem]");
    observe("n869", { compactRailHidden: hiddenNarrow, wideRailHidden: wideHidden });
  });

  it("[sma:m_wnr_menu] the narrow menu is one select that names where the person is — a project by its name, a system page by its title, a section by its own name", async () => {
    const { MobileScopeSelect } = await import("../../src/rooms/pages/project-nav");
    const shown = async (value: string, extra: Record<string, unknown> = {}) => {
      const view = await mount(() => <MobileScopeSelect page={rail({ mobileNavValue: value, ...extra }).page as never} />);
      const label = text(view.getByTestId("scope-nav-mobile"));
      cleanup();
      return label;
    };
    const labels = { project: await shown("project:p_b"), page: await shown("tasks"), section: await shown("section:s2", {}), service: await shown("project:p_sb") };
    expect(labels).toEqual({ project: "Beta", page: t("navTasks"), section: "Api", service: "LP sandbox" });
    observe("n870", labels);
  });
});

// ---- the window itself ----
async function cockpit(rpc: Table, subPath: string) {
  const app = await loadPluginApp(() => import("../../app"));
  const panel = app.navPanels.find((row: { id: string }) => row.id === "lane-pilot-cockpit")!;
  const calls: Array<[string, unknown]> = [];
  const table: Table = { list_projects: () => ({ projects: [{ id: "proj_a", name: "Alpha" }, { id: "proj_b", name: "Beta" }] }), get_screen: () => ({ hostId: "h1", runs: [] }), first_run_get: () => ({ needed: false }),
    owner_waiting: () => ({ items: [] }), world_version: () => ({ version: "1" }), phase_list: () => [], cockpit_seen: () => ({}), ...rpc };
  const wrapped = Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, (params: never) => { calls.push([name, params]); return handler(params); }]));
  const slot = renderSlot({ component: () => <panel.component subPath={subPath} /> } as never, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
  return { slot, calls };
}
const shownScreens = (slot: ReturnType<typeof renderSlot>) => ["ck-first-run", "ck-home", "ck-money", "ck-first-run-banner"].filter((id) => slot.queryByTestId(id) !== null);
const interview = (needed: boolean) => () => ({ needed, steps: [{ id: "goal", question: "What is it for?" }, { id: "writer", question: "Which writer?" }, { id: "quality", question: "How strict?" }, { id: "words", question: "Your words?" }], draft: { answers: {}, done: null } });

describe("region 9 · the window", () => {
  it("[sma:m_ws_app] the window root opens the screen its path names, and a project never set up gets the first-run interview in front of an empty path — once, never over a real path", async () => {
    const fresh = await cockpit({ first_run_get: interview(true) }, "");
    await fresh.slot.findByTestId("ck-first-run");
    expect(fresh.slot.queryByTestId("ck-home")).toBeNull();
    const freshShown = shownScreens(fresh.slot);
    cleanup();
    const real = await cockpit({ first_run_get: interview(true), money_status: () => MONEY, cockpit_windows: () => WINDOWS, cockpit_accounts: () => [] }, "money");
    await real.slot.findByTestId("ck-money");
    await real.slot.findByTestId("ck-first-run-banner");
    expect(real.slot.queryByTestId("ck-first-run")).toBeNull();
    const realShown = shownScreens(real.slot);
    cleanup();
    const done = await cockpit({ first_run_get: interview(false) }, "");
    await done.slot.findByTestId("ck-home");
    expect(done.slot.queryByTestId("ck-first-run")).toBeNull();
    expect(done.slot.queryByTestId("ck-first-run-banner")).toBeNull();
    const doneShown = shownScreens(done.slot);
    observe("n874", { emptyPathNeedsSetup: freshShown, realPathKept: realShown, setUpProject: doneShown });
  });

  it("[sma:m_wnr_wide_only] a screen that needs a wide window says so on a narrow one and says nothing on a wide one or on a screen that fits a phone", async () => {
    const media = controllableMedia(() => false);
    window.matchMedia = media.stub;
    const narrow = await cockpit({ coord_status: () => ({ output: "" }) }, "coord");
    await narrow.slot.findByTestId("ck-coord");
    const coordNarrow = text(narrow.slot.getByTestId("ck-wide-only"));
    expect(coordNarrow).toBe(t("ckWideOnly"));
    act(() => media.flip(() => true));
    await waitFor(() => expect(narrow.slot.queryByTestId("ck-wide-only")).toBeNull());
    const coordWideShown = narrow.slot.queryByTestId("ck-wide-only") !== null;
    cleanup();
    media.flip(() => false);
    const fits = await cockpit({}, "phases");
    await fits.slot.findByTestId("ck-phases");
    expect(fits.slot.queryByTestId("ck-wide-only")).toBeNull();
    observe("n873", { coordNarrow, coordWideShown, phasesNarrowShown: fits.slot.queryByTestId("ck-wide-only") !== null });
  });

  it("[sma:m_ws_signed_out] when the owner door is on and this browser holds no owner pass the window says it is signed out and that only the entry link brings the pass back; with the pass, or with the door off, it says nothing", async () => {
    const answer = (body: unknown) => vi.fn(async () => ({ ok: true, json: async () => body }));
    const seen = async (body: unknown) => {
      const fetcher = answer(body);
      vi.stubGlobal("fetch", fetcher);
      const view = await cockpit({}, "phases");
      await view.slot.findByTestId("ck-phases");
      await waitFor(() => expect(fetcher).toHaveBeenCalled());
      await act(async () => { await Promise.resolve(); });
      const message = view.slot.queryByTestId("ck-signed-out");
      const out = { shown: message ? text(message) : null, url: (fetcher.mock.calls[0] as unknown[])[0] };
      cleanup();
      return out;
    };
    const signedOut = await seen({ enforced: true, owner: false });
    expect(signedOut).toEqual({ shown: t("ckSignedOut"), url: "/api/v1/vk/owner/status" });
    const withPass = (await seen({ enforced: true, owner: true })).shown;
    const doorOff = (await seen({ enforced: false, owner: false })).shown;
    expect(withPass).toBeNull();
    expect(doorOff).toBeNull();
    observe("n877", { signedOut: signedOut.shown, withPass, doorOff });
  });

  it("[sma:m_ws_selected_project] a project chosen in an earlier visit is the one the window opens on, and the screen read for it is that project's; a refused choice keeps the stored one", async () => {
    localStorage.setItem("lane-pilot:cockpit:project", "proj_b");
    const view = await cockpit({}, "phases");
    await view.slot.findByTestId("ck-phases");
    await waitFor(() => expect((view.slot.getByTestId("ck-project") as HTMLSelectElement).value).toBe("proj_b"));
    expect(view.calls.filter(([name]) => name === "get_screen").map(([, params]) => params)[0]).toEqual({ projectId: "proj_b", runsLimit: 5 });
    expect(localStorage.getItem("lane-pilot:cockpit:project")).toBe("proj_b");
    observe("n881", { opensOn: (view.slot.getByTestId("ck-project") as HTMLSelectElement).value, firstRead: view.calls.find(([name]) => name === "get_screen")![1] });
  });
});

// ---- waiting ----
describe("region 9 · waiting", () => {
  it("[sma:m_ws_waiting] before the answer the screen shows the waiting line, and from the second second it says itself how long it has taken; when the data arrives both go", async () => {
    vi.useFakeTimers();
    const { Loaded } = await import("../../src/rooms/cockpit/ui/kit");
    const state = { data: null as string | null, error: null, loading: true };
    const view = render(createElement(Loaded as never, { state, children: (data: string) => createElement("p", { "data-testid": "got" }, data) } as never));
    const waiting = () => view.queryByTestId("ck-waiting-elapsed")?.textContent ?? null;
    const atStart = waiting();
    expect(view.getByTestId("ck-waiting").textContent).toContain(t("ckLoading"));
    act(() => { vi.advanceTimersByTime(1000); });
    const atOne = waiting();
    expect(atOne).toBeNull();
    act(() => { vi.advanceTimersByTime(1000); });
    const atTwo = waiting();
    expect(atTwo).toBe("Waiting for an answer for 2 s");
    act(() => { vi.advanceTimersByTime(3000); });
    expect(waiting()).toBe("Waiting for an answer for 5 s");
    const at5 = waiting();
    view.rerender(createElement(Loaded as never, { state: { data: "the answer", error: null, loading: false }, children: (data: string) => createElement("p", { "data-testid": "got" }, data) } as never));
    expect(view.queryByTestId("ck-waiting")).toBeNull();
    expect(view.getByTestId("got").textContent).toBe("the answer");
    observe("n878", { atStart, atOneSecond: atOne, atTwoSeconds: atTwo, atFive: at5, gone: view.queryByTestId("ck-waiting") === null });
  });

  it("[sma:m_ws_magic_rings] the wait draws its animated ring inside the waiting line, and only while it waits", async () => {
    const { Loaded } = await import("../../src/rooms/cockpit/ui/kit");
    const view = render(createElement(Loaded as never, { state: { data: null, error: null, loading: true }, children: () => null } as never));
    const ring = view.getByTestId("ck-waiting").querySelector("span.animate-spin");
    expect(ring).not.toBeNull();
    expect(ring!.className).toContain("rounded-full");
    const ringWhileWaiting = ring !== null;
    view.rerender(createElement(Loaded as never, { state: { data: "x", error: null, loading: false }, children: () => createElement("i") } as never));
    expect(view.container.querySelector(".animate-spin")).toBeNull();
    observe("n879", { ringWhileWaiting, ringAfter: view.container.querySelector(".animate-spin") !== null });
  });
});

// ---- the live channel ----
describe("region 9 · the live channel", () => {
  it("[sma:m_ws_hints] the window listens on one channel per project: a signal of a kind it asked for calls back with that signal, another kind or a broken payload does not, a drop and reconnect asks for one reread, and the poll is slow while live and fast while not", async () => {
    const { useLpRealtime } = await import("../../src/rooms/ui-shell/ui/use-lp-realtime");
    const heard: unknown[] = [];
    let interval = 0;
    const Probe = () => { interval = useLpRealtime("p1", ["rules", "helpers"], (signal) => heard.push(signal)); return null; };
    await loadPluginApp(() => import("../../app"));
    const slot = renderSlot({ component: Probe }, {}, { context: { projectId: null, threadId: null }, rpc: {} as never });
    const liveInterval = interval;
    expect(interval).toBe(30_000);
    await slot.emitRealtime("lp:p1", { kind: "rules" });
    await slot.emitRealtime("lp:p1", { kind: "council" });
    await slot.emitRealtime("lp:p1", { kind: "nonsense" });
    await slot.emitRealtime("lp:p1", "junk");
    await slot.emitRealtime("lp:other", { kind: "helpers" });
    await slot.emitRealtime("lp:p1", { kind: "helpers", threadId: "thr_1" });
    expect(heard).toEqual([{ kind: "rules" }, { kind: "helpers", threadId: "thr_1" }]);
    await slot.setRealtimeConnectionState("reconnecting");
    const offlineInterval = interval;
    expect(interval).toBe(4_000);
    await slot.setRealtimeConnectionState("connected");
    expect(heard).toEqual([{ kind: "rules" }, { kind: "helpers", threadId: "thr_1" }, null]);
    expect(interval).toBe(30_000);
    observe("n876", { heard, liveInterval, offlineInterval });
  });
});
