/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { en, ru, setLocaleOverride } from "@lane-pilot/i18n";
import { mountPage } from "./ui-harness";
import { openTab } from "./ui-tabs";
import { useMatrixHooks } from "./ui-matrix/helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

type Level = { projectId: string; projectName: string | null; sectionId: string | null; sectionName: string | null; keys: string[] };

const LEVELS: Level[] = [
  { projectId: "p1", projectName: "Alpha", sectionId: null, sectionName: null, keys: ["writer.provider", "writer.model", "writer.fallback1.provider"] },
  { projectId: "p1", projectName: "Alpha", sectionId: "s1", sectionName: "Docs", keys: ["docs.provider", "docs.model"] },
  { projectId: "gone", projectName: null, sectionId: null, sectionName: null, keys: ["memory.model"] },
];

/** The two RPCs of the reset on a small in-memory list. */
function overridesRpc(levels: Level[]) {
  const calls: Array<{ method: string; input: unknown }> = [];
  return {
    calls,
    rpc: {
      list_model_overrides: () => { calls.push({ method: "list_model_overrides", input: {} }); return { levels: [...levels] }; },
      reset_model_overrides: (input: unknown) => {
        calls.push({ method: "reset_model_overrides", input });
        levels.splice(0, levels.length);
        return { ok: true, levels: (input as { levels: unknown[] }).levels.length, removed: 6 };
      },
    },
  };
}

async function openGlobalTeam(slot: Awaited<ReturnType<typeof mountPage>>) {
  await slot.findByTestId("status-writer");
  fireEvent.click(slot.getAllByRole("tab", { name: "General settings" })[0]!);
  await waitFor(() => expect(slot.getByTestId("project-settings").querySelector("h1")?.textContent).toBe("General settings"));
  openTab(slot, "team");
  return await slot.findByTestId("model-overrides");
}

describe("giving every project and section the global models back, from the global Team tab", () => {
  useMatrixHooks();

  it("lists the projects and sections that have their own models before anything is reset", async () => {
    const { rpc, calls } = overridesRpc([...LEVELS]);
    const slot = await mountPage(rpc);
    const panel = await openGlobalTeam(slot);
    await waitFor(() => expect(slot.getAllByTestId("model-overrides-level")).toHaveLength(3));
    expect(slot.getByTestId("model-overrides-count").textContent).toBe(en.modelOverridesCount.replace("{places}", "3"));
    expect(slot.getAllByTestId("model-overrides-level").map((row) => row.textContent)).toEqual([
      `Alpha · ${en.modelOverridesWholeProject}${en.modelOverridesSettings.replace("{n}", "3")}`,
      `Alpha · Docs${en.modelOverridesSettings.replace("{n}", "2")}`,
      `gone · ${en.modelOverridesWholeProject}${en.modelOverridesSettings.replace("{n}", "1")}`,
    ]);
    expect(panel.textContent).toContain(en.modelOverridesHelp);
    expect(calls.some((call) => call.method === "reset_model_overrides")).toBe(false);
    slot.lifecycle.unmount();
  });

  it("asks first, shows the same list in the question, and resets exactly the listed places on confirm", async () => {
    const { rpc, calls } = overridesRpc([...LEVELS]);
    const slot = await mountPage(rpc);
    await openGlobalTeam(slot);
    await waitFor(() => expect(slot.getAllByTestId("model-overrides-level")).toHaveLength(3));
    fireEvent.click(slot.getByTestId("model-overrides-reset"));
    const dialog = await waitFor(() => document.querySelector("[data-testid='model-overrides-dialog']") as HTMLElement);
    expect(dialog.textContent).toContain(en.modelOverridesConfirmTitle);
    expect(dialog.querySelectorAll("[data-testid='model-overrides-level']")).toHaveLength(3);
    expect(calls.some((call) => call.method === "reset_model_overrides")).toBe(false);
    // Cancel: nothing is sent.
    fireEvent.click(Array.from(dialog.querySelectorAll("button")).find((button) => button.textContent === en.confirmCancel)!);
    await waitFor(() => expect(document.querySelector("[data-testid='model-overrides-dialog']")).toBeNull());
    expect(calls.some((call) => call.method === "reset_model_overrides")).toBe(false);
    // Confirm: the listed places, and the list is read again.
    fireEvent.click(slot.getByTestId("model-overrides-reset"));
    fireEvent.click(await waitFor(() => document.querySelector("[data-testid='model-overrides-confirm']") as HTMLElement));
    await waitFor(() => expect(calls.filter((call) => call.method === "reset_model_overrides")).toHaveLength(1));
    expect(calls.find((call) => call.method === "reset_model_overrides")!.input).toEqual({ levels: [
      { projectId: "p1", sectionId: null }, { projectId: "p1", sectionId: "s1" }, { projectId: "gone", sectionId: null },
    ] });
    expect((await slot.findByTestId("model-overrides-none")).textContent).toBe(en.modelOverridesNone);
    expect(slot.queryByTestId("model-overrides-reset")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("says so when nobody has their own models", async () => {
    const { rpc } = overridesRpc([]);
    const slot = await mountPage(rpc);
    await openGlobalTeam(slot);
    expect((await slot.findByTestId("model-overrides-none")).textContent).toBe(en.modelOverridesNone);
    expect(slot.queryByTestId("model-overrides-reset")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("is not on a project: there the role rows have their own reset", async () => {
    const { rpc } = overridesRpc([...LEVELS]);
    const slot = await mountPage(rpc);
    await slot.findByTestId("status-writer");
    openTab(slot, "team");
    await slot.findByTestId("team-table");
    expect(slot.queryByTestId("model-overrides")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("speaks Russian", async () => {
    setLocaleOverride("ru");
    const { rpc } = overridesRpc([...LEVELS]);
    const slot = await mountPage({ ...rpc, get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }) });
    await slot.findByTestId("status-writer");
    fireEvent.click(slot.getAllByRole("tab", { name: ru.navGlobals })[0]!);
    await waitFor(() => expect(slot.getByTestId("project-settings").querySelector("h1")?.textContent).toBe(ru.navGlobals));
    openTab(slot, "team");
    await slot.findByTestId("model-overrides");
    await waitFor(() => expect(slot.getByTestId("model-overrides-count").textContent).toBe("Мест со своими моделями: 3"));
    expect(slot.getByTestId("model-overrides-reset").textContent).toBe("Сбросить везде");
    slot.lifecycle.unmount();
  });
});
