/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { en, setLocaleOverride } from "@lane-pilot/i18n";
import { projectId, type PickerNode, mountWithBackend, choosePickerValue, finish } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("native writer settings against the registered SQLite backend", () => {
  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.clearAllMocks();
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

  it("keeps project selection left and user-facing settings separate from the Maintenance diagnostics", async () => {
    const { harness, slot } = await mountWithBackend();
    expect(slot.getByTestId(`project-item-${projectId}`)).toBeTruthy();
    expect(slot.getByTestId("writer-picker")).toBeTruthy();
    expect(slot.getByTestId("memory-picker")).toBeTruthy();
    fireEvent.click(slot.getByTestId("role-open-writer"));
    expect(slot.getByTestId("jev-settings").querySelectorAll("[role='switch']")).toHaveLength(1);
    expect(slot.getByTestId("writer-effort-mode")).toBeTruthy();
    expect(slot.getByTestId("night-review-settings")).toBeTruthy();
    expect(slot.getByLabelText(en.nightReviewEnabled)).toBeTruthy();
    for (const id of ["team", "work"]) expect(slot.getByTestId(`${id}-panel`).textContent).not.toContain("--writer-provider");
    // Diagnostics sit folded inside Maintenance, away from the settings tabs.
    expect(slot.queryByTestId("service-panel")).toBeNull();
    openTab(slot, "service");
    expect(slot.getByTestId("diagnostics-disclosure").hasAttribute("open")).toBe(false);
    expect(slot.getByTestId("field-s024").textContent).toContain(en.legacyFastModeExplanation);
    expect(slot.getByTestId("cli-preview")).toBeTruthy();
    await finish(harness, slot);
  });

  it("saves night-review model selection as one provider-catalog-validated CAS tuple",async()=>{
    const {harness,slot,nightSaveCalls}=await mountWithBackend();
    await waitFor(()=>expect(slot.getByTestId("night-review-settings").querySelector("[data-testid='bb-provider-model-picker']")).not.toBeNull());
    const picker=slot.getByTestId("night-review-settings").querySelector("[data-testid='bb-provider-model-picker']")!;
    expect(picker.getAttribute("data-provider")).toBe("codex");
    await choosePickerValue({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",serviceTier:"default"}, picker as PickerNode);
    await waitFor(()=>expect(nightSaveCalls).toHaveLength(1));
    expect(nightSaveCalls[0]).toMatchObject({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",expectedVersions:{"night_review.provider":0,"night_review.model":0,"night_review.reasoning_effort":0,"night_review.service_tier":0}});
    await finish(harness,slot);
  });

  it("saves docs-maintenance model selection as a native catalog-validated CAS tuple",async()=>{
    const {harness,slot,docsSaveCalls}=await mountWithBackend();
    const before=await harness.behavior.callRpc("get_screen",{projectId}) as {versions:Record<string,number>};
    await waitFor(()=>expect(slot.getByTestId("docs-picker").querySelector("[data-testid='bb-provider-model-picker']")).toBeTruthy());
    const picker=slot.getByTestId("docs-picker").querySelector("[data-testid='bb-provider-model-picker']");
    expect(picker?.getAttribute("data-provider")).toBe("codex");
    await choosePickerValue({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",serviceTier:"default"}, picker as PickerNode);
    await waitFor(()=>expect(docsSaveCalls).toHaveLength(1));
    expect(docsSaveCalls[0]).toMatchObject({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",expectedVersions:{"docs.provider":before.versions["docs.provider"]??0,"docs.model":before.versions["docs.model"]??0,"docs.reasoning_effort":before.versions["docs.reasoning_effort"]??0,"docs.service_tier":before.versions["docs.service_tier"]??0}});
    await finish(harness,slot);
  });

  it("saves onboarding model selection as a native catalog-validated CAS tuple",async()=>{
    const {harness,slot,onboardingSaveCalls}=await mountWithBackend();
    const before=await harness.behavior.callRpc("get_screen",{projectId}) as {versions:Record<string,number>};
    await waitFor(()=>expect(slot.getByTestId("onboarding-picker").querySelector("[data-testid='bb-provider-model-picker']")).toBeTruthy());
    const picker=slot.getByTestId("onboarding-picker").querySelector("[data-testid='bb-provider-model-picker']");
    expect(picker?.getAttribute("data-provider")).toBe("codex");
    await choosePickerValue({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",serviceTier:"default"}, picker as PickerNode);
    await waitFor(()=>expect(onboardingSaveCalls).toHaveLength(1));
    expect(onboardingSaveCalls[0]).toMatchObject({providerId:"qwen",model:"qwen-test",reasoningLevel:"medium",expectedVersions:{"onboarding.provider":before.versions["onboarding.provider"]??0,"onboarding.model":before.versions["onboarding.model"]??0,"onboarding.reasoning_effort":before.versions["onboarding.reasoning_effort"]??0,"onboarding.service_tier":before.versions["onboarding.service_tier"]??0}});
    await finish(harness,slot);
  });
});
