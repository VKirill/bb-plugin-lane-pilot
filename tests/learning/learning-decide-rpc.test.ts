import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { openDatabase } from "../../src/rooms/plugin-db";
import { getItem, insertItem } from "../../src/rooms/learning/store";
import { collectOwnerWaiting } from "../../src/rooms/owner-waiting";

// F-006.5 (Gemini grill): a `learning:<id>` row of the owner's list had actions with a `cli` line and no `rpc`, so the screen showed a
// sentence where every other row had buttons. `learning_decide` gives the row real buttons.

describe("learning_decide on the owner's list", () => {
  let dispose: (() => Promise<void> | void) | null = null;
  afterEach(async () => { await dispose?.(); dispose = null; });

  async function start() {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    insertItem(db, { id: "lrn_a", obsId: "thr_1:1:0", projectId: "project-a", threadId: "thr_1", kind: "preference",
      text: "Prefer short answers", audience: null, reach: "owner", dueAt: null, state: "pending_owner", target: "bb-memory",
      evidence: "owner message thr_1:1:0 «prefer short answers»", duplicateOf: null, confirmations: 0, note: null,
      createdAt: Date.now(), decidedAt: null, announcedAt: null } as never);
    return { harness, db, rpc: async (method: string, input: Record<string, unknown>) => await harness.behavior.callRpc(method, input) as Record<string, unknown> };
  }

  it("rejects a waiting item from a button and the row leaves the owner's list", async () => {
    const { rpc, db } = await start();
    const before = collectOwnerWaiting(db);
    const row = before.items.find((item) => item.key === "learning:lrn_a")!;
    expect(row.actions.map((action) => action.rpc?.method)).toEqual(["learning_decide", "learning_decide"]);
    expect(row.actions.map((action) => action.rpc?.input)).toEqual([
      { id: "lrn_a", action: "accept" },
      { id: "lrn_a", action: "reject" },
    ]);
    expect(await rpc("learning_decide", { id: "lrn_a", action: "reject" })).toMatchObject({ ok: true });
    expect(getItem(db, "lrn_a")!.state).toBe("rejected");
    expect(collectOwnerWaiting(db).items.some((item) => item.key === "learning:lrn_a")).toBe(false);
  });

  it("answers { ok: false, reason } for an id the room does not know (the screen toasts it, like lead_decide)", async () => {
    const { rpc } = await start();
    expect(await rpc("learning_decide", { id: "lrn_ghost", action: "accept" })).toMatchObject({ ok: false, reason: expect.stringContaining("lrn_ghost") });
  });
});
