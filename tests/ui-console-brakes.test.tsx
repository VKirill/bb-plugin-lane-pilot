/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import type { BrakesOutput } from "../src/rooms/contracts/ui";
import { boardFixture, screenFixture } from "./ui-harness";

const toast = vi.hoisted(() => ({ info: vi.fn(), success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.setConfig({ testTimeout: 60_000 });
configure({ asyncUtilTimeout: 10_000 });

const NOW = 1_800_000_000_000;

function brakesFixture(pausedIds: ReadonlyArray<string> = []): BrakesOutput {
  const paused = new Set(pausedIds);
  return {
    brakes: [
      {
        id: "schedules",
        paused: paused.has("schedules"),
        since: paused.has("schedules") ? NOW - 60_000 : null,
        reason: null,
        impact: { label: "active schedules", count: 14 },
      },
      {
        id: "conveyor",
        paused: paused.has("conveyor"),
        since: paused.has("conveyor") ? NOW - 60_000 : null,
        reason: null,
        impact: { label: "queued writer attempts", count: 2 },
      },
      {
        id: "graphs",
        paused: paused.has("graphs"),
        since: paused.has("graphs") ? NOW - 60_000 : null,
        reason: null,
        impact: { label: "triggered workflows", count: 3 },
      },
      {
        id: "staff",
        paused: paused.has("staff"),
        since: paused.has("staff") ? NOW - 60_000 : null,
        reason: null,
        impact: { label: "specialists with active schedules", count: 2 },
      },
    ],
  };
}

function defaultProviders() {
  return {
    status: "ready",
    providers: [{
      id: "codex",
      displayName: "Codex",
      available: true,
      capabilities: {
        modelCatalogScope: "host",
        permissionModes: [],
        supportsFork: false,
        supportsNativeUserQuestion: false,
        supportsServiceTier: true,
        supportsSessionRewind: false,
        supportsThreadArchive: false,
        supportsThreadRename: false,
      },
      serviceTiers: [{ id: "default", label: "Default" }],
    }],
  } as never;
}

async function mountConsole(rpcOverrides: Record<string, (input: unknown) => unknown> = {}, subPath = "") {
  const app = await loadPluginApp(() => import("../app"));
  return renderSlot(app.navPanels[0]!, { subPath }, {
    context: { projectId: null, threadId: null },
    providers: defaultProviders(),
    rpc: {
      get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }),
      set_locale: (input: unknown) => ({
        locale: (input as { locale: string }).locale,
        preference: (input as { locale: string }).locale,
      }),
      remember_project: () => ({ ok: true }),
      list_projects: () => ({ projects: [{ id: "proj_ui", name: "UI test" }], lastProjectId: null }),
      list_sections: () => ({ sections: [] }),
      get_screen: () => ({ ...screenFixture(), projectId: "proj_ui" }),
      console_overview: () => ({
        tz: "Europe/Moscow",
        counts: { active: 0, waiting: 0, closedToday: 0, spendTodayUsd: 0, goalsOnTrack: 0, goalsTotal: 0 },
        active: [],
        closedByDay: [],
        goals: [],
        costCoverage: 1,
      }),
      schedule_calendar: () => ({ planned: [], past: [], truncated: [] }),
      task_board: () => boardFixture(),
      work_graph_strips: () => ({}),
      owner_waiting: () => ({
        generatedAt: NOW,
        now: 0,
        counts: {},
        overnight: { windowMs: 86_400_000, red: [], accepted: 0, rulesAdopted: 0, rulesConfirmed: 0 },
        answered: { owner: 0, agent: 0, lead: 0, janitor: 0 },
        items: [],
      }),
      brakes_get: () => brakesFixture([]),
      ...rpcOverrides,
    } as never,
  });
}

describe("Brakes button and dialog (D1)", () => {
  beforeEach(() => {
    cleanup();
    document.body.innerHTML = "";
    toast.error.mockClear();
  });

  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.restoreAllMocks();
  });

  it("is reachable from every console screen and shows a warn pill only when any brake is paused", async () => {
    const slotNoPaused = await mountConsole({
      brakes_get: () => brakesFixture([]),
    });
    const btnIdle = await slotNoPaused.findByTestId("brakes-button");
    expect(btnIdle.textContent).toContain("Тормоза");
    expect(slotNoPaused.queryByTestId("brakes-paused-pill")).toBeNull();

    // Navigate across console screens and verify the Brakes button stays in headerExtras.
    fireEvent.click(slotNoPaused.getByTestId("console-nav-decisions"));
    await slotNoPaused.findByTestId("console-decisions");
    expect(slotNoPaused.getByTestId("brakes-button")).toBeTruthy();

    fireEvent.click(slotNoPaused.getByTestId("console-nav-work"));
    await slotNoPaused.findByTestId("task-board");
    expect(slotNoPaused.getByTestId("brakes-button")).toBeTruthy();

    fireEvent.click(slotNoPaused.getByTestId("console-nav-system"));
    await slotNoPaused.findByTestId("console-system-hub");
    expect(slotNoPaused.getByTestId("brakes-button")).toBeTruthy();
    slotNoPaused.lifecycle.unmount();

    const slotPaused = await mountConsole({
      brakes_get: () => brakesFixture(["staff"]),
    });
    const pill = await slotPaused.findByTestId("brakes-paused-pill");
    expect(pill.closest("[data-tone='warn']")).not.toBeNull();
    expect(pill.textContent).toContain("1");
    slotPaused.lifecycle.unmount();
  });

  it("pauses directly via brakes_set and requires ConfirmDialog when releasing a paused brake", async () => {
    let state = brakesFixture(["staff"]);
    const brakesSet = vi.fn((input: unknown) => {
      const { id, paused } = input as { id: string; paused: boolean };
      const currentPaused = state.brakes.filter((b) => b.paused).map((b) => b.id);
      const nextPaused = paused
        ? [...new Set([...currentPaused, id])]
        : currentPaused.filter((x) => x !== id);
      state = brakesFixture(nextPaused);
      return state;
    });

    const slot = await mountConsole({
      brakes_get: () => state,
      brakes_set: brakesSet,
    });

    fireEvent.click(await slot.findByTestId("brakes-button"));
    await slot.findByTestId("brakes-dialog");

    expect(slot.getByTestId("brake-impact-schedules").textContent).toContain("затронет 14");
    expect(slot.getByTestId("brake-impact-conveyor").textContent).toContain("затронет 2");

    // Enabling a brake pauses immediately without ConfirmDialog.
    fireEvent.click(slot.getByTestId("brake-switch-schedules"));
    await waitFor(() => expect(brakesSet).toHaveBeenCalledWith({ id: "schedules", paused: true }));

    // Releasing a paused brake opens ConfirmDialog first.
    fireEvent.click(slot.getByTestId("brake-switch-staff"));
    await waitFor(() => {
      const alertDialog = slot.container.ownerDocument.querySelector("[role='alertdialog']");
      expect(alertDialog?.textContent).toContain("Снять тормоз");
    });
    expect(brakesSet).toHaveBeenCalledTimes(1);

    const releaseBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Снять тормоз");
    expect(releaseBtn).toBeTruthy();
    fireEvent.click(releaseBtn!);

    await waitFor(() => expect(brakesSet).toHaveBeenCalledWith({ id: "staff", paused: false }));
    await slot.findByTestId("brakes-dialog");
    slot.lifecycle.unmount();
  });

  it("disables «Остановить всех» until СТОП is typed, validates reason, calls stop_all with reason, logs, and lists halted & failed runs", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    let state = brakesFixture([]);
    const stopAll = vi.fn((input: unknown) => {
      const { reason } = input as { reason: string };
      expect(reason).toBe("Аварийная остановка деплоя");
      state = brakesFixture(["schedules", "conveyor", "graphs", "staff"]);
      return {
        brakes: state.brakes,
        halted: [
          { runId: "run_101", ok: true },
          { runId: "run_102", ok: false },
        ],
      };
    });

    const slot = await mountConsole({
      brakes_get: () => state,
      stop_all: stopAll,
    });

    fireEvent.click(await slot.findByTestId("brakes-button"));
    fireEvent.click(await slot.findByTestId("brakes-stop-all"));

    const confirmInput = slot.container.ownerDocument.querySelector<HTMLInputElement>("input[aria-label='СТОП']");
    expect(confirmInput).toBeTruthy();
    const confirmBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Остановить всех") as HTMLButtonElement | undefined;
    expect(confirmBtn).toBeTruthy();
    expect(confirmBtn!.disabled).toBe(true);

    // Partial match keeps button disabled.
    fireEvent.change(confirmInput!, { target: { value: "СТО" } });
    expect(confirmBtn!.disabled).toBe(true);

    // Typing exact "СТОП" enables the button, but short reason triggers validation error without calling stop_all.
    fireEvent.change(confirmInput!, { target: { value: "СТОП" } });
    expect(confirmBtn!.disabled).toBe(false);
    const reasonInput = slot.container.ownerDocument.querySelector<HTMLInputElement>("[data-testid='brakes-stop-all-reason']");
    expect(reasonInput).toBeTruthy();
    fireEvent.change(reasonInput!, { target: { value: "ок" } });
    fireEvent.click(confirmBtn!);

    await waitFor(() => {
      const alert = slot.container.ownerDocument.querySelector("[role='alertdialog'] [role='alert']");
      expect(alert?.textContent).toContain("от 3 до 300");
    });
    expect(stopAll).not.toHaveBeenCalled();

    // Valid reason calls stop_all, logs result, and displays halted and failed runs.
    fireEvent.change(reasonInput!, { target: { value: "  Аварийная остановка деплоя  " } });
    fireEvent.click(confirmBtn!);

    await waitFor(() => expect(stopAll).toHaveBeenCalledWith({ reason: "Аварийная остановка деплоя" }));
    expect(infoSpy).toHaveBeenCalledWith("[lane-pilot:brakes] stop_all", {
      halted: ["run_101"],
      failed: ["run_102"],
    });

    const resultBox = await slot.findByTestId("brakes-stop-all-result");
    expect(resultBox.textContent).toContain("run_101");
    expect(resultBox.textContent).toContain("run_102");
    expect(slot.getByTestId("brakes-halted-list").textContent).toContain("run_101");
    expect(slot.getByTestId("brakes-failed-list").textContent).toContain("run_102");
    slot.lifecycle.unmount();
  });

  it("displays server error text if brakes_set or stop_all fails", async () => {
    const slot = await mountConsole({
      brakes_get: () => brakesFixture([]),
      brakes_set: () => {
        throw new Error("Brakes store locked by maintenance");
      },
      stop_all: () => {
        throw new Error("Hub unreachable during stop_all");
      },
    });

    fireEvent.click(await slot.findByTestId("brakes-button"));
    fireEvent.click(await slot.findByTestId("brake-switch-schedules"));

    const errorEl = await slot.findByTestId("brakes-error");
    expect(errorEl.textContent).toContain("Brakes store locked by maintenance");

    fireEvent.click(slot.getByTestId("brakes-stop-all"));
    const confirmInput = slot.container.ownerDocument.querySelector<HTMLInputElement>("input[aria-label='СТОП']");
    const reasonInput = slot.container.ownerDocument.querySelector<HTMLInputElement>("[data-testid='brakes-stop-all-reason']");
    fireEvent.change(confirmInput!, { target: { value: "СТОП" } });
    fireEvent.change(reasonInput!, { target: { value: "Проверка ошибки" } });

    const confirmBtn = Array.from(slot.container.ownerDocument.querySelectorAll("[role='alertdialog'] button"))
      .find((btn) => btn.textContent === "Остановить всех") as HTMLButtonElement;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const alert = slot.container.ownerDocument.querySelector("[role='alertdialog'] [role='alert']");
      expect(alert?.textContent).toContain("Hub unreachable during stop_all");
    });
    slot.lifecycle.unmount();
  });
});
