import { createFakePluginHost, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createProviderRetryGuard } from "../../src/rooms/stability/server/provider-retry";

type Row = ReturnType<typeof makeQueueEntry>;
const retryRow = (id: string, threadId: string): Row => makeQueueEntry({ id, threadId, sendAt: Date.now() + 3600_000, payload: { kind: "retry", attempt: 1, reason: "Rate limited", retryOfTurnRequestId: "req-1" } });
const inlineRow = (id: string, threadId: string): Row => makeQueueEntry({ id, threadId, payload: { kind: "inline" } });

function setup(rows: Row[], options: { listFails?: boolean; deleteFails?: boolean } = {}) {
  const deleted: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      queue: { list: async ({ threadId }: { threadId?: string }) => {
        if (options.listFails) throw new Error("queue unavailable");
        return rows.filter((row) => !threadId || row.threadId === threadId);
      } },
      queuedMessages: { delete: async ({ queuedMessageId }: { queuedMessageId: string }) => {
        if (options.deleteFails) throw new Error("already sent");
        deleted.push(queuedMessageId);
        return { ok: true as const };
      } },
    } } as never,
  });
  return { guard: createProviderRetryGuard(bb), harness, deleted };
}

describe("provider-retry guard", () => {
  it("deletes the retry rows of an abandoned thread and nothing else", async () => {
    const { guard, deleted } = setup([retryRow("r1", "t1"), inlineRow("i1", "t1"), retryRow("r2", "t2"), retryRow("r3", "t1")]);
    expect(await guard.abandon("t1")).toBe(2);
    expect(deleted).toEqual(["r1", "r3"]);
  });

  it("cancels a retry the plugin queues after the thread was abandoned, and leaves other threads' retries alone", async () => {
    const { guard, harness, deleted } = setup([]);
    await guard.abandon("t1");
    await harness.emitThreadEvent("message.queued", { entry: retryRow("late", "t1") });
    await harness.emitThreadEvent("message.queued", { entry: retryRow("other", "t2") });
    await harness.emitThreadEvent("message.queued", { entry: inlineRow("typed", "t1") });
    expect(deleted).toEqual(["late"]);
  });

  it("does nothing without provider-retry's rows, and never throws when the queue or a delete fails", async () => {
    expect(await setup([]).guard.abandon("t1")).toBe(0);
    expect(await setup([retryRow("r1", "t1")], { listFails: true }).guard.abandon("t1")).toBe(0);
    const failing = setup([retryRow("r1", "t1")], { deleteFails: true });
    expect(await failing.guard.abandon("t1")).toBe(0);
    const late = await failing.harness.emitThreadEvent("message.queued", { entry: retryRow("r2", "t1") });
    expect(late.errors).toEqual([]);
    expect(await failing.guard.abandon(null)).toBe(0);
    expect(await failing.guard.abandon("")).toBe(0);
  });
});
