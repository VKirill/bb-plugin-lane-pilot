import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { compileMainAgentProfile } from "../src/agent-profile";
import { createRun, getRun, loadProjectSettings, openDatabase, savePrototypeConfig } from "../src/database";
import { inheritProjectValues, LP_AGENT_OVERRIDES_KEY, LP_DEFAULTS_KEY, parseLanePilotDefaults } from "../src/lp-defaults";
import { buildRunPolicy, parseRunPolicy } from "../src/stages/run-policy";

describe("inherited dispatch after override-row delete", () => {
  it("uses globals on a new settings merge, keeps the active run snapshot, and does not rewrite agent hashes", async () => {
    const projectId = "proj_inherit_reset";
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId, hostId: "host-a", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer",
      pmProviderId: "claude-code", pmModel: "claude-opus-5", writerProviderId: "codex", writerModel: "gpt-test",
    });
    await plugin(bb);

    const savedGlobals = await harness.behavior.callRpc("save_globals", {
      defaults: { writerProviderId: "kimi", writerModel: "kimi-k2" },
      expectedRevision: 0,
    }) as { ok: boolean; revision: number };
    expect(savedGlobals).toMatchObject({ ok: true, revision: 1 });

    expect(await harness.behavior.callRpc("save_setting", {
      projectId, key: "writer.provider", value: "grok", expectedVersion: 0,
    })).toMatchObject({ ok: true, version: 1 });
    expect(await harness.behavior.callRpc("save_setting", {
      projectId, key: "ops.pool_size", value: 7, expectedVersion: 0,
    })).toMatchObject({ ok: true, version: 1 });

    createRun(db, "run-frozen", projectId, "bb", "/tmp/writer", "none", buildRunPolicy(loadProjectSettings(db, projectId)));
    const frozenJson = getRun(db, "run-frozen")!.run_policy_json;
    expect(parseRunPolicy(JSON.parse(frozenJson)).pools.provider).toBe(7);

    const stock = compileMainAgentProfile("copy-lead");
    const savedAgent = await harness.behavior.callRpc("save_agent_profile", {
      id: "copy-lead",
      prompt: "Write only the headline.",
      expectedSourceHash: stock.sourceHash,
    }) as { ok: boolean; sourceHash: string };
    expect(savedAgent.ok).toBe(true);
    const hashBefore = savedAgent.sourceHash;

    db.prepare(`DELETE FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key IN ('writer.provider','ops.pool_size')`)
      .run(projectId);

    expect(getRun(db, "run-frozen")!.run_policy_json).toBe(frozenJson);
    expect(parseRunPolicy(JSON.parse(getRun(db, "run-frozen")!.run_policy_json)).pools.provider).toBe(7);

    const live = inheritProjectValues(
      loadProjectSettings(db, projectId),
      parseLanePilotDefaults(await bb.storage.kv.get(LP_DEFAULTS_KEY)),
    );
    expect(live.values["writer.provider"]).toBe("kimi");
    expect(live.inherited).toContain("writer.provider");
    expect(buildRunPolicy(live.values).pools.provider).toBe(5);

    const screen = await harness.behavior.callRpc("get_screen", { projectId }) as {
      values: Record<string, unknown>;
      versions: Record<string, number>;
      inheritedKeys?: string[];
      explicitKeys?: string[];
    };
    expect(screen.values["writer.provider"]).toBe("kimi");
    expect(screen.inheritedKeys).toContain("writer.provider");
    expect(screen.explicitKeys ?? []).not.toContain("writer.provider");
    expect(screen.versions["writer.provider"]).toBe(1);

    const globals = await harness.behavior.callRpc("get_globals", {}) as {
      revision: number;
      agents: Array<{ id: string; sourceHash: string }>;
    };
    expect(globals.revision).toBe(1);
    expect(globals.agents.find((row) => row.id === "copy-lead")?.sourceHash).toBe(hashBefore);
    expect(await bb.storage.kv.get(LP_AGENT_OVERRIDES_KEY)).toMatchObject({
      "copy-lead": { compiled: { sourceHash: hashBefore } },
    });

    await harness.lifecycle.dispose();
  });
});
