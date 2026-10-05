import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, setRunThread } from "../../src/database";
import { getHandoff } from "@lane-pilot/handoff";

const projectId = "handoff-project";
const pmThreadId = "handoff-pm";
const runId = "handoff-run";

type Sent = { threadId: string; text: string };

async function setup() {
  const sent: Sent[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
        send: async (args: { threadId: string; input: Array<{ type: string; text?: string }> }) => {
          sent.push({ threadId: args.threadId, text: args.input.map((item) => item.text ?? "").join("") });
          return { ok: true } as never;
        },
      },
    },
  });
  await plugin(bb);
  const db = openDatabase(bb);
  createRun(db, runId, projectId);
  setRunThread(db, runId, pmThreadId);
  const call = async (name: string, params: Record<string, unknown>, threadId = pmThreadId) =>
    JSON.parse(String(await harness.behavior.callAgentTool(name, params, { threadId, projectId }))) as Record<string, any>;
  return { db, harness, sent, call };
}

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

describe("handoff tools", () => {
  it("creates a card for a named agent, delivers it into a thread and records the receipt from the output", async () => {
    const { db, harness, sent, call } = await setup();
    dispose = () => harness.lifecycle.dispose();

    const created = await call("lane_pilot_handoff_create", {
      runId, toAgent: "copy-lead", title: "Checkout language", objective: "Collect customer phrases about checkout.",
      acceptance: ["20 phrases with sources"], recipientThreadId: "thr-copy", deadlineMinutes: 30,
    });
    const id = created.handoff.id as string;
    expect(created.handoff).toMatchObject({ state: "delivered", toAgent: "copy-lead", recipientThreadId: "thr-copy" });
    expect(created.chosenBy).toBe("caller");
    expect(sent).toEqual([{ threadId: "thr-copy", text: expect.stringContaining(`Handoff ${id} from lane-pilot-pm`) }]);
    expect(getHandoff(db, id)?.card.deadlineAt).toBeGreaterThan(Date.now());

    const output = `Collected.\n\`\`\`json\n{"handoff":"${id}","status":"done","summary":"24 phrases","outputs":[".agents/copy/checkout.md"],"evidence":["counted"]}\n\`\`\``;
    const receipt = await call("lane_pilot_handoff_receipt", { runId, handoffId: id, output });
    expect(receipt.handoff).toMatchObject({ state: "done", receipt: { status: "done", outputs: [".agents/copy/checkout.md"] } });
    expect(receipt.events.map((event: { to: string }) => event.to)).toEqual(["queued", "delivered", "accepted", "in_progress", "done"]);

    const listed = await call("lane_pilot_handoff_list", { runId, states: ["done"] });
    expect(listed.handoffs.map((item: { id: string }) => item.id)).toEqual([id]);
  });

  it("chooses the recipient from the registry and hands the card back to the caller when no thread is named", async () => {
    const { harness, sent, call } = await setup();
    dispose = () => harness.lifecycle.dispose();

    const created = await call("lane_pilot_handoff_create", {
      runId, request: "cluster the Yandex Direct queries by intent and map them to cabinet features",
      title: "Demand map", objective: "Map Direct queries to features.", acceptance: ["clusters with counts"],
    });
    expect(created.chosenBy).toBe("registry");
    expect(created.handoff.toAgent).toBe("seo-specialist");
    expect(created.deliveredTo).toBe("caller");
    expect(created.handoff.recipientThreadId).toBe(pmThreadId);
    expect(sent).toEqual([]);
    expect(created.message).toContain("## How to answer");
  });

  it("refuses a run that does not belong to the calling PM thread and a receipt without a block", async () => {
    const { harness, call } = await setup();
    dispose = () => harness.lifecycle.dispose();

    const listed = await call("lane_pilot_handoff_list", { runId }, "someone-else");
    expect(listed).toMatchObject({ ok: false, error: { code: "not_found", retryable: false, sideEffects: "none" } });
    expect(listed.error.message).toMatch(/does not belong/);
    const created = await call("lane_pilot_handoff_create", { runId, toAgent: "design-lead", title: "t", objective: "o", acceptance: ["a"] });
    const receipt = await call("lane_pilot_handoff_receipt", { runId, handoffId: created.handoff.id, output: "no block here" });
    expect(receipt).toMatchObject({ ok: false, error: { retryable: false, sideEffects: "none" } });
    expect(receipt.error.message).toMatch(/no receipt block/);
  });
});
