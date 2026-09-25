import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { TARGET_SHA } from "../src/constants";
import { getRun, getRunWriterHost, openDatabase, savePrototypeConfig } from "../src/database";

const projectId = "proj_qphej4juxc";
const request = {
  type: "provider",
  environmentProviderId: "project-checkout",
  machine: { type: "existing", hostId: "host-mini" },
  inputs: { projectSourceId: "src_fixture" },
};

function hostRpc(calls: string[]) {
  return (call: { method: string }) => {
    calls.push(call.method);
    if (call.method === "detect") {
      return {
        hostId: "host-test",
        laneStack: { present: true, version: "1.39.0", sourceSha: "sha" },
        openCode: { present: false, version: null },
        workspace: { path: "/tmp/pm", present: true },
        targetSha: TARGET_SHA,
        matchesTarget: true,
        scenario: "S2",
      };
    }
    if (call.method === "coexistenceInventory") {
      return {
        schemaVersion: 1, hostId: "host-test", targetSha: TARGET_SHA,
        managers: [{
          manager: "agents-marker", path: "/tmp/install.json", installed: true, configured: true,
          loaded: null, compatible: true, modified: null, version: "1", sourceSha: "sha",
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
    throw new Error(`unexpected ${call.method}`);
  };
}

describe("composer snapshot activate", () => {
  it("forwards the host-owned request and never writes shared Claude settings", async () => {
    const calls: string[] = [];
    const spawns: Array<Record<string, unknown>> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          get: async () => ({ id: projectId, sources: [{ hostId: "host-mini", path: "/tmp/fixture" }] }),
        },
        environments: {
          get: async () => ({ id: "env_live", projectId, hostId: "host-mini", path: "/tmp/fixture" }),
          listProviders: async () => [{ id: "project-checkout" }],
        },
        threads: {
          getPluginMetadata: async () => ({ role: "user" }),
          get: async () => ({ status: "idle" }) as never,
          listRunning: async () => [],
          stop: async () => undefined,
          spawn: async (input) => {
            spawns.push(input as unknown as Record<string, unknown>);
            return { id: "pm-snapshot", environmentId: "env_live" } as never;
          },
        },
      },
      experimental_callHostRpc: hostRpc(calls),
    });
    Object.assign(bb.agents, {
      experimental_vkCompiledMainAgent: () => ({
        persist: true,
        bridgeAgentOptions: true,
        requiredMarker: true,
        snapshotDigest: true,
        providerIds: ["claude-code"],
      }),
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId,
      hostId: "host-test",
      pmWorkspacePath: "/tmp/pm",
      writerWorkspacePath: "/tmp/writer",
      pmProviderId: "claude-code",
      pmModel: "claude-saved",
      writerProviderId: "codex",
      writerModel: "codex-test",
    });
    await plugin(bb);
    const result = await harness.behavior.callRpc("activate_pm", {
      projectId,
      sourceThreadId: null,
      agentId: "dev-orchestrator",
      snapshot: {
        status: "ready",
        scope: { kind: "new-thread", projectId },
        projectId,
        providerId: "claude-code",
        model: "claude-opus-5",
        reasoningLevel: "medium",
        environment: {
          kind: "provisioning",
          type: "provider",
          environmentProviderId: "project-checkout",
          machine: { type: "existing", hostId: "host-mini" },
        },
        environmentRequest: request,
        environmentProvenance: { projectId, sectionId: null, hostId: "host-mini", path: "/tmp/fixture", projectSourceId: "src_fixture" },
      },
    }) as { threadId: string; runId: string };
    expect(result.threadId).toBe("pm-snapshot");
    expect(spawns[0]?.providerId).toBe("claude-code");
    expect(spawns[0]?.model).toBe("claude-opus-5");
    expect(spawns[0]?.reasoningLevel).toBe("medium");
    expect(spawns[0]?.environment).toEqual(request);
    const prompt = String(spawns[0]?.prompt ?? "");
    expect(prompt).toContain("current workspace");
    expect(prompt).toMatch(/Wait for the user's task/i);
    expect(prompt).not.toMatch(/fixture|production write|demonstrate the guard|lane_pilot_dispatch_writer|lane_pilot_wait_writer|\/tmp\/writer/i);
    expect(calls).not.toContain("writePmSettings");
    expect(spawns[0]?.experimental_vkCompiledMainAgent).toMatchObject({ id: "dev-orchestrator" });
    expect(spawns[0]?.experimental_vkCompiledMainAgent).not.toHaveProperty("model");
    expect(getRunWriterHost(db, result.runId)).toBe("host-mini");
    expect(getRun(db, result.runId)).toMatchObject({
      writer_workspace_path: "/tmp/fixture",
      writer_environment_id: "env_live",
    });
  });

  it("stops and blocks when spawned environment has no path", async () => {
    const stopped: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: {
          get: async () => ({ id: projectId, sources: [{ hostId: "host-mini", path: "/tmp/fixture" }] }),
        },
        environments: {
          get: async () => ({ id: "env_incomplete", projectId, hostId: "host-mini" }),
          listProviders: async () => [{ id: "project-checkout" }],
        },
        threads: {
          getPluginMetadata: async () => ({ role: "user" }),
          get: async () => ({ status: "idle" }) as never,
          listRunning: async () => [],
          stop: async ({ threadId }) => { stopped.push(threadId); },
          spawn: async () => ({ id: "pm-incomplete", environmentId: "env_incomplete" }) as never,
        },
      },
      experimental_callHostRpc: hostRpc([]),
    });
    Object.assign(bb.agents, {
      experimental_vkCompiledMainAgent: () => ({
        persist: true,
        bridgeAgentOptions: true,
        requiredMarker: true,
        snapshotDigest: true,
        providerIds: ["claude-code"],
      }),
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, {
      projectId,
      hostId: "host-test",
      pmWorkspacePath: "/tmp/pm",
      writerWorkspacePath: "/tmp/writer",
      pmProviderId: "claude-code",
      pmModel: "claude-saved",
      writerProviderId: "codex",
      writerModel: "codex-test",
    });
    await plugin(bb);
    await expect(harness.behavior.callRpc("activate_pm", {
      projectId,
      sourceThreadId: null,
      agentId: "dev-orchestrator",
      snapshot: {
        status: "ready",
        scope: { kind: "new-thread", projectId },
        projectId,
        providerId: "claude-code",
        model: "claude-opus-5",
        reasoningLevel: "medium",
        environment: {
          kind: "provisioning",
          type: "provider",
          environmentProviderId: "project-checkout",
          machine: { type: "existing", hostId: "host-mini" },
        },
        environmentRequest: request,
        environmentProvenance: { projectId, sectionId: null, hostId: "host-mini" },
      },
    })).rejects.toThrow(/missing host or path/);
    expect(stopped).toEqual(["pm-incomplete"]);
  });
});
