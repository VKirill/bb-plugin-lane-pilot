/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, waitFor } from "@testing-library/react";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { projectId, mountWithBackend, writerPicker, scopedPicker, choosePickerValue, finish } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("native writer settings against the registered SQLite backend", () => {
  afterEach(() => {
    cleanup();
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
      expect(writerPicker(slot).getAttribute("data-tier")).toBe("fast");
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
    await waitFor(()=>expect(slot.getByTestId("memory-picker").querySelectorAll("[data-testid='bb-provider-model-picker']")).toHaveLength(1));
    await choosePickerValue({providerId:"qwen",model:"qwen-test",reasoningLevel:"high",serviceTier:"default"}, scopedPicker(slot, "memory-picker"));
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
});
