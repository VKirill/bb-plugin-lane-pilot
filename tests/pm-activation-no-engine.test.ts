import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { TARGET_SHA } from "../src/rooms/runs/constants";
import { openDatabase, savePrototypeConfig } from "../src/rooms/storage/database";

// Live 2026-10-30: after the Claude Lane cleanup every PM activation outside the composer (the drill, automations) stopped on
// «no compatible engine was found»: activation still asked the host for an installed Claude Lane engine. Lane Pilot needs none.
const projectId = "proj_no_engine";

describe("PM activation without a Claude Lane engine", () => {
  it("starts the PM when the host reports no Claude Lane engine at all", async () => {
    const asked: string[] = [];
    const spawns: unknown[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        hosts: { list: async () => [{ id: "host-test", name: "OVH", status: "connected" }] },
        projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-test", path: "/tmp/pm" }] }) },
        environments: { get: async () => ({ id: "env_pm", projectId, hostId: "host-test", path: "/tmp/pm" }), listProviders: async () => [] },
        threads: {
          getPluginMetadata: async () => ({ role: "user" }), get: async () => ({ status: "idle" }) as never, listRunning: async () => [], stop: async () => undefined,
          spawn: async (input: unknown) => { spawns.push(input); return { id: "pm-no-engine", environmentId: "env_pm" } as never; },
        },
      } as never,
      experimental_callHostRpc: ((call: { method: string }) => {
        asked.push(call.method);
        if (call.method === "detect") return { hostId: "host-test", laneStack: { present: false, version: null, sourceSha: null }, openCode: { present: false, version: null }, workspace: { path: "/tmp/pm", present: true }, targetSha: TARGET_SHA, matchesTarget: false, scenario: "S1" };
        if (call.method === "coexistenceInventory") return { schemaVersion: 1, hostId: "host-test", targetSha: TARGET_SHA, managers: [] };
        if (call.method === "importConfig") return { schemaVersion: 1, action: "import-config", scenario: "S7", status: "ok", filesChanged: [], externalOpsBefore: {}, externalOpsAfter: {}, skippedExternalOps: [], warning: null, exitCode: 0, receiptPath: null, snapshotPath: null, sourceSha: null, notes: [], imported: { routingProfile: null, nightShift: null } };
        if (call.method === "anamnesis") return { hostId: "host-test", response: { text: "", chars: 0, records: 0 } };
        throw new Error(`unexpected ${call.method}`);
      }) as never,
    });
    Object.assign(bb.agents, { experimental_vkCompiledMainAgent: () => ({ persist: true, bridgeAgentOptions: true, requiredMarker: true, snapshotDigest: true, providerIds: ["claude-code"] }) });
    savePrototypeConfig(openDatabase(bb), { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-saved", writerProviderId: "codex", writerModel: "codex-test" });
    await plugin(bb);
    await harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: null, agentId: "dev-orchestrator" });
    expect(spawns).toHaveLength(1);
    expect(asked).not.toContain("coexistenceInventory");
  });
});
