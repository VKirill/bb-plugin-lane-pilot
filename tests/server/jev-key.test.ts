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
  it("attaches TypeSafe's key and the provider id to Jev host calls only, by default, reading the catalog once", async () => {
    const { core, harness, sent, reads } = coreWith({ OPENLUX_API_KEY:"openlux-key", TYPESAFE_API_KEY:"catalog-key" });
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"q" }, { hostId:"h" });
    await core.host.call("docsLineCounts", { requestedHostId:"h", projectCwd:"/p", files:[] }, { hostId:"h" });
    expect(sent.map((call) => call.input.jevApiKey)).toEqual(["catalog-key", "catalog-key", undefined]);
    expect(sent.map((call) => call.input.jevProvider)).toEqual(["typesafe", "typesafe", undefined]);
    // The chosen provider's key, then OpenLux's for the one-retry standby; cached between the calls.
    expect(reads).toEqual(["TYPESAFE_API_KEY", "OPENLUX_API_KEY"]);
    await harness.lifecycle.dispose();
  });

  it("sends OpenLux's key when the global setting jev.provider says openlux", async () => {
    const { core, harness, sent, reads } = coreWith({ OPENLUX_API_KEY:"openlux-key", TYPESAFE_API_KEY:"catalog-key" }, "openlux");
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    expect(sent[0]!.input).toMatchObject({ jevApiKey:"openlux-key", jevProvider:"openlux" });
    expect(reads).toEqual(["OPENLUX_API_KEY", "TYPESAFE_API_KEY"]);
    await harness.lifecycle.dispose();
  });

  it("follows a changed setting on the next call", async () => {
    const { core, db, harness, sent } = coreWith({ OPENLUX_API_KEY:"openlux-key", TYPESAFE_API_KEY:"catalog-key" });
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "jev.provider", "openlux");
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"q" }, { hostId:"h" });
    expect(sent.map((call) => call.input.jevProvider)).toEqual(["typesafe", "openlux"]);
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
    const { jevCallFor } = await import("../../src/rooms/verification/docs-jev");
    const before = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "machine-key";
    try {
      expect((await jevCallFor())?.key).toBe("machine-key");
      expect((await jevCallFor())?.provider.id).toBe("typesafe");
      expect((await jevCallFor({ jevApiKey:"  " }))?.key).toBe("machine-key");
      expect(await jevCallFor({ jevApiKey:"catalog-key" })).toMatchObject({ key:"catalog-key", provider:{ id:"typesafe" } });
      expect((await jevCallFor({ jevApiKey:"openlux-key", jevProvider:"openlux" }))?.provider).toMatchObject({ id:"openlux", url:"https://api.openlux.ai/v1/systemone", model:"jev-1.14.0:stable" });
      expect((await jevCallFor())?.key).toBe("machine-key");
    } finally {
      if (before === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = before;
    }
  });
});
