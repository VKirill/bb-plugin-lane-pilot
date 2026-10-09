/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openTab } from "../ui-tabs";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { en, setLocaleOverride } from "@lane-pilot/i18n";
import { projectId, type RuleRow, mountWithBackend, writerPicker, scopedPicker, choosePickerValue, finish } from "./helpers";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }));

describe("native writer settings against the registered SQLite backend", () => {
  afterEach(() => {
    cleanup();
    setLocaleOverride(null);
    document.documentElement.lang = "en";
    vi.clearAllMocks();
  });

  it("shows repeated failures as rule proposals; the owner edits and accepts one, then revokes it", async () => {
    const rules:RuleRow[] = [
      { id:"rule_a", rule:"Create every expected output before answering.", author:"model", state:"proposed", occurrences:3, taskCount:3, examples:[],
        evidence:[{ runId:"r", taskId:"w1", attemptId:"a1", reason:"missing expected_outputs: docs/w1.md" }, { runId:"r", taskId:"w2", attemptId:"a2", reason:"missing expected_outputs: docs/w2.md" }], lastSeenAt:1, decidedAt:null },
      { id:"rule_b", rule:"Old ownership noise", author:"sweep", state:"rejected", occurrences:40, taskCount:40, examples:[], evidence:[], lastSeenAt:1, decidedAt:2 },
    ];
    const ruleCalls:Array<Record<string, unknown>> = [];
    const { harness, slot } = await mountWithBackend({ rules, ruleCalls });
    try {
      openTab(slot, "rules");
      const card = await slot.findByTestId("rule-rule_a");
      // Opening the screen must not save an analyzer the picker merely normalized.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(ruleCalls.filter((call) => "analyzer" in call)).toEqual([]);
      expect(card.textContent).toContain(`${en.rulesTasks}: 3`);
      expect(card.textContent).toContain(en.rulesAuthorModel);
      expect(slot.getByTestId("rule-evidence-rule_a").textContent).toContain("w2: missing expected_outputs: docs/w2.md");
      expect(slot.getByTestId("rules-triage").textContent).toContain(`${en.rulesOrigin_writer}: 3`);
      expect(slot.getByTestId("rules-triage").textContent).toContain(`${en.rulesOrigin_orchestrator}: 2`);
      expect(slot.getByTestId("rules-scan-result").textContent).toContain(`${en.rulesScanProposals} 1`);
      fireEvent.click(within(slot.getByTestId("rule-proposals")).getByRole("button", { name:en.rulesScan }));
      await waitFor(() => expect(ruleCalls[0]).toEqual({ scan:{ projectId, locale:"en" } }));
      ruleCalls.length = 0;
      expect(slot.getByTestId("rule-proposals").textContent).toContain(`${en.rulesClosed} (1)`);
      fireEvent.change(card.querySelector("textarea")!, { target:{ value:"Never use the network in verification commands." } });
      fireEvent.click(within(card).getByRole("button", { name:en.rulesAccept }));
      await waitFor(() => expect(slot.getByTestId("rule-rule_a").textContent).toContain(en.rulesRevoke));
      expect(ruleCalls[0]).toMatchObject({ id:"rule_a", action:"accept", rule:"Never use the network in verification commands." });
      expect(slot.getByTestId("rule-rule_a").textContent).toContain("Never use the network in verification commands.");
      fireEvent.click(within(slot.getByTestId("rule-rule_a")).getByRole("button", { name:en.rulesRevoke }));
      await waitFor(() => expect(slot.queryByTestId("rule-rule_a")).toBeNull());
      expect(ruleCalls[1]).toMatchObject({ id:"rule_a", action:"revoke" });
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
  });

  it("shows a rule the PM proposed as soon as the server signals the project's rules (H6)", async () => {
    const rules:RuleRow[] = [
      { id:"rule_a", rule:"Create every expected output before answering.", author:"model", state:"proposed", occurrences:3, taskCount:3, examples:[], evidence:[], lastSeenAt:1, decidedAt:null },
    ];
    const { harness, slot } = await mountWithBackend({ rules, ruleCalls:[] });
    try {
      openTab(slot, "rules");
      await slot.findByTestId("rule-rule_a");
      rules.push({ id:"rule_new", rule:"Run the focused test before the full suite.", author:"pm", state:"proposed", occurrences:1, taskCount:1, examples:[], evidence:[], lastSeenAt:2, decidedAt:null });
      await slot.behavior.emitRealtime(`lp:${projectId}`, { kind:"council" });
      await slot.behavior.emitRealtime("lp:proj_other", { kind:"rules" });
      expect(slot.queryByTestId("rule-rule_new")).toBeNull();
      await slot.behavior.emitRealtime(`lp:${projectId}`, { kind:"rules" });
      await slot.findByTestId("rule-rule_new");
    } finally { slot.lifecycle.unmount(); await harness.lifecycle.dispose(); }
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
    fireEvent.click(slot.getByTestId("role-open-writer"));
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
});
