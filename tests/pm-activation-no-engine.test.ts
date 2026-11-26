import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { TARGET_SHA } from "../src/rooms/runs";
import { openDatabase, saveProjectSetting, savePrototypeConfig } from "../src/rooms/plugin-db";

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
        throw new Error(`unexpected ${call.method}`);
      }) as never,
    });
    Object.assign(bb.agents, { experimental_vkCompiledMainAgent: () => ({ persist: true, bridgeAgentOptions: true, requiredMarker: true, snapshotDigest: true, providerIds: ["claude-code"] }) });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-saved", writerProviderId: "codex", writerModel: "codex-test" });
    await plugin(bb);
    const activated = await harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: null, agentId: "dev-orchestrator" });
    expect(spawns).toHaveLength(1);
    const run = db.prepare("SELECT writer_host_id, writer_workspace_path FROM lane_pilot_run WHERE id=?").get((activated as { runId: string }).runId) as { writer_host_id: string; writer_workspace_path: string };
    expect(run).toMatchObject({ writer_host_id: "host-test", writer_workspace_path: "/tmp/pm" });
    expect(asked).not.toContain("coexistenceInventory");
    // 0.1.573: activation assigns no fixture mission — the PM waits for the owner's task or an open phase.
    const spawned = spawns[0] as { prompt?: unknown; environment?: { workspace?: { type?: unknown; path?: unknown } } };
    expect(spawned.environment?.workspace).toMatchObject({ type: "unmanaged", path: "/tmp/pm" });
    const prompt = String(spawned.prompt ?? "");
    expect(prompt).toMatch(/Run id: lprun_[\w-]+\./);
    // The prototype writer path is stale; activation uses the sole current project source.
    expect(prompt).toContain("/tmp/pm");
    expect(prompt).toMatch(/Wait for the task/i);
    expect(prompt).not.toMatch(/fixture|production write|demonstrate the guard|lane_pilot_dispatch_writer|lane_pilot_wait_writer|read probes/i);
  });

  it("the managed-worktree variant also waits and names the managed binding", async () => {
    const spawns: Array<{ prompt?: unknown }> = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        hosts: { list: async () => [{ id: "host-test", name: "OVH", status: "connected" }] },
        // The writer source is on another host; the managed PM environment remains on the explicit PM host.
        projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-writer", path: "/tmp/writer-source" }] }) },
        environments: { get: async () => ({ id: "env_pm", projectId, hostId: "host-test", path: "/tmp/pm-managed", status: "ready", managed: true, workspaceProvisionType: "managed-worktree" }), listProviders: async () => [] },
        threads: {
          getPluginMetadata: async () => ({ role: "user" }), get: async () => ({ status: "idle" }) as never, listRunning: async () => [], stop: async () => undefined,
          spawn: async (input: unknown) => { spawns.push(input as { prompt?: unknown }); return { id: "pm-managed", environmentId: "env_pm" } as never; },
        },
      } as never,
      experimental_callHostRpc: ((call: { method: string }) => {
        if (call.method === "detect") return { hostId: "host-test", laneStack: { present: false, version: null, sourceSha: null }, openCode: { present: false, version: null }, workspace: { path: "/tmp/pm", present: true }, targetSha: TARGET_SHA, matchesTarget: false, scenario: "S1" };
        if (call.method === "coexistenceInventory") return { schemaVersion: 1, hostId: "host-test", targetSha: TARGET_SHA, managers: [] };
        throw new Error(`unexpected ${call.method}`);
      }) as never,
    });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-saved", writerProviderId: "codex", writerModel: "codex-test" });
    saveProjectSetting(db, projectId, "adoc.040", "worktree");
    await plugin(bb);
    const activated = await harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: null });
    expect(spawns).toHaveLength(1);
    const run = db.prepare("SELECT writer_host_id, writer_workspace_path FROM lane_pilot_run WHERE id=?").get((activated as { runId: string }).runId) as { writer_host_id: string; writer_workspace_path: string };
    expect(run).toMatchObject({ writer_host_id: "host-test", writer_workspace_path: "/tmp/pm-managed" });
    const spawned = spawns[0] as { prompt?: unknown; environment?: { workspace?: { type?: unknown; path?: unknown } } };
    expect(spawned.environment?.workspace).toMatchObject({ type: "managed-worktree" });
    const prompt = String(spawned.prompt ?? "");
    expect(prompt).toContain("BB-managed worktree");
    expect(prompt).toMatch(/Wait for the task/i);
    expect(prompt).not.toMatch(/fixture|production write|demonstrate the guard|lane_pilot_dispatch_writer|lane_pilot_wait_writer|read probes/i);
  });

  it("refuses an ambiguous writer source before creating a run or spawning the PM", async () => {
    const asked: string[] = [];
    const spawns: unknown[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-a", path: "/tmp/a" }, { hostId: "host-b", path: "/tmp/b" }] }) },
        threads: {
          getPluginMetadata: async () => ({ role: "user" }), get: async () => ({ status: "idle" }) as never, listRunning: async () => [],
          spawn: async (input: unknown) => { spawns.push(input); return { id: "pm-ambiguous" } as never; },
        },
      } as never,
      experimental_callHostRpc: ((call: { method: string }) => {
        asked.push(call.method);
        throw new Error(`unexpected ${call.method}`);
      }) as never,
    });
    Object.assign(bb.agents, { experimental_vkCompiledMainAgent: () => ({ persist: true, bridgeAgentOptions: true, requiredMarker: true, snapshotDigest: true, providerIds: ["claude-code"] }) });
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm-job", writerWorkspacePath: "/tmp/ag194-v4-cli", pmProviderId: "claude-code", pmModel: "claude-saved", writerProviderId: "codex", writerModel: "codex-test" });
    await plugin(bb);
    await expect(harness.behavior.callRpc("activate_pm", { projectId, sourceThreadId: null })).rejects.toThrow(/writer binding is ambiguous/);
    expect(spawns).toHaveLength(0);
    expect(asked).not.toContain("detect");
    expect((db.prepare("SELECT COUNT(*) AS count FROM lane_pilot_run").get() as { count: number }).count).toBe(0);
  });
});
