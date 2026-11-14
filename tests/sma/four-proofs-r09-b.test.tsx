/** @vitest-environment jsdom */
// Region 9 · Person and window, batch b (n786 … n813), the screens: the cockpit's operations screens rendered for real in jsdom. Each test drives what the
// person types and presses and checks what the screen shows or which call it sends (the whole parameter list), not that a string exists in the source.
// The server halves of the same cards are in four-proofs-r09-b.test.ts.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); localStorage.clear(); vi.restoreAllMocks(); });

type Table = Record<string, (params: never) => unknown>;
/** The rpc handle the cockpit screens take as a prop: it records every call and answers from the table. */
function recorder(table: Table) {
  const calls: Array<[string, unknown]> = [];
  const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); const handler = table[name]; if (!handler) return Promise.resolve(undefined); try { return Promise.resolve(handler(params as never)); } catch (cause) { return Promise.reject(cause); } } };
  return { rpc: rpc as never, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}
async function mount(component: () => React.ReactElement) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: {} as never });
}
const button = (view: { getByText: (text: string, options: { selector: string }) => HTMLElement }, text: string) => view.getByText(text, { selector: "button" }) as HTMLButtonElement;
const type = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });

describe("region 9 · first run (the onboarding interview)", () => {
  const STEPS = [
    { id: "goal", question: "What is this project?" }, { id: "writer", question: "Which writer?" },
    { id: "quality", question: "How strict?" }, { id: "words", question: "Your word?" },
  ];
  /** A first-run table with a draft the answer call really changes, as the server's kv draft does. */
  function interview(answered: Record<string, string> = {}) {
    const state = { answers: { ...answered } as Record<string, string>, done: undefined as number | undefined };
    return { state, table: {
      first_run_get: () => ({ needed: !state.done, steps: STEPS, draft: { answers: { ...state.answers }, ...(state.done ? { done: state.done } : {}) } }),
      first_run_answer: ({ step, answer }: { step: string; answer: string }) => { state.answers[step] = answer; return {}; },
      first_run_finish: () => { state.done = 1; return { written: [], goal: true }; },
    } as Table };
  }

  it("[sma:d_onboarding] the first-run screen asks the first unanswered step as «n/4 · question» and lists the answered ones as «✓ step: answer» in the ready column; a finished project says it has its settings", async () => {
    const { FirstRunScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const { rpc, of } = recorder(interview({ goal: "a shop", writer: "codex / gpt-6-luna" }).table);
    const slot = await mount(() => <FirstRunScreen rpc={rpc} projectId="p1" />);
    await slot.findByTestId("ck-interview");
    expect(of("first_run_get")).toEqual([{ projectId: "p1" }]);
    expect(slot.getByTestId("ck-interview").textContent).toContain("3/4 · How strict?");
    expect(slot.getByTestId("ck-ready").textContent).toBe("Ready✓ goal: a shop✓ writer: codex / gpt-6-luna");
    cleanup();
    const done = interview({ goal: "a", writer: "b", quality: "full", words: "no" });
    done.state.done = 5;
    const finished = await mount(() => <FirstRunScreen rpc={recorder(done.table).rpc} projectId="p1" />);
    await waitFor(() => expect(finished.getByTestId("ck-first-run").textContent).toContain("This project has its settings already."));
    expect(finished.queryByTestId("ck-interview")).toBeNull();
  });

  it("[sma:d_onboarding_answer] «Send» on a step sends that step's id and the typed words (nothing while the box is empty), then the next step is asked and the answer shows in the ready column", async () => {
    const { FirstRunScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const { rpc, of } = recorder(interview().table);
    const slot = await mount(() => <FirstRunScreen rpc={rpc} projectId="p1" />);
    await slot.findByTestId("ck-interview");
    expect(button(slot, "Send").disabled).toBe(true);
    type(slot.getByLabelText("goal"), "a shop with a cart");
    fireEvent.click(button(slot, "Send"));
    await waitFor(() => expect(of("first_run_answer")).toEqual([{ projectId: "p1", step: "goal", answer: "a shop with a cart" }]));
    await waitFor(() => expect(slot.getByTestId("ck-interview").textContent).toContain("2/4 · Which writer?"));
    expect(slot.getByTestId("ck-ready").textContent).toContain("✓ goal: a shop with a cart");
    // The second answer goes under the second step's id, and the box was emptied for it.
    expect((slot.getByLabelText("writer") as HTMLTextAreaElement).value).toBe("");
    type(slot.getByLabelText("writer"), "codex / gpt-6-luna");
    fireEvent.click(button(slot, "Send"));
    await waitFor(() => expect(of("first_run_answer")[1]).toEqual({ projectId: "p1", step: "writer", answer: "codex / gpt-6-luna" }));
  });

  it("[sma:d_onboarding_done] once all four steps are answered the finish button replaces the box, sends the finish for the project, and the screen then says the settings are written", async () => {
    const { FirstRunScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const { rpc, of } = recorder(interview({ goal: "a shop", writer: "codex / gpt-6-luna", quality: "full", words: "yes" }).table);
    const slot = await mount(() => <FirstRunScreen rpc={rpc} projectId="p1" />);
    const finish = await slot.findByText("Finish and write the settings", { selector: "button" });
    expect(slot.queryByText("Send", { selector: "button" })).toBeNull();
    expect(of("first_run_finish")).toEqual([]);
    fireEvent.click(finish);
    await waitFor(() => expect(of("first_run_finish")).toEqual([{ projectId: "p1" }]));
    await waitFor(() => expect(slot.getByTestId("ck-first-run").textContent).toContain("This project has its settings already."));
    expect(of("first_run_answer")).toEqual([]);
  });
});

describe("region 9 · terminals' coordination", () => {
  it("[sma:d_coordination] the coordination screen shows the claims the run's checkout answers (the whole status text), «Nothing yet.» for an empty one, and nothing to clear without a run", async () => {
    const { CoordScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const { rpc, of } = recorder({ coord_status: () => ({ exitCode: 0, output: "claim a1 term-1 src/a.ts\nclaim b2 term-2 src/b.ts" }) });
    const slot = await mount(() => <CoordScreen rpc={rpc} runId="run_1" />);
    await waitFor(() => expect(slot.getByTestId("ck-coord").querySelector("pre")!.textContent).toBe("claim a1 term-1 src/a.ts\nclaim b2 term-2 src/b.ts"));
    expect(of("coord_status")).toEqual([{ runId: "run_1" }]);
    cleanup();
    const empty = await mount(() => <CoordScreen rpc={recorder({ coord_status: () => ({ exitCode: 0, output: "" }) }).rpc} runId="run_1" />);
    await waitFor(() => expect(empty.getByTestId("ck-coord").querySelector("pre")!.textContent).toBe("Nothing yet."));
    cleanup();
    const none = recorder({ coord_status: () => ({ output: "never" }) });
    const without = await mount(() => <CoordScreen rpc={none.rpc} runId={null} />);
    await waitFor(() => expect(without.getByTestId("ck-coord").querySelector("pre")!.textContent).toBe("Nothing yet."));
    expect(none.of("coord_status")).toEqual([]);
    expect(without.queryByText("Clear the claim of a session")).toBeNull();
  });

  it("[sma:d_claim_clear] «Send» clears a session's claim only with a session and a reason of three letters or more, sends the run, the session and the reason, and reads the status again", async () => {
    const { CoordScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    let status = "claim a1 term-1";
    const { rpc, of } = recorder({ coord_status: () => ({ exitCode: 0, output: status }), coord_clear: () => { status = "no claims"; return { exitCode: 0, output: "cleared" }; } });
    const slot = await mount(() => <CoordScreen rpc={rpc} runId="run_1" />);
    await waitFor(() => expect(slot.getByTestId("ck-coord").querySelector("pre")!.textContent).toBe("claim a1 term-1"));
    const send = button(slot, "Send");
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText("Session"), "term-1");
    type(slot.getByLabelText("Why"), "ab");
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText("Why"), "abc");
    expect(send.disabled).toBe(false);
    type(slot.getByLabelText("Session"), "  ");
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText("Session"), "term-1");
    fireEvent.click(send);
    await waitFor(() => expect(of("coord_clear")).toEqual([{ runId: "run_1", session: "term-1", reason: "abc" }]));
    await waitFor(() => expect(slot.getByTestId("ck-coord").querySelector("pre")!.textContent).toBe("no claims"));
    expect(of("coord_status")).toHaveLength(2);
  });
});

describe("region 9 · ship and update", () => {
  const mountShip = async (table: Table, hostId: string | null = "h1") => {
    const { ShipScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const rec = recorder(table);
    const slot = await mount(() => <ShipScreen rpc={rec.rpc} projectId="p1" hostId={hostId} />);
    return { ...rec, slot };
  };
  const started = (slot: { getByTestId: (id: string) => HTMLElement }) => slot.getByTestId("ck-ship").querySelector("pre")!.textContent;

  it("[sma:d_ship_gate] «Run validate-phase» needs a phase id, starts the validate-phase workflow for the project with that phase id, and says what the run answered", async () => {
    const { slot, of } = await mountShip({ workflow_run: () => ({ runId: "wf_9", state: "started" }) });
    const gate = button(slot, "Run validate-phase");
    expect(gate.disabled).toBe(true);
    type(slot.getByLabelText("phase_id"), "  ph7 ");
    expect(gate.disabled).toBe(false);
    fireEvent.click(gate);
    await waitFor(() => expect(of("workflow_run")).toEqual([{ id: "validate-phase", projectId: "p1", inputs: { phase_id: "  ph7 " } }]));
    await waitFor(() => expect(started(slot)).toBe('Started: {"runId":"wf_9","state":"started"}'));
    expect(slot.queryByTestId("ck-ship-push")).toBeNull();
    // A refusal is said as it is.
    cleanup();
    const refused = await mountShip({ workflow_run: () => { throw new Error("phase ph7 has no plan"); } });
    type(refused.slot.getByLabelText("phase_id"), "ph7");
    fireEvent.click(button(refused.slot, "Run validate-phase"));
    await waitFor(() => expect(started(refused.slot)).toBe("Error: phase ph7 has no plan"));
  });

  it("[sma:d_ship_publish] «Run pr-branch» and «Run ship» start their own workflows with the phase id; only the ship run lists the push and PR command lines its output carries", async () => {
    const out = { steps: [{ log: "ok\ngit push origin lp/ph7\nnoise" }, { log: "gh pr create --title x" }], again: "git push origin lp/ph7" };
    const { slot, of } = await mountShip({ workflow_run: ({ id }: { id: string }) => (id === "ship" || id === "pr-branch" ? out : {}) });
    type(slot.getByLabelText("phase_id"), "ph7");
    fireEvent.click(button(slot, "Run pr-branch"));
    await waitFor(() => expect(of("workflow_run")).toEqual([{ id: "pr-branch", projectId: "p1", inputs: { phase_id: "ph7" } }]));
    await waitFor(() => expect(started(slot)).toContain("Started:"));
    expect(slot.queryByTestId("ck-ship-push")).toBeNull();
    fireEvent.click(button(slot, "Run ship"));
    await waitFor(() => expect(of("workflow_run")[1]).toEqual({ id: "ship", projectId: "p1", inputs: { phase_id: "ph7" } }));
    await waitFor(() => expect(slot.getByTestId("ck-ship-push").textContent).toBe("git push origin lp/ph7\ngh pr create --title x"));
    // A later gate run clears the command lines.
    fireEvent.click(button(slot, "Run validate-phase"));
    await waitFor(() => expect(slot.queryByTestId("ck-ship-push")).toBeNull());
  });

  it("[sma:d_update_run] «Check for an update» asks the machine without applying, «Run update» applies; the answer's output is shown clipped to 600 characters; with no machine there are no update buttons", async () => {
    const { slot, of } = await mountShip({ cockpit_update: ({ apply }: { apply: boolean }) => ({ exitCode: 0, output: apply ? `applied ${"x".repeat(700)}` : "up to date" }) });
    fireEvent.click(button(slot, "Check for an update"));
    await waitFor(() => expect(of("cockpit_update")).toEqual([{ hostId: "h1", apply: false }]));
    await waitFor(() => expect(started(slot)).toBe("up to date"));
    fireEvent.click(button(slot, "Run update"));
    await waitFor(() => expect(of("cockpit_update")[1]).toEqual({ hostId: "h1", apply: true }));
    await waitFor(() => expect(started(slot)).toBe(`applied ${"x".repeat(592)}`));
    cleanup();
    const none = await mountShip({}, null);
    expect(none.slot.queryByText("Check for an update", { selector: "button" })).toBeNull();
    expect(none.slot.queryByText("Run update", { selector: "button" })).toBeNull();
  });
});

describe("region 9 · bring your own helpers (the screen)", () => {
  it("[sma:d_import_enroll] ticking found helpers and «Take as drafts» sends the run and exactly the ticked names; each draft's status is listed, and an applied or kept draft offers «Check and enable» that hands the role to the PM and turns the line into «awaits your «да»»", async () => {
    const { ForgeScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const { rpc, of } = recorder({
      helpers_list: () => [{ source: ".claude/agents/yard.md", name: "yard", description: "A yard agent.", format: "claude" }, { source: ".codex/agents/ranger.toml", name: "ranger", description: "", format: "codex" }],
      cockpit_forge_list: () => [], helpers_import: () => [{ name: "yard", status: "applied" }, { name: "ranger", status: "kept: a draft with this name exists" }], cockpit_forge_enable: () => ({}),
    });
    const slot = await mount(() => <ForgeScreen rpc={rpc} projectId="p1" runId="run_1" />);
    await slot.findByText("yard");
    expect(of("helpers_list")).toEqual([{ runId: "run_1" }]);
    const take = button(slot, "Take as drafts");
    expect(take.disabled).toBe(true);
    fireEvent.click(slot.getByLabelText("yard"));
    expect(take.disabled).toBe(false);
    fireEvent.click(slot.getByLabelText("ranger"));
    fireEvent.click(slot.getByLabelText("ranger"));
    fireEvent.click(take);
    await waitFor(() => expect(of("helpers_import")).toEqual([{ runId: "run_1", names: ["yard"] }]));
    await waitFor(() => expect(slot.getByTestId("ck-own-helpers").textContent).toContain("yard: applied"));
    const enable = slot.getAllByText("Check and enable", { selector: "button" });
    expect(enable).toHaveLength(2);
    fireEvent.click(enable[0]!);
    await waitFor(() => expect(of("cockpit_forge_enable")).toEqual([{ projectId: "p1", kind: "role", name: "yard" }]));
    await waitFor(() => expect(slot.getByTestId("ck-own-helpers").textContent).toContain("yard: awaits your «да»"));
    expect(slot.getByTestId("ck-own-helpers").textContent).toContain("ranger: kept: a draft with this name exists");
  });
});

describe("region 9 · the project list and the project choice", () => {
  const rail = (extra: Record<string, unknown> = {}) => {
    const chosen: string[] = [];
    const projects = [{ id: "p_a", name: "Alpha" }, { id: "p_b", name: "Beta" }];
    const page = { compactChrome: false, activeScope: "projects", setActiveScope: () => undefined, projectListError: null, projectsLoaded: true, projects, projectGroups: { main: projects, service: [{ id: "p_sb", name: "LP sandbox" }] },
      projectId: "p_b", selectedSectionId: null, setSelectedSectionId: () => undefined, sections: [], chooseProject: (id: string) => chosen.push(id), hiddenProjects: new Set<string>(["p_sb"]), showProject: () => undefined, ...extra };
    return { page, chosen };
  };

  it("[sma:d_projects] the rail lists the projects by name, marks the open one as the current page, folds service projects away, and a press on a project chooses it; before the list loads or without projects it says so", async () => {
    const { ScopeRail } = await import("../../src/rooms/pages/project-nav");
    const { page, chosen } = rail();
    const view = await mount(() => <ScopeRail page={page as never} />);
    const names = Array.from(document.body.querySelectorAll("[data-testid^='project-item-']")).map((node) => `${node.getAttribute("data-testid")}|${node.textContent}|${node.getAttribute("aria-current")}`);
    expect(names).toEqual(["project-item-p_a|Alpha|null", "project-item-p_b|Beta|page", "project-item-p_sb|LP sandbox|null"]);
    expect(view.getByTestId("service-projects").hasAttribute("open")).toBe(false);
    expect(view.getByTestId("service-projects").textContent).toContain("LP sandbox");
    fireEvent.click(view.getByTestId("project-item-p_a"));
    expect(chosen).toEqual(["p_a"]);
    cleanup();
    // A system page open: no project is the current one.
    const away = await mount(() => <ScopeRail page={rail({ activeScope: "tasks" }).page as never} />);
    expect(away.getByTestId("project-item-p_b").getAttribute("aria-current")).toBeNull();
    cleanup();
    expect((await mount(() => <ScopeRail page={rail({ projectsLoaded: false }).page as never} />)).getByTestId("scope-rail").textContent).toContain("Loading projects");
    cleanup();
    expect((await mount(() => <ScopeRail page={rail({ projects: [], projectGroups: { main: [], service: [] } }).page as never} />)).getByTestId("scope-rail").textContent).toContain("No projects");
  });

  const cockpit = async (rpc: Table) => {
    const app = await loadPluginApp(() => import("../../app"));
    const panel = app.navPanels.find((row: { id: string }) => row.id === "lane-pilot-cockpit")!;
    const calls: Array<[string, unknown]> = [];
    const wrapped = Object.fromEntries(Object.entries({ list_projects: () => ({ projects: [{ id: "proj_a", name: "Alpha" }, { id: "proj_b", name: "Beta" }] }), first_run_get: () => ({ needed: false }),
      owner_waiting: () => ({ items: [] }), world_version: () => ({ version: "1" }), phase_list: () => [], cockpit_seen: () => ({}), ...rpc }).map(([name, handler]) => [name, (params: never) => { calls.push([name, params]); return (handler as (p: never) => unknown)(params); }]));
    const slot = renderSlot({ component: () => <panel.component subPath="phases" /> } as never, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
    return { slot, calls };
  };

  it("[sma:d_project_select] the window opens on the first project, a pick in the list asks the server for that project's screen and only then switches and is remembered; a project the server refuses leaves the choice as it was and says so", async () => {
    const { slot, calls } = await cockpit({ get_screen: ({ projectId }: { projectId: string }) => { if (projectId === "proj_bad") throw new Error("no such project"); return { hostId: "h1", runs: [] }; } });
    await slot.findByTestId("ck-phases");
    const select = slot.getByTestId("ck-project") as HTMLSelectElement;
    expect(select.value).toBe("proj_a");
    await waitFor(() => expect(localStorage.getItem("lane-pilot:cockpit:project")).toBe("proj_a"));
    fireEvent.change(select, { target: { value: "proj_b" } });
    await waitFor(() => expect((slot.getByTestId("ck-project") as HTMLSelectElement).value).toBe("proj_b"));
    expect(calls.filter(([name, params]) => name === "get_screen" && (params as { projectId: string }).projectId === "proj_b")[0]![1]).toEqual({ projectId: "proj_b", runsLimit: 5 });
    await waitFor(() => expect(localStorage.getItem("lane-pilot:cockpit:project")).toBe("proj_b"));
    expect(slot.queryByTestId("ck-project-error")).toBeNull();
    // A project the server refuses: the select cannot take it, nothing is remembered for it, the failure is said.
    const option = document.createElement("option");
    option.value = "proj_bad"; option.textContent = "Bad";
    select.appendChild(option);
    fireEvent.change(select, { target: { value: "proj_bad" } });
    await waitFor(() => expect(slot.getByTestId("ck-project-error")).toBeTruthy());
    expect(localStorage.getItem("lane-pilot:cockpit:project")).toBe("proj_b");
  });
});

describe("region 9 · machines on the System screen", () => {
  it("[sma:d_machines] the System screen lists each machine's line from the hub's peers (online green, the silent one muted) and the machine row follows the answer on refresh", async () => {
    const { SystemScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    let peers = [{ hostId: "h1", name: "mini", online: true, line: "mini: на связи · окна: 5h 12%" }, { hostId: "h2", name: "ovh", online: false, line: "ovh: не отвечает (last seen 9 min ago)" }];
    const { rpc, of } = recorder({ peers_list: () => peers, door_audience: () => ({ door: "the BB hub", reachedOver: "WireGuard", machines: [] }), actions_recent: () => [], cockpit_seen_list: () => ({ seen: {}, rpcs: [] }) });
    const slot = await mount(() => <SystemScreen rpc={rpc} projectId="p1" />);
    await waitFor(() => expect(slot.getByTestId("ck-machines").querySelectorAll("li")).toHaveLength(2));
    const rows = Array.from(slot.getByTestId("ck-machines").querySelectorAll("li")).map((row) => `${row.textContent}|${row.querySelector("span")!.className.includes("bg-emerald-500") ? "online" : "silent"}`);
    expect(rows).toEqual(["mini: на связи · окна: 5h 12%|online", "ovh: не отвечает (last seen 9 min ago)|silent"]);
    expect(of("peers_list")).toEqual([{}]);
    peers = [{ hostId: "h2", name: "ovh", online: true, line: "ovh: на связи" }];
    fireEvent.click(slot.getByTestId("ck-machines").querySelector("button")!);
    await waitFor(() => expect(slot.getByTestId("ck-machines").querySelectorAll("li")).toHaveLength(1));
    expect(slot.getByTestId("ck-machines").querySelector("li")!.textContent).toBe("ovh: на связи");
    expect(slot.getByTestId("ck-machines").querySelector("li span")!.className).toContain("bg-emerald-500");
  });
});

describe("region 9 · diagnostics of the install", () => {
  const trace = { providerId: "codex", model: "gpt-6-luna", effectiveReasoningLevel: "high", serviceTier: null, requestedReasoningLevel: "medium", fallbackReason: "provider limit", selectionSource: { reasoningLevelSource: "project setting" } };
  const segment = async (data: Record<string, unknown> | null) => {
    const { ServiceSegment } = await import("../../src/rooms/pages/service-segment");
    const page = { rpc: { call: () => Promise.resolve(undefined) }, load: () => undefined, projectId: "p1", nativeState: null, data, error: null, confirmOpen: false, setConfirmOpen: () => undefined, pendingOp: null, setPendingOp: () => undefined,
      snapshotPath: "", setSnapshotPath: () => undefined, detectResult: null, resultPatch: null, resultSource: null, stackControls: false, diagnosticsGrouped: [], writeDraft: () => undefined, applySetting: () => undefined,
      displayedValue: () => undefined, runStack: () => undefined, hostLabel: (id: string | null) => id ?? "-", nativeHostId: null, installNative: () => undefined };
    return mount(() => <ServiceSegment page={page as never} />);
  };

  it("[sma:d_diagnostics] the technical details of the install show the workspace the project runs in, the last backup folder, the writer's last run (provider/model · reasoning · tier, the requested level, the fallback reason, where the level came from) and the settings the install could not apply with their reasons", async () => {
    const slot = await segment({ workspacePath: "/srv/shop", lastSnapshotPath: "/srv/shop/.bak", lastWriterTrace: trace, unapplied: [{ key: "writer.fast_mode", reason: "unknown" }], values: {}, versions: {} });
    expect(slot.getByTestId("import-diagnostics").textContent).toContain("/srv/shop");
    expect(slot.getByTestId("import-diagnostics").textContent).toContain("/srv/shop/.bak");
    expect(slot.getByTestId("writer-trace-execution").textContent).toBe("codex/gpt-6-luna · high · default");
    const panel = slot.getByTestId("diagnostics-panel").textContent!;
    expect(panel).toContain("provider limit");
    expect(panel).toContain("project setting");
    expect(panel).toContain("writer.fast_mode:");
    cleanup();
    // Nothing known yet: the dash and the «no data» line, not a blank block.
    const empty = await segment({ workspacePath: null, lastSnapshotPath: null, lastWriterTrace: null, unapplied: [], values: {}, versions: {} });
    expect(empty.getByTestId("import-diagnostics").textContent).toContain("—");
    expect(empty.queryByTestId("writer-trace-execution")).toBeNull();
    expect(empty.getByTestId("writer-trace").textContent).not.toContain("provider limit");
  });
});
