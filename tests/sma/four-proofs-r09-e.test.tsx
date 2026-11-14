/** @vitest-environment jsdom */
// Region 9 · Person and window, batch e (n882 … n916), the screens: each window rendered for real in jsdom, driven the way the person drives it. Every
// test checks what the window SENT (the whole call) or DREW (the text, the mark, the size), and writes it down with observe() for the region scene sma_r09.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride, t } from "@lane-pilot/i18n";
import { observe, recorder, textOf, type Table } from "./r09-world-e";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });

async function mount(component: () => React.ReactElement, table: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: table as never });
}
const button = (slot: { getByText: (text: string, options: { selector: string }) => HTMLElement }, label: string) => slot.getByText(label, { selector: "button" }) as HTMLButtonElement;
const type = (element: HTMLElement, value: string) => fireEvent.change(element, { target: { value } });

async function cockpit(rpc: Table, subPath: string) {
  const app = await loadPluginApp(() => import("../../app"));
  const panel = app.navPanels.find((row: { id: string }) => row.id === "lane-pilot-cockpit")!;
  const calls: Array<[string, unknown]> = [];
  const table: Table = { list_projects: () => ({ projects: [{ id: "proj_a", name: "Alpha" }] }), get_screen: () => ({ hostId: "h1", runs: [] }), first_run_get: () => ({ needed: false }),
    owner_waiting: () => ({ items: [] }), world_version: () => ({ version: "1" }), phase_list: () => [], cockpit_seen: () => ({}), ...rpc };
  const wrapped = Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, (params: never) => { calls.push([name, params]); return handler(params); }]));
  const slot = renderSlot({ component: () => <panel.component subPath={subPath} /> } as never, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
  return { slot, calls };
}

describe("region 9 · the window's own plumbing", () => {
  it("[sma:m_ws_link_state] the window says «the hub does not answer» as soon as the door's pulse read fails, says nothing while the pulse answers, and the screens keep showing what they last saw", async () => {
    const healthy = await cockpit({}, "phases");
    await healthy.slot.findByTestId("ck-phases");
    await waitFor(() => expect(healthy.calls.some(([name]) => name === "world_version")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const whenAnswering = healthy.slot.queryByTestId("ck-door-silent") !== null;
    expect(whenAnswering).toBe(false);
    cleanup();
    const quiet = await cockpit({ world_version: () => { throw new Error("no answer"); } }, "phases");
    await quiet.slot.findByTestId("ck-phases");
    const said = textOf(await quiet.slot.findByTestId("ck-door-silent"));
    expect(said).toBe("The hub does not answer — the screens show what they saw last.");
    expect(quiet.slot.getByTestId("ck-phases")).toBeTruthy();
    observe("n882", { whenAnswering, whenSilent: said, screenKept: quiet.slot.queryByTestId("ck-phases") !== null });
  });

  it("[sma:m_sw_feedback] «Report a fault» takes the person's words (not under three letters), sends the screen's name and the words, then shows the prepared title and description to copy and says that nothing was sent", async () => {
    const issue = { ok: true, title: "Lane Pilot: fault on «phases»", body: "the button is dead\n\nLane Pilot 0.1.568 · linux · screen phases" };
    const view = await cockpit({ cockpit_fault: () => issue }, "phases");
    await view.slot.findByTestId("ck-phases");
    fireEvent.click(await view.slot.findByTestId("ck-report-fault"));
    const send = button(view.slot, "Send");
    expect(send.disabled).toBe(true);
    const box = view.slot.getByLabelText(t("ckFaultPlaceholder"));
    type(box, "ab");
    expect(send.disabled).toBe(true);
    type(box, "the button is dead");
    expect(send.disabled).toBe(false);
    fireEvent.click(send);
    await view.slot.findByTestId("ck-fault-issue");
    const shown = textOf(view.slot.getByTestId("ck-fault-issue"));
    const sent = view.calls.filter(([name]) => name === "cockpit_fault").map(([, params]) => params);
    expect(sent).toEqual([{ screen: "phases", text: "the button is dead" }]);
    expect(shown).toContain("Title: Lane Pilot: fault on «phases»");
    expect(shown).toContain("the button is dead");
    expect(shown).toContain(t("ckNothingSent"));
    observe("n883", { sent, shown });
  });

  it("[sma:m_sw_agents] the team page ends with «Need a new worker?» and one button that opens the cockpit's forge screen, where the order box and the drafts live", async () => {
    const { NeedWorkerBlock } = await import("../../src/rooms/pages/tab-team");
    const slot = await mount(() => <NeedWorkerBlock projectId="p1" />);
    expect(textOf(slot.getByTestId("team-need-worker"))).toBe(`${t("teamNeedWorker")}${t("teamOpenForge")}`);
    expect(slot.inspection.navigateCalls).toEqual([]);
    fireEvent.click(slot.getByTestId("team-open-forge"));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "lane-pilot-cockpit", options: { subPath: "forge" } }]);
    observe("n884", { text: textOf(slot.getByTestId("team-need-worker")), navigated: slot.inspection.navigateCalls });
  });
});

describe("region 9 · the forge order and the skills", () => {
  it("[sma:m_sw_forge_dialog] the forge order is a kind, a name and a description in words: «Send» waits for a kebab-case name and a description of at least twenty letters, and only a skill has a box for the owner's own text", async () => {
    const { ForgeScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const r = recorder({ cockpit_forge_list: () => [], cockpit_forge_order: () => ({ ordered: true }) });
    const slot = await mount(() => <ForgeScreen rpc={r.rpc as never} projectId="p1" runId={null} />);
    const send = button(slot, "Send");
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText(t("ckForgeName")), "yard-keeper");
    type(slot.getByLabelText(t("ckForgeBrief")), "keeps the yard");
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText(t("ckForgeBrief")), "x".repeat(19));
    expect(send.disabled).toBe(true);
    type(slot.getByLabelText(t("ckForgeBrief")), "x".repeat(20));
    expect(send.disabled).toBe(false);
    const skillHasBody = slot.queryByLabelText(t("ckForgeBody")) !== null;
    fireEvent.click(button(slot, "role"));
    const roleHasBody = slot.queryByLabelText(t("ckForgeBody")) !== null;
    expect(skillHasBody).toBe(true);
    expect(roleHasBody).toBe(false);
    fireEvent.click(send);
    await waitFor(() => expect(r.of("cockpit_forge_order")).toEqual([{ projectId: "p1", kind: "role", name: "yard-keeper", brief: "x".repeat(20) }]));
    await waitFor(() => expect(textOf(slot.getByTestId("ck-forge-order"))).toContain(t("ckForgeOrdered")));
    observe("n886", { sent: r.of("cockpit_forge_order"), skillHasBody, roleHasBody });
  });

  it("[sma:m_sw_skills] each skill of the team page is listed with the store it came from (a skill with no store says «общие BB»), and an empty list names the two places it looked", async () => {
    const { SkillsBlock } = await import("../../src/rooms/pages/tab-team");
    const view = { catalog: { skills: [{ name: "pick", description: "Use when picking.", store: "навыки проекта «p1»" }, { name: "gen", description: "" }], skillsLooked: ["общие навыки BB", "навыки проекта «p1»"] } };
    render(createElement(SkillsBlock, { access: { view } as never }));
    const lines = ["pick", "gen"].map((name) => textOf(document.querySelector(`[data-testid='team-skill-${name}']`)));
    expect(lines).toEqual(["pick навыки проекта «p1»Use when picking.", "gen общие BB"]);
    cleanup();
    render(createElement(SkillsBlock, { access: { view: { catalog: { skills: [], skillsLooked: ["общие навыки BB", "навыки проекта «p1»"] } } } as never }));
    const empty = textOf(document.querySelector("[data-testid='team-skills-empty']"));
    expect(empty).toContain("общие навыки BB, навыки проекта «p1»");
    cleanup();
    render(createElement(SkillsBlock, { access: { view: { catalog: { skills: [] } } } as never }));
    const defaults = textOf(document.querySelector("[data-testid='team-skills-empty']"));
    expect(defaults).toContain("общие навыки BB, навыки проекта");
    observe("n889", { lines, empty, defaults });
  });
});

describe("region 9 · memory and rules", () => {
  const proposal = (id: string, state: string, rule: string) => ({ id, rule, author: "sweep", state, occurrences: 3, taskCount: 2, examples: [], evidence: [], lastSeenAt: 1, decidedAt: null, decidedBy: null, trialState: null, revision: 1, retiredReason: null, trial: null, scope: [], scopeLabel: "", audience: "both", always: false });
  const listed = (proposals: unknown[]) => ({ proposals, memory: { enabled: true, inject: true }, triage: { total: 0, byOrigin: {}, errors: 0, lastTriagedAt: null, pendingGroups: 0 }, scan: { state: "idle", startedAt: null, finishedAt: null, triaged: 0, groups: 0, proposals: 0, reason: null }, analyzer: null, events: [] });

  it("[sma:m_sw_drafts_panel] a lesson draft waits under «Waiting for your decision» with its text in a box the person may edit; «Accept» waits for a text of at least eight letters; a draft already decided is not offered again, and with none waiting there is no waiting block", async () => {
    const { RuleProposals } = await import("../../src/rooms/self-repair/ui/rule-proposals");
    const slot = await mount(() => <RuleProposals projectId="p1" />, { list_rule_proposals: () => listed([proposal("r1", "proposed", "Run the lint before every commit."), proposal("r3", "rejected", "Rejected one.")]) });
    const draft = await slot.findByTestId("rule-r1");
    const box = draft.querySelector("textarea") as HTMLTextAreaElement;
    const accept = Array.from(draft.querySelectorAll("button")).find((node) => node.textContent === "Accept") as HTMLButtonElement;
    expect(box.value).toBe("Run the lint before every commit.");
    expect(accept.disabled).toBe(false);
    type(box, "1234567");
    const sevenOff = accept.disabled;
    expect(sevenOff).toBe(true);
    type(box, "12345678");
    const eightOn = !accept.disabled;
    expect(eightOn).toBe(true);
    expect(textOf(slot.getByTestId("rule-proposals"))).toContain("Waiting for your decision");
    expect(slot.queryByTestId("rule-r3")).toBeNull();
    cleanup();
    const quiet = await mount(() => <RuleProposals projectId="p1" />, { list_rule_proposals: () => listed([proposal("r2", "accepted", "Never edit the lockfile by hand.")]) });
    await quiet.findByTestId("rule-r2");
    const none = textOf(quiet.getByTestId("rule-proposals")).includes("Waiting for your decision");
    expect(none).toBe(false);
    observe("n892", { text: "Run the lint before every commit.", sevenLettersOff: sevenOff, eightLettersOn: eightOn, decidedListed: slot.queryByTestId("rule-r3") !== null, waitingBlockWithNone: none });
  });

  it("[sma:m_sw_lint_panel] the memory list marks a record «no trace» only where the server says so, and leaves the mark off the records that have one", async () => {
    const { MemoryRecords } = await import("../../src/rooms/memory/ui/memory-records");
    const rec = (id: string, noTrace: boolean) => ({ id, kind: "note", sources: 1, createdAt: 1, originTaskId: null, noTrace, origin: "maintainer", scope: [], rule: false, content: `Record ${id}.`, concepts: [] });
    const slot = await mount(() => <MemoryRecords projectId="P" />, { memory_records_list: () => ({ records: [rec("orphan1-aaaaaaa", true), rec("vouched1-aaaaaa", false)] }) });
    await waitFor(() => expect(slot.getAllByText(/Record /).length).toBeGreaterThan(0));
    const marked = (id: string) => textOf(slot.getByTestId(`memory-record-${id.slice(0, 12)}`)).includes(t("memoryRecordNoTrace"));
    const result = { orphan: marked("orphan1-aaaaaaa"), vouched: marked("vouched1-aaaaaa"), marks: slot.queryAllByTestId("memory-record-no-trace").length };
    expect(result).toEqual({ orphan: true, vouched: false, marks: 1 });
    observe("n893", result);
  });

  it("[sma:m_sw_tag_cloud] the tag cloud lists the tags the corpus holds, each as big as it is frequent (11 px and one for every use, 18 px at most)", async () => {
    const { MemoryScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const r = recorder({ session_memory_search: () => ({ records: [] }), cockpit_memory: () => ({ exitCode: 0, output: "", tags: [{ tag: "billing", count: 1 }, { tag: "ledger", count: 4 }, { tag: "rare", count: 40 }] }) });
    const slot = await mount(() => <MemoryScreen rpc={r.rpc as never} runId="run_1" projectId="p1" />);
    fireEvent.click(button(slot, t("ckMemoryTags")));
    const cloud = await slot.findByTestId("ck-tags");
    const sizes = Array.from(cloud.querySelectorAll("span")).map((node) => [node.textContent, (node as HTMLElement).style.fontSize]);
    expect(r.of("cockpit_memory")).toEqual([{ runId: "run_1", action: "tags" }]);
    expect(sizes).toEqual([["billing", "12px"], ["ledger", "15px"], ["rare", "18px"]]);
    observe("n895", { sent: r.of("cockpit_memory"), sizes });
  });
});

describe("region 9 · connections", () => {
  it("[sma:m_sw_connections] the access panel says in words what each kind of worker honours: «Claude Code and Codex: everything.», and for the others what they leave out and which switch cannot be turned off", async () => {
    const { AccessModePanel } = await import("../../src/rooms/settings/ui/agent-access");
    const { CORE_PROVIDER_GROUPS } = await import("../../src/rooms/contracts/helper-context");
    const providers = Object.fromEntries(Object.entries(CORE_PROVIDER_GROUPS).filter(([id]) => id !== "acp-opencode").map(([id, groups]) => [id, [...groups]]));
    const api = { view: { mode: "roles", modeOrigin: null, roles: [], catalog: { bbPlugins: [], skills: [] }, mandatory: { bbPlugins: [], mcpServers: [] }, providers }, scope: "project", below: {}, failed: false, busy: null, reload: async () => undefined, save: async () => undefined, reset: async () => undefined };
    const slot = await mount(() => <AccessModePanel api={api as never} modeControl={null} />);
    const lines = Array.from(slot.getByTestId("access-providers").querySelectorAll("p, li, div")).map((node) => textOf(node)).filter(Boolean);
    const whole = textOf(slot.getByTestId("access-providers"));
    expect(whole).toContain("Claude Code and Codex: everything.");
    expect(whole).toContain("Grok (Cursor) and OpenCode: everything except CLI plugins; Cursor's own skills cannot be turned off; project instructions cannot be turned off.");
    observe("n899", { whole, lines: lines.length > 0 });
  });
});

describe("region 9 · which workers get a skill", () => {
  it("[sma:m_sw_assign_dialog] on a worker's access card «Only these» for skills saves the skills the worker has now, adding a skill by name saves the list with it, and choosing the mode the worker is already on saves nothing", async () => {
    const { RoleAccessBody } = await import("../../src/rooms/settings/ui/agent-access");
    const role = { role: "writer", key: "helper.access.writer", version: 2, value: null, inherited: false, origin: null, originBelow: null,
      groups: { bbPlugins: { names: [], source: "role" }, skills: { names: ["lp-writer"], source: "role" }, mcpServers: { names: [], source: "role" }, nativePlugins: { names: [], source: "role" } },
      switches: { userInstructions: { include: false, source: "role" }, projectInstructions: { include: true, source: "role" } } };
    const view = { mode: "roles", modeOrigin: null, roles: [role], catalog: { bbPlugins: [], skills: [{ name: "lp-writer", description: "Writing habits" }, { name: "ru-text", description: "Russian text quality" }] }, mandatory: { bbPlugins: [], mcpServers: [] }, providers: {} };
    const saved: unknown[] = [];
    const slot = await mount(() => <RoleAccessBody role={role as never} view={view as never} scope="project" below="role" busy={false} onSave={(r, value) => saved.push({ role: r.role, version: r.version, value })} onReset={() => undefined} />);
    const choose = async (testId: string, label: string) => { fireEvent.keyDown(slot.getByTestId(testId), { key: "Enter" }); fireEvent.click(await slot.findByRole("option", { name: label })); };
    await choose("access-writer-skills-mode", t("accessModeRole"));
    expect(saved).toEqual([]);
    await choose("access-writer-skills-mode", t("accessModeAllow"));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ role: "writer", version: 2, value: { skills: { mode: "allow", names: ["lp-writer"] } } });
    cleanup();
    const chosenRole = { ...role, groups: { ...role.groups, skills: { names: ["lp-writer"], source: "owner" } } };
    const second: unknown[] = [];
    const again = await mount(() => <RoleAccessBody role={chosenRole as never} view={{ ...view, roles: [chosenRole] } as never} scope="project" below="role" busy={false} onSave={(r, value) => second.push(value)} onReset={() => undefined} />);
    const search = again.getByLabelText(t("accessAddSearchSkills"));
    fireEvent.focus(search);
    type(search, "ru-");
    fireEvent.click(await again.findByRole("option", { name: /ru-text/ }));
    await waitFor(() => expect(second).toHaveLength(1));
    expect(second[0]).toEqual({ skills: { mode: "allow", names: ["lp-writer", "ru-text"] } });
    observe("n890", { onlyThese: saved[0], added: second[0] });
  });
});

describe("region 9 · the designer's statistics on the workers screen", () => {
  it("[sma:m_sw_designer_stats] the workers screen draws the designer's readiness words, each condition of «trained» with a tick or a cross and its numbers, and the ratios as «name: value» with a dash where nothing is measured yet (a measured zero stays 0)", async () => {
    const { WorkersScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
    const r = recorder({ cockpit_workers: () => [], cockpit_windows: () => ({ at: null, windows: {} }),
      cockpit_designer: () => ({ readiness: "Дизайнер ещё учится: 2 of 8 drawings.", conditions: [{ id: "enough_drawings", ok: false, detail: "2 of 8 drawings" }, { id: "critique_pass", ok: true, detail: "critique pass 1 (≥ 0.8)" }], ratios: { drawings: 2, firstPass: 0, judgeAgrees: null, ownerYes: 0.5 } }) });
    const slot = await mount(() => <WorkersScreen rpc={r.rpc as never} projectId="p1" hostId={null} />);
    const panel = await slot.findByTestId("ck-designer");
    await waitFor(() => expect(textOf(panel)).toContain("2 of 8 drawings"));
    const lines = Array.from(panel.querySelectorAll("p, li")).map((node) => textOf(node));
    expect(r.of("cockpit_designer")).toEqual([{ projectId: "p1" }]);
    expect(lines).toEqual(["Дизайнер ещё учится: 2 of 8 drawings.", "✗ 2 of 8 drawings", "✓ critique pass 1 (≥ 0.8)", "drawings: 2 · firstPass: 0 · judgeAgrees: — · ownerYes: 0.5"]);
    observe("n887", { lines });
  });
});

describe("region 9 · the system screens", () => {
  it("[sma:m_sw_remote] «Work remotely» explains how the machines join and are let go, names the door and the way the hub is reached, and only reads: the screen's calls are the four reads, none writes", async () => {
    const { SystemScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const r = recorder({ actions_recent: () => [], peers_list: () => [], door_audience: () => ({ door: "https://hub.example", reachedOver: "WireGuard (no public bb connect)", machines: ["Mac mini: на связи"] }), cockpit_seen_list: () => ({ seen: {}, rpcs: [] }) });
    const slot = await mount(() => <SystemScreen rpc={r.rpc as never} projectId="p1" />);
    await waitFor(() => expect(textOf(slot.getByTestId("ck-door"))).toContain("https://hub.example"));
    const door = textOf(slot.getByTestId("ck-door"));
    const machines = textOf(slot.getByTestId("ck-machines"));
    const called = [...new Set(r.calls.map(([name]) => name))].sort();
    expect(door).toContain("https://hub.example · WireGuard (no public bb connect)");
    expect(door).toContain(t("ckRemote"));
    expect(machines).toContain(t("ckPeerJoin"));
    expect(machines).toContain(t("ckPeerRemove"));
    expect(called).toEqual(["actions_recent", "cockpit_seen_list", "door_audience", "peers_list"]);
    observe("n905", { door, joinAndLetGo: [machines.includes(t("ckPeerJoin")), machines.includes(t("ckPeerRemove"))], called });
  });

  it("[sma:m_sw_system] the home of the window is one tile for every other screen (not for itself), and a tile opens its screen", async () => {
    const { SCREENS } = await import("../../src/rooms/cockpit/ui/registry");
    const view = await cockpit({}, "");
    const home = await view.slot.findByTestId("ck-home");
    const tiles = Array.from(home.querySelectorAll("button")).map((node) => textOf(node));
    const expected = SCREENS.filter((row) => row.id !== "home").map((row) => t(row.title));
    expect(tiles).toEqual(expected);
    expect(tiles).not.toContain(t("ckScreen_home"));
    fireEvent.click(Array.from(home.querySelectorAll("button")).find((node) => textOf(node) === t("ckScreen_money"))!);
    expect(view.slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "lane-pilot-cockpit", options: { subPath: "money" } });
    observe("n906", { tiles, opened: view.slot.inspection.navigateCalls.at(-1), expected });
  });
});

describe("region 9 · bring your own helpers, step by step", () => {
  const HELPERS = [{ source: ".claude/agents/yard.md", name: "yard", description: "A yard agent.", format: "claude" }, { source: ".codex/agents/ranger.toml", name: "ranger", description: "", format: "codex" }];
  const forge = (table: Table, runId: string | null = "run_1") => {
    const r = recorder({ cockpit_forge_list: () => [], helpers_list: () => HELPERS, ...table });
    return import("../../src/rooms/cockpit/ui/screens-ops").then(({ ForgeScreen }) => mount(() => <ForgeScreen rpc={r.rpc as never} projectId="p1" runId={runId} />).then((slot) => ({ slot, r })));
  };

  it("[sma:m_sw_import] the three steps of bringing helpers of one's own — found, take, drafts — are on the Forge screen only inside a run; without a run only the order and the drafts of the forge stay", async () => {
    const none = await forge({}, null);
    await none.slot.findByTestId("ck-forge-order");
    const withoutRun = none.slot.queryByTestId("ck-own-helpers") !== null;
    expect(none.r.of("helpers_list")).toEqual([]);
    cleanup();
    const run = await forge({});
    const panel = await run.slot.findByTestId("ck-own-helpers");
    const steps = Array.from(panel.querySelectorAll("p.font-medium")).map((node) => textOf(node));
    expect(steps).toEqual([`1 · ${t("ckStepFound")}`, `2 · ${t("ckStepTake")}`, `3 · ${t("ckStepDrafts")}`]);
    expect(withoutRun).toBe(false);
    observe("n907", { withoutRun, steps });
  });

  it("[sma:m_sw_found_step] the found helpers are read for the run and listed with a tick box, the name, the format and what they say they do — the file they came from where they say nothing; an empty list says so", async () => {
    const { slot, r } = await forge({});
    await slot.findByText("yard");
    const rows = Array.from(slot.getByTestId("ck-own-helpers").querySelectorAll("li")).map((node) => textOf(node));
    expect(r.of("helpers_list")).toEqual([{ runId: "run_1" }]);
    expect(rows).toEqual(["yard claudeA yard agent.", "ranger codex.codex/agents/ranger.toml"]);
    cleanup();
    const empty = await forge({ helpers_list: () => [] });
    await waitFor(() => expect(textOf(empty.slot.getByTestId("ck-own-helpers"))).toContain(t("ckEmpty")));
    observe("n908", { rows, asked: r.of("helpers_list"), emptySays: t("ckEmpty") });
  });

  it("[sma:m_sw_take_step] «Take as drafts» is off until a helper is ticked and sends the run with exactly the ticked names, in the order they were ticked; a helper ticked off again is not sent", async () => {
    const { slot, r } = await forge({ helpers_import: () => [{ name: "ranger", status: "applied" }, { name: "yard", status: "applied" }] });
    await slot.findByText("yard");
    const take = button(slot, "Take as drafts");
    const offAtStart = take.disabled;
    expect(offAtStart).toBe(true);
    fireEvent.click(slot.getByLabelText("ranger"));
    fireEvent.click(slot.getByLabelText("yard"));
    fireEvent.click(slot.getByLabelText("ranger"));
    fireEvent.click(slot.getByLabelText("ranger"));
    fireEvent.click(take);
    await waitFor(() => expect(r.of("helpers_import")).toEqual([{ runId: "run_1", names: ["yard", "ranger"] }]));
    observe("n909", { offAtStart, sent: r.of("helpers_import") });
  });

  it("[sma:m_sw_drafts_step] after taking, each draft is listed as «name: status»; an applied or kept one offers «Check and enable», and pressing it hands that role to the PM and changes only that line to «awaits your «да»»; a draft in another state has no button", async () => {
    const { slot, r } = await forge({ helpers_import: () => [{ name: "yard", status: "applied" }, { name: "ranger", status: "kept: a draft with this name exists" }, { name: "scout", status: "conflict" }], cockpit_forge_enable: () => ({ sent: true }) });
    await slot.findByText("yard");
    expect(textOf(slot.getByTestId("ck-own-helpers"))).toContain(t("ckEmpty"));
    fireEvent.click(slot.getByLabelText("yard"));
    fireEvent.click(button(slot, "Take as drafts"));
    await waitFor(() => expect(slot.getAllByText("Check and enable", { selector: "button" })).toHaveLength(2));
    const lines = () => Array.from(slot.getByTestId("ck-own-helpers").querySelectorAll("li.flex.items-center")).map((node) => textOf(node));
    const before = lines();
    fireEvent.click(slot.getAllByText("Check and enable", { selector: "button" })[0]!);
    await waitFor(() => expect(r.of("cockpit_forge_enable")).toEqual([{ projectId: "p1", kind: "role", name: "yard" }]));
    await waitFor(() => expect(lines()[0]).toBe("yard: awaits your «да»"));
    const after = lines();
    expect(before).toEqual(["yard: appliedCheck and enable", "ranger: kept: a draft with this name existsCheck and enable", "scout: conflict"]);
    expect(after.slice(1)).toEqual(before.slice(1));
    observe("n910", { before, after });
  });
});

describe("region 9 · the first-run interview", () => {
  const STEPS = [{ id: "goal", question: "What is it for?" }, { id: "writer", question: "Which writer?" }, { id: "quality", question: "How strict?" }, { id: "words", question: "Your words?" }];
  const interview = (answers: Record<string, string>) => ({ first_run_get: () => ({ needed: true, steps: STEPS, draft: { answers } }) } as Table);
  const screen = async (answers: Record<string, string>) => {
    const { FirstRunScreen } = await import("../../src/rooms/cockpit/ui/screens-ops");
    const r = recorder(interview(answers));
    const slot = await mount(() => <FirstRunScreen rpc={r.rpc as never} projectId="p1" />);
    await slot.findByTestId("ck-interview");
    return slot;
  };

  it("[sma:m_sw_step_panel] the interview asks the first step nobody answered as «n/4 · question» with a box named by the step, and «Send» waits for words in the box", async () => {
    const slot = await screen({ goal: "a shop", words: "no" });
    const asked = textOf(slot.getByTestId("ck-interview").querySelector("p"));
    expect(asked).toBe("2/4 · Which writer?");
    expect(slot.getByLabelText("writer")).toBeTruthy();
    expect(button(slot, "Send").disabled).toBe(true);
    type(slot.getByLabelText("writer"), "codex");
    const onWithWords = !button(slot, "Send").disabled;
    expect(onWithWords).toBe(true);
    cleanup();
    const later = await screen({ goal: "a shop", writer: "codex" });
    const next = textOf(later.getByTestId("ck-interview").querySelector("p"));
    expect(next).toBe("3/4 · How strict?");
    observe("n912", { asked, next, onWithWords });
  });

  it("[sma:m_sw_ready_column] the «ready» column lists the answered steps as «✓ step: the answer» in the order of the interview, with the person's own words, and nothing under its title before the first answer", async () => {
    const slot = await screen({ writer: "codex / gpt-6-luna", goal: "a shop" });
    const ready = textOf(slot.getByTestId("ck-ready"));
    expect(ready).toBe("Ready✓ goal: a shop✓ writer: codex / gpt-6-luna");
    cleanup();
    const fresh = await screen({});
    const empty = textOf(fresh.getByTestId("ck-ready"));
    expect(empty).toBe("Ready");
    observe("n913", { ready, empty });
  });
});

describe("region 9 · the acceptance frame", () => {
  const card = (extra: Record<string, unknown>) => ({ contract: { objective: "Save the form", acceptance: ["the form saves"], ownsPaths: [] }, risk: null, base: null, receipts: [], gates: [], planFact: null, notRun: [], baseline: null, awaitsWord: false,
    cost: { state: "not_measured", usd: null, tokens: null, note: null, attempts: 1, measured: 0 }, ...extra });
  const frame = async (answer: unknown, props: { finished?: boolean } = {}) => {
    const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui");
    const slot = await mount(() => <AcceptanceCard runId="run" taskId="t1" refreshKey={1} finished={props.finished ?? false} fallback={{ objective: "Save the form", acceptance: ["the form saves"] }} />, { task_acceptance_card: () => answer, get_stage_return_options: () => ({}) });
    return slot;
  };
  const chips = (slot: Awaited<ReturnType<typeof frame>>) => ["acc-risk", "acc-base", "acc-cost"].map((id) => textOf(slot.queryByTestId(id)));

  it("[sma:m_ws_acceptance_frame] the frame of the acceptance card says the risk, the base commit and branch, and the cost — a cost not measured is said so and never $0, a measured one in dollars with three decimals under a dollar and two above, a part-measured one with how many attempts were measured — and a card that cannot be read falls back to the contract's own words", async () => {
    const small = await frame(card({ risk: "high", base: { ref: "main", sha: "0123456789abcdef0123456789abcdef01234567", branch: "lp/t1", compareCommitted: true }, cost: { state: "measured", usd: 0.5, tokens: 10, note: null, attempts: 1, measured: 1 } }));
    await small.findByTestId("acceptance-card");
    const a = chips(small);
    cleanup();
    const big = await frame(card({ cost: { state: "measured", usd: 12.5, tokens: 10, note: null, attempts: 1, measured: 1 } }));
    await big.findByTestId("acceptance-card");
    const b = chips(big);
    cleanup();
    const part = await frame(card({ cost: { state: "partial", usd: 3, tokens: 10, note: null, attempts: 2, measured: 1 } }));
    await part.findByTestId("acceptance-card");
    const c = chips(part);
    cleanup();
    const gone = await frame(null, { finished: false });
    await gone.findByTestId("acceptance-card-fallback");
    const fallback = textOf(gone.getByTestId("acceptance-card-fallback")).slice(0, 28);
    expect(a).toEqual(["Risk: high", "Base: 01234567 · lp/t1", "Cost: $0.500"]);
    expect(b).toEqual(["", "Base: not recorded (folder without git)", "Cost: $12.50"]);
    expect(c[2]).toBe("Cost: $3.00, 1 of 2 attempts measured");
    expect(fallback).toBe("Save the form○the form saves");
    observe("n914", { a, b, c, fallback });
  });
});

describe("region 9 · the decision card and the work file", () => {
  const NOW = Date.now();
  const rpcItem = { key: "lead:r1", source: "lead", kind: "proposal", projectId: "p1", what: "Make the cart its own phase", why: "The lead proposes a direction.", since: NOW, wake: false, tier: "now", evidence: [{ kind: "task", ref: "task_abcdef123456", label: null }],
    actions: [{ id: "yes", label: "Yes", cli: "bb lane-pilot lead yes", rpc: { method: "lead_decide", input: { roadId: "r1", decision: "yes" } } }, { id: "no", label: "No", cli: "bb lane-pilot lead no", rpc: { method: "lead_decide", input: { roadId: "r1", decision: "no" } } }] };
  const cliItem = { key: "cli:c1", source: "lead", kind: "proposal", projectId: "p1", what: "Run the migration", why: "Only a person may.", since: NOW, wake: false, tier: "now", evidence: [],
    actions: [{ id: "a", label: "bb lane-pilot migrate", cli: "bb lane-pilot migrate" }, { id: "b", label: "bb lane-pilot verify", cli: "bb lane-pilot verify" }] };

  it("[sma:m_ws_decision_card] a decision is a card with what is asked, the project, why, and a button for each answer the window can send; an item whose answers are only commands lists them after «To do:» instead, and its details name the key", async () => {
    await loadPluginApp(() => import("../../app"));
    const { OwnerWaitingBoard } = await import("../../src/rooms/owner-waiting/ui");
    const calls: Array<[string, unknown]> = [];
    const table: Table = { owner_waiting_config: () => ({ enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" }), owner_waiting: () => ({ generatedAt: NOW, counts: {}, overnight: { windowMs: 86_400_000, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 }, items: [rpcItem, cliItem] }), lead_decide: () => ({ ok: true }) };
    const wrapped = Object.fromEntries(Object.entries(table).map(([name, handler]) => [name, (params: never) => { calls.push([name, params]); return handler(params); }]));
    const slot = renderSlot({ component: () => <OwnerWaitingBoard projects={[{ id: "p1", name: "Shop" }]} /> }, {}, { context: { projectId: null, threadId: null }, rpc: wrapped as never });
    const decision = await slot.findByTestId("owner-item-lead:r1");
    const commandsOnly = await slot.findByTestId("owner-item-cli:c1");
    const head = textOf(decision.querySelector("div"));
    const why = textOf(decision.querySelectorAll("p")[1]);
    const buttons = Array.from(decision.querySelectorAll("button[data-testid^='owner-run-']")).map((node) => textOf(node));
    const todo = textOf(Array.from(commandsOnly.querySelectorAll("p")).find((node) => textOf(node).startsWith(t("ow_do"))));
    expect(head).toBe("Make the cart its own phaseShop");
    expect(why).toBe(`${t("ow_why")}: The lead proposes a direction.`);
    expect(buttons).toEqual(["Yes", "No"]);
    expect(commandsOnly.querySelector("button[data-testid^='owner-run-']")).toBeNull();
    expect(todo).toBe(`${t("ow_do")}: bb lane-pilot migrate · bb lane-pilot verify`);
    fireEvent.click(slot.getByTestId("owner-run-lead:r1-no"));
    await waitFor(() => expect(calls.filter(([name]) => name === "lead_decide").map(([, params]) => params)).toEqual([{ roadId: "r1", decision: "no" }]));
    observe("n915", { head, why, buttons, todo });
  });

  const item = { kind: "task", key: "task:run:w1", runId: "run", taskId: "w1", title: "Title w1", techTitle: null, taskKind: "feature", area: null, objective: "Cakekeeper UI", projectId: "proj_a", pmThreadId: "thr_pm", pmThreadTitle: "Coordinator", column: "running",
    state: "running", phase: "writing", stage: null, model: null, since: null, waitingFor: [], detail: null, attemptNo: 1, threadId: null, attemptId: "a-w1", updatedAt: 1_791_800_000_000 };
  const taskCard = { kind: "task", title: "Title w1", techTitle: null, taskKind: "feature", area: null, objective: "Cakekeeper UI", pmThreadId: "thr_pm", id: "w1", projectId: "proj_a", state: "running", reason: null,
    contract: { objective: "Fix the form", acceptance: ["form saves"], ownsPaths: ["src/a.ts", "src/**"], expectedOutputs: [], dependsOn: [], checks: ["npm test"] }, plan: null, stages: [], attempts: [], threads: null };

  it("[sma:m_ws_work_file] in the task card a path of the contract is a button that reads that file of that run and shows its text under the path — «…» after a text that was cut, the reason where it could not be read — a pattern with a star has no button, and pressing again folds it", async () => {
    await loadPluginApp(() => import("../../app"));
    const { TaskBoard } = await import("../../src/rooms/runs/ui/task-board");
    const { AcceptanceCard } = await import("../../src/rooms/acceptance/ui");
    const reads: unknown[] = [];
    const table: Table = { task_board: () => ({ items: [item] }), task_card: () => taskCard, task_acceptance_card: () => null, work_graph_task: () => ({ cells: [], stages: [], summary: { returns: 0, seconds: null, costUsd: null, costState: "not_measured", models: [] } }), work_graph_strips: () => ({}), task_diff: () => ({ reason: "no merge" }),
      work_file_read: (params: { relativePath: string }) => { reads.push(params); if (params.relativePath === "npm test") throw new Error("work file refused: not a file"); return { content: "export const a = 1;", truncated: true }; } };
    const slot = renderSlot({ component: () => <TaskBoard projects={[{ id: "proj_a", name: "Alpha" }]} serviceProjectIds={[]} locale="en" AcceptanceCard={AcceptanceCard} /> }, {}, { context: { projectId: null, threadId: null }, rpc: table as never });
    fireEvent.click(await slot.findByTestId("board-card-task:run:w1"));
    await slot.findByTestId("task-card");
    fireEvent.click(await slot.findByText("2 · 1"));
    const star = slot.queryByTestId("work-file-src/**") !== null;
    fireEvent.click(await slot.findByTestId("work-file-src/a.ts"));
    await waitFor(() => expect(textOf(slot.getByTestId("task-files"))).toContain("export const a = 1;"));
    const shown = textOf(slot.getByTestId("task-files").querySelector("pre"));
    fireEvent.click(slot.getByTestId("work-file-npm test"));
    await waitFor(() => expect(textOf(slot.getByTestId("task-files"))).toContain("work file refused: not a file"));
    fireEvent.click(slot.getByTestId("work-file-src/a.ts"));
    await waitFor(() => expect(slot.getByTestId("task-files").querySelector("pre")).toBeNull());
    expect(reads).toEqual([{ runId: "run", relativePath: "src/a.ts", offset: 0 }, { runId: "run", relativePath: "npm test", offset: 0 }]);
    expect(star).toBe(false);
    expect(shown).toBe("export const a = 1; …");
    observe("n916", { reads, starHasButton: star, shown });
  });
});
