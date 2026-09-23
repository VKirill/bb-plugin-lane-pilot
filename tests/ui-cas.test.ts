import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, savePrototypeConfig } from "../src/database";
import plugin from "../server";

describe("settings CAS over RPC", () => {
  it("saves unrelated paths after a native Claude selection while retaining legacy validation and atomicity", async () => {
    const projectId = "proj_native_paths";
    const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ providers:{
      list:async () => [{ id:"claude-code", available:true, capabilities:{ supportsServiceTier:false }, serviceTiers:[] }] as never,
      models:async () => ({ models:[{ id:"claude-opus-5", model:"claude-opus-5", supportedReasoningEfforts:[{ reasoningEffort:"medium", description:"Medium" }] }] as never }),
    } } });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId, hostId:"host-native", pmWorkspacePath:"/tmp/pm-before", writerWorkspacePath:"/tmp/writer-before",
      pmProviderId:"claude-code", pmModel:"claude-opus-5", writerProviderId:"codex", writerModel:"gpt-test",
    });
    await plugin(bb);
    const native = await harness.behavior.callRpc("save_writer_selection", {
      projectId, providerId:"claude-code", model:"claude-opus-5", reasoningLevel:"medium", serviceTier:null,
      expectedVersions:{ "writer.provider":0, "writer.model":0, "writer.reasoning_effort":0, "writer.service_tier":0 },
    }) as { ok:boolean; versions:Record<string,number> };
    expect(native.ok).toBe(true);
    const paths = await harness.behavior.callRpc("save_settings", { projectId, changes:[
      { key:"pmWorkspacePath", value:"/tmp/pm-after", expectedVersion:1 },
      { key:"writerWorkspacePath", value:"/tmp/writer-after", expectedVersion:1 },
    ] }) as { ok:boolean; versions:Record<string,number> };
    expect(paths).toMatchObject({ ok:true, versions:{ pmWorkspacePath:2, writerWorkspacePath:2 } });
    const invalid = await harness.behavior.callRpc("save_settings", { projectId, changes:[
      { key:"pmWorkspacePath", value:"/tmp/partial", expectedVersion:2 },
      { key:"writer.provider", value:"invalid-provider", expectedVersion:native.versions["writer.provider"] },
    ] }) as { ok:boolean; validation?:{ code:string; key:string } };
    expect(invalid).toMatchObject({ ok:false, validation:{ code:"invalid_choice", key:"writer.provider" } });
    const invalidOther = await harness.behavior.callRpc("save_settings", { projectId, changes:[
      { key:"pmWorkspacePath", value:"/tmp/partial", expectedVersion:2 },
      { key:"ui.language", value:"invalid-language", expectedVersion:0 },
    ] }) as { ok:boolean; validation?:{ code:string; key:string } };
    expect(invalidOther).toMatchObject({ ok:false, validation:{ code:"invalid_choice", key:"ui.language" } });
    const screen = await harness.behavior.callRpc("get_screen", { projectId }) as { values:Record<string,unknown>; versions:Record<string,number> };
    expect(screen.values).toMatchObject({ pmWorkspacePath:"/tmp/pm-after", writerWorkspacePath:"/tmp/writer-after", "writer.provider":"claude-code" });
    expect(screen.versions.pmWorkspacePath).toBe(2);
    await harness.lifecycle.dispose();
  });

  it("rejects a stale version and keeps the stored value", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const first = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_a",
      key: "ui.language",
      value: "en",
      expectedVersion: 0,
    }) as { ok: boolean; version: number };
    expect(first.ok).toBe(true);
    const conflict = await harness.behavior.callRpc("save_setting", {
      projectId: "proj_a",
      key: "ui.language",
      value: "ru",
      expectedVersion: 0,
    }) as { ok: boolean; conflict: boolean; value: unknown };
    expect(conflict.ok).toBe(false);
    expect(conflict.conflict).toBe(true);
    expect(conflict.value).toBe("en");
    const isolated = await harness.behavior.callRpc("get_screen", { projectId: "proj_b" }) as {
      values: Record<string, unknown>;
    };
    expect(isolated.values["ui.language"]).toBeUndefined();
    await harness.lifecycle.dispose();
  });

  it("atomically transitions saved provider/effort pairs and rejects invalid or stale groups", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const save = (provider: string, effort: string, providerVersion: number, effortVersion: number) =>
      harness.behavior.callRpc("save_settings", {
        projectId: "proj_pairs",
        changes: [
          { key: "writer.provider", value: provider, expectedVersion: providerVersion },
          { key: "writer.reasoning_effort", value: effort, expectedVersion: effortVersion },
        ],
      }) as Promise<{ ok:boolean; conflict:boolean; values:Record<string, unknown>; versions:Record<string, number>; validation?: { code:string } }>;

    const initial = await save("qwen", "medium", 0, 0);
    expect(initial).toMatchObject({ ok:true, conflict:false, values:{ "writer.provider":"qwen", "writer.reasoning_effort":"medium" }, versions:{ "writer.provider":1, "writer.reasoning_effort":1 } });
    const toCodex = await save("codex", "max", 1, 1);
    expect(toCodex).toMatchObject({ ok:true, values:{ "writer.provider":"codex", "writer.reasoning_effort":"max" }, versions:{ "writer.provider":2, "writer.reasoning_effort":2 } });
    const toQwen = await save("qwen", "low", 2, 2);
    expect(toQwen).toMatchObject({ ok:true, values:{ "writer.provider":"qwen", "writer.reasoning_effort":"low" }, versions:{ "writer.provider":3, "writer.reasoning_effort":3 } });
    const backToCodex = await save("codex", "max", 3, 3);
    expect(backToCodex).toMatchObject({ ok:true, values:{ "writer.provider":"codex", "writer.reasoning_effort":"max" }, versions:{ "writer.provider":4, "writer.reasoning_effort":4 } });

    const invalid = await save("qwen", "max", 4, 4);
    expect(invalid.ok).toBe(false);
    expect(invalid.conflict).toBe(false);
    expect(invalid.validation?.code).toBe("incompatible_setting");
    expect(invalid.values).toEqual({ "writer.provider":"codex", "writer.reasoning_effort":"max" });
    expect(invalid.versions).toEqual({ "writer.provider":4, "writer.reasoning_effort":4 });

    const stale = await save("qwen", "low", 4, 3);
    expect(stale).toMatchObject({ ok:false, conflict:true, values:{ "writer.provider":"codex", "writer.reasoning_effort":"max" }, versions:{ "writer.provider":4, "writer.reasoning_effort":4 } });
    const screen = await harness.behavior.callRpc("get_screen", { projectId:"proj_pairs" }) as {
      values:Record<string, unknown>; versions:Record<string, number>;
    };
    expect(screen.values).toMatchObject({ "writer.provider":"codex", "writer.reasoning_effort":"max" });
    expect(screen.versions).toMatchObject({ "writer.provider":4, "writer.reasoning_effort":4 });
    await harness.lifecycle.dispose();
  });
});
