import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../src/database";
import plugin from "../server";
import { costUsd } from "../src/model-prices";
import {
  EVENT_PAGE, TOKEN_USAGE_CACHE_SPLIT_RESET_KEY, TOKEN_USAGE_CURSOR_RESET_KEY, TOKEN_USAGE_EVENT_TYPES, TOKEN_USAGE_SCHEDULE,
  normalizeModel, queryTokenUsage, syncTokenUsage, tokenDelta, utcDay,
} from "../src/server/token-usage";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const day = utcDay(Date.now());
const last = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14 };
const usage = (seq: number, tokenUsage: unknown, extra: Record<string, unknown> = {}) => ({
  seq, createdAt: Date.now(), type: "thread/tokenUsage/updated", data: { tokenUsage, ...extra },
});

type ListArgs = { threadId: string; afterSeq?: string; types?: readonly string[]; order?: string; limit?: string };

function host(
  events: Record<string, unknown[]>,
  threads: Array<Record<string, unknown>> = [{ id: "thr_a", projectId: "proj_a", providerId: "codex" }],
  extra: { failThread?: string; projects?: Array<Record<string, unknown>> } = {},
) {
  const listed: ListArgs[] = [];
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      projects: { list: async () => extra.projects ?? [{ id: "proj_a", name: "A" }] },
      threads: {
        list: async () => threads,
        events: { list: async (args: ListArgs) => {
          listed.push(args);
          const limit = Number(args.limit);
          if (!Number.isFinite(limit) || limit > 100) throw new Error("HTTP 400: limit exceeds 100");
          if (extra.failThread && args.threadId === extra.failThread) throw new Error("events_list_error:boom");
          const after = args.afterSeq ? Number(args.afterSeq) : 0;
          const allowed = new Set(args.types ?? []);
          return (events[args.threadId] ?? []).filter((event) => {
            const seq = Number((event as { seq?: number }).seq ?? 0);
            const type = String((event as { type?: string }).type ?? "");
            if (seq <= after) return false;
            if (allowed.size && !allowed.has(type)) return false;
            return true;
          }).slice(0, limit);
        } },
      },
    } as never,
  });
  return { bb, db: openDatabase(bb), listed };
}

describe("token deltas", () => {
  const zero = { input: 0, output: 0, cached: 0, total: 0, cacheRead: 0, cacheWrite: 0 };
  it("uses last as the per-turn delta and does not add cumulative totals", () => {
    const first = tokenDelta({ last: { input: 10, output: 4, cached: 2, total: 14, cacheRead: 0, cacheWrite: 0 }, total: { input: 10, output: 4, cached: 2, total: 14, cacheRead: 0, cacheWrite: 0 } }, { last: zero, total: zero, turnId: "" });
    const second = tokenDelta({ last: { input: 6, output: 2, cached: 1, total: 8, cacheRead: 0, cacheWrite: 0 }, total: { input: 16, output: 6, cached: 3, total: 22, cacheRead: 0, cacheWrite: 0 } }, { last: first, total: { input: 10, output: 4, cached: 2, total: 14, cacheRead: 0, cacheWrite: 0 }, turnId: "" });
    expect(first).toEqual({ input: 10, output: 4, cached: 2, total: 14, cacheRead: 0, cacheWrite: 0 });
    expect(second).toEqual({ input: 6, output: 2, cached: 1, total: 8, cacheRead: 0, cacheWrite: 0 });
    expect(first.total + second.total).toBe(22);
  });
  it("falls back to consecutive totals when last is missing and never sums totals", () => {
    const first = tokenDelta({ total: { input: 100, output: 20, cached: 10, total: 120, cacheRead: 0, cacheWrite: 0 } }, { last: zero, total: zero, turnId: "" });
    const second = tokenDelta({ total: { input: 250, output: 50, cached: 20, total: 300, cacheRead: 0, cacheWrite: 0 } }, { last: zero, total: first, turnId: "" });
    const again = tokenDelta({ total: { input: 250, output: 50, cached: 20, total: 300, cacheRead: 0, cacheWrite: 0 } }, { last: zero, total: { input: 250, output: 50, cached: 20, total: 300, cacheRead: 0, cacheWrite: 0 }, turnId: "" });
    expect(first).toEqual({ input: 100, output: 20, cached: 10, total: 120, cacheRead: 0, cacheWrite: 0 });
    expect(second).toEqual({ input: 150, output: 30, cached: 10, total: 180, cacheRead: 0, cacheWrite: 0 });
    expect(again).toEqual(zero);
    expect(first.total + second.total).toBe(300);
  });
  it("does not recount last when the same last is re-emitted with a higher total", () => {
    const first = tokenDelta({ last: { input: 10, output: 4, cached: 2, total: 14, cacheRead: 0, cacheWrite: 0 }, total: { input: 10, output: 4, cached: 2, total: 14, cacheRead: 0, cacheWrite: 0 } }, { last: zero, total: zero, turnId: "" });
    const repeat = tokenDelta({ last: { input: 10, output: 4, cached: 2, total: 14, cacheRead: 0, cacheWrite: 0 }, total: { input: 20, output: 8, cached: 4, total: 28, cacheRead: 0, cacheWrite: 0 } }, { last: first, total: first, turnId: "" });
    expect(repeat).toEqual({ input: 10, output: 4, cached: 2, total: 14, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("token usage sync", () => {
  it("lists with the real SDK call shape and counts each event once", async () => {
    const events = {
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "gpt-5", providerId: "codex" } } },
        usage(2, { last, total: last }),
        usage(3, { last: { inputTokens: 5, outputTokens: 1, cachedInputTokens: 0, totalTokens: 6 }, total: { inputTokens: 15, outputTokens: 5, cachedInputTokens: 2, totalTokens: 20 } }),
      ],
    };
    const { bb, db, listed } = host(events, [{ id: "thr_a", projectId: "proj_a", providerId: "codex" }, { id: "thr_b", projectId: "proj_a", providerId: "claude-code" }]);
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    expect(listed[0]).toMatchObject({
      threadId: "thr_a", order: "asc", limit: String(EVENT_PAGE), types: [...TOKEN_USAGE_EVENT_TYPES],
    });
    expect(listed[0]?.afterSeq).toBeUndefined();
    const result = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(result.byModel).toEqual([
      { providerId: "codex", model: "gpt-5", input: 15, output: 5, cached: 2, total: 20, costUsd: null },
    ]);
    expect(result.costUsd).toBeNull();
    expect(result.noDataProviders).toEqual(["claude-code"]);
    expect(result.series.find((row) => row.day === day)?.models).toEqual([
      { providerId: "codex", model: "gpt-5", total: 20 },
    ]);
    expect(result.lastSyncAt).toEqual(expect.any(Number));
    expect(result.diagnostics).toMatchObject({ threadsSeen: 2, threadsWithUsage: 1, threadsFailed: 0, lastError: null });
    expect(result.months).toContain(day.slice(0, 7));
  });

  it("takes the model from client/turn/requested execution.model", async () => {
    const { bb, db } = host({
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "gpt-5.4" } } },
        usage(2, { last, total: last }),
      ],
    });
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    expect((await queryTokenUsage({ bb, db }, { range: "7d" })).byModel[0]?.model).toBe("gpt-5.4");
  });

  it("falls back to client/thread/start then provider/modelFallback", async () => {
    const startHost = host({
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/thread/start", data: { request: { method: "thread/start", params: { model: "opus" } } } },
        usage(2, { last, total: last }),
      ],
    });
    await syncTokenUsage({ bb: startHost.bb, db: startHost.db }, { sinceDays: 90 });
    expect((await queryTokenUsage({ bb: startHost.bb, db: startHost.db }, { range: "7d" })).byModel[0]?.model).toBe("opus");

    const fallbackHost = host({
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "provider/modelFallback", data: { fallbackModel: "sonnet", originalModel: "opus" } },
        usage(2, { last, total: last }),
      ],
    });
    await syncTokenUsage({ bb: fallbackHost.bb, db: fallbackHost.db }, { sinceDays: 90 });
    expect((await queryTokenUsage({ bb: fallbackHost.bb, db: fallbackHost.db }, { range: "7d" })).byModel[0]?.model).toBe("sonnet");
  });

  it("does not advance the cursor when listing fails, counts threadsFailed, and logs the first error once", async () => {
    const events = {
      thr_ok: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "gpt-5" } } },
        usage(2, { last, total: last }),
      ],
      thr_fail: [usage(1, { last, total: last })],
    };
    const threads = [
      { id: "thr_ok", projectId: "proj_a", providerId: "codex" },
      { id: "thr_fail", projectId: "proj_a", providerId: "codex" },
    ];
    const { bb, db } = host(events, threads, { failThread: "thr_fail" });
    const warns: string[] = [];
    const original = bb.log.warn.bind(bb.log);
    bb.log.warn = ((message: string) => {
      warns.push(message);
      original(message);
    }) as typeof bb.log.warn;
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    const failCursor = db.prepare(`SELECT last_seq FROM lane_pilot_token_cursor WHERE thread_id=?`).get("thr_fail") as { last_seq: number } | undefined;
    expect(failCursor).toBeUndefined();
    const okCursor = db.prepare(`SELECT last_seq FROM lane_pilot_token_cursor WHERE thread_id=?`).get("thr_ok") as { last_seq: number };
    expect(okCursor.last_seq).toBe(2);
    const result = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(result.byModel[0]?.total).toBe(14);
    expect(result.diagnostics.threadsSeen).toBe(2);
    expect(result.diagnostics.threadsWithUsage).toBe(1);
    expect(result.diagnostics.threadsFailed).toBe(1);
    expect(result.diagnostics.lastError).toContain("events_list_error:boom");
    expect(warns.filter((line) => line.includes("token usage listing failed")).length).toBe(2);
    expect(warns.filter((line) => line.includes("events_list_error:boom")).length).toBe(2);
  });

  it("resets 0.1.151 cursors once so a 90-day pass backfills, and does not reset again", async () => {
    const { bb, db } = host({
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "gpt-5" } } },
        usage(2, { last, total: last }),
      ],
    });
    db.prepare(`INSERT INTO lane_pilot_token_cursor
      (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at)
      VALUES ('thr_a','proj_a','codex',99,'{}','{}','','codex','',0)`).run();
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    const first = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(first.byModel[0]?.total).toBe(14);
    expect((db.prepare(`SELECT last_seq FROM lane_pilot_token_cursor WHERE thread_id='thr_a'`).get() as { last_seq: number }).last_seq).toBe(2);
    db.prepare(`UPDATE lane_pilot_token_cursor SET last_seq=99 WHERE thread_id='thr_a'`).run();
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    expect((db.prepare(`SELECT last_seq FROM lane_pilot_token_cursor WHERE thread_id='thr_a'`).get() as { last_seq: number }).last_seq).toBe(99);
    expect((await queryTokenUsage({ bb, db }, { range: "7d" })).byModel).toEqual(first.byModel);
  });

  it("uses consecutive totals when last is absent and does not double on a second sync", async () => {
    const events = {
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "opus" } } },
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
    events.thr_a.push(usage(4, { total: { inputTokens: 300, outputTokens: 40, cachedInputTokens: 90, totalTokens: 340 } }));
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    expect((await queryTokenUsage({ bb, db }, { range: "7d" })).byModel[0]).toMatchObject({
      model: "opus", input: 300, output: 40, cached: 90, total: 340,
    });
  });

  it("pages events at most 100 at a time and still collects every row", async () => {
    const turn = { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0, totalTokens: 1 };
    const rows: unknown[] = [
      { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "gpt-5" } } },
    ];
    const extra = 205;
    for (let i = 0; i < extra; i++) {
      rows.push(usage(i + 2, {
        last: turn,
        total: { inputTokens: i + 1, outputTokens: 0, cachedInputTokens: 0, totalTokens: i + 1 },
      }));
    }
    const { bb, db, listed } = host({ thr_a: rows });
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    expect(listed.every((call) => Number(call.limit) <= 100)).toBe(true);
    expect(listed.length).toBeGreaterThan(1);
    expect(listed.map((call) => call.limit)).toEqual(Array(listed.length).fill(String(EVENT_PAGE)));
    expect((await queryTokenUsage({ bb, db }, { range: "7d" })).byModel[0]).toMatchObject({
      model: "gpt-5", input: extra, output: 0, cached: 0, total: extra,
    });
  });

  it("aggregates spend by project with share and top model", async () => {
    const { bb, db } = host({
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "gpt-5" } } },
        usage(2, { last, total: last }),
      ],
      thr_b: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "opus" } } },
        usage(2, { last: { inputTokens: 6, outputTokens: 0, cachedInputTokens: 0, totalTokens: 6 }, total: { inputTokens: 6, outputTokens: 0, cachedInputTokens: 0, totalTokens: 6 } }),
      ],
    }, [
      { id: "thr_a", projectId: "proj_a", providerId: "codex" },
      { id: "thr_b", projectId: "proj_b", providerId: "claude-code" },
    ]);
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    const result = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(result.byProject).toEqual([
      { projectId: "proj_a", projectName: "A", total: 14, share: 0.7, topModel: "gpt-5", costUsd: null },
      { projectId: "proj_b", projectName: "proj_b", total: 6, share: 0.3, topModel: "opus", costUsd: null },
    ]);
    const one = await queryTokenUsage({ bb, db }, { range: "7d", projectId: "proj_b" });
    expect(one.byProject).toEqual([{ projectId: "proj_b", projectName: "proj_b", total: 6, share: 1, topModel: "opus", costUsd: null }]);
    expect(one.byModel[0]?.model).toBe("opus");
  });

  it("merges context-window variants at read time without rewriting stored rows", async () => {
    const { bb, db } = host({});
    const insert = db.prepare(`INSERT INTO lane_pilot_token_daily
      (day, project_id, provider_id, model, input_tokens, output_tokens, cached_tokens, total_tokens,
       uncached_tokens, cache_read_tokens, cache_write_tokens)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    insert.run(day, "proj_a", "claude-code", "claude-opus-5-5", 10, 4, 1, 14, 9, 1, 0);
    insert.run(day, "proj_a", "claude-code", "claude-opus-5-5[1m]", 20, 6, 2, 26, 18, 2, 0);
    insert.run(day, "proj_b", "claude-code", "claude-opus-5", 8, 2, 0, 10, 8, 0, 0);
    insert.run(day, "proj_b", "claude-code", "claude-opus-5[1m]", 12, 3, 1, 15, 11, 1, 0);
    insert.run(day, "proj_a", "codex", "gpt-5", 5, 1, 0, 6, 5, 0, 0);
    const stored = db.prepare(`SELECT model FROM lane_pilot_token_daily ORDER BY model`).all() as Array<{ model: string }>;
    const result = await queryTokenUsage({ bb, db }, { range: "7d" });
    const month = await queryTokenUsage({ bb, db }, { range: "month", month: day.slice(0, 7) });
    expect(stored.map((row) => row.model)).toEqual([
      "claude-opus-5", "claude-opus-5-5", "claude-opus-5-5[1m]", "claude-opus-5[1m]", "gpt-5",
    ]);
    const opus55 = costUsd("claude-opus-5-5", { uncached: 27, cacheRead: 3, cacheWrite: 0, output: 10 });
    const opus5 = costUsd("claude-opus-5", { uncached: 19, cacheRead: 1, cacheWrite: 0, output: 5 });
    expect(result.byModel).toEqual([
      { providerId: "claude-code", model: "claude-opus-5-5", input: 30, output: 10, cached: 3, total: 40, costUsd: opus55 },
      { providerId: "claude-code", model: "claude-opus-5", input: 20, output: 5, cached: 1, total: 25, costUsd: opus5 },
      { providerId: "codex", model: "gpt-5", input: 5, output: 1, cached: 0, total: 6, costUsd: null },
    ]);
    expect(result.series.find((row) => row.day === day)?.models).toEqual([
      { providerId: "claude-code", model: "claude-opus-5-5", total: 40 },
      { providerId: "claude-code", model: "claude-opus-5", total: 25 },
      { providerId: "codex", model: "gpt-5", total: 6 },
    ]);
    expect(result.byProject).toEqual([
      { projectId: "proj_a", projectName: "A", total: 46, share: 46 / 71, topModel: "claude-opus-5-5", costUsd: opus55 },
      { projectId: "proj_b", projectName: "proj_b", total: 25, share: 25 / 71, topModel: "claude-opus-5", costUsd: opus5 },
    ]);
    expect(month.byModel.reduce((sum, row) => sum + row.total, 0)).toBe(71);
    expect(month.byModel.map((row) => row.model)).toEqual(["claude-opus-5-5", "claude-opus-5", "gpt-5"]);
    expect(result.byModel.reduce((sum, row) => sum + row.total, 0)).toBe(71);
    expect(result.costUsd).toBeCloseTo((opus55 ?? 0) + (opus5 ?? 0), 10);
    expect(month.costUsd).toBeCloseTo((opus55 ?? 0) + (opus5 ?? 0), 10);
  });

  it("prices the hub claude-code sample as a positive hand-computed cost and leaves the codex sample on the 0.1.158 formula", async () => {
    const claudeUsage = {
      totalTokens: 397855, inputTokens: 2, cachedInputTokens: 397697,
      cacheReadInputTokens: 394582, cacheWriteInputTokens: 3115, outputTokens: 156,
    };
    const codexUsage = {
      totalTokens: 1474178, inputTokens: 1461386, cachedInputTokens: 1366016,
      cacheReadInputTokens: 1366016, cacheWriteInputTokens: 0, outputTokens: 12792,
    };
    const { bb, db } = host({
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "claude-opus-5-5", providerId: "claude-code" } } },
        usage(2, { last: claudeUsage, total: claudeUsage }),
      ],
      thr_b: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "gpt-6.1-sol", providerId: "codex" } } },
        usage(2, { last: codexUsage, total: codexUsage }),
      ],
    }, [
      { id: "thr_a", projectId: "proj_personal", providerId: "claude-code" },
      { id: "thr_b", projectId: "proj_a", providerId: "codex" },
    ], {
      projects: [{ id: "proj_a", name: "A" }, { id: "proj_personal", name: "Personal" }],
    });
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    const result = await queryTokenUsage({ bb, db }, { range: "7d" });
    const claudeCost = (2 * 4 + 394582 * 0.2 + 3115 * 5 + 156 * 20) / 1_000_000;
    const codexCost = ((1461386 - 1366016) * 2 + 1366016 * 0.1 + 12792 * 10) / 1_000_000;
    const claude = result.byModel.find((row) => row.model === "claude-opus-5-5");
    const codex = result.byModel.find((row) => row.model === "gpt-6.1-sol");
    expect(claude).toMatchObject({ input: 397699, output: 156, cached: 397697, total: 397855 });
    expect(claude?.costUsd).toBeCloseTo(claudeCost, 10);
    expect(claude?.costUsd).toBeGreaterThan(0);
    expect(codex).toMatchObject({ input: 1461386, output: 12792, cached: 1366016, total: 1474178 });
    expect(codex?.costUsd).toBeCloseTo(codexCost, 10);
    expect(result.byModel.every((row) => row.costUsd === null || row.costUsd >= 0)).toBe(true);
    expect(result.byProject.find((row) => row.projectId === "proj_personal")?.projectName).toBe("Personal");
    const stored = db.prepare(`SELECT uncached_tokens, cache_read_tokens, cache_write_tokens FROM lane_pilot_token_daily WHERE model='claude-opus-5-5'`).get() as {
      uncached_tokens: number; cache_read_tokens: number; cache_write_tokens: number;
    };
    expect(stored).toEqual({ uncached_tokens: 2, cache_read_tokens: 394582, cache_write_tokens: 3115 });
  });

  it("resets cursors once for the cache-split columns and does not reset again", async () => {
    const { bb, db } = host({
      thr_a: [
        { seq: 1, createdAt: Date.now(), type: "client/turn/requested", data: { execution: { model: "gpt-5" } } },
        usage(2, { last, total: last }),
      ],
    });
    await bb.storage.kv.set(TOKEN_USAGE_CURSOR_RESET_KEY, 1);
    db.prepare(`INSERT INTO lane_pilot_token_cursor
      (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at)
      VALUES ('thr_a','proj_a','codex',99,'{}','{}','','codex','',0)`).run();
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    expect((db.prepare(`SELECT last_seq FROM lane_pilot_token_cursor WHERE thread_id='thr_a'`).get() as { last_seq: number }).last_seq).toBe(2);
    expect(await bb.storage.kv.get(TOKEN_USAGE_CACHE_SPLIT_RESET_KEY)).toBe(1);
    db.prepare(`UPDATE lane_pilot_token_cursor SET last_seq=99 WHERE thread_id='thr_a'`).run();
    await syncTokenUsage({ bb, db }, { sinceDays: 90 });
    expect((db.prepare(`SELECT last_seq FROM lane_pilot_token_cursor WHERE thread_id='thr_a'`).get() as { last_seq: number }).last_seq).toBe(99);
  });
});

describe("normalizeModel", () => {
  it("strips a trailing context-window suffix and leaves other names", () => {
    expect(normalizeModel("claude-opus-5-5[1m]")).toBe("claude-opus-5-5");
    expect(normalizeModel("claude-opus-5[1m]")).toBe("claude-opus-5");
    expect(normalizeModel("gpt-5")).toBe("gpt-5");
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
