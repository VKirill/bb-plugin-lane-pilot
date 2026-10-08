import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { costUsd } from "@lane-pilot/models";
import { createDb } from "./harness";
import { averageCost, priceView, scheduleCost, threadUsage, usageOfCursor } from "../../src/rooms/schedule/server/schedule-usage";

const total = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => JSON.stringify({ input: input + cacheRead + cacheWrite, output, cached: cacheRead + cacheWrite, total: input + cacheRead + cacheWrite + output, cacheRead, cacheWrite });
const cursor = (extra: Partial<{ total_json: string; last_model: string; last_provider: string; provider_id: string }> = {}) => ({ total_json: total(1_000_000, 100_000), last_model: "claude-opus-5-5", last_provider: "claude-code", provider_id: "claude-code", ...extra });

describe("cost of a run from its thread's usage", () => {
  it("known usage: tokens, the model and a cost from the price table", () => {
    const got = usageOfCursor(cursor());
    // 1M uncached in at $4 + 100k out at $20 per 1M.
    expect(got).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", tokens: 1_100_000, costUsd: 6, usageKnown: true });
  });

  it("cache reads and writes are priced at their own rates", () => {
    const got = usageOfCursor(cursor({ total_json: total(0, 0, 1_000_000, 1_000_000) }));
    expect(got.costUsd).toBeCloseTo(costUsd("claude-opus-5-5", { uncached: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 0 })!, 6);
    expect(got.costUsd).toBeCloseTo(5.2, 6);
  });

  it("no row (an ACP provider reports no usage) is unknown, not zero", () => {
    expect(usageOfCursor(undefined)).toEqual({ providerId: null, model: null, tokens: null, costUsd: null, usageKnown: false });
  });

  it("a row with no tokens is unknown too, and keeps what model it saw", () => {
    expect(usageOfCursor(cursor({ total_json: "{}" }))).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", tokens: null, costUsd: null, usageKnown: false });
  });

  it("tokens with a model that has no price: usage is known, the cost is not", () => {
    expect(usageOfCursor(cursor({ last_model: "router9/some-model" }))).toMatchObject({ usageKnown: true, tokens: 1_100_000, costUsd: null, model: "router9/some-model" });
    expect(usageOfCursor(cursor({ last_model: "" }))).toMatchObject({ usageKnown: true, costUsd: null, model: null });
  });

  it("reads the cursor of a thread from the database, and a missing table is unknown", () => {
    const db = new Database(":memory:");
    expect(threadUsage(db, "thr_1")).toMatchObject({ usageKnown: false });
    db.exec("CREATE TABLE lane_pilot_token_cursor (thread_id TEXT PRIMARY KEY, project_id TEXT, provider_id TEXT, last_seq INTEGER, last_json TEXT, total_json TEXT, last_model TEXT, last_provider TEXT, last_turn_id TEXT, updated_at INTEGER)");
    db.prepare("INSERT INTO lane_pilot_token_cursor VALUES ('thr_1','p','claude-code',1,'{}',?, 'claude-sonnet-5-5','claude-code','t',0)").run(total(500_000, 50_000));
    expect(threadUsage(db, "thr_1")).toMatchObject({ usageKnown: true, model: "claude-sonnet-5-5", costUsd: 1.5 });
    expect(threadUsage(db, "thr_none").usageKnown).toBe(false);
  });
});

describe("cost per run of a schedule", () => {
  it("averages the known costs, counts the samples and leaves the unknown out", () => {
    expect(averageCost([2, null, 4])).toEqual({ perRunUsd: 3, samples: 2 });
    expect(averageCost([null, null])).toEqual({ perRunUsd: null, samples: 0 });
    expect(averageCost([])).toEqual({ perRunUsd: null, samples: 0 });
  });

  it("prices the model per 1M tokens, or says it has no price", () => {
    expect(priceView("claude-opus-5-5")).toEqual({ priceInPer1M: 4, priceOutPer1M: 20 });
    expect(priceView("claude-opus-5-5[1m]")).toEqual({ priceInPer1M: 4, priceOutPer1M: 20 });
    expect(priceView("router9/some-model")).toEqual({ priceInPer1M: null, priceOutPer1M: null });
    expect(priceView(null)).toEqual({ priceInPer1M: null, priceOutPer1M: null });
  });

  it("scheduleCost: the average over the runs whose thread has usage, ignoring runs without a thread, without usage and unfinished ones", () => {
    const db = createDb();
    db.exec("CREATE TABLE lane_pilot_token_cursor (thread_id TEXT PRIMARY KEY, project_id TEXT, provider_id TEXT, last_seq INTEGER, last_json TEXT, total_json TEXT, last_model TEXT, last_provider TEXT, last_turn_id TEXT, updated_at INTEGER)");
    db.prepare(`INSERT INTO lane_pilot_schedule (id, project_id, name, kind, task_json, trigger_type, timeout_sec, state, cursor_at, created_by, created_at, updated_at) VALUES ('s1','p','n','errand','{}','cron',60,'active',0,'t',0,0)`).run();
    const run = db.prepare("INSERT INTO lane_pilot_schedule_run (id, schedule_id, run_key, scheduled_at, trigger, status, queued_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)");
    const usage = db.prepare("INSERT INTO lane_pilot_token_cursor VALUES (?,?,?,?,?,?,?,?,?,?)");
    run.run("r1", "s1", "s1:1", 1, "tick", "succeeded", 1, "thread", "thr_a");
    run.run("r2", "s1", "s1:2", 2, "tick", "succeeded", 2, "thread", "thr_b");
    run.run("r3", "s1", "s1:3", 3, "tick", "failed", 3, "thread", "thr_c");
    run.run("r4", "s1", "s1:4", 4, "tick", "running", 4, "thread", "thr_d");
    run.run("r5", "s1", "s1:5", 5, "tick", "succeeded", 5, "host_job", "job_1");
    usage.run("thr_a", "p", "claude-code", 1, "{}", total(1_000_000, 0), "claude-opus-5-5", "claude-code", "t", 0);
    usage.run("thr_b", "p", "claude-code", 1, "{}", total(0, 100_000), "claude-opus-5-5", "claude-code", "t", 0);
    usage.run("thr_d", "p", "claude-code", 1, "{}", total(9_000_000, 0), "claude-opus-5-5", "claude-code", "t", 0);
    // thr_c has no row (ACP): unknown, left out of the average.
    expect(scheduleCost(db, "s1", "claude-opus-5-5")).toEqual({ perRunUsd: 3, samples: 2, priceInPer1M: 4, priceOutPer1M: 20 });
    // No history: the price of the model only.
    expect(scheduleCost(db, "s_none", "claude-sonnet-5-5")).toEqual({ perRunUsd: null, samples: 0, priceInPer1M: 2, priceOutPer1M: 10 });
    // A model without a price.
    expect(scheduleCost(db, "s_none", "router9/x")).toEqual({ perRunUsd: null, samples: 0, priceInPer1M: null, priceOutPer1M: null });
  });
});
