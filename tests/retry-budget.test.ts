import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRun, openDatabase } from "../src/database";
import { failureClass, nextStep } from "../src/failure-class";
import { TASK_ATTEMPT_BUDGET, loadRetryBudget, retryBudgetKey, retryBudgetReason, spendRetryBudget } from "../src/retry-budget";
import { createStability } from "../src/server/stability";

describe("overall retry budget of a task", () => {
  it("counts every fresh writer, primary and fallback, and ends the task once it is spent", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const kv = bb.storage.kv as never;
    for (let n = 1; n <= TASK_ATTEMPT_BUDGET - 2; n += 1) expect((await spendRetryBudget(kv, "run", "T1", "attempt", 1000 + n)).ok).toBe(true);
    expect((await spendRetryBudget(kv, "run", "T1", "fallback", 5000)).ok).toBe(true);
    expect((await spendRetryBudget(kv, "run", "T1", "fallback", 6000)).ok).toBe(true);
    const spent = await spendRetryBudget(kv, "run", "T1", "attempt", 7000);
    expect(spent.ok).toBe(false);
    expect(spent.record).toMatchObject({ spent:TASK_ATTEMPT_BUDGET, attempts:TASK_ATTEMPT_BUDGET - 2, fallbacks:2, firstAt:1001, lastAt:6000 });
    // A refused spend writes nothing; another task has its own budget.
    expect((await loadRetryBudget(kv, "run", "T1")).spent).toBe(TASK_ATTEMPT_BUDGET);
    expect((await spendRetryBudget(kv, "run", "T2", "attempt")).ok).toBe(true);
  });

  it("survives a reload: the record is in the plugin's store, not in a loop's memory", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    await spendRetryBudget(bb.storage.kv as never, "run", "T1", "attempt", 1);
    // A new instance reads the same store.
    expect(await bb.storage.kv.get(retryBudgetKey("run", "T1"))).toMatchObject({ spent:1, attempts:1 });
    expect((await loadRetryBudget(bb.storage.kv as never, "run", "T1")).spent).toBe(1);
  });

  it("a store that fails never stops a task", async () => {
    const broken = { get:async () => { throw new Error("kv down"); }, set:async () => { throw new Error("kv down"); } };
    expect((await spendRetryBudget(broken as never, "run", "T1", "attempt")).ok).toBe(true);
  });

  it("ends with a terminal reason that is neither parked nor retried and tells the PM what to do", () => {
    const reason = retryBudgetReason("T1", { spent:12, attempts:10, fallbacks:2, firstAt:1, lastAt:2 });
    expect(reason).toMatch(/^retry_budget_exhausted: T1 spent 12 of 12 writer attempts/);
    expect(failureClass("blocked", reason)).toBe("budget");
    expect(nextStep("blocked", reason)).toMatch(/dispatch it again as a new task/);
  });

  it("a task that ended on the budget is not parked by the stability layer", async () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{ send:async () => ({}) } } as never });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    const { stability } = createStability({ bb, db, log:() => undefined } as never, { activeWriterTasks:new Set() } as never);
    expect(await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T1", pmThreadId:"pm", state:"blocked",
      reason:retryBudgetReason("T1", { spent:12, attempts:12, fallbacks:0, firstAt:1, lastAt:2 }) })).toBe(false);
    expect(await stability.loadParked()).toEqual([]);
  });
});
