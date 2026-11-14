/** @vitest-environment jsdom */
// Region 0 (Phase graph), batch d, the screen: the phase card at acceptance (n107) rendered for real in jsdom. The person sees every acceptance line with what it saw, the package
// he decides on (its key, the frozen verdict, the diff of the work) and how the phase ends; what he presses goes out with the package key.
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride, t } from "@lane-pilot/i18n";

configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 30_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); vi.useRealTimers(); vi.restoreAllMocks(); });

type Table = Record<string, (params: never) => unknown>;
function recorder(table: Table) {
  const calls: Array<[string, unknown]> = [];
  const rpc = { call: (name: string, params: unknown) => { calls.push([name, params]); const handler = table[name]; return Promise.resolve(handler ? handler(params as never) : undefined); } };
  return { rpc: rpc as never, of: (name: string) => calls.filter(([method]) => method === name).map(([, params]) => params) };
}
async function mount(component: () => React.ReactElement) {
  await loadPluginApp(() => import("../../app"));
  return renderSlot({ component }, {}, { context: { projectId: null, threadId: null }, rpc: {} as never });
}
const button = (view: { getByText: (text: string, options: { selector: string }) => HTMLElement }, text: string) => view.getByText(text, { selector: "button" }) as HTMLButtonElement;

describe("region 0 · the phase card at acceptance", () => {
  const lines = [
    { id: "contract_current", ok: true, detail: "the plan is the admitted one" },
    { id: "checks_passed", ok: false, detail: "checks failed: b" },
    { id: "limits_acknowledged", ok: false, detail: "awaits the owner's keyed decision" },
  ];
  const status = {
    phase: { id: "ph1", title: "Footer", goal: "Ship the footer", stage: "acceptance", state: "active", record: { ownerWords: true, acceptance: { lines, at: 1, accepted: false },
      observation: { outcome: "failure", reverted: ["a (task a, reverted in cafe01)"], until: Date.UTC(2026, 10, 20) } } },
    withdrawable: [], next: { text: "Waiting", key: "ph1:word:acceptance" }, ownerWord: {}, gates: {}, book: "", facts: {},
    acceptancePackage: { key: "pk-77", verdict: { state: "passed", detail: "every piece accepted and proved", mainSha: "b".repeat(40) }, diffStat: " src/a.ts | 2 +-\n 1 file changed" },
  };

  it("[sma:p6_view] shows every acceptance line with what it saw, the package (key, verdict with its tree, the diff) and the watch; the yes carries the package key and waits for both decisions", async () => {
    const { PhasesScreen } = await import("../../src/rooms/cockpit/ui/screens-work");
    const r = recorder({ phase_list: () => [{ id: "ph1", title: "Footer", goal: "g", stage: "acceptance", state: "active" }], phase_get: () => status, phase_files: () => ({ files: [] }), phase_control: () => ({}), phase_act: () => ({}) });
    const slot = await mount(() => <PhasesScreen rpc={r.rpc} projectId="p1" />);
    fireEvent.click(await slot.findByTestId("ck-phase-ph1").then((row) => row.querySelector("button")!));
    await slot.findByTestId("ck-phase-card");
    const rows = Array.from(slot.getByTestId("ck-acceptance").querySelectorAll("li")).map((row) => row.textContent);
    expect(rows).toEqual(["✓ contract_current: the plan is the admitted one", "✗ checks_passed: checks failed: b", "✗ limits_acknowledged: awaits the owner's keyed decision"]);
    expect(slot.getByTestId("ck-package-key").textContent).toBe("package pk-77");
    const box = slot.getByTestId("ck-acceptance-package").textContent!;
    expect(box).toContain(`passed: every piece accepted and proved (${"b".repeat(12)})`);
    expect(box).toContain("src/a.ts | 2 +-");
    expect(slot.getByTestId("ck-observation").textContent).toContain("a (task a, reverted in cafe01)");
    const yes = button(slot, t("ckYes"));
    expect(yes.disabled).toBe(true);
    fireEvent.click(slot.getByTestId("ck-useful"));
    fireEvent.click(slot.getByTestId("ck-limits"));
    expect(yes.disabled).toBe(false);
    fireEvent.click(yes);
    await waitFor(() => expect(r.of("phase_control")).toEqual([{ phaseId: "ph1", action: "word", turn: "acceptance", decision: "yes", note: "да", useful: true, limits: true, key: "pk-77" }]));
  });
});
