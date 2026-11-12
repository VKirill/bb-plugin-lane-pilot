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
  mountHandoff({ bb, db, log: () => undefined, isDisposed: () => false }, { activate: activate as never });
  const call = async (params: Record<string, unknown>) =>
    JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_handoff_create", { runId, title: "t", objective: "o", acceptance: ["a"], ...params }, { threadId: pmThreadId, projectId }))) as Record<string, any>;
  return { db, harness, sent, activate, call };
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("handoff into another project", () => {
  it("starts a PM chat in the target project and sends the card as its first message", async () => {
    const { db, harness, sent, activate, call } = await setup();
    dispose = () => harness.lifecycle.dispose();

    const created = await call({ targetProjectId: target, targetSectionId: "sec-1" });
    expect(activate).toHaveBeenCalledWith(target, null, "bb", undefined, undefined, { sectionId: "sec-1" });
    expect(created.deliveredTo).toBe("thr-new");
    expect(created.targetProjectId).toBe(target);
    expect(created.handoff).toMatchObject({ state: "delivered", toAgent: "lane-pilot-pm", recipientThreadId: "thr-new" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: "thr-new", senderThreadId: pmThreadId });
    expect(sent[0]!.text).toContain(`Handoff ${created.handoff.id}`);
    expect(sent[0]!.text).toContain(`project ${projectId}`);
    // The record is the source project's: list and receipt see it.
    expect(getHandoff(db, created.handoff.id)?.card).toMatchObject({ projectId, ownerThreadId: pmThreadId });
    expect(listHandoffs(db, { projectId }).map((row) => row.card.id)).toEqual([created.handoff.id]);
  });

  it("refuses a project without Lane Pilot setup and says what the owner does", async () => {
    const { db, harness, sent, activate, call } = await setup({ configured: false });
    dispose = () => harness.lifecycle.dispose();

    const refused = await call({ targetProjectId: target });
    expect(refused).toMatchObject({ ok: false, error: { sideEffects: "none" } });
    expect(refused.error.message).toMatch(/not set up in project other-project.*owner has to enable Lane Pilot/s);
    expect(activate).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
    expect(listHandoffs(db, { projectId })).toEqual([]);
  });

  it("points at the existing PM thread when the target project already has one", async () => {
    const { db, harness, activate, call } = await setup();
    dispose = () => harness.lifecycle.dispose();
    createRun(db, "run-t", target);
    setRunThread(db, "run-t", "thr-existing");
    claimActivation(db, { projectId: target, pmThreadId: "thr-existing", runId: "run-t" });

    const refused = await call({ targetProjectId: target });
    expect(refused.error.message).toContain('recipientThreadId "thr-existing"');
    expect(activate).not.toHaveBeenCalled();
  });

  it("cancels the record when the PM chat cannot start", async () => {
    const { db, harness, sent, call } = await setup({ activateFails: true });
    dispose = () => harness.lifecycle.dispose();

    const failed = await call({ targetProjectId: target });
    expect(failed.error.message).toMatch(/could not start a PM chat.*spawn refused/);
    expect(sent).toEqual([]);
    expect(listHandoffs(db, { projectId }).map((row) => row.card.state)).toEqual(["canceled"]);
  });

  it("rejects the project's own id and a thread together with a project", async () => {
    const { harness, activate, call } = await setup();
    dispose = () => harness.lifecycle.dispose();

    expect((await call({ targetProjectId: projectId })).error.message).toMatch(/own project/);
    await expect(call({ targetProjectId: target, recipientThreadId: "x" })).rejects.toThrow(/not both/);
    await expect(call({ targetSectionId: "s" })).rejects.toThrow(/needs targetProjectId/);
    expect(activate).not.toHaveBeenCalled();
  });
});
