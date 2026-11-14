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
