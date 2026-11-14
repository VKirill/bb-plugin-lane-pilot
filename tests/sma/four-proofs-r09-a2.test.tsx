/** @vitest-environment jsdom */
// Region 9 · Person and window, batch a (n755 … n784), part 2: money, workers, memory drafts, the task board, the live panel, the window itself.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride, t } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); vi.restoreAllMocks(); });

type Table = Record<string, (params: never) => unknown>;
function recorder(table: Table) {
  const calls: Array<[string, unknown]> = [];
  const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); const handler = table[name]; if (!handler) return Promise.resolve(undefined); try { return Promise.resolve(handler(params as never)); } catch (cause) { return Promise.reject(cause); } } };
  return { rpc, calls, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}
async function mount(component: () => React.ReactElement, table: Table = {}) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: table as never });
}
const button = (slot: ReturnType<typeof renderSlot>, text: string) => slot.getByText(text, { selector: "button" }) as HTMLButtonElement;

describe("region 9 · money and workers", () => {
  it("[sma:d_budget_set] the money cap is saved as the global setting money.monthly_cap_usd with the number the owner typed; a version conflict is retried once on the version the setting has; «unlimited» is kept as the word; a non-number cannot be sent; the month's spend is shown against the cap", async () => {
    const { MoneyScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
    const { GLOBAL_SETTINGS_PROJECT_ID } = await import("@lane-pilot/settings-catalog");
    let conflict = true;
    const r = recorder({
      money_status: () => ({ monthUsd: 12.5, cap: 50, left: 37.5, byProvider: { codex: 12.5 }, table: [] }),
      save_setting: ({ expectedVersion }: { expectedVersion: number }) => (conflict && expectedVersion === 0 ? { ok: false, conflict: true, version: 7 } : { ok: true }),
      cockpit_accounts: () => [],
    });
    const slot = await mount(() => <MoneyScreen rpc={r.rpc as never} hostId={null} />);
    expect((await slot.findByTestId("ck-money")).textContent).toContain("$12.50 / $50");
    const cap = slot.getByLabelText(t("ckMoneyCap")) as HTMLInputElement;
    const save = button(slot, "Save the cap");
    expect(save.disabled).toBe(true);
    fireEvent.change(cap, { target: { value: "abc" } });
    expect(save.disabled).toBe(true);
    fireEvent.change(cap, { target: { value: "75" } });
    fireEvent.click(save);
    await waitFor(() => expect(r.of("save_setting")).toEqual([
      { projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "money.monthly_cap_usd", value: 75, expectedVersion: 0 },
      { projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "money.monthly_cap_usd", value: 75, expectedVersion: 7 },
    ]));
    await waitFor(() => expect(slot.getByText("Sent")).toBeTruthy());
    conflict = false; r.calls.length = 0;
    fireEvent.change(cap, { target: { value: "unlimited" } });
    fireEvent.click(save);
    await waitFor(() => expect(r.of("save_setting")).toEqual([{ projectId: GLOBAL_SETTINGS_PROJECT_ID, key: "money.monthly_cap_usd", value: "unlimited", expectedVersion: 0 }]));
  });

  it("[sma:d_harness] the workers screen shows one card per worker with its model, provider, tokens and what it holds now, a lane table with a mark for every capability each provider supports, and the designer's readiness; with no workers it says so", async () => {
    const { WorkersScreen } = await import("../../src/rooms/cockpit/ui/screens-day");
    const cap = (capability: string, state: string) => ({ capability, state, version: "1" });
    const workers = [
      { providerId: "codex", model: "gpt-6-luna", tokens: 12_345, days: [{ day: "2026-11-11", tokens: 12_345 }], capabilities: [cap("answers", "supported"), cap("pause", "not_supported")], running: 2, runningTasks: ["t1", "t2"], lastAt: Date.UTC(2026, 10, 11, 10, 30) },
      { providerId: "opencode", model: "router9/flash", tokens: 5, days: [], capabilities: [cap("gate", "supported")], running: 0, runningTasks: [], lastAt: null },
    ];
    const r = recorder({ cockpit_workers: () => workers, cockpit_windows: () => ({ at: null, windows: {} }), cockpit_designer: () => ({ readiness: "trained", conditions: [{ id: "c1", ok: true, detail: "50 drawings" }, { id: "c2", ok: false, detail: "no review yet" }], ratios: { accepted: 0.5, flaky: null } }) });
    const slot = await mount(() => <WorkersScreen rpc={r.rpc as never} projectId="p1" hostId={null} />);
    const cards = await slot.findAllByTestId("ck-worker-card");
    expect(cards.map((card) => card.querySelector("p")!.textContent)).toEqual(["gpt-6-luna", "router9/flash"]);
    expect(cards[0]!.textContent).toContain("codex · ");
    expect(cards[0]!.textContent).toContain("12,345");
    expect(cards[0]!.querySelector("[data-testid=ck-worker-presence]")!.textContent).toContain("t1, t2");
    expect(cards[1]!.querySelector("[data-testid=ck-worker-presence]")).toBeNull();
    const rows = Array.from(slot.getByTestId("ck-lanes").querySelectorAll("tbody tr")).map((row) => Array.from(row.querySelectorAll("td")).map((cell) => cell.textContent));
    expect(rows).toEqual([["codex", "✓", "·", "·", "·", "·", "✗", "·", "·", "·"], ["opencode", "·", "·", "·", "·", "·", "·", "·", "·", "✓"]]);
    const designer = (await slot.findByTestId("ck-designer")).textContent!;
    expect(designer).toContain("trained");
    expect(designer).toContain("✓ 50 drawings");
    expect(designer).toContain("✗ no review yet");
    expect(designer).toContain("accepted: 0.5 · flaky: —");
    cleanup();
    const empty = recorder({ cockpit_workers: () => [], cockpit_windows: () => ({ at: null, windows: {} }), cockpit_designer: () => ({ readiness: "none", conditions: [], ratios: {} }) });
    const none = await mount(() => <WorkersScreen rpc={empty.rpc as never} projectId="p1" hostId={null} />);
    await waitFor(() => expect(none.getByTestId("ck-workers").textContent).toContain(t("ckEmpty")));
  });
});

describe("region 9 · memory drafts", () => {
  const proposal = (id: string, state: string, rule: string) => ({ id, rule, author: "sweep", state, occurrences: 3, taskCount: 2, examples: [], evidence: [], lastSeenAt: 1, decidedAt: null, decidedBy: null, trialState: null, revision: 1, retiredReason: null, trial: null, scope: [], scopeLabel: "", audience: "both", always: false });
  const listed = (proposals: unknown[]) => ({ proposals, memory: { enabled: true, inject: true }, triage: { total: 0, byOrigin: {}, errors: 0, lastTriagedAt: null, pendingGroups: 0 }, scan: { state: "idle", startedAt: null, finishedAt: null, triaged: 0, groups: 0, proposals: 0, reason: null }, analyzer: null, events: [] });

  it("[sma:d_mem_drafts] the memory drafts waiting for a person's word are listed as rules waiting for the decision, each with its text editable, and the rules already in force are listed apart; none waiting shows no waiting block", async () => {
    const { RuleProposals } = await import("../../src/rooms/self-repair/ui/rule-proposals");
    const slot = await mount(() => <RuleProposals projectId="p1" />, { list_rule_proposals: () => listed([proposal("r1", "proposed", "Run the lint before every commit."), proposal("r2", "accepted", "Never edit the lockfile by hand."), proposal("r3", "rejected", "Rejected one.")]) });
    const draft = await slot.findByTestId("rule-r1");
    expect((draft.querySelector("textarea") as HTMLTextAreaElement).value).toBe("Run the lint before every commit.");
    expect(slot.getByTestId("rule-proposals").textContent).toContain("Waiting for your decision");
    expect(slot.getByTestId("rule-r2").textContent).toContain("Never edit the lockfile by hand.");
    expect(slot.getByTestId("rule-r2").textContent).not.toContain("Accept");
    expect(slot.queryByTestId("rule-r3")).toBeNull();
    cleanup();
    const quiet = await mount(() => <RuleProposals projectId="p1" />, { list_rule_proposals: () => listed([proposal("r2", "accepted", "Never edit the lockfile by hand.")]) });
    await quiet.findByTestId("rule-r2");
    expect(quiet.getByTestId("rule-proposals").textContent).not.toContain("Waiting for your decision");
  });

  it("[sma:d_mem_apply] «Accept» sends the draft into the corpus with the text the owner left in the box (edited or as proposed) for that draft; it is off for a text too short to be a rule; «Reject» and «Revoke» send their own decision with no text", async () => {
    const { RuleProposals } = await import("../../src/rooms/self-repair/ui/rule-proposals");
    const decisions: unknown[] = [];
    let rows = [proposal("r1", "proposed", "Run the lint before every commit."), proposal("r2", "proposed", "Another draft rule here."), proposal("r9", "accepted", "Old rule in force.")];
    const slot = await mount(() => <RuleProposals projectId="p1" />, { list_rule_proposals: () => listed(rows), decide_rule_proposal: (params: unknown) => { decisions.push(params); return { ok: true }; } });
    const first = await slot.findByTestId("rule-r1");
    const accept = Array.from(first.querySelectorAll("button")).find((node) => node.textContent === "Accept") as HTMLButtonElement;
    fireEvent.change(first.querySelector("textarea")!, { target: { value: "short" } });
    expect(accept.disabled).toBe(true);
    fireEvent.change(first.querySelector("textarea")!, { target: { value: "  Run the lint and the types before every commit.  " } });
    expect(accept.disabled).toBe(false);
    rows = [rows[1]!, rows[2]!];
    fireEvent.click(accept);
    await waitFor(() => expect(decisions).toEqual([{ projectId: "p1", id: "r1", action: "accept", rule: "Run the lint and the types before every commit." }]));
    await waitFor(() => expect(slot.queryByTestId("rule-r1")).toBeNull());
    fireEvent.click(Array.from(slot.getByTestId("rule-r2").querySelectorAll("button")).find((node) => node.textContent === "Reject")!);
    await waitFor(() => expect(decisions[1]).toEqual({ projectId: "p1", id: "r2", action: "reject" }));
    fireEvent.click(button(slot, "Revoke"));
    await waitFor(() => expect(decisions[2]).toEqual({ projectId: "p1", id: "r9", action: "revoke" }));
  });
});
