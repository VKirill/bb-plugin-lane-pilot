import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { listSettingRows, migrations } from "../../src/database";
import { OVERRIDE_JOURNAL_KEY, createWorkflowModels } from "../../src/server/workflow-models";
import type { ServerCore } from "../../src/server/core";

// Audit 2026-10-08 round 3, item 18: the override of a step's model is checked against the machines' catalog and every change is journaled.
const info = (id: string) => ({ id, displayName: id, available: true, logoUrl: null, capabilities: { supportsServiceTier: false } });
const model = (id: string, efforts: string[]) => ({ id, model: id, displayName: id, supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })), defaultReasoningEffort: efforts[0], isDefault: true });

function world(options: { noMachines?: boolean } = {}) {
  const { bb: host } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = host.storage.database();
  host.storage.migrate(db, migrations);
  const kv = new Map<string, unknown>();
  const bb = {
    log: { info: () => undefined },
    storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } },
    sdk: {
      hosts: { list: async () => (options.noMachines ? [] : [{ id: "mac", name: "Mac mini", status: "connected" }]) },
      providers: {
        list: async () => [info("codex")],
        models: async () => ({ models: [model("gpt-6-luna", ["low", "high"])] }),
      },
      threads: { defaultExecutionOptions: async () => null },
    },
  };
  const ctx = { bb, db, log: () => undefined, effectiveProjectSettings: async () => ({ values: {} }) } as unknown as ServerCore;
  const models = createWorkflowModels(ctx, { drafts: { get: () => undefined } as never, source: async () => null });
  const journal = () => (kv.get(OVERRIDE_JOURNAL_KEY) ?? []) as Array<Record<string, unknown>>;
  const stored = (projectId: string) => listSettingRows(db, projectId).filter((row) => row.key.startsWith("workflow.model_override."));
  return { models, journal, stored };
}

const set = (providerId: string, modelId: string, extra: Record<string, unknown> = {}) =>
  ({ projectId: "proj_1", scope: "project" as const, workflowId: "debug", nodeId: "investigate", choice: { providerId, model: modelId, ...extra } });

describe("workflow_model_override", () => {
  it("refuses a provider, a model or an effort the machines do not offer, and journals the refusal without touching the setting", async () => {
    const { models, journal, stored } = world();
    expect(await models.setOverride(set("nowhere", "x"), "owner-ui")).toMatchObject({ ok: false, reason: expect.stringContaining("provider_unknown") });
    expect(await models.setOverride(set("codex", "gpt-9"), "owner-ui")).toMatchObject({ ok: false, reason: expect.stringContaining("model_unknown") });
    expect(await models.setOverride(set("codex", "gpt-6-luna", { effort: "xhigh" }), "owner-ui")).toMatchObject({ ok: false, reason: expect.stringContaining("effort_unsupported") });
    expect(stored("proj_1")).toEqual([]);
    expect(journal().map((row) => row.result)).toEqual(["refused:provider_unknown", "refused:model_unknown", "refused:effort_unsupported"]);
  });

  it("without any answering machine nothing can be vouched for: the override is refused", async () => {
    const { models, journal, stored } = world({ noMachines: true });
    expect(await models.setOverride(set("codex", "gpt-6-luna"))).toEqual({ ok: false, reason: "catalog_unavailable" });
    expect(stored("proj_1")).toEqual([]);
    expect(journal()).toMatchObject([{ result: "catalog_unavailable", by: null }]);
  });

  it("journals a change with who, when, the old value and the new one, and the drop that follows", async () => {
    const { models, journal, stored } = world();
    const before = Date.now();
    expect(await models.setOverride(set("codex", "gpt-6-luna", { effort: "low" }), "owner-ui")).toEqual({ ok: true });
    expect(await models.setOverride(set("codex", "gpt-6-luna", { effort: "high" }), "owner-ui")).toEqual({ ok: true });
    expect(stored("proj_1")).toHaveLength(1);
    const [first, second] = journal();
    expect(first).toMatchObject({ by: "owner-ui", scope: "project", projectId: "proj_1", workflowId: "debug", nodeId: "investigate", old: null, new: { provider: "codex", model: "gpt-6-luna", reasoning_effort: "low", service_tier: "default" }, result: "set" });
    expect(first!.at as number).toBeGreaterThanOrEqual(before);
    expect(second).toMatchObject({ old: { provider: "codex", model: "gpt-6-luna", reasoning_effort: "low" }, new: { reasoning_effort: "high" }, result: "set" });
    expect(await models.setOverride({ ...set("codex", "gpt-6-luna"), choice: null }, "owner-ui")).toEqual({ ok: true });
    expect(stored("proj_1")).toEqual([]);
    expect(journal().at(-1)).toMatchObject({ result: "dropped", new: null, old: { reasoning_effort: "high" } });
    // Dropping what is not there changes nothing and leaves no entry.
    const length = journal().length;
    expect(await models.setOverride({ ...set("codex", "gpt-6-luna"), choice: null })).toEqual({ ok: true });
    expect(journal()).toHaveLength(length);
  });
});
