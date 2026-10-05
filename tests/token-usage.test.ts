import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database";
import plugin from "../server";
import { TOKEN_USAGE_SCHEDULE, queryTokenUsage, syncTokenUsage, tokenDelta, utcDay } from "../src/server/token-usage";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const day = utcDay(Date.now());
const last = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14 };
const usage = (seq: number, tokenUsage: unknown, extra: Record<string, unknown> = {}) => ({
  seq, createdAt: Date.now(), type: "thread/tokenUsage/updated", data: { tokenUsage, ...extra },
});

function host(events: Record<string, unknown[]>, threads: Array<Record<string, unknown>> = [{ id: "thr_a", projectId: "proj_a", providerId: "codex" }]) {
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      projects: { list: async () => [{ id: "proj_a", name: "A" }] },
      threads: {
        list: async () => threads,
        events: { list: async ({ threadId, afterSeq }: { threadId: string; afterSeq?: string }) => {
          const after = afterSeq ? Number(afterSeq) : 0;
          return (events[threadId] ?? []).filter((event) => Number((event as { seq?: number }).seq ?? 0) > after);
        } },
      },
    } as never,
  });
  return { bb, db: openDatabase(bb) };
}

describe("token deltas", () => {
  const zero = { input: 0, output: 0, cached: 0, total: 0 };
  it("uses last as the per-turn delta and does not add cumulative totals", () => {
    const first = tokenDelta({ last: { input: 10, output: 4, cached: 2, total: 14 }, total: { input: 10, output: 4, cached: 2, total: 14 } }, { last: zero, total: zero, turnId: "" });
    const second = tokenDelta({ last: { input: 6, output: 2, cached: 1, total: 8 }, total: { input: 16, output: 6, cached: 3, total: 22 } }, { last: first, total: { input: 10, output: 4, cached: 2, total: 14 }, turnId: "" });
    expect(first).toEqual({ input: 10, output: 4, cached: 2, total: 14 });
    expect(second).toEqual({ input: 6, output: 2, cached: 1, total: 8 });
    expect(first.total + second.total).toBe(22);
  });
  it("falls back to consecutive totals when last is missing and never sums totals", () => {
    const first = tokenDelta({ total: { input: 100, output: 20, cached: 10, total: 120 } }, { last: zero, total: zero, turnId: "" });
    const second = tokenDelta({ total: { input: 250, output: 50, cached: 20, total: 300 } }, { last: zero, total: first, turnId: "" });
    const again = tokenDelta({ total: { input: 250, output: 50, cached: 20, total: 300 } }, { last: zero, total: { input: 250, output: 50, cached: 20, total: 300 }, turnId: "" });
    expect(first).toEqual({ input: 100, output: 20, cached: 10, total: 120 });
    expect(second).toEqual({ input: 150, output: 30, cached: 10, total: 180 });
    expect(again).toEqual(zero);
    expect(first.total + second.total).toBe(300);
  });
  it("does not recount last when the same last is re-emitted with a higher total", () => {
    const first = tokenDelta({ last: { input: 10, output: 4, cached: 2, total: 14 }, total: { input: 10, output: 4, cached: 2, total: 14 } }, { last: zero, total: zero, turnId: "" });
    const repeat = tokenDelta({ last: { input: 10, output: 4, cached: 2, total: 14 }, total: { input: 20, output: 8, cached: 4, total: 28 } }, { last: first, total: first, turnId: "" });
    expect(repeat).toEqual({ input: 10, output: 4, cached: 2, total: 14 });
  });
});

describe("token usage sync", () => {
  it("counts each event once across repeated syncs and takes model from turn start", async () => {
    const events = {
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/start", data: { request: { method: "turn/start", params: { options: { model: "gpt-5" } } } } },
        usage(2, { last, total: last }),
        usage(3, { last: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0, totalTokens: 6 }, total: { inputTokens: 15, outputTokens: 5, cachedInputTokens: 2, totalTokens: 20 } }),
      ],
    };
    const { bb, db } = host(events, [{ id: "thr_a", projectId: "proj_a", providerId: "codex" }, { id: "thr_b", projectId: "proj_a", providerId: "claude-code" }]);
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    const result = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(result.byModel).toEqual([
      { providerId: "codex", model: "gpt-5", input: 15, output: 5, cached: 2, total: 20 },
    ]);
    expect(result.noDataProviders).toEqual(["claude-code"]);
    expect(result.series.find((row) => row.day === day)?.models).toEqual([
      { providerId: "codex", model: "gpt-5", total: 20 },
    ]);
    expect(result.lastSyncAt).toEqual(expect.any(Number));
  });

  it("uses consecutive totals when last is absent and does not double on a second sync", async () => {
    const events = {
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/start", data: { execution: { model: "opus" } } },
        usage(2, { total: { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40, totalTokens: 110 } }),
        usage(3, { total: { inputTokens: 250, outputTokens: 30, cachedInputTokens: 80, totalTokens: 280 } }),
      ],
    };
    const { bb, db } = host(events);
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    const first = await queryTokenUsage({ bb, db }, { range: "7d" });
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    const second = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(first.byModel[0]).toMatchObject({ model: "opus", input: 250, output: 30, cached: 80, total: 280 });
    expect(second.byModel).toEqual(first.byModel);
  });
});

describe("token usage schedule", () => {
  it("returns while a sync still runs, so other schedules keep their turn", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: { list: () => new Promise(() => {}) } } as never,
    });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();
    const settled = (name: string) => Promise.race([
      harness.runSchedule(name).then(() => "returned"),
      new Promise((done) => setTimeout(() => done("held"), 200)),
    ]);
    expect(await settled(TOKEN_USAGE_SCHEDULE)).toBe("returned");
    expect(await settled(TOKEN_USAGE_SCHEDULE)).toBe("returned");
  });
});
