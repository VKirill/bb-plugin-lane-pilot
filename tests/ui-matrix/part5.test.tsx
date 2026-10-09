/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { fireEvent, waitFor } from "@testing-library/react";
import { mountPage, screenFixture } from "../ui-harness";
import { en, ru, setLocaleOverride } from "@lane-pilot/i18n";
import { openRole, useMatrixHooks } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("Lane Pilot UI", () => {
  useMatrixHooks();

  it("shows localized enum labels and stores the original codes", async () => {
    const saved: Array<{ key:string; value:unknown }> = [];
    // Only the Team tab (the pickers) and the Work tab (the field) are read, so the other four are not warmed up.
    const slot = await mountPage({
      save_setting: (input: unknown) => {
        const row = input as { key:string; value:unknown };
        saved.push(row);
        return { ok:true, conflict:false, version:2, value:row.value };
      },
    }, undefined, "", false);
    openTab(slot, "team");
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    openTab(slot, "work");
    const field = slot.getByTestId("field-s040");
    expect(field.textContent).toContain(en.enumWorkspaceAuto);
    expect(field.textContent).not.toContain("in_place");
    fireEvent.click(slot.getByTestId("help-adoc.040"));
    expect(slot.getByTestId("help-dialog-adoc.040").textContent).toContain(en.workspaceModeHelp);
    expect(slot.getByTestId("help-dialog-adoc.040").textContent).not.toContain("in_place");
    fireEvent.click(field.querySelector("button[role='combobox']") as HTMLButtonElement);
    fireEvent.click(slot.getByRole("option", { name: en.enumWorkspaceWorktree }));
    await waitFor(() => expect(saved).toContainEqual(expect.objectContaining({ key:"adoc.040", value:"worktree" })));
    expect(openRole(slot, "browser_qa").querySelector("[data-testid='browser-qa-host-select']")).toBeTruthy();
    expect(slot.getByTestId("browser-qa-host").textContent).not.toContain(en.browserQaHostNone);
    slot.lifecycle.unmount();
    Object.defineProperty(navigator, "language", { configurable: true, value: "ru-RU" });
    document.documentElement.lang = "ru";
    const ruSlot = await mountPage({}, undefined, "", false);
    openTab(ruSlot, "team");
    await waitFor(() => expect(ruSlot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    openTab(ruSlot, "work");
    expect(ruSlot.getByTestId("field-s040").textContent).toContain(ru.enumWorkspaceAuto);
    expect(ruSlot.getByTestId("field-s040").textContent).not.toContain("in_place");
    ruSlot.lifecycle.unmount();
    document.documentElement.lang = "en";
    setLocaleOverride(null);
  });

  it("lists the runs in progress apart from the history, newest first, and opens the history 20 at a time", async () => {
    const base = screenFixture();
    const run = (id: string, state: string, updated: number) => ({ ...base.runs[0]!, id, state, updated_at: updated, attempts: [], stageCount: 0 });
    base.runs = [run("lprun_old", "closed", 1), ...Array.from({ length: 21 }, (_, i) => run(`lprun_h${i}`, "closed", 100 + i)), run("lprun_live", "running", 2)];
    const slot = await mountPage({ get_screen: () => base });
    openTab(slot, "monitor");
    // Active: only what is in progress; the closed runs wait in the history.
    const active = await slot.findByTestId("run-list");
    expect(Array.from(active.children).map((card) => card.getAttribute("data-testid"))).toEqual(["run-lprun_live"]);
    expect(slot.queryByTestId("runs-show-more")).toBeNull();
    openTab(slot, "monitor", "history");
    const list = await slot.findByTestId("run-list");
    const ids = () => Array.from(list.children).map((card) => card.getAttribute("data-testid"));
    expect(ids()[0]).toBe("run-lprun_h20");
    expect(ids()).not.toContain("run-lprun_live");
    expect(ids()).toHaveLength(20);
    fireEvent.click(slot.getByTestId("runs-show-more"));
    await waitFor(() => expect(ids()).toHaveLength(22));
    expect(ids().at(-1)).toBe("run-lprun_old");
    slot.lifecycle.unmount();
  });

  // One page mount per scenario: five mounts in a single test outran the 5 s budget.
  it.each([
    { runState:"closed", attemptState:"accepted", cancel:false, retry:false },
    { runState:"closed", attemptState:"validation_failed", cancel:false, retry:false },
    { runState:"running", attemptState:"queued", cancel:true, retry:false },
    { runState:"running", attemptState:"running", cancel:true, retry:false },
    { runState:"running", attemptState:"validation_failed", cancel:false, retry:true },
  ])("shows only legal cancel and retry actions (run $runState, attempt $attemptState)", async (scenario) => {
    {
      const base = screenFixture();
      const run = base.runs[0]!;
      run.state = scenario.runState;
      run.attempts[0]!.state = scenario.attemptState;
      (run.attempts[0]! as {thread_id:string|null}).thread_id = scenario.attemptState === "queued" ? null : "thr_writer";
      const slot = await mountPage({ get_screen:() => base });
      // A run in progress is listed under Active, a closed one in the History.
      openTab(slot, "monitor", scenario.runState === "closed" ? "history" : "active");
      const row = await slot.findByTestId("attempt-lpattempt_1");
      const buttons = Array.from(row.querySelectorAll("button")).map((button) => button.textContent);
      expect(buttons.includes(en.cancel)).toBe(scenario.cancel);
      expect(buttons.includes(en.retry)).toBe(scenario.retry);
      slot.lifecycle.unmount();
    }
  });

  it("renders numeric limits instead of sliders and keeps a failed draft", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: false, version: 1, value: 5, validation: {
        code: "invalid_choice", key: "night_review.max_fix_tasks", params: ["night_review.max_fix_tasks", "1-10"],
      } }),
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const field = await slot.findByTestId("night-review-policy").then((panel) => panel.querySelector("[data-testid='field-s006']") as HTMLElement);
    expect(field).toBeTruthy();
    expect(field.querySelector("[role='slider']")).toBeNull();
    const input = field.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.min).toBe("1");
    expect(input.max).toBe("10");
    expect(field.textContent).toContain(en.fieldLimits);
    fireEvent.change(input, { target: { value: "8" } });
    fireEvent.blur(input);
    await slot.findByTestId("setting-validation-error");
    expect((field.querySelector("input[type='number']") as HTMLInputElement).value).toBe("8");
    slot.lifecycle.unmount();
  });

  it("keeps picker keys off the settings list and shows the advanced rows on demand", async () => {
    const slot = await mountPage();
    openTab(slot, "work");
    expect(slot.getByTestId("work-panel").querySelector("[data-testid='field-s004']")).toBeNull();
    expect(slot.getByTestId("settings-execution")).toBeTruthy();
    expect(slot.getByTestId("team-panel").querySelector("[data-testid='browser-qa-host']")).toBeTruthy();
    expect(slot.queryByTestId("settings-search")).toBeNull();
    expect(slot.getByTestId("work-night").hidden).toBe(true);
    openTab(slot, "knowledge", "memory");
    expect(slot.getByTestId("memory-advanced").hidden).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    expect(slot.getByTestId("settings-group-workspace")).toBeTruthy();
    expect(slot.getByTestId("work-night").hidden).toBe(false);
    expect(slot.getByTestId("memory-advanced").hidden).toBe(false);
    expect(slot.getByTestId("memory-advanced").textContent).toContain(en.settingMemoryMaintain);
    expect(slot.getByTestId("memory-advanced").textContent).toContain(en.fieldUnitTokens);
    expect(slot.getByTestId("memory-advanced").textContent).not.toContain("memory.core_budget");
    expect(slot.getByTestId("work-panel").querySelector("[data-testid='settings-group-memory']")).toBeNull();
    slot.lifecycle.unmount();
  });
});
