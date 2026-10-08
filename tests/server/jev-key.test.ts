import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { createCore } from "../../src/server/core";

describe("Jev key from Env Catalog", () => {
  it("attaches the catalog's TYPESAFE_API_KEY to Jev host calls only, reading the catalog once", async () => {
    const sent: Array<{ method:string; input:Record<string, unknown> }> = [];
    let catalogReads = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ plugins:{ callRpc: async ({ pluginId, method, input }: { pluginId:string; method:string; input:{ name:string } }) => {
        catalogReads++;
        expect([pluginId, method, input.name]).toEqual(["env-catalog", "env_get_value", "TYPESAFE_API_KEY"]);
        return { name:"TYPESAFE_API_KEY", value:"catalog-key" };
      } } } as never,
      experimental_callHostRpc: async (call) => {
        sent.push({ method:call.method, input:call.input as Record<string, unknown> });
        return call.method === "classifyPlan"
          ? { hostId:"h", status:"ok", effort:"low", reason:null, planSha256:"a", sentPlanSha256:"a", sourceLength:1, sentLength:1 }
          : { hostId:"h", counts:{} };
      },
    });
    const core = createCore(bb, openDatabase(bb));
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"q" }, { hostId:"h" });
    await core.host.call("docsLineCounts", { requestedHostId:"h", projectCwd:"/p", files:[] }, { hostId:"h" });
    expect(sent.map((call) => call.input.jevApiKey)).toEqual(["catalog-key", "catalog-key", undefined]);
    expect(catalogReads).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("leaves the call alone when Env Catalog has no key, so the machine uses its own", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId:"lane-pilot",
      sdk:{ plugins:{ callRpc: async () => { throw new Error("not found"); } } } as never,
      experimental_callHostRpc: async (call) => {
        sent.push(call.input as Record<string, unknown>);
        return { hostId:"h", status:"disabled", effort:null, reason:"missing_typesafe_api_key", planSha256:"a", sentPlanSha256:null, sourceLength:1, sentLength:null };
      },
    });
    const core = createCore(bb, openDatabase(bb));
    await core.host.call("classifyPlan", { requestedHostId:"h", plan:"p" }, { hostId:"h" });
    expect(sent[0]).not.toHaveProperty("jevApiKey");
    await harness.lifecycle.dispose();
  });
});

describe("Jev key on the machine", () => {
  it("prefers the key the server sent over the machine's env", async () => {
    const { jevApiKey, provideJevKey } = await import("../../src/rooms/verification/docs-jev");
    const before = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "machine-key";
    try {
      expect(await jevApiKey()).toBe("machine-key");
      provideJevKey("  ");
      expect(await jevApiKey()).toBe("machine-key");
      provideJevKey("catalog-key");
      expect(await jevApiKey()).toBe("catalog-key");
    } finally {
      if (before === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = before;
    }
  });
});
