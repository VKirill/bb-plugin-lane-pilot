/** @vitest-environment jsdom */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { en, ru } from "@lane-pilot/i18n";
import { ROLE_MODEL_OPTIONS, ROLE_TABLE, roleDefaultModel, roleModelKey } from "@lane-pilot/models";
import { mountPage } from "./ui-harness";
import { openTab } from "./ui-tabs";
import { useMatrixHooks } from "./ui-matrix/helpers";
import React from "react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { choosePickerValue, scopedPicker, type PickerNode, type PickerValue } from "./ui-settings-integration/helpers";

/** BB's window as a test driver, put on the shared test SDK itself: `loadPluginApp` (mountPage) swaps the runtime's SDK object back, not its fields. */
function installPickerTestDriver() {
  installTestPluginRuntime();
  const sdk = (globalThis as typeof globalThis & { __bbPluginRuntime: { pluginSdkApp: Record<string, unknown> } }).__bbPluginRuntime.pluginSdkApp;
  sdk.experimental_ProviderModelPicker = (props: { value: PickerValue; onChange: (next: PickerValue) => void }) => React.createElement("div", {
    "data-testid": "bb-provider-model-picker", "data-provider": props.value.providerId, "data-model": props.value.model, "data-effort": props.value.reasoningLevel,
    ref: (node: PickerNode | null) => { if (node) { node.__pickerValue = props.value; node.__pickerOnChange = props.onChange; } },
  });
}

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

type PoolEntry = { providerId: string; model: string; effort: string | null };
type Row = { role: string; providerId: string; model: string; effort: string; source: "table" | "stage" | "default"; sourceKey: string | null; own: boolean; version: number; defaultModel: string; defaultEffort: string; offered: boolean | null; pool: PoolEntry[] };

/** The table as the server reads it for a place: every role on its default, except what the test changes. */
function view(changes: Record<string, Partial<Row>> = {}) {
  const roles: Row[] = ROLE_TABLE.map((row) => {
    const builtin = roleDefaultModel(row.id);
    return { role: row.id, providerId: builtin.providerId, model: builtin.model, effort: builtin.effort, source: "default", sourceKey: null, own: false, version: 0, defaultModel: builtin.model, defaultEffort: builtin.effort, offered: true, pool: [], ...changes[row.id] };
  });
  return { roles, options: ROLE_MODEL_OPTIONS.map((option) => ({ id: option.id, providerId: option.providerId, label: option.label, family: option.family, offered: true, efforts: ["low", "medium", "high"] })) };
}

/** What BB's own window lists: any provider, not only the table's (Grok on Cursor here). */
const catalog = {
  hosts: [{ id: "mini", name: "Mac mini", connected: true }],
  providers: [
    { id: "claude-code", displayName: "Claude Code", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mini"], models: [
      { id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "high", isDefault: true, hostIds: ["mini"] },
      { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: false, hostIds: ["mini"] }] },
    { id: "acp-cursor", displayName: "Cursor", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mini"], models: [
      { id: "grok-4.6", model: "grok-4.6", displayName: "Grok 4.6", efforts: ["medium", "high"], defaultEffort: "medium", isDefault: true, hostIds: ["mini"] }] },
  ],
  runHostId: "mini",
};

function tableRpc(initial: ReturnType<typeof view>) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let current = initial;
  return {
    calls,
    set: (next: ReturnType<typeof view>) => { current = next; },
    rpc: {
      get_role_models: (input: unknown) => { calls.push({ method: "get_role_models", input: input as Record<string, unknown> }); return current; },
      workflow_model_catalog: () => catalog,
      save_setting: (input: unknown) => { calls.push({ method: "save_setting", input: input as Record<string, unknown> }); return { ok: true, conflict: false, version: 1, value: (input as { value: unknown }).value }; },
      reset_project_settings: (input: unknown) => { calls.push({ method: "reset_project_settings", input: input as Record<string, unknown> }); return { ok: true, conflict: false, values: {}, versions: {} }; },
    },
  };
}

async function openTeam(slot: Awaited<ReturnType<typeof mountPage>>) {
  await slot.findByTestId("status-writer");
  openTab(slot, "team");
  return await slot.findByTestId("role-models");
}
const picker = async (slot: Awaited<ReturnType<typeof mountPage>>, testId: string) => {
  await waitFor(() => expect(scopedPicker(slot, testId)).toBeTruthy());
  return scopedPicker(slot, testId);
};
const saves = (calls: Array<{ method: string; input: Record<string, unknown> }>) => calls.filter((call) => call.method === "save_setting");

describe("the table «role -> model» on the Team tab", () => {
  useMatrixHooks();

  it("shows every role once in BB's own model window, with where its model comes from and why", async () => {
    installPickerTestDriver();
    const { rpc, calls } = tableRpc(view({ "plan-critic": { source: "stage", sourceKey: "plan_critique.model", model: "gpt-6.1-terra", providerId: "codex", effort: "medium" }, analyst: { source: "table", own: true, version: 3, model: "claude-sonnet-5-5", effort: "low", sourceKey: "role_model.analyst" } }));
    const slot = await mountPage(rpc);
    const panel = await openTeam(slot);
    await waitFor(() => expect(panel.querySelectorAll("li[data-testid^='role-model-']")).toHaveLength(ROLE_TABLE.length));
    expect(calls[0]).toEqual({ method: "get_role_models", input: { projectId: "proj_ui" } });
    expect(panel.textContent).toContain(en.roleModelsHelp);
    const analyst = await picker(slot, "role-model-pick-analyst");
    expect(analyst.getAttribute("data-model")).toBe("claude-sonnet-5-5");
    expect(analyst.getAttribute("data-effort")).toBe("low");
    expect(slot.getByTestId("role-model-source-analyst").textContent).toBe(en.roleModelsSource_table);
    expect(slot.getByTestId("role-model-source-plan-critic").textContent).toBe(en.roleModelsSource_stage.replace("{key}", "plan_critique.model"));
    expect(slot.getByTestId("role-model-code-critic").textContent).toContain(en.roleModelWhy_code_critic);
    slot.lifecycle.unmount();
  });

  it("the roster above names what a role runs on instead of a dash: the table's row with its pool, or the task writer's model", async () => {
    installPickerTestDriver();
    const { rpc, calls } = tableRpc(view({ analyst: { source: "table", own: true, version: 1, model: "claude-opus-5-5", effort: "high", sourceKey: "role_model.analyst", pool: [{ providerId: "codex", model: "gpt-6.1-sol", effort: null }] } }));
    const slot = await mountPage(rpc);
    await openTeam(slot);
    const analyst = await picker(slot, "team-model-analyst");
    expect(analyst.getAttribute("data-model")).toBe("claude-opus-5-5");
    expect(slot.getByTestId("team-model-analyst").textContent).toContain("+1");
    expect(slot.getByTestId("team-model-code-repair").textContent).toBe(en.teamModelAsWriter);
    // A choice in the roster's window goes into the role's row of the table, its pool kept.
    await choosePickerValue({ providerId: "acp-cursor", model: "grok-4.6", reasoningLevel: "medium" }, analyst);
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0]!.input).toMatchObject({ key: roleModelKey("analyst"), expectedVersion: 1,
      value: { provider: "acp-cursor", model: "grok-4.6", reasoning_effort: "medium", pool: [{ provider: "codex", model: "gpt-6.1-sol" }] } });
    slot.lifecycle.unmount();
  });

  it("warns about a light model for a role that judges", async () => {
    installPickerTestDriver();
    const { rpc } = tableRpc(view({ planner: { source: "table", own: true, model: "claude-haiku-5-5", effort: "high", sourceKey: "role_model.planner" } }));
    const slot = await mountPage(rpc);
    await openTeam(slot);
    expect((await slot.findByTestId("role-model-light-planner")).textContent).toBe(en.roleModelsLight);
    expect(slot.queryByTestId("role-model-light-analyst")).toBeNull();
    slot.lifecycle.unmount();
  });

  it("saves any provider's model the window answers as role_model.<role> with its provider, at the place shown, with its version", async () => {
    installPickerTestDriver();
    const { rpc, calls } = tableRpc(view({ debugger: { version: 4 } }));
    const slot = await mountPage(rpc);
    await openTeam(slot);
    await choosePickerValue({ providerId: "acp-cursor", model: "grok-4.6", reasoningLevel: "high" }, await picker(slot, "role-model-pick-debugger"));
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0]!.input).toEqual({ projectId: "proj_ui", key: roleModelKey("debugger"), value: { provider: "acp-cursor", model: "grok-4.6", reasoning_effort: "high" }, expectedVersion: 4 });
    slot.lifecycle.unmount();
  });

  it("a row's pool: shown, a model added through the same window, kept when the model changes, taken out with ×", async () => {
    installPickerTestDriver();
    const pooled = { source: "table" as const, own: true, version: 3, model: "claude-sonnet-5-5", effort: "medium", sourceKey: "role_model.errand", pool: [{ providerId: "codex", model: "gpt-6.1-terra", effort: null }] };
    const { rpc, calls } = tableRpc(view({ errand: pooled }));
    const slot = await mountPage(rpc);
    await openTeam(slot);
    expect((await slot.findByTestId("role-model-pool-errand")).textContent).toContain("gpt-6.1-terra");
    fireEvent.click(slot.getByTestId("role-model-pool-add-errand"));
    await choosePickerValue({ providerId: "acp-cursor", model: "grok-4.6", reasoningLevel: "medium" }, await picker(slot, "role-model-pool-picker-errand"));
    await waitFor(() => expect(saves(calls)).toHaveLength(1));
    expect(saves(calls)[0]!.input).toMatchObject({ value: { provider: "claude-code", model: "claude-sonnet-5-5", reasoning_effort: "medium",
      pool: [{ provider: "codex", model: "gpt-6.1-terra" }, { provider: "acp-cursor", model: "grok-4.6", reasoning_effort: "medium" }] } });
    await choosePickerValue({ providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high" }, await picker(slot, "role-model-pick-errand"));
    await waitFor(() => expect(saves(calls)).toHaveLength(2));
    expect(saves(calls)[1]!.input).toMatchObject({ value: { model: "claude-opus-5-5", pool: [{ provider: "codex", model: "gpt-6.1-terra" }] } });
    fireEvent.click(slot.getByTestId("role-model-pool-remove-errand-gpt-6.1-terra"));
    await waitFor(() => expect(saves(calls)).toHaveLength(3));
    expect(saves(calls)[2]!.input).toEqual(expect.objectContaining({ value: { provider: "claude-code", model: "claude-sonnet-5-5", reasoning_effort: "medium" } }));
    slot.lifecycle.unmount();
  });

  it("«Default» drops the row of this place (the level below shows through) and only a row of this place has the button", async () => {
    installPickerTestDriver();
    const { rpc, calls } = tableRpc(view({ memory: { source: "table", own: true, version: 2, model: "gpt-6-luna", providerId: "codex", effort: "low", sourceKey: "role_model.memory" } }));
    const slot = await mountPage(rpc);
    await openTeam(slot);
    expect(slot.queryByTestId("role-model-reset-analyst")).toBeNull();
    fireEvent.click(await slot.findByTestId("role-model-reset-memory"));
    await waitFor(() => expect(calls.filter((call) => call.method === "reset_project_settings")).toHaveLength(1));
    expect(calls.find((call) => call.method === "reset_project_settings")!.input).toEqual({ projectId: "proj_ui", keys: [roleModelKey("memory")], expectedVersions: { [roleModelKey("memory")]: 2 } });
    slot.lifecycle.unmount();
  });

  it("says why a save was refused", async () => {
    installPickerTestDriver();
    const { rpc } = tableRpc(view());
    const refused = { ...rpc, save_setting: () => ({ ok: false, conflict: false, version: 0, value: null, validation: { code: "invalid_choice", key: roleModelKey("analyst"), params: [roleModelKey("analyst"), "model: one of nothing"] } }) };
    const slot = await mountPage(refused);
    await openTeam(slot);
    await choosePickerValue({ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "medium" }, await picker(slot, "role-model-pick-analyst"));
    expect((await slot.findByTestId("role-models-error")).textContent).toBe(en.roleModelsSaveFailed.replace("{error}", "model: one of nothing"));
    slot.lifecycle.unmount();
  });

  it("reads in Russian with the word «граф» and no «воркфлоу» or «цепочка»", async () => {
    installPickerTestDriver();
    const { rpc } = tableRpc(view());
    const slot = await mountPage({ ...rpc, get_preferences: () => ({ locale: "ru", preference: "ru", lastProjectId: null }) });
    const panel = await openTeam(slot);
    await waitFor(() => expect(panel.textContent).toContain(ru.roleModelsTitle));
    expect(panel.textContent).toContain("в каждом графе");
    expect(panel.textContent).not.toMatch(/воркфлоу|цепочк/i);
    for (const key of Object.keys(ru).filter((name) => name.startsWith("roleModels") || name.startsWith("roleModelName_") || name.startsWith("roleModelWhy_"))) {
      expect((ru as Record<string, string>)[key], key).not.toMatch(/воркфлоу|цепочк/i);
    }
    slot.lifecycle.unmount();
  });
});

describe("the strings of the table", () => {
  it("name every role in both languages", () => {
    for (const row of ROLE_TABLE) {
      for (const dictionary of [en, ru] as Array<Record<string, string>>) {
        expect(dictionary[`roleModelName_${row.id.replace(/-/g, "_")}`], row.id).toBeTruthy();
        expect(dictionary[`roleModelWhy_${row.id.replace(/-/g, "_")}`], row.id).toBeTruthy();
      }
    }
  });
});
