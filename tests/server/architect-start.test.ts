import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { rpcContract } from "../../src/rooms/contracts";
import { SELF_REPAIR_DEFAULTS } from "../../src/rooms/self-repair/server/self-repair";
import { tokensFrom } from "../../src/rooms/native-agent/native-session";

const projectId = "proj_arch";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

async function setup(options: { sources?: Array<{ hostId: string; path: string }>; archived?: () => boolean } = {}) {
  const spawned: Array<Record<string, any>> = [];
  const placed: Array<Record<string, unknown>> = [];
  let counter = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        spawn: async (args: unknown) => { spawned.push(args as Record<string, any>); counter += 1; await new Promise((done) => setTimeout(done, 5)); return { id: `thr_architect_${counter}` }; },
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: threadId.startsWith("thr_architect_hub") ? SELF_REPAIR_DEFAULTS.projectId : projectId, archivedAt: options.archived?.() ? 1 : null }),
      },
      projects: { get: async ({ projectId: id }: { projectId: string }) => ({ id, name: "Arch project", sources: options.sources ?? [{ hostId: "host_arch", path: "/work/arch" }] }) },
      plugins: { callRpc: async ({ method, input }: { method: string; input: Record<string, unknown> }) => { if (method === "thread_place") { placed.push(input); return { ok: true }; } throw new Error(`unexpected rpc ${method}`); } },
    } as never,
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const rpc = async (input: Record<string, unknown>) => await harness.behavior.callRpc("workflow_architect_start", input) as { threadId: string; projectId: string; reused: boolean };
  return { bb, harness, spawned, placed, rpc };
}

describe("workflow_architect_start", () => {
  it("is part of the contract", () => {
    expect(Object.keys(rpcContract)).toContain("workflow_architect_start");
  });

  it("spawns an architect session: claude-code, Opus 5.5, high, standard speed sent explicitly, in the project's own folder", async () => {
    const { bb, spawned, rpc } = await setup();
    const started = await rpc({ projectId });
    expect(started).toEqual({ threadId: "thr_architect_1", projectId, reused: false });
    const args = spawned[0]!;
    expect(args).toMatchObject({
      projectId, providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default", title: "Архитектор цепочек", visibility: "visible",
      environment: { type: "host", hostId: "host_arch", workspace: { type: "unmanaged", path: "/work/arch" } },
      executionInputSources: { providerId: "explicit", model: "explicit", reasoningLevel: "explicit", serviceTier: "explicit" },
    });
    expect(args.pluginMetadata).toMatchObject({ role: "workflow-architect", architectProjectId: projectId });
    // The first message carries the profile token of the architect (the dispatch hook binds the session from it) and an agent-only brief.
    const [token] = tokensFrom(args.input);
    expect(await bb.storage.kv.get(`native-selection:${token}`)).toMatchObject({ agentId: "workflow-architect", projectId });
    expect(args.input[0]).toMatchObject({ type: "text" });
    expect(args.input[0].visibility).toBeUndefined();
    expect(args.input[1]).toMatchObject({ visibility: "agent-only" });
    expect(args.input[1].text).toContain("greeting");
  });

  it("returns the live architect chat of the project instead of a second one, also for a double click", async () => {
    const { spawned, rpc } = await setup();
    const [first, second] = await Promise.all([rpc({ projectId }), rpc({ projectId })]);
    expect(second.threadId).toBe(first.threadId);
    expect(spawned).toHaveLength(1);
    const again = await rpc({ projectId });
    expect(again).toEqual({ threadId: first.threadId, projectId, reused: true });
    expect(spawned).toHaveLength(1);
  });

  it("starts a new chat when the earlier one is archived", async () => {
    let archived = false;
    const { spawned, rpc } = await setup({ archived: () => archived });
    const first = await rpc({ projectId });
    archived = true;
    const second = await rpc({ projectId });
    expect(second.threadId).not.toBe(first.threadId);
    expect(spawned).toHaveLength(2);
  });

  it("continues a draft: the project is the draft's and the brief names it", async () => {
    const { harness, spawned, rpc } = await setup();
    // A draft made by the architect's tool in a chat of the project.
    const created = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_workflow_draft_create", { name: "Digest", description: "Weekly digest" }, { threadId: "thr_other", projectId }))) as { draftId: string };
    const started = await rpc({ draftId: created.draftId });
    expect(started.projectId).toBe(projectId);
    expect(spawned[0]!.input[1].text).toContain(created.draftId);
    expect(spawned[0]!.pluginMetadata).toMatchObject({ architectDraftId: created.draftId });
    // A chat for the draft is not the chat of the project's empty start.
    const plain = await rpc({ projectId });
    expect(plain.threadId).not.toBe(started.threadId);
    await expect(rpc({ draftId: "draft_missing" })).rejects.toThrow(/does not exist/);
  });

  it("without a project uses the Lane Pilot project of the hub, and files the chat in the given section", async () => {
    const { spawned, placed, rpc } = await setup();
    const started = await rpc({ sectionId: "section_1" });
    expect(started.projectId).toBe(SELF_REPAIR_DEFAULTS.projectId);
    expect(spawned[0]!.projectId).toBe(SELF_REPAIR_DEFAULTS.projectId);
    expect(placed).toEqual([{ threadId: "thr_architect_1", projectId: SELF_REPAIR_DEFAULTS.projectId, folderId: "section_1" }]);
  });

  it("says plainly when the project has no folder on a machine", async () => {
    const { spawned, rpc } = await setup({ sources: [] });
    await expect(rpc({ projectId })).rejects.toThrow(/no source folder/);
    expect(spawned).toHaveLength(0);
  });
});
