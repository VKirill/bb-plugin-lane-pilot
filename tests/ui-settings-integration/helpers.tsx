import { expect, vi } from "vitest";
import { openAllTabs } from "../ui-tabs";
import { act, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import React from "react";
import { saveProjectSetting, savePrototypeConfig, openDatabase } from "../../src/rooms/storage/database";
import plugin from "../../server";


// The whole file takes 70-80 s on OVH and single tests near 15 s under a loaded machine (clean-clone run 2026-10-07).
vi.setConfig({ testTimeout: 60_000 });

export const projectId = "proj_settings_integration";
export const hostId = "host_settings_integration";
export type PickerValue = { providerId:string; model:string; reasoningLevel:string; serviceTier?:"default"|"fast" };
export type PickerNode = HTMLElement & { __pickerValue?: PickerValue; __pickerOnChange?: (next: PickerValue) => void };

export function installPickerTestDriver() {
  installTestPluginRuntime();
  const host = globalThis as typeof globalThis & { __bbPluginRuntime?: { pluginSdkApp: Record<string, unknown> } };
  const sdk = host.__bbPluginRuntime!.pluginSdkApp;
  host.__bbPluginRuntime!.pluginSdkApp = {
    ...sdk,
    experimental_ProviderModelPicker: (props: { value: PickerValue; onChange: (next: PickerValue) => void }) => React.createElement(
      "div",
      {
        "data-testid": "bb-provider-model-picker",
        "data-provider": props.value.providerId,
        "data-model": props.value.model,
        "data-effort": props.value.reasoningLevel,
        "data-tier": props.value.serviceTier ?? "none",
        ref: (node: PickerNode | null) => {
          if (!node) return;
          node.__pickerValue = props.value;
          node.__pickerOnChange = props.onChange;
        },
      },
    ),
  };
}

export const providers = ["codex", "qwen", "claude-code", "acp-cursor"].map((id) => ({
  id,
  displayName:id,
  available:true,
  capabilities:{
    modelCatalogScope:"host",
    permissionModes:[],
    supportsFork:false,
    supportsNativeUserQuestion:false,
    supportsServiceTier:id === "codex",
    supportsSessionRewind:false,
    supportsThreadArchive:false,
    supportsThreadRename:false,
  },
  serviceTiers:id === "codex"
    ? [{ id:"default", label:"Default" }, { id:"fast", label:"Fast" }]
    : id === "acp-cursor" ? [] : [{ id:"default", label:"Default" }],
})) as never;
export const codexModel = {
  id:"gpt-6-luna",
  model:"gpt-6-luna",
  defaultReasoningEffort:"medium",
  supportedReasoningEfforts:["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })),
};
export const qwenModel = {
  id:"qwen-test",
  model:"qwen-test",
  defaultReasoningEffort:"medium",
  supportedReasoningEfforts:["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })),
};
export const claudeModel = {
  id:"claude-opus-5",
  model:"claude-opus-5",
  defaultReasoningEffort:"medium",
  supportedReasoningEfforts:[{ reasoningEffort:"medium", description:"Medium" }],
};
export const cursorModel = {
  id:"claude-opus-5",
  model:"claude-opus-5",
  defaultReasoningEffort:"medium",
  supportedReasoningEfforts:[{ reasoningEffort:"medium", description:"Medium" }],
};
export const cursorGrokModel = {
  id:"grok-4.6",
  model:"grok-4.6",
  defaultReasoningEffort:"xhigh",
  supportedReasoningEfforts:["high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })),
};

export type RuleRow = { id:string; rule:string; author:"sweep"|"pm"|"owner"|"model"; state:"proposed"|"accepted"|"rejected"|"revoked"; occurrences:number; taskCount:number; examples:string[]; evidence:Array<{runId:string;taskId:string;attemptId:string;reason:string}>; lastSeenAt:number; decidedAt:number|null;
  decidedBy?:"owner"|"auto"|null; trialState?:"trial"|"confirmed"|null; revision?:number; retiredReason?:string|null; trial?:{applied:number;appliedAccepted:number;recurrences:number}|null; scope?:string[]; scopeLabel?:string };

export async function mountWithBackend(options?:{ delayWriterSave?:(input:{providerId:string;model:string;reasoningLevel:string})=>Promise<void>; rules?:RuleRow[]; ruleCalls?:Array<Record<string, unknown>> }) {
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{ providers:{
      list:async () => providers,
      models:async (input) => ({ models:(input?.providerId === "codex" ? [codexModel] : input?.providerId === "claude-code" ? [claudeModel] : input?.providerId === "acp-cursor" ? [cursorModel, cursorGrokModel] : [qwenModel]) as never }),
    }, projects:{
      get:async ({ projectId: id }) => ({ id, name:id, sources:[{ hostId, path:"/tmp/writer-settings", isDefault:true }] }),
      list:async () => [],
    } },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, {
    projectId,
    hostId,
    pmWorkspacePath:"/tmp/pm-settings",
    writerWorkspacePath:"/tmp/writer-settings",
    pmProviderId:"claude-code",
    pmModel:"claude-test",
    writerProviderId:"codex",
    writerModel:"gpt-6-luna",
  });
  saveProjectSetting(db, projectId, "writer.reasoning_effort", "medium");
  saveProjectSetting(db, projectId, "writer.service_tier", "standard");
  await plugin(bb);

  const saveCalls: Array<{ providerId:string; model:string; reasoningLevel:string; serviceTier:"default"|"fast"|null; expectedVersions:Record<string,number> }> = [];
  const memorySaveCalls: Array<{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;expectedVersions:Record<string,number>}> = [];
  const nightSaveCalls: Array<{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;expectedVersions:Record<string,number>}> = [];
  const docsSaveCalls: Array<{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;expectedVersions:Record<string,number>}> = [];
  const onboardingSaveCalls: Array<{providerId:string;model:string;reasoningLevel:string;serviceTier:"default"|"fast"|null;expectedVersions:Record<string,number>}> = [];
  const singleSaveCalls: Array<{ key:string; value:unknown; expectedVersion:number }> = [];
  installPickerTestDriver();
  const appModule = await import("../../app");
  const app = await loadPluginApp(appModule);
  const slot = renderSlot(app.navPanels[0]!, { subPath:"" }, {
    context:{ projectId, threadId:null },
    providers:{ status:"ready", providers },
    rpc:{
      get_preferences:(input) => harness.behavior.callRpc("get_preferences", input) as Promise<unknown>,
      set_locale:(input) => harness.behavior.callRpc("set_locale", input) as Promise<unknown>,
      remember_project:(input) => harness.behavior.callRpc("remember_project", input) as Promise<unknown>,
      list_projects:() => ({ projects:[{ id:projectId, name:"Settings fixture" }], lastProjectId:projectId }),
      get_screen:(input) => harness.behavior.callRpc("get_screen", input) as Promise<unknown>,
      save_writer_selection:async (input) => {
        saveCalls.push(input as typeof saveCalls[number]);
        if (options?.delayWriterSave) await options.delayWriterSave(input as {providerId:string;model:string;reasoningLevel:string});
        return harness.behavior.callRpc("save_writer_selection", input) as Promise<unknown>;
      },
      save_memory_selection:(input) => {
        memorySaveCalls.push(input as typeof memorySaveCalls[number]);
        return harness.behavior.callRpc("save_memory_selection", input) as Promise<unknown>;
      },
      save_night_review_selection:(input)=>{
        nightSaveCalls.push(input as typeof nightSaveCalls[number]);
        return harness.behavior.callRpc("save_night_review_selection",input) as Promise<unknown>;
      },
      save_docs_selection:(input)=>{
        docsSaveCalls.push(input as typeof docsSaveCalls[number]);
        return harness.behavior.callRpc("save_docs_selection",input) as Promise<unknown>;
      },
      save_onboarding_selection:(input)=>{
        onboardingSaveCalls.push(input as typeof onboardingSaveCalls[number]);
        return harness.behavior.callRpc("save_onboarding_selection",input) as Promise<unknown>;
      },
      save_setting:(input) => {
        singleSaveCalls.push(input as typeof singleSaveCalls[number]);
        return harness.behavior.callRpc("save_setting", input) as Promise<unknown>;
      },
      list_rule_proposals:() => ({ proposals:options?.rules ?? [], memory:{ enabled:true, inject:true },
        triage:{ total:5, byOrigin:{ writer:3, orchestrator:2 }, errors:0, lastTriagedAt:1, pendingGroups:0 },
        scan:{ state:"done", startedAt:1, finishedAt:2, triaged:5, groups:1, proposals:1, reason:null },
        analyzer:{ providerId:"codex", model:"gpt-6-luna", reasoningLevel:"high", serviceTier:null },
        events:[{ ruleId:"rule_a", action:"adopted", detail:null, at:1 }] }),
      save_rules_analyzer:(input) => { options?.ruleCalls?.push({ analyzer:input }); return { analyzer:(input as { analyzer:unknown }).analyzer }; },
      start_rule_scan:(input) => { options?.ruleCalls?.push({ scan:input }); return { started:true, scan:{ state:"running", startedAt:3, finishedAt:null, triaged:0, groups:0, proposals:0, reason:null } }; },
      decide_rule_proposal:(input) => {
        const call = input as { id:string; action:"accept"|"reject"|"revoke"; rule?:string };
        options?.ruleCalls?.push(call);
        const row = options!.rules!.find((item) => item.id === call.id)!;
        Object.assign(row, call.action === "accept" ? { state:"accepted", rule:call.rule ?? row.rule, author:"owner" } : { state:call.action === "reject" ? "rejected" : "revoked" });
        return { proposal:row };
      },
    },
  });
  await openAllTabs(slot);
  await waitFor(() => {
    const picker = writerPicker(slot);
    expect(picker.getAttribute("data-provider")).toBe("codex");
    expect(picker.getAttribute("data-effort")).toBe("medium");
  });
  return { harness, slot, saveCalls, memorySaveCalls, nightSaveCalls, docsSaveCalls, onboardingSaveCalls, singleSaveCalls };
}

export function writerPicker(slot: RenderedSlot) {
  return slot.getByTestId("writer-picker").querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
}

export function scopedPicker(slot: RenderedSlot, testId: string) {
  return slot.getByTestId(testId).querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
}

export async function choosePickerValue(next: Partial<PickerValue>, node?: PickerNode) {
  const picker = node ?? (document.querySelector("[data-testid='writer-picker'] [data-testid='bb-provider-model-picker']") as PickerNode | null);
  if (!picker?.__pickerOnChange || !picker.__pickerValue) throw new Error("ProviderModelPicker test driver was not rendered");
  await act(async () => {
    picker.__pickerOnChange!({ ...picker.__pickerValue!, ...next });
    await Promise.resolve();
  });
}

export async function finish(harness: Awaited<ReturnType<typeof createFakePluginHost>>["harness"], slot: RenderedSlot) {
  slot.lifecycle.unmount();
  await harness.lifecycle.dispose();
}
