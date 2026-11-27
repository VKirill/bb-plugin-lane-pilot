/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor, within } from "@testing-library/react";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import type { DocsProject, ManualModeOutput } from "../src/rooms/contracts/ui";
import { AutomationScreen } from "../src/rooms/pages/ui/screens/automation-screen";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 10_000 });

const NOW = 1_800_000_000_000;

function manualFixture(on: boolean, reason: string | null = "manual mode"): ManualModeOutput {
  return {
    on,
    since: NOW - 60_000,
    reason,
    brakes: [
      { id: "schedules", paused: on, since: on ? NOW - 60_000 : null, reason, impact: { label: "active schedules", count: 4 } },
      { id: "conveyor", paused: on, since: on ? NOW - 60_000 : null, reason, impact: { label: "queued writer attempts", count: 2 } },
      { id: "graphs", paused: on, since: on ? NOW - 60_000 : null, reason, impact: { label: "triggered workflows", count: 3 } },
      { id: "staff", paused: on, since: on ? NOW - 60_000 : null, reason, impact: { label: "specialists with active schedules", count: 1 } },
    ],
  };
}

describe("AutomationScreen (System -> Automation)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    setLocaleOverride("ru");
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
  });

  it("renders manual mode, read-only brakes, and docs projects; confirms manual off and toggles docs_set", async () => {
    let manualState = manualFixture(true, "включён при старте");
    let projects: DocsProject[] = [
      { projectId: "proj-a", name: "Alpha", on: false },
      { projectId: "proj-b", name: "Beta", on: true },
    ];
    const manualCalls: Array<{ on: boolean; reason?: string }> = [];
    const docsCalls: Array<{ projectId: string; on: boolean }> = [];

    const slot = renderSlot(
      { component: () => <AutomationScreen locale="ru" /> },
      {},
      {
        context: { projectId: null, threadId: null },
        rpc: {
          manual_mode_get: () => manualState,
          manual_mode_set: (input: unknown) => {
            const payload = input as { on: boolean; reason?: string };
            manualCalls.push(payload);
            manualState = manualFixture(payload.on, payload.on ? "owner" : null);
            return manualState;
          },
          docs_projects: () => ({ projects }),
          docs_set: (input: unknown) => {
            const payload = input as { projectId: string; on: boolean };
            docsCalls.push(payload);
            projects = projects.map((p) => (p.projectId === payload.projectId ? { ...p, on: payload.on } : p));
            return projects.find((p) => p.projectId === payload.projectId)!;
          },
        },
      },
    );

    await slot.findByTestId("automation-screen");
    await slot.findByTestId("automation-manual-switch");
    await slot.findByTestId("automation-docs-list");

    // Shows metadata and all four brakes read-only without brake switches.
    expect(slot.getByTestId("automation-manual-meta").textContent).toContain("включён при старте");
    const brakesSection = slot.getByTestId("automation-brakes");
    expect(within(brakesSection).queryByRole("switch")).toBeNull();
    expect(slot.getByTestId("automation-brake-schedules").textContent).toContain("На паузе");
    expect(slot.getByTestId("automation-brake-conveyor").textContent).toContain("На паузе");
    expect(slot.getByTestId("automation-brake-graphs").textContent).toContain("На паузе");
    expect(slot.getByTestId("automation-brake-staff").textContent).toContain("На паузе");

    // Projects list renders both rows; toggling Alpha calls docs_set({ projectId: "proj-a", on: true }).
    expect(slot.getByTestId("automation-docs-row-proj-a").textContent).toContain("Alpha");
    expect(slot.getByTestId("automation-docs-row-proj-b").textContent).toContain("Beta");
    const alphaSwitch = slot.getByTestId("automation-docs-switch-proj-a");
    expect(alphaSwitch.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(alphaSwitch);
    await waitFor(() => expect(docsCalls).toEqual([{ projectId: "proj-a", on: true }]));
    await waitFor(() => expect(slot.getByTestId("automation-docs-switch-proj-a").getAttribute("aria-checked")).toBe("true"));

    // Turning manual mode OFF opens ConfirmDialog first without calling manual_mode_set yet.
    fireEvent.click(slot.getByTestId("automation-manual-switch"));
    expect(manualCalls).toEqual([]);
    const dialog = await waitFor(() => {
      const el = document.querySelector("[role='alertdialog']");
      if (!el) throw new Error("ConfirmDialog not open");
      return el as HTMLElement;
    });
    expect(dialog.textContent).toContain("запустить один раз при пропуске");
    expect(dialog.textContent).toContain("писатели в очереди");
    expect(dialog.textContent).toContain("графы по событиям");
    expect(dialog.textContent).toContain("дозапуск при старте");

    // Confirming calls manual_mode_set({ on: false }).
    fireEvent.click(within(dialog).getByRole("button", { name: "Выключить ручной режим" }));
    await waitFor(() => expect(manualCalls).toEqual([{ on: false }]));
    await waitFor(() => expect(slot.getByTestId("automation-manual-switch").getAttribute("aria-checked")).toBe("false"));
    expect(slot.getByTestId("automation-brake-schedules").textContent).toContain("Открыт");

    // Turning manual mode back ON does not need ConfirmDialog.
    fireEvent.click(slot.getByTestId("automation-manual-switch"));
    await waitFor(() => expect(manualCalls).toEqual([{ on: false }, { on: true }]));
    expect(document.querySelector("[role='alertdialog']")).toBeNull();

    slot.lifecycle.unmount();
  });
});
