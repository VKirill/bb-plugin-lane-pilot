/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { fireEvent, waitFor } from "@testing-library/react";
import { boardFixture, mountPage, screenFixture } from "../ui-harness";
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

  it("the project's board asks the server for this project only and opens a task on its page", async () => {
    const taskBoard = vi.fn((_input: unknown) => boardFixture());
    const slot = await mountPage({ task_board: taskBoard });
    openTab(slot, "runs");
    await slot.findByTestId("task-board");
    await waitFor(() => expect(taskBoard).toHaveBeenCalledWith(expect.objectContaining({ projectId: "proj_ui" })));
    expect(taskBoard.mock.calls.every(([input]) => (input as { projectId?: string }).projectId === "proj_ui")).toBe(true);
    fireEvent.click(await slot.findByTestId("board-card-task:lprun_1:task_1"));
    await slot.findAllByTestId("task-rail");
    expect(slot.getByTestId("stage-receipts-lprun_1").textContent).toContain("(1)");
    slot.lifecycle.unmount();
  });


  it("renders numeric limits instead of sliders and keeps a failed draft", async () => {
    const slot = await mountPage({
      save_setting: () => ({ ok: false, conflict: false, version: 1, value: 5, validation: {
        code: "invalid_choice", key: "code_critique.max_rounds", params: ["code_critique.max_rounds", "1-3"],
      } }),
    });
    await waitFor(() => expect(slot.container.querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const field = await slot.findByTestId("code-critique-policy").then((panel) => panel.querySelector("[data-testid='field-s380']") as HTMLElement);
    expect(field).toBeTruthy();
    expect(field.querySelector("[role='slider']")).toBeNull();
    const input = field.querySelector("input[type='number']") as HTMLInputElement;
    expect(input.min).toBe("1");
    expect(input.max).toBe("3");
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
    expect(slot.getByTestId("work-code").hidden).toBe(true);
    openTab(slot, "knowledge", "memory");
    expect(slot.getByTestId("memory-advanced").hidden).toBe(true);
    fireEvent.click(slot.getByRole("button", { name: en.settingsAdvanced }));
    expect(slot.getByTestId("settings-group-workspace")).toBeTruthy();
    expect(slot.getByTestId("work-code").hidden).toBe(false);
    expect(slot.getByTestId("memory-advanced").hidden).toBe(false);
    expect(slot.getByTestId("memory-advanced").textContent).toContain(en.settingMemoryMaintain);
    expect(slot.getByTestId("memory-advanced").textContent).toContain(en.fieldUnitTokens);
    expect(slot.getByTestId("memory-advanced").textContent).not.toContain("memory.core_budget");
    expect(slot.getByTestId("work-panel").querySelector("[data-testid='settings-group-memory']")).toBeNull();
    slot.lifecycle.unmount();
  });
});
