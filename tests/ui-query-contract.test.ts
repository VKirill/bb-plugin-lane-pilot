import { describe, expect, it } from "vitest";
import { z } from "zod";
import { uiQueryContract } from "../src/rooms/ui-shell/ui/ui-query-contract";

/**
 * The watched-read contract the UI validates against: real schemas (no z.unknown() inputs) and entity
 * tags that match what platform/server/realtime.ts and the owner-waiting RPC invalidate.
 */
describe("uiQueryContract schemas and tags", () => {
  it("every method declares a real input schema, not z.unknown()", () => {
    for (const [name, method] of Object.entries(uiQueryContract)) {
      const input = (method as { input?: unknown }).input;
      expect(input, `${name} input`).toBeDefined();
      expect(input, `${name} input must be a real zod schema`).not.toBeInstanceOf(z.ZodUnknown);
    }
  });

  it("rejects malformed inputs the old unknown schema let through", () => {
    const entry = (name: string) => (uiQueryContract as Record<string, { input: { safeParse: (v: unknown) => { success: boolean } } }>)[name];
    expect(entry("attempt_log_tail").input.safeParse({ runId: "r" }).success).toBe(false);
    expect(entry("attempt_log_tail").input.safeParse({ runId: "r", taskId: "t", extra: 1 }).success).toBe(false);
    expect(entry("thread_live").input.safeParse({}).success).toBe(false);
    expect(entry("work_graph_strips").input.safeParse({ keys: Array.from({ length: 301 }, () => ({ runId: "r", taskId: "t" })) }).success).toBe(false);
    expect(entry("task_board").input.safeParse({ doneHours: 0 }).success).toBe(false);
    expect(entry("money_status").input.safeParse({ bogus: true }).success).toBe(false);
  });

  it("tags mark the entities each read depends on", () => {
    const method = (name: string) => (uiQueryContract as unknown as Record<string, { tags?: (input: never) => string[] }>)[name];
    expect(method("task_board").tags!({ projectId: "proj_1" } as never)).toEqual(["task-board:proj_1"]);
    expect(method("task_board").tags!({} as never)).toEqual(["task-board:all"]);
    expect(method("list_helper_threads").tags!({ threadId: "thr_pm" } as never)).toEqual(["helpers:thr_pm"]);
    expect(method("thread_live").tags!({ threadId: "thr_w" } as never)).toEqual(["thread-live:thr_w"]);
    expect(method("attempt_log_tail").tags!({ runId: "r", taskId: "t", projectId: "proj_1" } as never)).toEqual(["task-board:proj_1"]);
    expect(method("attempt_log_tail").tags!({ runId: "r", taskId: "t" } as never)).toEqual(["task-board:all"]);
    expect(method("work_graph_task").tags!({} as never)).toEqual(["work-graph"]);
    expect(method("work_graph_strips").tags!({} as never)).toEqual(["work-graph"]);
    expect(method("money_status").tags!({} as never)).toEqual(["money_status"]);
    expect(method("owner_waiting").tags!({} as never)).toEqual(["owner_waiting"]);
    expect(method("world_version").tags!({} as never)).toEqual(["world_version"]);
    // helper_thread_labels carries no tags: its ids are arbitrary helper threads, covered by helpers:<pm> of the parent read.
    expect(method("helper_thread_labels").tags).toBeUndefined();
  });

  it("output schemas reject malformed payloads at the contract boundary", () => {
    const output = (name: string) => (uiQueryContract as Record<string, { output: { safeParse: (v: unknown) => { success: boolean } } }>)[name].output;
    // attempt_log_tail: {threadId, lines[]} — a bare array or missing lines is not the envelope.
    expect(output("attempt_log_tail").safeParse(["x"]).success).toBe(false);
    expect(output("attempt_log_tail").safeParse({ threadId: null, lines: ["a"] }).success).toBe(true);
    expect(output("attempt_log_tail").safeParse(null).success).toBe(false);
    // thread_live: nullable envelope; a live card needs role/items/strips.
    expect(output("thread_live").safeParse(null).success).toBe(true);
    expect(output("thread_live").safeParse({ role: "writer" }).success).toBe(false);
    // work_graph_task: cells/stages/summary envelope; work_graph_strips: runId:taskId → strip record.
    expect(output("work_graph_task").safeParse({ cells: "no" }).success).toBe(false);
    expect(output("work_graph_strips").safeParse({ "r:t": { cells: [], summary: { returns: 0, seconds: null, costUsd: null, costState: null, models: [] } } }).success).toBe(true);
    // money_status / owner_waiting / world_version: envelope fields typed, open payload allowed.
    expect(output("money_status").safeParse({ monthUsd: "x" }).success).toBe(false);
    expect(output("money_status").safeParse({ monthUsd: 1.5, cap: null, left: null, extraField: { any: "json" } }).success).toBe(true);
    expect(output("owner_waiting").safeParse({ generatedAt: 1, items: "no" }).success).toBe(false);
    expect(output("world_version").safeParse({ version: -1 }).success).toBe(false);
    expect(output("world_version").safeParse({ version: 3 }).success).toBe(true);
  });
});
