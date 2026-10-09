import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { describe, expect, it } from "vitest";
import { openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";

const CLASSIFIED = { hostId:"h", status:"ok", effort:"low", reason:null, planSha256:"a", sentPlanSha256:"a", sourceLength:1, sentLength:1 };

/** A core on a fake host whose Env Catalog holds `catalog`; `provider` is the global jev.provider setting, when set. */
function coreWith(catalog: Record<string, string>, provider?: string) {
  const sent: Array<{ method:string; input:Record<string, unknown> }> = [];
  const reads: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId:"lane-pilot",
    sdk:{ plugins:{ callRpc: async ({ pluginId, method, input }: { pluginId:string; method:string; input:{ name:string } }) => {
      expect([pluginId, method]).toEqual(["env-catalog", "env_get_value"]);
      reads.push(input.name);
      if (!(input.name in catalog)) throw new Error("not found");
      return { name:input.name, value:catalog[input.name] };
    } } } as never,
    experimental_callHostRpc: async (call) => {
      sent.push({ method:call.method, input:call.input as Record<string, unknown> });
      return call.method === "classifyPlan" ? CLASSIFIED : { hostId:"h", counts:{} };
    },
  });
  const db = openDatabase(bb);
  if (provider) saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "jev.provider", provider);
  return { core: createCore(bb, db), db, harness, sent, reads };
}

describe("Jev key from Env Catalog", () => {
  it("attaches OpenLux's key and the provider id to Jev host calls only, by default, reading the catalog once", async () => {
    const { core, harness, sent, reads } = coreWith({ OPENLUX_API_KEY:"openlux-key", TYPESAFE_API_KEY:"catalog-key" });
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"q" }, { hostId:"h" });
    await core.host.call("docsLineCounts", { requestedHostId:"h", projectCwd:"/p", files:[] }, { hostId:"h" });
    expect(sent.map((call) => call.input.jevApiKey)).toEqual(["openlux-key", "openlux-key", undefined]);
    expect(sent.map((call) => call.input.jevProvider)).toEqual(["openlux", "openlux", undefined]);
    expect(reads).toEqual(["OPENLUX_API_KEY"]);
    await harness.lifecycle.dispose();
  });

  it("sends TypeSafe's key when the global setting jev.provider says typesafe", async () => {
    const { core, harness, sent, reads } = coreWith({ OPENLUX_API_KEY:"openlux-key", TYPESAFE_API_KEY:"catalog-key" }, "typesafe");
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    expect(sent[0]!.input).toMatchObject({ jevApiKey:"catalog-key", jevProvider:"typesafe" });
    expect(reads).toEqual(["TYPESAFE_API_KEY"]);
    await harness.lifecycle.dispose();
  });

  it("follows a changed setting on the next call", async () => {
    const { core, db, harness, sent } = coreWith({ OPENLUX_API_KEY:"openlux-key", TYPESAFE_API_KEY:"catalog-key" });
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "jev.provider", "typesafe");
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"q" }, { hostId:"h" });
    expect(sent.map((call) => call.input.jevProvider)).toEqual(["openlux", "typesafe"]);
    await harness.lifecycle.dispose();
  });

  it("falls back to TypeSafe's key when OpenLux has none in the catalog", async () => {
    const { core, harness, sent } = coreWith({ TYPESAFE_API_KEY:"catalog-key" });
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    expect(sent[0]!.input).toMatchObject({ jevApiKey:"catalog-key", jevProvider:"typesafe" });
    await harness.lifecycle.dispose();
  });

  it("leaves the call alone when Env Catalog has no key, so the machine uses its own", async () => {
    const { core, harness, sent } = coreWith({});
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    expect(sent[0]!.input).not.toHaveProperty("jevApiKey");
    expect(sent[0]!.input).not.toHaveProperty("jevProvider");
    await harness.lifecycle.dispose();
  });
});

describe("Jev key on the machine", () => {
  it("prefers the key the server sent over the machine's env, and knows whose key it is", async () => {
    const { jevApiKey, jevProviderOfKey, provideJevKey } = await import("../../src/rooms/verification/docs-jev");
    const before = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "machine-key";
    try {
      expect(await jevApiKey()).toBe("machine-key");
      expect(jevProviderOfKey("machine-key").id).toBe("typesafe");
      provideJevKey("  ");
      expect(await jevApiKey()).toBe("machine-key");
      provideJevKey("catalog-key");
      expect(await jevApiKey()).toBe("catalog-key");
      expect(jevProviderOfKey("catalog-key").id).toBe("typesafe");
      provideJevKey("openlux-key", "openlux");
      expect(await jevApiKey()).toBe("openlux-key");
      expect(jevProviderOfKey("openlux-key")).toMatchObject({ id:"openlux", url:"https://api.openlux.ai/v1/systemone", model:"jev-1.13.0:stable" });
      expect(jevProviderOfKey("machine-key").id).toBe("typesafe");
    } finally {
      if (before === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = before;
    }
  });
});
