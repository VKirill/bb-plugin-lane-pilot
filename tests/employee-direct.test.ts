import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { DEFAULT_NATIVE_AGENT } from "../src/rooms/native-agent";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function host(sdk: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: sdk as never });
  await plugin(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  const rpc = <T,>(name: string, input: Record<string, unknown> = {}) => harness.behavior.callRpc(name as never, input as never) as Promise<T>;
  return { bb, rpc };
}

type Prepared = { token: string; agentId: string; profileMode: string; environment: { type: string; hostId: string } | null; roleModel: { providerId: string; model: string; effort: string | null } | null };

describe("direct employee call (section 3.6): owner picks a specialist in the composer", () => {
  it("starts 3d-artist with its role model, skills and prompt; the coordinator keeps Opus", async () => {
    const { bb, rpc } = await host();
    const started = await rpc<Prepared>("prepare_native_session", { projectId: "proj_direct", agentId: "3d-artist" });
    expect(started.roleModel).toEqual({ providerId: "claude-code", model: "claude-sonnet-5-5", effort: "high" });
    const record = await bb.storage.kv.get<{ agentsJson: string }>(`native-selection:${started.token}`);
    const definition = (JSON.parse(record!.agentsJson) as Record<string, Record<string, unknown>>)["3d-artist"]!;
    expect(definition.skills).toEqual(["blender-director"]);
    expect(definition.prompt).toContain("## Skill catalog");

    const pm = await rpc<Prepared>("prepare_native_session", { projectId: "proj_direct", agentId: DEFAULT_NATIVE_AGENT });
    expect(pm.roleModel).toBeNull();
  });

  it("an owner's role-model row wins over the table default", async () => {
    const { bb, rpc } = await host();
    await rpc("save_setting", { projectId: "proj_direct", key: "role_model.billing-assistant", value: { model: "claude-opus-5-5" }, expectedVersion: 0 });
    const started = await rpc<Prepared>("prepare_native_session", { projectId: "proj_direct", agentId: "billing-assistant" });
    expect(started.roleModel).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5" });
  });

  it("a pinned employee gets its machine's environment when the project has a folder there", async () => {
    const { rpc } = await host({
      hosts: {
        directory: async ({ hostId }: { hostId: string }) => ({ directory: hostId === "host_7sea4qaad8" ? "/Users/kir" : null }),
      },
      files: { mkdir: async () => ({}) },
      projects: {
        get: async () => ({ id: "proj_direct", name: "Direct", sources: [{ hostId: "host_7sea4qaad8", path: "/Users/kir/3d", isDefault: true }] }),
        list: async () => [],
      },
    });
    const started = await rpc<Prepared>("prepare_native_session", { projectId: "proj_direct", agentId: "3d-artist" });
    expect(started.environment).toMatchObject({ type: "host", hostId: "host_7sea4qaad8" });
  });
});
