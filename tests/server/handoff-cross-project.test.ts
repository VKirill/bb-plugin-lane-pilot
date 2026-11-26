import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimActivation, createRun, savePrototypeConfig, setRunThread } from "../../src/rooms/storage";
import { openDatabase } from "../../src/rooms/plugin-db";
import { mountHandoff } from "../../src/rooms/relay/server";
import { getHandoff, listHandoffs } from "@lane-pilot/handoff";

const projectId = "src-project";
const pmThreadId = "src-pm";
const runId = "src-run";
const target = "other-project";

type Sent = { threadId: string; text: string; senderThreadId?: string };

async function setup(options: { configured?: boolean; activateFails?: boolean } = {}) {
  const sent: Sent[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        send: async (args: { threadId: string; senderThreadId?: string; input: ReadonlyArray<{ type: string; text?: string }> }) => {
          sent.push({ threadId: args.threadId, senderThreadId: args.senderThreadId, text: args.input.map((item) => ("text" in item ? item.text : "") ?? "").join("") });
          return { ok: true } as never;
        },
      },
    },
  });
  const db = openDatabase(bb);
  createRun(db, runId, projectId);
  setRunThread(db, runId, pmThreadId);
  if (options.configured !== false) {
    savePrototypeConfig(db, { projectId: target, hostId: "h1", pmWorkspacePath: "/w", writerWorkspacePath: "/w", pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "m" } as never);
  }
  const activate = vi.fn(async (..._args: unknown[]) => {
    if (options.activateFails) throw new Error("spawn refused");
    return { threadId: "thr-new", runId: "run-new" };
  });
  mountHandoff({ bb, db, log: () => undefined, isDisposed: () => false }, { startChild: activate as never });
  const call = async (params: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_handoff_create", { runId, title: "t", objective: "o", acceptance: ["a"], ...params }, { threadId: pmThreadId, projectId }))) as Record<string, any>;
  return { db, harness, sent, activate, call };
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("handoff into another project", () => {
  it("starts a PM chat in the target project and delivers the card", async () => {
    const { db, harness, sent, activate, call } = await setup();
    dispose = () => harness.lifecycle.dispose();

    const created = await call({ targetProjectId: target, targetSectionId: "sec-1" });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ projectId: target, parentThreadId: pmThreadId, sectionId: "sec-1" }));
    expect(created.deliveredTo).toBe("thr-new");
    expect(created.targetProjectId).toBe(target);
    expect(created.handoff).toMatchObject({ state: "delivered", toAgent: "lane-pilot-pm", recipientThreadId: "thr-new" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: "thr-new", senderThreadId: pmThreadId });
    expect(sent[0]!.text).toContain("as an agent assignment");
    expect(created.message).toContain(`Handoff ${created.handoff.id}`);
    expect(created.message).toContain(`project ${projectId}`);
    // The record is the source project's: list and receipt see it.
    expect(getHandoff(db, created.handoff.id)?.card).toMatchObject({ projectId, ownerThreadId: pmThreadId });
    expect(listHandoffs(db, { projectId }).map((row) => row.card.id)).toEqual([created.handoff.id]);
  });

  it("starts a child without requiring prior Lane Pilot setup", async () => {
    const { db, harness, activate, call } = await setup({ configured: false });
    dispose = () => harness.lifecycle.dispose();

    const created = await call({ targetProjectId: target });
    expect(created.deliveredTo).toBe("thr-new");
    expect(activate).toHaveBeenCalledOnce();
    expect(listHandoffs(db, { projectId })).toHaveLength(1);
  });

  it("can create a separate child even when the destination has an active PM", async () => {
    const { db, harness, activate, call } = await setup();
    dispose = () => harness.lifecycle.dispose();
    createRun(db, "run-t", target);
    setRunThread(db, "run-t", "thr-existing");
    claimActivation(db, { projectId: target, pmThreadId: "thr-existing", runId: "run-t" });

    const created = await call({ targetProjectId: target });
    expect(created.deliveredTo).toBe("thr-new");
    expect(activate).toHaveBeenCalledOnce();
  });

  it("cancels the record when the PM chat cannot start", async () => {
    const { db, harness, sent, call } = await setup({ activateFails: true });
    dispose = () => harness.lifecycle.dispose();

    const failed = await call({ targetProjectId: target });
    expect(failed.error.message).toMatch(/could not complete child Pilot handoff.*spawn refused/);
    expect(sent).toEqual([]);
    expect(listHandoffs(db, { projectId }).map((row) => row.card.state)).toEqual(["canceled"]);
  });

  it("supports its own project but rejects contradictory target selectors", async () => {
    const { harness, activate, call } = await setup();
    dispose = () => harness.lifecycle.dispose();

    expect((await call({ targetProjectId: projectId })).deliveredTo).toBe("thr-new");
    await expect(call({ targetProjectId: target, recipientThreadId: "x" })).rejects.toThrow(/not both/);
    await expect(call({ targetSectionId: "s" })).rejects.toThrow(/needs targetProjectId/);
    expect(activate).toHaveBeenCalledOnce();
  });
});
