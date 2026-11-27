import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { MODEL_PRICES, type ModelCatalog } from "@lane-pilot/models";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { describe, expect, it } from "vitest";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import {
  MODEL_CATALOG_DIGEST_KV_KEY,
  catalogDigest,
  checkModelCatalogDigest,
  createModelCatalog,
  mountModelCatalogDigest,
} from "../../src/rooms/platform/server";
import type { ServerCore } from "../../src/rooms/contracts/server";

function makeCatalog(models: Array<{ id: string; efforts?: string[]; hostIds?: string[] }>): ModelCatalog {
  return {
    hosts: [{ id: "host-1", name: "Mini", connected: true }],
    providers: [
      {
        id: "claude-code",
        displayName: "Claude Code",
        logoUrl: null,
        family: "claude",
        supportsServiceTier: false,
        serviceTiers: [],
        hostIds: ["host-1"],
        models: models.map((m, idx) => ({
          id: m.id,
          model: m.id,
          displayName: m.id,
          efforts: m.efforts ?? ["low", "medium", "high"],
          defaultEffort: "medium",
          isDefault: idx === 0,
          hostIds: m.hostIds ?? ["host-1"],
        })),
      },
    ],
  };
}

function memoryKv() {
  const store = new Map<string, unknown>();
  return {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

describe("Task 34: model catalog digest and MODEL_CATALOG_CHANGED", () => {
  it("unchanged catalog emits nothing, a new model emits one event, and a price change emits one event", async () => {
    const kv = memoryKv();
    const emitted: Array<{ name: string; payload?: Record<string, unknown>; options?: { id?: string; key?: string } }> = [];
    const emitEvent = async (name: string, payload?: Record<string, unknown>, options?: { id?: string; key?: string }) => {
      emitted.push({ name, payload, options });
      return { duplicate: false };
    };

    const baseCatalog = makeCatalog([{ id: "claude-sonnet-5-5" }]);
    const sha1 = catalogDigest(baseCatalog);

    // Seed initial digest without emitting.
    const seed = await checkModelCatalogDigest({ catalog: baseCatalog, kv, emitEvent });
    expect(seed).toEqual({ changed: false, seeded: true, prevSha: null, nextSha: sha1 });
    expect(await kv.get(MODEL_CATALOG_DIGEST_KV_KEY)).toBe(sha1);
    expect(emitted).toHaveLength(0);

    // Unchanged catalog emits nothing.
    const unchanged = await checkModelCatalogDigest({ catalog: baseCatalog, kv, emitEvent });
    expect(unchanged).toEqual({ changed: false, seeded: false, prevSha: sha1, nextSha: sha1 });
    expect(emitted).toHaveLength(0);

    // A new model emits one MODEL_CATALOG_CHANGED event.
    const withNewModel = makeCatalog([{ id: "claude-sonnet-5-5" }, { id: "claude-haiku-5-5" }]);
    const added = await checkModelCatalogDigest({ catalog: withNewModel, kv, emitEvent });
    expect(added.changed).toBe(true);
    expect(added.prevSha).toBe(sha1);
    expect(added.nextSha).not.toBe(sha1);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      name: LP_EVENTS.MODEL_CATALOG_CHANGED,
      payload: { prevSha: sha1, nextSha: added.nextSha },
      options: { id: `catalog:${added.nextSha}`, key: added.nextSha },
    });

    // Repeating the same catalog with the new model emits nothing.
    const repeat = await checkModelCatalogDigest({ catalog: withNewModel, kv, emitEvent });
    expect(repeat.changed).toBe(false);
    expect(emitted).toHaveLength(1);

    // A price change emits one MODEL_CATALOG_CHANGED event.
    const updatedPrices = {
      ...MODEL_PRICES,
      "claude-haiku-5-5": { ...MODEL_PRICES["claude-haiku-5-5"]!, output: 0.25 },
    };
    const priced = await checkModelCatalogDigest({ catalog: withNewModel, kv, prices: updatedPrices, emitEvent });
    expect(priced.changed).toBe(true);
    expect(priced.prevSha).toBe(added.nextSha);
    expect(emitted).toHaveLength(2);
    expect(emitted[1]).toEqual({
      name: LP_EVENTS.MODEL_CATALOG_CHANGED,
      payload: { prevSha: added.nextSha, nextSha: priced.nextSha },
      options: { id: `catalog:${priced.nextSha}`, key: priced.nextSha },
    });
  });

  it("triggers digest check inside createModelCatalog refresh and on role_model.* setting changes", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const kv = memoryKv();

    let modelsList = [
      { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", supportedReasoningEfforts: [{ reasoningEffort: "medium" }], defaultReasoningEffort: "medium", isDefault: true },
    ];
    harness.sdk.stub("hosts.list", async () => [{ id: "h1", name: "Mini", status: "connected" }]);
    harness.sdk.stub("providers.list", async () => [{ id: "claude-code", displayName: "Claude Code", available: true }]);
    harness.sdk.stub("providers.models", async () => ({ models: modelsList }));

    const emitted: Array<{ name: string; payload?: Record<string, unknown>; options?: { id?: string } }> = [];
    const ctx = { bb, db, log: () => undefined } as unknown as Pick<ServerCore, "bb" | "db" | "log">;
    const mounted = mountModelCatalogDigest(ctx, {
      kv,
      emitEvent: async (name, payload, options) => {
        emitted.push({ name, payload, options });
        return { duplicate: false };
      },
    });

    // Startup sync seeds baseline.
    const first = await mounted.sync();
    expect(first?.seeded).toBe(true);
    expect(emitted).toHaveLength(0);

    // Refresh via createModelCatalog / modelCatalogOf with a new model emits MODEL_CATALOG_CHANGED.
    modelsList = [
      ...modelsList,
      { id: "claude-haiku-5-5", model: "claude-haiku-5-5", displayName: "Haiku 5.5", supportedReasoningEfforts: [{ reasoningEffort: "low" }], defaultReasoningEffort: "low", isDefault: false },
    ];
    const catalogReader = createModelCatalog(ctx);
    await catalogReader.get(true);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.name).toBe(LP_EVENTS.MODEL_CATALOG_CHANGED);

    // Changing role_model.* setting via saveProjectSetting triggers onSettingChanged -> emits MODEL_CATALOG_CHANGED.
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "role_model.errand", { provider: "claude-code", model: "claude-haiku-5-5" });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(emitted).toHaveLength(2);
    expect(emitted[1]!.name).toBe(LP_EVENTS.MODEL_CATALOG_CHANGED);
    mounted.dispose();
  });
});
