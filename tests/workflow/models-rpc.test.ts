import { describe, expect, it, vi } from "vitest";
import { createModelCatalog, createWorkflowModels } from "../../src/server/workflow-models";
import type { ServerCore } from "../../src/server/core";
import { journalDb } from "./engine-helpers";

type Info = { id: string; displayName: string; available: boolean; logoUrl: string | null; capabilities: { supportsServiceTier: boolean }; serviceTiers?: Array<{ id: string }> };
const info = (id: string, available = true, tiers = false): Info => ({ id, displayName: id.toUpperCase(), available, logoUrl: `/logo/${id}`, capabilities: { supportsServiceTier: tiers }, ...(tiers ? { serviceTiers: [{ id: "default" }, { id: "fast" }] } : {}) });
const model = (id: string, efforts: string[]) => ({ id, model: id, displayName: id, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })), defaultReasoningEffort: efforts[0] });

/** Two machines: the Mac mini has OpenCode (Gemini, DeepSeek) and Codex; OVH has Codex only; a third is offline. */
function fakeBb() {
  const providers = vi.fn(async ({ hostId }: { hostId: string }) => (hostId === "mac" ? [info("codex", true, true), info("acp-opencode")] : hostId === "ovh" ? [info("codex", true, true), info("acp-opencode", false)] : []));
  const models = vi.fn(async ({ providerId, hostId }: { providerId: string; hostId: string }) => ({
    models: providerId === "codex" ? [model("gpt-6-luna", ["low", "high"])] : hostId === "mac" ? [model("router9/ag/gemini-3.8-flash-high", ["medium", "high"]), model("deepseek/v4", ["high"])] : [],
  }));
  const hosts = vi.fn(async () => [{ id: "mac", name: "Mac mini", status: "connected" }, { id: "ovh", name: "OVH", status: "connected" }, { id: "old", name: "Old laptop", status: "offline" }]);
  return { bb: { sdk: { hosts: { list: hosts }, providers: { list: providers, models } } }, providers, models, hosts };
}

describe("the model catalog of the hub", () => {
  it("merges the machines: each provider and model says where it is available, an offline machine is left out", async () => {
    const fake = fakeBb();
    const catalog = await createModelCatalog({ bb: fake.bb, log: () => undefined } as never).get();
    expect(catalog.hosts).toEqual([{ id: "mac", name: "Mac mini", connected: true }, { id: "ovh", name: "OVH", connected: true }, { id: "old", name: "Old laptop", connected: false }]);
    const byId = Object.fromEntries(catalog.providers.map((row) => [row.id, row]));
    expect(byId.codex).toMatchObject({ hostIds: ["mac", "ovh"], supportsServiceTier: true, serviceTiers: ["default", "fast"], logoUrl: "/logo/codex" });
    expect(byId.codex!.models).toEqual([{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "gpt-6-luna", efforts: ["low", "high"], defaultEffort: "low", hostIds: ["mac", "ovh"] }]);
    expect(byId["acp-opencode"]!.hostIds).toEqual(["mac"]);
    expect(byId["acp-opencode"]!.models.map((row) => [row.id, row.hostIds])).toEqual([["router9/ag/gemini-3.8-flash-high", ["mac"]], ["deepseek/v4", ["mac"]]]);
    expect(fake.providers).not.toHaveBeenCalledWith({ hostId: "old" });
  });

  it("keeps the answer for a minute and reads again when asked to refresh", async () => {
    const fake = fakeBb();
    let clock = 1_000;
    const reader = createModelCatalog({ bb: fake.bb, log: () => undefined } as never, () => clock);
    await reader.get();
    clock += 30_000;
    await reader.get();
    expect(fake.hosts).toHaveBeenCalledTimes(1);
    clock += 31_000;
    await reader.get();
    expect(fake.hosts).toHaveBeenCalledTimes(2);
    await reader.get(true);
    expect(fake.hosts).toHaveBeenCalledTimes(3);
  });

  it("a machine that does not answer does not block the others", async () => {
    const fake = fakeBb();
    fake.providers.mockImplementation(async ({ hostId }: { hostId: string }) => { if (hostId === "mac") throw new Error("down"); return [info("codex")]; });
    const catalog = await createModelCatalog({ bb: fake.bb, log: () => undefined } as never).get();
    expect(catalog.providers.map((row) => [row.id, row.hostIds])).toEqual([["codex", ["ovh"]]]);
  });
});

describe("workflow_step_executors", () => {
  function models(settings: Record<string, unknown> = { "writer.provider": "codex", "writer.model": "gpt-6-luna" }) {
    const fake = fakeBb();
    const db = journalDb();
    const ctx = { bb: fake.bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: settings }) } as unknown as ServerCore;
    const draft = { id: "wfd_1", projectId: "proj_1", definition: { nodes: [
      { id: "a", type: "agent", role: "analyst", provider: "acp-opencode", model: "deepseek/v9", reasoning: "high" },
      { id: "w", type: "lp-task" },
    ] } };
    const lib = { nodes: [{ id: "x", type: "agent", role: "planner", model_preset: "cheap-fast" }] };
    return createWorkflowModels(ctx, {
      drafts: { get: (id: string) => (id === draft.id ? draft : undefined) } as never,
      source: async ({ id }) => (id === "lib" ? { workflow: lib } : null),
    });
  }

  it("resolves a draft against the project's settings and flags a model the machines do not list", async () => {
    const result = await models().stepExecutors({ draftId: "wfd_1" });
    expect(result.found).toBe(true);
    expect(result.executors.map((row) => [row.nodeId, row.model, row.issues])).toEqual([
      ["a", "deepseek/v9", ["model_unknown"]], ["w", "gpt-6-luna", ["effort_auto", "effort_unsupported"]],
    ]);
    expect(result.executors[1]!.fallbacks.at(-1)).toEqual({ providerId: null, model: null, reasoningEffort: null, pm: true });
  });

  it("resolves a workflow of the library, and says when there is none", async () => {
    const api = models();
    expect((await api.stepExecutors({ workflowId: "lib" })).executors[0]).toMatchObject({ nodeId: "x", source: "preset" });
    expect(await api.stepExecutors({ workflowId: "nope" })).toEqual({ found: false, executors: [], pm: null });
    expect(await api.stepExecutors({ draftId: "nope" })).toEqual({ found: false, executors: [], pm: null });
  });
});
