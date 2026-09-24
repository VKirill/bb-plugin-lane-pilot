/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { installTestPluginRuntime, loadPluginApp, renderSlot, type RenderedSlot } from "@get-bb/plugin-sdk/testing/app";
import React from "react";
import { saveProjectSetting, savePrototypeConfig, openDatabase } from "../src/database";
import { en, setLocaleOverride } from "../i18n";
import plugin from "../server";
import { toast } from "sonner";

vi.setConfig({ testTimeout: 15_000 });
vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

const projectId = "proj_settings_integration";
const hostId = "host_settings_integration";
type PickerValue = { providerId:string; model:string; reasoningLevel:string; serviceTier?:"default"|"fast" };
let pickerValue: PickerValue | null = null;
let pickerOnChange: ((next: PickerValue) => void) | null = null;

function installPickerTestDriver() {
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
      },
      (pickerValue = props.value, pickerOnChange = props.onChange, null),
    ),
  };
}

const providers = ["codex", "qwen", "claude-code", "acp-cursor"].map((id) => ({
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
const codexModel = {
  id:"gpt-6-luna",
  model:"gpt-6-luna",
  defaultReasoningEffort:"medium",
  supportedReasoningEfforts:["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })),
};
const qwenModel = {
  id:"qwen-test",
  model:"qwen-test",
  defaultReasoningEffort:"medium",
  supportedReasoningEfforts:["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })),
};
const claudeModel = {
  id:"claude-opus-5",
  model:"claude-opus-5",
  defaultReasoningEffort:"medium",
  supportedReasoningEfforts:[{ reasoningEffort:"medium", description:"Medium" }],
};
const cursorModel = {
  id:"claude-opus-5",
  model:"claude-opus-5",
  defaultReasoningEffort:"medium",
  supportedReasoningEfforts:[{ reasoningEffort:"medium", description:"Medium" }],
};
const cursorGrokModel = {
  id:"grok-4.6",
  model:"grok-4.6",
  defaultReasoningEffort:"xhigh",
  supportedReasoningEfforts:["high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description:reasoningEffort })),
};

async function mountWithBackend(options?:{ delayWriterSave?:(input:{providerId:string;model:string;reasoningLevel:string})=>Promise<void> }) {
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
  const appModule = await import("../app");
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
    },
  });
  await waitFor(() => {
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-provider")).toBe("codex");
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-effort")).toBe("medium");
  });
  return { harness, slot, saveCalls, memorySaveCalls, nightSaveCalls, docsSaveCalls, onboardingSaveCalls, singleSaveCalls };
}

async function choosePickerValue(next: PickerValue) {
  if (!pickerValue || !pickerOnChange) throw new Error("ProviderModelPicker test driver was not rendered");
  await act(async () => {
    pickerOnChange!({ ...pickerValue!, ...next });
    await Promise.resolve();
  });
}

async function finish(harness: Awaited<ReturnType<typeof createFakePluginHost>>["harness"], slot: RenderedSlot) {
  slot.lifecycle.unmount();
  await harness.lifecycle.dispose();
}

describe("native writer settings against the registered SQLite backend", () => {
  afterEach(() => {
    cleanup();
    pickerValue = null;
    pickerOnChange = null;
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("saves one coherent provider/model/reasoning/service-tier selection with CAS and persists it", async () => {
    const { harness, slot, saveCalls } = await mountWithBackend();
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown>; versions:Record<string,number> };

    await choosePickerValue({ providerId:"codex", model:"gpt-6-luna", reasoningLevel:"xhigh", serviceTier:"fast" });
    await waitFor(() => expect(saveCalls).toHaveLength(1));
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
      expect(current.values).toMatchObject({
        "writer.provider":"codex",
        "writer.model":"gpt-6-luna",
        "writer.reasoning_effort":"xhigh",
        "writer.service_tier":"fast",
      });
      expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-tier")).toBe("fast");
    });
    expect(saveCalls[0]).toMatchObject({
      providerId:"codex", model:"gpt-6-luna", reasoningLevel:"xhigh", serviceTier:"fast",
      expectedVersions:{
        "writer.provider":before.versions["writer.provider"] ?? 0,
        "writer.model":before.versions["writer.model"] ?? 0,
        "writer.reasoning_effort":before.versions["writer.reasoning_effort"],
        "writer.service_tier":before.versions["writer.service_tier"],
      },
    });
    const persisted = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown>; versions:Record<string,number> };
    expect(persisted.versions["writer.provider"]).toBe((before.versions["writer.provider"] ?? 0) + 1);
    expect(persisted.versions["writer.model"]).toBe((before.versions["writer.model"] ?? 0) + 1);
    expect(persisted.versions["writer.reasoning_effort"]).toBe(before.versions["writer.reasoning_effort"] + 1);
    expect(persisted.versions["writer.service_tier"]).toBe(before.versions["writer.service_tier"] + 1);
    await finish(harness, slot);
  });

  it("persists task workspace threshold and multi-output switch independently with CAS",async()=>{
    const {harness,slot,singleSaveCalls}=await mountWithBackend();
    const before=await harness.behavior.callRpc("get_screen",{projectId}) as {values:Record<string,unknown>;versions:Record<string,number>};
    const threshold=await harness.behavior.callRpc("save_setting",{projectId,key:"adoc.041",value:7,expectedVersion:before.versions["adoc.041"]??0}) as {ok:boolean;value:unknown;version:number};
    const multiWrite=await harness.behavior.callRpc("save_setting",{projectId,key:"adoc.042",value:false,expectedVersion:before.versions["adoc.042"]??0}) as {ok:boolean;value:unknown;version:number};
    expect(threshold).toMatchObject({ok:true,value:7,version:(before.versions["adoc.041"]??0)+1});
    expect(multiWrite).toMatchObject({ok:true,value:false,version:(before.versions["adoc.042"]??0)+1});
    const persisted=await harness.behavior.callRpc("get_screen",{projectId}) as {values:Record<string,unknown>;versions:Record<string,number>};
    expect(persisted.values).toMatchObject({"adoc.041":7,"adoc.042":false});
    expect(singleSaveCalls).toHaveLength(0);
    await finish(harness,slot);
  });

  it("uses a separate live native picker and atomic CAS for memory maintenance", async () => {
    const {harness,slot,memorySaveCalls}=await mountWithBackend();
    const before=await harness.behavior.callRpc("get_screen",{projectId}) as {versions:Record<string,number>};
    fireEvent.click(slot.getByText(en.configureMemoryPicker));
    await waitFor(()=>expect(slot.getByTestId("memory-picker").querySelectorAll("[data-testid='bb-provider-model-picker']")).toHaveLength(1));
    await choosePickerValue({providerId:"qwen",model:"qwen-test",reasoningLevel:"high",serviceTier:"default"});
    await waitFor(()=>expect(memorySaveCalls).toHaveLength(1));
    await waitFor(async()=>{
      const current=await harness.behavior.callRpc("get_screen",{projectId}) as {values:Record<string,unknown>};
      expect(current.values).toMatchObject({"memory.provider":"qwen","memory.model":"qwen-test","memory.reasoning_effort":"high","memory.service_tier":"standard"});
    });
    expect(memorySaveCalls[0].expectedVersions).toEqual({
      "memory.provider":before.versions["memory.provider"]??0,
      "memory.model":before.versions["memory.model"]??0,
      "memory.reasoning_effort":before.versions["memory.reasoning_effort"]??0,
      "memory.service_tier":before.versions["memory.service_tier"]??0,
    });
    await finish(harness,slot);
  });

  it("saves the real Jev switch after native Claude selection through the single-setting RPC", async () => {
    const { harness, slot, singleSaveCalls } = await mountWithBackend();
    await choosePickerValue({ providerId:"claude-code", model:"claude-opus-5", reasoningLevel:"medium", serviceTier:undefined });
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
      expect(current.values["writer.provider"]).toBe("claude-code");
    });
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown>; versions:Record<string,number> };
    const key = "jev.LANE_JEV_EFFORT";
    const expectedValue = String(before.values[key]) === "1" ? "0" : "1";
    fireEvent.click(slot.getByTestId("writer-effort-mode").querySelector("button") as HTMLButtonElement);
    fireEvent.click(slot.getByText(expectedValue === "1" ? en.writerEffortAutomatic : en.writerEffortManual));
    await waitFor(() => expect(singleSaveCalls).toContainEqual(expect.objectContaining({ key, value:expectedValue, expectedVersion:before.versions[key] ?? 0 })));
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown>; versions:Record<string,number> };
      expect(current.values[key]).toBe(expectedValue);
      expect(current.versions[key]).toBe((before.versions[key] ?? 0) + 1);
      expect(current.values["writer.provider"]).toBe("claude-code");
    });
    expect(slot.getByTestId("writer-effort-mode").textContent).toContain(expectedValue === "1" ? en.writerEffortAutomatic : en.writerEffortManual);
    expect(slot.queryByTestId("setting-validation-error")).toBeNull();
    await finish(harness, slot);
  });

  it("rejects catalog mismatches and stale CAS without changing the saved selection", async () => {
    const { harness, slot } = await mountWithBackend();
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown>; versions:Record<string,number> };
    const expectedVersions = {
      "writer.provider":before.versions["writer.provider"] ?? 0,
      "writer.model":before.versions["writer.model"] ?? 0,
      "writer.reasoning_effort":before.versions["writer.reasoning_effort"],
      "writer.service_tier":before.versions["writer.service_tier"],
    };
    const remappedTier = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"qwen", model:"qwen-test", reasoningLevel:"medium", serviceTier:"fast", expectedVersions,
    }) as { ok:boolean; conflict:boolean; values:Record<string,unknown>; versions:Record<string,number> };
    expect(remappedTier).toMatchObject({ ok:true, conflict:false, values:{ "writer.provider":"qwen", "writer.model":"qwen-test", "writer.service_tier":"standard" } });
    const unknownModel = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"qwen", model:"missing-model", reasoningLevel:"medium", serviceTier:"default",
      expectedVersions: remappedTier.versions,
    }) as { ok:boolean; conflict:boolean; validation?:{ code:string } };
    expect(unknownModel).toMatchObject({ ok:false, conflict:false, validation:{ code:"invalid_choice" } });

    const screen = await harness.behavior.callRpc("get_screen", { projectId }) as { versions:Record<string,number> };
    const valid = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"codex", model:"gpt-6-luna", reasoningLevel:"xhigh", serviceTier:"fast",
      expectedVersions:{
        "writer.provider":screen.versions["writer.provider"] ?? 0,
        "writer.model":screen.versions["writer.model"] ?? 0,
        "writer.reasoning_effort":screen.versions["writer.reasoning_effort"],
        "writer.service_tier":screen.versions["writer.service_tier"],
      },
    }) as { ok:boolean; conflict:boolean; versions:Record<string,number> };
    expect(valid.ok).toBe(true);
    const stale = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"qwen", model:"qwen-test", reasoningLevel:"medium", serviceTier:"default", expectedVersions,
    }) as { ok:boolean; conflict:boolean };
    expect(stale).toMatchObject({ ok:false, conflict:true });
    const persisted = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown>; versions:Record<string,number> };
    expect(persisted.values).toMatchObject({ "writer.provider":"codex", "writer.model":"gpt-6-luna", "writer.reasoning_effort":"xhigh", "writer.service_tier":"fast" });
    expect(persisted.versions).toMatchObject(valid.versions);
    await finish(harness, slot);
  });

  it("keeps project selection left and user-facing settings separate from Diagnostics", async () => {
    const { harness, slot } = await mountWithBackend();
    expect(slot.getByTestId(`project-item-${projectId}`)).toBeTruthy();
    expect(slot.getByTestId("writer-picker")).toBeTruthy();
    expect(slot.getByTestId("memory-picker")).toBeTruthy();
    expect(slot.getByTestId("jev-settings").querySelectorAll("[role='switch']")).toHaveLength(1);
    expect(slot.getByTestId("writer-effort-mode")).toBeTruthy();
    expect(slot.getByTestId("night-review-settings").textContent).toContain(en.nightReviewEnabled);
    expect(slot.getByLabelText(en.nightReviewEnabled)).toBeTruthy();
    expect(slot.getByTestId("settings-panel").textContent).not.toContain("--writer-provider");
    expect(slot.getByTestId("diagnostics-panel").hasAttribute("hidden")).toBe(true);
    fireEvent.click(slot.getByTestId("tab-diagnostics"));
    expect(slot.getByTestId("field-s024").textContent).toContain(en.legacyFastModeExplanation);
    expect(slot.getByTestId("cli-preview")).toBeTruthy();
    await finish(harness, slot);
  });

  it("saves night-review model selection as one provider-catalog-validated CAS tuple",async()=>{
    const {harness,slot,nightSaveCalls}=await mountWithBackend();
    fireEvent.click(slot.getByText(en.configureNightPicker));
    await waitFor(()=>expect(slot.getAllByTestId("bb-provider-model-picker")).toHaveLength(2));
    const picker=slot.getAllByTestId("bb-provider-model-picker").at(-1)!;
    expect(picker.getAttribute("data-provider")).toBe("codex");
    pickerOnChange?.({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",serviceTier:"default"});
    await waitFor(()=>expect(nightSaveCalls).toHaveLength(1));
    expect(nightSaveCalls[0]).toMatchObject({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",expectedVersions:{"night_review.provider":0,"night_review.model":0,"night_review.reasoning_effort":0,"night_review.service_tier":0}});
    await finish(harness,slot);
  });

  it("saves docs-maintenance model selection as a native catalog-validated CAS tuple",async()=>{
    const {harness,slot,docsSaveCalls}=await mountWithBackend();
    const before=await harness.behavior.callRpc("get_screen",{projectId}) as {versions:Record<string,number>};
    fireEvent.click(slot.getByText(en.configureDocsPicker));
    await waitFor(()=>expect(slot.getByTestId("docs-picker").querySelector("[data-testid='bb-provider-model-picker']")).toBeTruthy());
    const picker=slot.getByTestId("docs-picker").querySelector("[data-testid='bb-provider-model-picker']");
    expect(picker?.getAttribute("data-provider")).toBe("codex");
    pickerOnChange?.({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",serviceTier:"default"});
    await waitFor(()=>expect(docsSaveCalls).toHaveLength(1));
    expect(docsSaveCalls[0]).toMatchObject({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",expectedVersions:{"docs.provider":before.versions["docs.provider"]??0,"docs.model":before.versions["docs.model"]??0,"docs.reasoning_effort":before.versions["docs.reasoning_effort"]??0,"docs.service_tier":before.versions["docs.service_tier"]??0}});
    await finish(harness,slot);
  });
  it("saves onboarding model selection as a native catalog-validated CAS tuple",async()=>{
    const {harness,slot,onboardingSaveCalls}=await mountWithBackend();
    const before=await harness.behavior.callRpc("get_screen",{projectId}) as {versions:Record<string,number>};
    fireEvent.click(slot.getByText(en.configureOnboardingPicker));
    await waitFor(()=>expect(slot.getByTestId("onboarding-picker").querySelector("[data-testid='bb-provider-model-picker']")).toBeTruthy());
    const picker=slot.getByTestId("onboarding-picker").querySelector("[data-testid='bb-provider-model-picker']");
    expect(picker?.getAttribute("data-provider")).toBe("codex");
    pickerOnChange?.({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",serviceTier:"default"});
    await waitFor(()=>expect(onboardingSaveCalls).toHaveLength(1));
    expect(onboardingSaveCalls[0]).toMatchObject({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",expectedVersions:{"onboarding.provider":before.versions["onboarding.provider"]??0,"onboarding.model":before.versions["onboarding.model"]??0,"onboarding.reasoning_effort":before.versions["onboarding.reasoning_effort"]??0,"onboarding.service_tier":before.versions["onboarding.service_tier"]??0}});
    await finish(harness,slot);
  });

  it("maps leftover low to catalog defaultReasoningEffort and keeps an explicit supported high", async () => {
    const { harness, slot } = await mountWithBackend();
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as { versions:Record<string,number> };
    const versions = {
      "writer.provider":before.versions["writer.provider"] ?? 0,
      "writer.model":before.versions["writer.model"] ?? 0,
      "writer.reasoning_effort":before.versions["writer.reasoning_effort"],
      "writer.service_tier":before.versions["writer.service_tier"],
    };
    const leftoverLow = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"acp-cursor", model:"grok-4.6", reasoningLevel:"low", serviceTier:"fast", expectedVersions:versions,
    }) as { ok:boolean; values:Record<string,unknown>; versions:Record<string,number> };
    expect(leftoverLow).toMatchObject({
      ok:true,
      values:{
        "writer.provider":"acp-cursor",
        "writer.model":"grok-4.6",
        "writer.reasoning_effort":"xhigh",
        "writer.service_tier":"standard",
      },
    });
    const explicitHigh = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"acp-cursor", model:"grok-4.6", reasoningLevel:"high", serviceTier:null,
      expectedVersions:leftoverLow.versions,
    }) as { ok:boolean; values:Record<string,unknown> };
    expect(explicitHigh).toMatchObject({ ok:true, values:{ "writer.reasoning_effort":"high", "writer.model":"grok-4.6" } });
    const readback = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
    expect(readback.values).toMatchObject({
      "writer.provider":"acp-cursor",
      "writer.model":"grok-4.6",
      "writer.reasoning_effort":"high",
      "writer.service_tier":"standard",
    });
    await finish(harness, slot);
  });

  it("keeps the last Cursor selection while an earlier writer save is still in flight", async () => {
    let releaseFirst: (() => void) | undefined;
    const { harness, slot, saveCalls } = await mountWithBackend({
      delayWriterSave: async (input) => {
        if (input.providerId === "codex" && input.reasoningLevel === "low") {
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
      },
    });
    await choosePickerValue({ providerId:"codex", model:"gpt-6-luna", reasoningLevel:"low", serviceTier:"default" });
    await waitFor(() => expect(releaseFirst).toBeTypeOf("function"));
    await choosePickerValue({ providerId:"acp-cursor", model:"claude-opus-5", reasoningLevel:"low" });
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-provider")).toBe("acp-cursor");
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-model")).toBe("claude-opus-5");
    releaseFirst!();
    await waitFor(async () => {
      const current = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
      expect(current.values).toMatchObject({
        "writer.provider":"acp-cursor",
        "writer.model":"claude-opus-5",
        "writer.reasoning_effort":"medium",
      });
    });
    expect(saveCalls.at(-1)).toMatchObject({ providerId:"acp-cursor", model:"claude-opus-5" });
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-provider")).toBe("acp-cursor");
    expect(slot.queryByTestId("setting-validation-error")).toBeNull();
    await finish(harness, slot);
  });

  it("keeps the attempted picker draft and shows the RPC reason when the model is not in catalog", async () => {
    const { harness, slot } = await mountWithBackend();
    await choosePickerValue({ providerId:"acp-cursor", model:"not-in-catalog", reasoningLevel:"medium" });
    await waitFor(() => expect(slot.getByTestId("setting-validation-error")).toBeTruthy());
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-provider")).toBe("acp-cursor");
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-model")).toBe("not-in-catalog");
    const persisted = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
    expect(persisted.values["writer.provider"]).toBe("codex");
    expect(persisted.values["writer.model"]).toBe("gpt-6-luna");
    await finish(harness, slot);
  });

  it("does not reload away a Cursor draft when writer save hits a CAS conflict", async () => {
    const { harness, slot } = await mountWithBackend();
    const before = await harness.behavior.callRpc("get_screen", { projectId }) as { versions:Record<string,number> };
    const external = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"codex", model:"gpt-6-luna", reasoningLevel:"xhigh", serviceTier:"fast",
      expectedVersions:{
        "writer.provider":before.versions["writer.provider"] ?? 0,
        "writer.model":before.versions["writer.model"] ?? 0,
        "writer.reasoning_effort":before.versions["writer.reasoning_effort"],
        "writer.service_tier":before.versions["writer.service_tier"],
      },
    }) as { ok:boolean };
    expect(external.ok).toBe(true);
    await choosePickerValue({ providerId:"acp-cursor", model:"claude-opus-5", reasoningLevel:"medium" });
    await waitFor(() => expect(slot.getByTestId("cas-conflict")).toBeTruthy());
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-provider")).toBe("acp-cursor");
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-model")).toBe("claude-opus-5");
    const persisted = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown> };
    expect(persisted.values).toMatchObject({ "writer.provider":"codex", "writer.model":"gpt-6-luna", "writer.reasoning_effort":"xhigh" });
    await finish(harness, slot);
  });
});
