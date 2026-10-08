import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@lane-pilot/thread-observe", () => ({ observeStageChild: async () => ({ kind: "observing" }) }));

import { createScheduleExecutors } from "../../src/rooms/schedule/server/schedule-executors";
import { FAILED_FINAL_STATUSES, finalRuleOf, scheduleFailureNotice, workflowFinish } from "../../src/rooms/schedule/outcome";
import type { ExecutorInput } from "../../src/rooms/schedule/scheduler";
import type { RunRow, ScheduleRow } from "../../src/rooms/schedule/store";

// Audit 2026-10-08 round 4, item 16: a scheduled chain that ended aborted, blocked or send_failed was counted as a success
// (the counter of failures went back to zero) and nobody was told.
const schedule = { id: "sch_1", project_id: "p1", name: "Monthly invoice", timeout_sec: 600, consecutive_failures: 1 } as ScheduleRow;
const task = { kind: "workflow" as const, workflowId: "invoice-send", inputs: {} };
const input = (): ExecutorInput => ({ schedule, task, run: { id: "srun_1", schedule_id: "sch_1", run_key: "k", scheduled_at: 1, ref_id: "wfrun_1" } as RunRow });

function world(definition: unknown, summary: Record<string, unknown>) {
  const db = { prepare: () => ({ get: () => (definition === undefined ? undefined : { definition_json: JSON.stringify(definition) }) }) };
  const ctx = { bb: { log: { warn: () => undefined } }, db, host: {}, secrets: {} } as never;
  const services = { workflowEngine: { get: () => summary } } as never;
  return createScheduleExecutors(ctx, services);
}
const done = (output: Record<string, unknown>) => ({ status: "succeeded", output, waiting: [] });

describe("a scheduled chain that ended on a branch that did not do the job", () => {
  const rule = { live_success: { output: "status", in: ["sent"] } };
  beforeEach(() => undefined);

  it("is failed for every non-finished final status of a chain that declares which ones prove it", async () => {
    for (const status of ["aborted", "blocked", "send_failed", "send_unconfirmed"]) {
      const polled = await world(rule, done({ status, reason: "login wall" })).workflow.poll(input());
      expect(polled, status).toMatchObject({ state: "done", status: "failed", reason: `ended_${status}`, error: expect.stringContaining(status) });
    }
    expect(await world(rule, done({ status: "sent", message_id: "m1" })).workflow.poll(input())).toMatchObject({ state: "done", status: "succeeded" });
  });

  it("a chain without a rule is judged by the statuses that never mean done", async () => {
    for (const status of FAILED_FINAL_STATUSES) {
      expect(await world({}, done({ status })).workflow.poll(input()), status).toMatchObject({ status: "failed" });
    }
    expect(await world({}, done({ status: "done" })).workflow.poll(input())).toMatchObject({ status: "succeeded" });
    expect(await world(undefined, done({ status: "aborted" })).workflow.poll(input())).toMatchObject({ status: "failed" });
    expect(await world(undefined, done({ total: 3 })).workflow.poll(input())).toMatchObject({ status: "succeeded" });
  });

  it("reads the rule out of the pinned definition", () => {
    expect(finalRuleOf(JSON.stringify(rule))).toEqual({ output: "status", in: ["sent"] });
    expect(finalRuleOf("not json")).toBeNull();
    expect(workflowFinish({ status: "aborted", reason: "the owner stopped" }, null)).toMatchObject({ ok: false, detail: expect.stringContaining("the owner stopped") });
  });
});

describe("the notice of a failed scheduled run", () => {
  const run = { status: "failed" as const, error: "the chain ended with status «aborted»", reason: "ended_aborted" };
  it("is one message for every failure, and says the schedule is paused when this failure paused it", () => {
    const first = scheduleFailureNotice({ name: "Monthly invoice", consecutive_failures: 1 }, run, false);
    expect(first).toContain("«Monthly invoice» failed");
    expect(first).toContain("1 time in a row");
    expect(first).not.toContain("is paused");
    const last = scheduleFailureNotice({ name: "Monthly invoice", consecutive_failures: 3 }, run, true);
    expect(last).toContain("3 times in a row and is paused");
  });
});
