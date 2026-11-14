/** @vitest-environment jsdom */
// Region 9 · Person and window, batch e: the Team page mounted whole (the heavy page tests of this region; the file runs alone, see vitest.config.ts).
// A model chosen in BB's own window for one worker goes into that worker's row of the table, with its provider, effort and the rest of its pool.
import { describe, expect, it } from "vitest";
import React from "react";
import { waitFor } from "@testing-library/react";
import { installTestPluginRuntime } from "@get-bb/plugin-sdk/testing/app";
import { ROLE_MODEL_OPTIONS, ROLE_TABLE, roleDefaultModel, roleModelKey } from "@lane-pilot/models";
import { mountPage } from "../ui-harness";
import { openTab } from "../ui-tabs";
import { useMatrixHooks } from "../ui-matrix/helpers";
import { choosePickerValue, scopedPicker, type PickerNode, type PickerValue } from "../ui-settings-integration/helpers";
import { observe } from "./r09-world-e";

function installPickerTestDriver() {
  installTestPluginRuntime();
  const sdk = (globalThis as typeof globalThis & { __bbPluginRuntime: { pluginSdkApp: Record<string, unknown> } }).__bbPluginRuntime.pluginSdkApp;
  sdk.experimental_ProviderModelPicker = (props: { value: PickerValue; onChange: (next: PickerValue) => void }) => React.createElement("div", {
    "data-testid": "bb-provider-model-picker", "data-provider": props.value.providerId, "data-model": props.value.model, "data-effort": props.value.reasoningLevel,
    ref: (node: PickerNode | null) => { if (node) { node.__pickerValue = props.value; node.__pickerOnChange = props.onChange; } },
  });
}

type Row = { role: string; providerId: string; model: string; effort: string; source: "table" | "stage" | "default"; sourceKey: string | null; own: boolean; version: number; defaultModel: string; defaultEffort: string; offered: boolean | null; pool: Array<{ providerId: string; model: string; effort: string | null }> };
function view(changes: Record<string, Partial<Row>> = {}) {
  const roles: Row[] = ROLE_TABLE.map((row) => {
    const builtin = roleDefaultModel(row.id);
    return { role: row.id, providerId: builtin.providerId, model: builtin.model, effort: builtin.effort, source: "default", sourceKey: null, own: false, version: 0, defaultModel: builtin.model, defaultEffort: builtin.effort, offered: true, pool: [], ...changes[row.id] };
  });
  return { roles, options: ROLE_MODEL_OPTIONS.map((option) => ({ id: option.id, providerId: option.providerId, label: option.label, family: option.family, offered: true, efforts: ["low", "medium", "high"] })) };
}
const catalog = {
  hosts: [{ id: "mini", name: "Mac mini", connected: true }],
  providers: [{ id: "acp-cursor", displayName: "Cursor", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mini"], models: [
    { id: "grok-4.6", model: "grok-4.6", displayName: "Grok 4.6", efforts: ["medium", "high"], defaultEffort: "medium", isDefault: true, hostIds: ["mini"] }] }],
  runHostId: "mini",
};

describe("region 9 · a worker's model", () => {
  useMatrixHooks();

  it("[sma:m_sw_model_dialog] the model and effort chosen for one worker in BB's own window are saved into that worker's row of the table at the place shown, with the version read and the rest of its pool kept; the roster shows the writer's model for the roles that run on it", async () => {
    installPickerTestDriver();
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    const table = view({ analyst: { source: "table", own: true, version: 3, model: "claude-opus-5-5", effort: "high", sourceKey: "role_model.analyst", pool: [{ providerId: "codex", model: "gpt-6.1-sol", effort: null }] } });
    const slot = await mountPage({
      get_role_models: (input: unknown) => { calls.push({ method: "get_role_models", input: input as Record<string, unknown> }); return table; },
      workflow_model_catalog: () => catalog,
      save_setting: (input: unknown) => { calls.push({ method: "save_setting", input: input as Record<string, unknown> }); return { ok: true, conflict: false, version: 4, value: (input as { value: unknown }).value }; },
    });
    await slot.findByTestId("status-writer");
    openTab(slot, "team");
    await waitFor(() => expect(scopedPicker(slot, "team-model-analyst")).toBeTruthy());
    const analyst = scopedPicker(slot, "team-model-analyst");
    const before = { provider: analyst.getAttribute("data-provider"), model: analyst.getAttribute("data-model"), effort: analyst.getAttribute("data-effort") };
    expect(before).toEqual({ provider: "claude-code", model: "claude-opus-5-5", effort: "high" });
    const asWriter = slot.getByTestId("team-model-code-repair").textContent;
    await choosePickerValue({ providerId: "acp-cursor", model: "grok-4.6", reasoningLevel: "medium" }, analyst);
    await waitFor(() => expect(calls.filter((call) => call.method === "save_setting")).toHaveLength(1));
    const saved = calls.find((call) => call.method === "save_setting")!.input;
    expect(saved).toEqual({ projectId: "proj_ui", key: roleModelKey("analyst"), expectedVersion: 3, value: { provider: "acp-cursor", model: "grok-4.6", reasoning_effort: "medium", pool: [{ provider: "codex", model: "gpt-6.1-sol" }] } });
    observe("n885", { before, saved, codeRepair: asWriter });
    slot.lifecycle.unmount();
  });
});
