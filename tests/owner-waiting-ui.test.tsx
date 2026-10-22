/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { mountPage } from "./ui-harness";

const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); toast.success.mockClear(); toast.error.mockClear(); });

const NOW = 1_800_000_000_000;
const accept = { projectId: "proj_1", id: "r1", action: "accept" };
const waiting = (extra: Record<string, unknown> = {}) => ({
  generatedAt: NOW,
  counts: { deferral_overdue: 1, rule_proposal: 1, deferral_term: 2 },
  overnight: { windowMs: 86_400_000, red: [{ state: "validation_failed", count: 2, attempts: ["lpattempt_1111111122", "lpattempt_3333333344"] }], accepted: 4, rulesAdopted: 1, rulesConfirmed: 0 },
  items: [
    { key: "deferral:dfr_b", source: "deferral_overdue", kind: "deferral_gate", projectId: null, what: "Gate X is put off", why: "The term you gave passed: the drill is red.", since: NOW - 3_600_000, wake: true,
      evidence: [{ kind: "command", ref: "bb lane-pilot deferrals --state overdue", label: "dfr_b" }],
      actions: [{ id: "term", label: "New term (by your message)", needsOwnerMessage: true, cli: "bb lane-pilot defer dfr_b --owner-msg <threadId>#<seq> [--due YYYY-MM-DD]", hint: "Say the date in a message of your own." }] },
    { key: "rule:proj_1:r1", source: "rule_proposal", kind: "rule_proposal", projectId: "proj_1", what: "Never edit lockfiles by hand", why: "A rule that goes into every writer prompt is yours to introduce.", since: NOW, wake: false,
      evidence: [{ kind: "attempt", ref: "att_1", label: "lockfile edited" }],
      actions: [
        { id: "accept", label: "Accept the rule", cli: "echo accept", rpc: { method: "decide_rule_proposal", input: accept } },
        { id: "reject", label: "Reject", cli: "echo reject", rpc: { method: "decide_rule_proposal", input: { ...accept, action: "reject" } } },
      ] },
    { key: "deferral:dfr_a", source: "deferral_term", kind: "deferral_skipped_test", projectId: null, what: "tests/a.test.ts is skipped", why: "No term.", since: NOW, wake: false, evidence: [{ kind: "command", ref: "x" }], actions: [{ id: "term", label: "Set a term", needsOwnerMessage: true, cli: "bb lane-pilot defer dfr_a --owner-msg <threadId>#<seq>" }] },
    { key: "deferral:dfr_c", source: "deferral_term", kind: "deferral_skipped_test", projectId: null, what: "tests/c.test.ts is skipped", why: "No term.", since: NOW, wake: false, evidence: [{ kind: "command", ref: "x" }], actions: [{ id: "term", label: "Set a term", needsOwnerMessage: true, cli: "bb lane-pilot defer dfr_c --owner-msg <threadId>#<seq>" }] },
  ],
  ...extra,
});

async function mount(rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const { OwnerWaitingBoard } = await import("../src/rooms/owner-waiting/ui");
  return renderSlot({ component: () => <OwnerWaitingBoard projects={[{ id: "proj_1", name: "Shop" }]} /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

describe("the «Waiting for you» screen", () => {
  it("shows what, why it is the owner's, evidence and the exact action; a term is a command that needs his message, not a button", async () => {
    const slot = await mount({ owner_waiting: () => waiting(), owner_waiting_config: () => ({ enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" }) });
    await slot.findByTestId("owner-waiting");
    await waitFor(() => expect(slot.getByTestId("owner-count").textContent).toBe("4"));
    const overdue = slot.getByTestId("owner-item-deferral:dfr_b");
    expect(overdue.textContent).toContain("Gate X is put off");
    expect(overdue.textContent).toContain("Why it is yours");
    expect(overdue.textContent).toContain("bb lane-pilot deferrals --state overdue");
    expect(slot.getByTestId("owner-command-deferral:dfr_b-term").textContent).toContain("--owner-msg <threadId>#<seq>");
    expect(slot.getByTestId("owner-command-deferral:dfr_b-term").textContent).toContain("needs a message of your own");
    expect(overdue.querySelector("button[data-testid^='owner-run-']")).toBeNull();
    expect(slot.getByTestId("owner-red").textContent).toContain("validation_failed 2");
    expect(slot.getByTestId("owner-overnight").textContent).toContain("attempt: 11111111");
    expect(slot.getByTestId("owner-accepted").textContent).toContain("Accepted: 4 attempts, rules on trial 1, confirmed 0");
    // Deferrals without a term are folded and counted.
    expect(slot.getByTestId("owner-section-deferral_term").textContent).toContain("Deferrals without a term");
    expect(slot.getByTestId("owner-section-deferral_term").querySelector("details")?.hasAttribute("open")).toBe(false);
    expect(slot.getByTestId("owner-push").textContent).toContain("Telegram");
  });

  it("accepts a rule with the button: the same RPC as the Rules tab, then the list is read again", async () => {
    const decide = vi.fn().mockResolvedValue({ proposal: {} });
    let reads = 0;
    const slot = await mount({ owner_waiting: () => { reads += 1; return waiting(); }, decide_rule_proposal: decide, owner_waiting_config: () => ({ enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" }) });
    fireEvent.click(await slot.findByTestId("owner-run-rule:proj_1:r1-accept"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith(accept));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    await waitFor(() => expect(reads).toBeGreaterThan(1));
    expect(slot.getByTestId("owner-item-rule:proj_1:r1").textContent).toContain("Shop");
  });

  it("says nothing waits when the list is empty, and keeps the overnight lines", async () => {
    const slot = await mount({ owner_waiting: () => waiting({ items: [], counts: {}, overnight: { windowMs: 1, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 } }), owner_waiting_config: () => ({ enabled: false, quiet: "23:00-08:00", timezone: "Europe/Madrid" }) });
    await slot.findByTestId("owner-empty");
    expect(slot.getByTestId("owner-red").textContent).toContain("nothing");
  });
});

describe("the page", () => {
  it("has the screen in the system pages with a count, and opens it", async () => {
    const slot = await mountPage({ list_projects: () => ({ projects: [{ id: "proj_1", name: "Shop" }], lastProjectId: "proj_1" }), owner_waiting: () => waiting(), owner_waiting_config: () => ({ enabled: true, quiet: "23:00-08:00", timezone: "Europe/Madrid" }) });
    const nav = await slot.findByTestId("scope-nav-waiting");
    await waitFor(() => expect(nav.textContent).toContain("4"));
    fireEvent.click(nav);
    await slot.findByTestId("owner-waiting");
  });
});
