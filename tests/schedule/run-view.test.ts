import { describe, expect, it } from "vitest";
import { runView } from "../../src/rooms/schedule/board";
import type { RunRow } from "../../src/rooms/schedule/store";

const row = (extra: Partial<RunRow>): RunRow => ({
  id: "r1", schedule_id: "s1", run_key: "k", scheduled_at: 1, trigger: "tick", status: "succeeded", reason: null, queued_at: 1, started_at: 1, finished_at: 2, deadline_at: null,
  ref_kind: null, ref_id: null, host_id: null, exit_code: null, output: null, error: null, truncated: 0, ...extra,
} as RunRow);

describe("the thread a scheduled run opens", () => {
  it("is the thread itself for a thread run, and what the resolver finds for a graph run (an errand)", () => {
    expect(runView(row({ ref_kind: "thread", ref_id: "thr_1" })).threadId).toBe("thr_1");
    const graph = row({ ref_kind: "workflow_run", ref_id: "wfrun_1" });
    expect(runView(graph).threadId).toBeNull();
    expect(runView(graph, (found) => (found.ref_id === "wfrun_1" ? "thr_errand" : null)).threadId).toBe("thr_errand");
    expect(runView(row({ ref_kind: "host_job", ref_id: "job_1" }), () => null).threadId).toBeNull();
  });
});
