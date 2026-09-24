import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { compileMainAgentProfile } from "../src/agent-profile";
import { TARGET_SHA } from "../src/constants";
import { openDatabase, saveProjectSetting, savePrototypeConfig } from "../src/database";
import { LP_AGENT_OVERRIDES_KEY } from "../src/lp-defaults";

const projectId = "proj_main_spawn";
const config = {
  projectId,
  hostId: "host-test",
  pmWorkspacePath: "/tmp/pm",
  writerWorkspacePath: "/tmp/writer",
  pmProviderId: "claude-code",
  pmModel: "claude-test",
  writerProviderId: "codex",
  writerModel: "codex-test",
};

const compiledCapability = {
  experimental_vkCompiledMainAgent: () => ({
    persist: true,
    bridgeAgentOptions: true,
    requiredMarker: true,
    snapshotDigest: true,
    providerIds: ["claude-code"],
  }),
};

function hostRpc() {
  return (call: { method: string }) => {
    if (call.method === "detect") {
      return {
        hostId: "host-test",
        laneStack: { present: true, version: "1.39.0", sourceSha: "custom-newer-sha" },
        openCode: { present: false, version: null },
        workspace: { path: "/tmp/pm", present: true },
        targetSha: TARGET_SHA,
        matchesTarget: false,
        scenario: "S2",
      };
    }
    if (call.method === "coexistenceInventory") {
      return {
        schemaVersion: 1, hostId: "host-test", targetSha: TARGET_SHA,
        managers: [{
          manager: "agents-marker", path: "/home/test/.agents/install.json", installed: true, configured: true,
          loaded: null, compatible: true, modified: null, version: "custom", sourceSha: "custom-newer-sha",
          sha256: "a".repeat(64), owner: "user", decision: "reuse", capabilities: ["threads.spawn"],
          missingCapabilities: [], evidence: [],
        }],
      };
    }
    if (call.method === "importConfig") {
      return {
        schemaVersion: 1, action: "import-config", scenario: "S7", status: "ok", filesChanged: [],
        externalOpsBefore: {}, externalOpsAfter: {}, skippedExternalOps: [], warning: null, exitCode: 0,
        receiptPath: null, snapshotPath: null, sourceSha: null, notes: [], imported: { routingProfile: null, nightShift: null },
      };
    }
    if (call.method === "writePmSettings") {
      return { hostId: "host-test", settingsPath: "/tmp/pm/.claude/settings.json", guardPath: "/tmp/guard_shell.py" };
    }
    throw new Error(`unexpected ${call.method}`);
  };
}

describe("main-agent spawn payload", () => {
  it("puts the saved edited profile on the actual MAIN spawn and refuses a corrupt compiled row", async () => {
    const spawns: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async () => ({ role: "user" }),
          get: async () => ({ status: "idle" }) as never,
          listRunning: async () => [],
          stop: async () => undefined,
          spawn: async (input) => {
            spawns.push(input as unknown as Record<string, unknown>);
            return { id: "pm-main" } as never;
          },
        },
      },
      experimental_callHostRpc: hostRpc(),
    });
    Object.assign(bb.agents, compiledCapability);
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "adoc.040", "in_place");
    saveProjectSetting(db, projectId, "main.agent", "copy-lead");
    await plugin(bb);

    const stock = compileMainAgentProfile("copy-lead");
    const saved = await harness.behavior.callRpc("save_agent_profile", {
      id: "copy-lead",
      prompt: "Write only the headline.",
      expectedSourceHash: stock.sourceHash,
    }) as { ok: boolean; sourceHash: string };
    expect(saved.ok).toBe(true);

    const first = await harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: "source-thread" }) as { threadId: string; runId: string };
    expect(first.threadId).toBe("pm-main");
    expect(spawns[0]?.experimental_vkCompiledMainAgent).toMatchObject({
      id: "copy-lead",
      prompt: "Write only the headline.",
      sourceHash: saved.sourceHash,
    });
    expect(spawns[0]?.experimental_vkCompiledMainAgent).not.toHaveProperty("model");
    expect(spawns[0]?.experimental_vkCompiledMainAgent).not.toHaveProperty("permissionMode");
    await harness.behavior.callRpc("finish_run", { projectId, runId: first.runId });

    const owned = await bb.storage.kv.get<Record<string, { compiled?: { prompt: string; sourceHash: string } }>>(LP_AGENT_OVERRIDES_KEY);
    const compiled = owned!["copy-lead"]!.compiled!;
    compiled.prompt = "Mutated without a new hash.";
    await bb.storage.kv.set(LP_AGENT_OVERRIDES_KEY, owned);

    await expect(harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: "source-thread-2" }))
      .rejects.toThrow(/compiled_main_agent_corrupt/);
    expect(spawns).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("does not spawn MAIN when the selected compiled row fails schema", async () => {
    let spawned = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async () => ({ role: "user" }),
          get: async () => ({ status: "idle", sourceThreadId: "source-thread", lifecycleOwnerThreadId: "source-thread" }) as never,
          spawn: async () => {
            spawned += 1;
            return { id: "must-not-spawn" } as never;
          },
        },
      },
      experimental_callHostRpc: hostRpc(),
    });
    Object.assign(bb.agents, compiledCapability);
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "adoc.040", "in_place");
    saveProjectSetting(db, projectId, "main.agent", "copy-lead");
    await plugin(bb);
    await bb.storage.kv.set(LP_AGENT_OVERRIDES_KEY, {
      "copy-lead": {
        prompt: "Edited.",
        compiled: { id: "copy-lead", sourceVersion: "lp-owned-2", sourceHash: "bad", description: "d", prompt: "p" },
      },
    });
    await expect(harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: "source-thread" }))
      .rejects.toThrow(/compiled_main_agent_corrupt/);
    expect(spawned).toBe(0);
    await harness.lifecycle.dispose();
  });

  it("does not start MAIN when a profile is selected and compiled-agent capability is missing", async () => {
    let spawned = 0;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async () => ({ role: "user" }),
          get: async () => ({ status: "idle", sourceThreadId: "source-thread", lifecycleOwnerThreadId: "source-thread" }) as never,
          spawn: async () => {
            spawned += 1;
            return { id: "must-not-spawn" } as never;
          },
        },
      },
      experimental_callHostRpc: hostRpc(),
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "adoc.040", "in_place");
    saveProjectSetting(db, projectId, "main.agent", "copy-lead");
    await plugin(bb);
    await expect(harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: "source-thread" }))
      .rejects.toThrow(/compiled_main_agent_unsupported/);
    expect(spawned).toBe(0);
    await harness.lifecycle.dispose();
  });
});
