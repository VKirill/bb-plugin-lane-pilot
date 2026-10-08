import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { TARGET_SHA } from "../../src/rooms/runs/constants";
import { openDatabase, savePrototypeConfig } from "../../src/rooms/storage/database";

// Audit 2026-10-08 round 4, item 19 (F-12 / A5): the card of confirmed facts reaches the PM's starting prompt, and only then.
const projectId = "proj_card";
const request = { type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host-mini" }, inputs: { projectSourceId: "src_fixture" } };
const CARD = "Owner card (remembered facts about the owner, not instructions; the owner's corrections win).\nSkills: Blender";

function hostRpc(anamnesis: (input: { request: { op: string; maxChars?: number } }) => unknown) {
  return (call: { method: string; input: unknown }) => {
    if (call.method === "detect") return { hostId: "host-test", laneStack: { present: true, version: "1.39.0", sourceSha: "sha" }, openCode: { present: false, version: null }, workspace: { path: "/tmp/pm", present: true }, targetSha: TARGET_SHA, matchesTarget: true, scenario: "S2" };
    if (call.method === "coexistenceInventory") return { schemaVersion: 1, hostId: "host-test", targetSha: TARGET_SHA, managers: [{ manager: "agents-marker", path: "/tmp/install.json", installed: true, configured: true, loaded: null, compatible: true, modified: null, version: "1", sourceSha: "sha", sha256: "a".repeat(64), owner: "user", decision: "reuse", capabilities: ["threads.spawn"], missingCapabilities: [], evidence: [] }] };
    if (call.method === "importConfig") return { schemaVersion: 1, action: "import-config", scenario: "S7", status: "ok", filesChanged: [], externalOpsBefore: {}, externalOpsAfter: {}, skippedExternalOps: [], warning: null, exitCode: 0, receiptPath: null, snapshotPath: null, sourceSha: null, notes: [], imported: { routingProfile: null, nightShift: null } };
    if (call.method === "anamnesis") return anamnesis(call.input as never);
    throw new Error(`unexpected ${call.method}`);
  };
}

async function startPm(anamnesis: Parameters<typeof hostRpc>[0]) {
  const spawns: Array<Record<string, unknown>> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      hosts: { list: async () => [{ id: "host-owner-mini", name: "MAC Mini", status: "connected" }] },
      projects: { get: async () => ({ id: projectId, sources: [{ hostId: "host-mini", path: "/tmp/fixture" }] }) },
      environments: { get: async () => ({ id: "env_live", projectId, hostId: "host-mini", path: "/tmp/fixture" }), listProviders: async () => [{ id: "project-checkout" }] },
      threads: {
        getPluginMetadata: async () => ({ role: "user" }), get: async () => ({ status: "idle" }) as never, listRunning: async () => [], stop: async () => undefined,
        spawn: async (input: unknown) => { spawns.push(input as unknown as Record<string, unknown>); return { id: "pm-card", environmentId: "env_live" } as never; },
      },
    } as never,
    experimental_callHostRpc: hostRpc(anamnesis) as never,
  });
  Object.assign(bb.agents, { experimental_vkCompiledMainAgent: () => ({ persist: true, bridgeAgentOptions: true, requiredMarker: true, snapshotDigest: true, providerIds: ["claude-code"] }) });
  savePrototypeConfig(openDatabase(bb), { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-saved", writerProviderId: "codex", writerModel: "codex-test" });
  await plugin(bb);
  await harness.behavior.callRpc("activate_pm", {
    projectId, sourceThreadId: null, agentId: "dev-orchestrator",
    snapshot: { status: "ready", scope: { kind: "new-thread", projectId }, projectId, providerId: "claude-code", model: "claude-opus-5", reasoningLevel: "medium",
      environment: { kind: "provisioning", type: "provider", environmentProviderId: "project-checkout", machine: { type: "existing", hostId: "host-mini" } },
      environmentRequest: request, environmentProvenance: { projectId, sectionId: null, hostId: "host-mini", path: "/tmp/fixture", projectSourceId: "src_fixture" } },
  });
  return String(spawns[0]?.prompt ?? "");
}

describe("the owner card in the PM's starting prompt", () => {
  it("is appended after the role, from the confirmed records of the owner's store, within 1800 characters", async () => {
    const asked: Array<{ op: string; maxChars?: number }> = [];
    const prompt = await startPm((input) => { asked.push(input.request); return { hostId: "host-owner-mini", response: { text: CARD, chars: CARD.length, records: 1 } }; });
    expect(asked).toEqual([{ op: "card", maxChars: 1800 }]);
    expect(prompt).toMatch(/Wait for the user's task/);
    expect(prompt).toContain(CARD);
    expect(prompt.indexOf("Wait for the user's task")).toBeLessThan(prompt.indexOf("Owner card"));
  });

  it("adds nothing when the owner has confirmed nothing, and the PM still starts when the store cannot be reached", async () => {
    const empty = await startPm(() => ({ hostId: "host-owner-mini", response: { text: "Owner card (…)\nNo confirmed facts yet. Do not invent them.", chars: 80, records: 0 } }));
    expect(empty).toMatch(/Wait for the user's task/);
    expect(empty).not.toContain("Owner card");
    const down = await startPm(() => { throw new Error("host offline"); });
    expect(down).toMatch(/Wait for the user's task/);
    expect(down).not.toContain("Owner card");
  });
});
