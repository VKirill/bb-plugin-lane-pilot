/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { cockpitRpc } from "../../src/rooms/cockpit/server";
import { boardWindows } from "../../src/rooms/usage/server/provider-usage";
import { Loaded } from "../../src/rooms/cockpit/ui/kit";
import { MoneyScreen, TodayScreen } from "../../src/rooms/cockpit/ui/screens-day";
import { useProjectChoice } from "../../src/rooms/cockpit/ui/cockpit-page";
import { searchCockpit, startScreen } from "../../src/rooms/cockpit/ui/registry";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";

const open = (hostCall?: (request: { method: string }) => unknown) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", ...(hostCall ? { hostCall: async (_h: string, r: { method: string }) => hostCall(r) } : {}) } as never);
  return { bb, harness, db: openDatabase(bb) };
};
const rpcOf = (db: never, bb: never, services: Record<string, unknown> = {}) =>
  cockpitRpc({ db, bb, log: () => undefined } as never, { front: { actions: async () => [], peers: async () => [] }, ...services } as never) as Record<string, (input: never) => Promise<unknown>>;
const contract = (extra: Record<string, unknown> = {}) => ({
  schema_version: 2, display_title: "Task T", kind: "feature", title: "T", risk: "medium", lane: "writer", project_cwd: "/ws",
  read_first: [], interfaces: [], invariants: [], expected_outputs: ["a/out.ts"], owns_paths: ["a/**"], never_touch: [],
  depends_on: [], objective: "Make T", acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: "/ws" }], ...extra,
});

afterEach(() => { cleanup(); document.body.innerHTML = ""; vi.useRealTimers(); setLocaleOverride(null); });

describe("window parity d6", () => {
  it("[sma:sc_clarify] cockpit_task returns the promise, files, out-of-scope and the blockers of a stored contract", async () => {
    const { bb, db, harness } = open();
    createRun(db, "run1", "p1");
    createTask(db, { id: "dep", runId: "run1", kind: "bb", contract: contract() });
    createAttempt(db, { id: "a_dep", runId: "run1", taskId: "dep" });
    transitionAttempt(db, "a_dep", "spawn_requested");
    transitionAttempt(db, "a_dep", "spawn_rejected", { reason: "no provider" });
    transitionAttempt(db, "a_dep", "blocked", { reason: "no provider" });
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: contract({ promise: { given: "a project", when: "the owner asks", then: "it answers" }, out_of_scope: ["no docs"], depends_on: ["dep"] }) });
    const view = await rpcOf(db as never, bb as never).cockpit_task({ runId: "run1", taskId: "t1" } as never) as Record<string, unknown>;
    expect(view.promise).toEqual({ given: "a project", when: "the owner asks", then: "it answers" });
    expect(view.ownsPaths).toEqual(["a/**"]);
    expect(view.expectedOutputs).toEqual(["a/out.ts"]);
    expect(view.outOfScope).toEqual(["no docs"]);
    expect(view.blockers).toEqual([{ taskId: "dep", state: "blocked", reason: "no provider" }]);
    await harness.lifecycle.dispose();
  });

  it("[sma:sc_design] after cockpit_task_drawing_ok the drawing is ok with stale false; after its content changes it is stale with the ok's date", async () => {
    const { bb, db, harness } = open();
    createRun(db, "run1", "p1");
    setRunThread(db, "run1", "thr_pm");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: contract({ drawing: ["docs/d.md"] }) });
    let sha = "sha-1";
    const read = async () => ({ sha256: sha });
    const rpc = rpcOf(db as never, bb as never, { readWriterWorkspaceFile: read });
    await rpc.cockpit_task_drawing_ok!({ runId: "run1", taskId: "t1" } as never);
    const first = await rpc.cockpit_task!({ runId: "run1", taskId: "t1" } as never) as { drawing: Array<{ path: string; sha256: string }>; drawingOk: { at: number; stale: boolean } };
    expect(first.drawing).toEqual([{ path: "docs/d.md", sha256: "sha-1" }]);
    expect(first.drawingOk.stale).toBe(false);
    sha = "sha-2";
    const second = await rpc.cockpit_task!({ runId: "run1", taskId: "t1" } as never) as { drawingOk: { at: number; stale: boolean } };
    expect(second.drawingOk.stale).toBe(true);
    expect(second.drawingOk.at).toBe(first.drawingOk.at);
    await harness.lifecycle.dispose();
  });

  it("[sma:m_ws_contract_summary] cockpit_task_correct sends the run's PM one message naming the task and the text, and refuses a task of another run", async () => {
    const { bb, db, harness } = open();
    createRun(db, "run1", "p1");
    createRun(db, "run2", "p1");
    setRunThread(db, "run1", "thr_pm");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: contract() });
    const sent: string[] = [];
    harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
    const rpc = rpcOf(db as never, bb as never);
    await rpc.cockpit_task_correct!({ runId: "run1", taskId: "t1", text: "promise two screens" } as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("t1");
    expect(sent[0]).toContain("promise two screens");
    expect(sent[0]).toContain("lane_pilot_update_task");
    await expect(rpc.cockpit_task_correct!({ runId: "run2", taskId: "t1", text: "not yours" } as never)).rejects.toThrow("not a task of run run2");
    expect(sent).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("[sma:m_rd_accounts] cockpit_accounts answers one entry per online machine with its live windows, and windows null with a reason for one BB has no usage figure for; no machine file is read", async () => {
    const { bb, db, harness } = open();
    const hostCalls: string[] = [];
    bb.hosts.experimental_client = (() => ({ call: async (method: string) => { hostCalls.push(method); throw new Error("no host call expected"); } })) as never;
    const providerUsage = { windows: async ({ providerId, hostId }: { providerId: string; hostId: string }) => providerId === "claude-code" && hostId === "h1"
      ? { at: "2026-11-11T00:00:00.000Z", windows: { five_hour: { utilization: 40, resetsAt: null }, seven_day: { utilization: 12, resetsAt: null } } }
      : { at: null, windows: {} } };
    const peers = async () => [
      { hostId: "h1", name: "Big", online: true, at: 1, lastOnlineAt: 1, line: "Big" },
      { hostId: "h2", name: "Mini", online: true, at: 1, lastOnlineAt: 1, line: "Mini" },
      { hostId: "h3", name: "Off", online: false, at: 1, lastOnlineAt: 1, line: "Off" },
    ];
    const rpc = rpcOf(db as never, bb as never, { front: { actions: async () => [], peers }, providerUsage });
    const rows = await rpc.cockpit_accounts({} as never) as Array<{ hostId: string; name: string | null; windows: unknown; reason: string | null }>;
    expect(rows.map((row) => row.hostId)).toEqual(["h1", "h2"]);
    expect(rows[0]).toMatchObject({ name: "Big", windows: { five_hour: { utilization: 40 } }, reason: null });
    expect(rows[1]!.windows).toBeNull();
    expect(rows[1]!.reason).toBeTruthy();
    // The bars of the Money screen read the same live figure; with no usage source at all they are empty, never an old number.
    expect(await rpc.cockpit_windows({ hostId: "h1" } as never)).toMatchObject({ hostId: "h1", at: "2026-11-11T00:00:00.000Z", windows: { seven_day: { utilization: 12 } } });
    expect(await rpcOf(db as never, bb as never, { front: { actions: async () => [], peers } }).cockpit_windows({ hostId: "h1" } as never)).toEqual({ hostId: "h1", at: null, windows: {} });
    expect(hostCalls).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("[sma:m_wn_two] boardWindows names BB's live windows five_hour, seven_day and seven_day_<family>, takes the machine's own resource before a shared one, and says at:null while nothing was read", () => {
    const ok = (windows: Array<Record<string, unknown>>) => ({ usage: { status: "ok" as const, windows } }) as never;
    const own = { resource: { id: "a", providerId: "claude-code", scope: { kind: "host" as const, hostId: "h1" } }, measurement: ok([
      { kind: "five-hour", label: "5h", usedPercent: 41, resetsAt: "2026-11-11T05:00:00Z", model: null },
      { kind: "weekly", label: "7d", usedPercent: 12, resetsAt: null, model: null },
      { kind: "weekly", label: "7d Opus", usedPercent: 77, resetsAt: null, model: "Opus" },
    ]) };
    const shared = { resource: { id: "b", providerId: "claude-code", scope: { kind: "shared" as const } }, measurement: ok([{ kind: "five-hour", label: "5h", usedPercent: 99, resetsAt: null, model: null }]) };
    const other = { resource: { id: "c", providerId: "codex", scope: { kind: "shared" as const } }, measurement: ok([{ kind: "weekly", label: "7d", usedPercent: 5, resetsAt: null, model: null }]) };
    const now = Date.parse("2026-11-11T00:00:00Z");
    expect(boardWindows([own, shared, other], { providerId: "claude-code", hostId: "h1", now })).toEqual({ at: "2026-11-11T00:00:00.000Z", windows: {
      five_hour: { utilization: 41, resetsAt: "2026-11-11T05:00:00Z" }, seven_day: { utilization: 12, resetsAt: null }, seven_day_opus: { utilization: 77, resetsAt: null } } });
    // Another machine has no resource of its own: the shared one answers.
    expect(boardWindows([own, shared, other], { providerId: "claude-code", hostId: "h2", now }).windows).toEqual({ five_hour: { utilization: 99, resetsAt: null } });
    // An unread or signed-out source is «nothing known».
    expect(boardWindows([{ resource: own.resource, measurement: null }, { resource: shared.resource, measurement: { usage: { status: "unauthenticated" } } as never }], { providerId: "claude-code", hostId: "h1", now })).toEqual({ at: null, windows: {} });
  });

  it("[sma:m_sw_terminal_window] the money screen's account list names each line «Ваш терминал» with its percents, and SystemScreen keeps only the how-to footnote", async () => {
    setLocaleOverride("ru");
    const rpc = { call: async (name: string) => name === "money_status" ? { monthUsd: 0, cap: null, left: null }
      : name === "cockpit_windows" ? { at: null, windows: {} }
      : [{ hostId: "h1", name: "Big", at: "now", windows: { five_hour: { utilization: 40 }, seven_day: { utilization: 12 } }, reason: null }] };
    const view = render(createElement(MoneyScreen, { rpc: rpc as never, hostId: "h1" }));
    await waitFor(() => expect(view.container.textContent).toContain("Ваш терминал на машине Big: 5 часов 40%, 7 дней 12%"));
    view.unmount();
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const ops = readFileSync(join(import.meta.dirname, "../../src/rooms/cockpit/ui/screens-ops.tsx"), "utf8");
    expect(ops.match(/ckTerminal/g)).toHaveLength(1);
  });

  it("[sma:m_sw_feedback] cockpit_fault returns a prepared issue with title, body, the Lane Pilot version and the platform, stores it, and sends nothing", async () => {
    const { bb, db, harness } = open();
    const { HARNESS_VERSION } = await import("../../src/rooms/storage");
    const answer = await rpcOf(db as never, bb as never).cockpit_fault({ screen: "money", text: "the cap did not save" } as never) as { title: string; body: string };
    expect(answer.title).toContain("money");
    expect(answer.body).toContain("the cap did not save");
    expect(answer.body).toContain(HARNESS_VERSION);
    expect(answer.body).toContain(process.platform);
    const stored = (await bb.storage.kv.get("lp.cockpit.faults")) as Array<{ screen: string; text: string }>;
    expect(stored.at(-1)).toMatchObject({ screen: "money", text: "the cap did not save" });
    await harness.lifecycle.dispose();
  });

  it("[sma:m_sw_drafts_step] cockpit_forge_enable sends the PM a message naming lint, request and confirm for the role, refuses a bad name, throws without a PM chat", async () => {
    const { bb, db, harness } = open();
    createRun(db, "run1", "p1");
    setRunThread(db, "run1", "thr_pm");
    const sent: string[] = [];
    harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
    const rpc = rpcOf(db as never, bb as never);
    await rpc.cockpit_forge_enable!({ projectId: "p1", kind: "role", name: "my-helper" } as never);
    expect(sent).toHaveLength(1);
    for (const word of ["lint", "request", "confirm", "my-helper"]) expect(sent[0]).toContain(word);
    await expect(rpc.cockpit_forge_enable!({ projectId: "p1", kind: "role", name: "Bad_Name" } as never)).rejects.toThrow("kebab-case");
    const { bb: bb2, db: db2, harness: h2 } = open();
    createRun(db2, "run9", "p9");
    await expect(rpcOf(db2 as never, bb2 as never).cockpit_forge_enable!({ projectId: "p9", kind: "role", name: "my-helper" } as never)).rejects.toThrow("no Lane Pilot PM chat");
    await harness.lifecycle.dispose();
    await h2.lifecycle.dispose();
  });

  it("[sma:m_ws_selected_project] a failed get_screen leaves the stored project and the select unchanged; a good read stores the new id", async () => {
    localStorage.setItem("lane-pilot:cockpit:project", "p_old");
    const calls: string[] = [];
    const rpc = { call: async (name: string, input: { projectId: string }) => { calls.push(input.projectId); if (input.projectId === "p_bad") throw new Error("gone"); return { hostId: null, runs: [] }; } };
    let probe: { projectId: string; choose: (id: string) => Promise<unknown>; error: string | null } | null = null;
    const Probe = () => { probe = useProjectChoice(rpc as never); return null; };
    const view = render(createElement(Probe));
    await waitFor(() => expect(probe?.projectId).toBe("p_old"));
    await probe!.choose("p_bad").catch(() => undefined);
    await waitFor(() => expect(probe?.error).toBeTruthy());
    expect(probe!.projectId).toBe("p_old");
    expect(localStorage.getItem("lane-pilot:cockpit:project")).toBe("p_old");
    await probe!.choose("p_new");
    await waitFor(() => expect(probe?.projectId).toBe("p_new"));
    expect(calls).toEqual(["p_bad", "p_new"]);
    view.unmount();
  });

  it("[sma:m_ws_waiting] with no data Loaded shows only the spinner at 1 s and «already N s» at 3 s; the line goes when data arrives", async () => {
    setLocaleOverride("ru");
    vi.useFakeTimers();
    const waiting = { data: null, error: null, loading: true };
    const view = render(createElement(Loaded as never, { state: waiting, children: (data: unknown) => String(data) }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(view.container.querySelector("[data-testid=ck-waiting]")).toBeTruthy();
    expect(view.container.textContent).not.toContain("Ждём ответа уже");
    act(() => { vi.advanceTimersByTime(2000); });
    expect(view.container.textContent).toContain("Ждём ответа уже 3 с");
    view.rerender(createElement(Loaded as never, { state: { data: "here", error: null, loading: false }, children: (data: unknown) => String(data) }));
    expect(view.container.textContent).toBe("here");
    view.unmount();
  });

  it("[sma:m_sw_first_run] startScreen(\"\", {needed}) is firstrun or home; a real path is never overridden", () => {
    expect(startScreen("", { needed: true })).toBe("firstrun");
    expect(startScreen("", { needed: false })).toBe("home");
    expect(startScreen("phases", { needed: true })).toBe("phases");
  });

  it("[sma:m_ws_palette] searchCockpit finds screens by title words and phases by title; an empty query lists all screens", () => {
    setLocaleOverride("ru");
    const hits = searchCockpit("деньги");
    expect(hits[0]).toMatchObject({ kind: "screen", id: "money" });
    const withPhases = searchCockpit("фаза 3", { phases: [{ id: "ph1", title: "фаза 3: окно" }] });
    expect(withPhases[0]).toMatchObject({ kind: "phase", id: "ph1" });
    expect(searchCockpit("")).toHaveLength(14);
    expect(searchCockpit("")[0]!.kind).toBe("screen");
  });

  it("[sma:m_sw_done_unfold] pressing an accepted row loads its acceptance card; an unopened row calls nothing", async () => {
    const calls: string[] = [];
    const rpc = { call: async (name: string) => { calls.push(name); return name === "task_acceptance_card"
      ? { contract: { objective: "make the cap", acceptance: ["cap holds"] }, planFact: { items: [{ item: 1, acceptance: "cap holds", verdict: "proven", why: "tested" }] } }
      : { kpi: { accepted: 1, blocked: 0, running: 0, tokens: 0, actions: 0 }, feed: [{ at: Date.now(), kind: "task_accepted", text: "t1", runId: "run1", taskId: "t1", title: "Task T" }] }; } };
    const view = render(createElement(TodayScreen, { rpc: rpc as never, projectId: "p1" }));
    await waitFor(() => expect(view.container.textContent).toContain("Task T"));
    expect(calls).not.toContain("task_acceptance_card");
    fireEvent.click(view.container.querySelector("button[aria-expanded]")!);
    await waitFor(() => expect(view.container.textContent).toContain("make the cap"));
    expect(view.container.textContent).toContain("cap holds");
    expect(calls).toContain("task_acceptance_card");
    view.unmount();
  });

  it("[sma:sc_live_stream] TodayScreen re-reads cockpit_today after 8 s and shows the row the second answer added; a hidden page does not call", async () => {
    const feeds = [
      { kpi: { accepted: 0, blocked: 0, running: 0, tokens: 0, actions: 0 }, feed: [] },
      { kpi: { accepted: 1, blocked: 0, running: 0, tokens: 0, actions: 0 }, feed: [{ at: Date.now(), kind: "task_accepted", text: "t1", runId: "r", taskId: "t1", title: "New work" }] },
    ];
    let reads = 0;
    const rpc = { call: async () => feeds[Math.min(reads++, 1)] };
    vi.useFakeTimers();
    const view = render(createElement(TodayScreen, { rpc: rpc as never, projectId: "p1" }));
    await vi.waitFor(() => expect(reads).toBe(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    await vi.waitFor(() => expect(reads).toBe(2));
    await vi.waitFor(() => expect(view.container.textContent).toContain("New work"));
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(reads).toBe(2);
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    view.unmount();
  });
});
