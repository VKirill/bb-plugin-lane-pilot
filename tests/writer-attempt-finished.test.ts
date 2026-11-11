import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { attemptFinishedSubscriberCount, attemptFinishedSubscriberNames, emitAttemptFinished, onAttemptFinished, type AttemptFinished } from "../src/rooms/writer/server/attempt-finished";
import { createWriterFinish } from "../src/rooms/writer/server/finish";
import { mountStabilityAttemptFinished } from "../src/rooms/writer/server/stability";
import { mountWriterTaskFinished } from "../src/rooms/writer/server/attempt-reactions";
import { mountWorkflowAttemptFinished } from "../src/rooms/workflow/server/after-accept";

const ctx = () => ({ log: vi.fn(), state: { disposed: false }, isDisposed: () => false }) as never;

const event = (over: Partial<AttemptFinished> = {}): AttemptFinished => ({
  scope: "attempt", projectId: "p", runId: "r", taskId: "t", attemptId: "a",
  pmThreadId: "pm", writerThreadId: "w", task: {} as never, config: {} as never,
  status: "blocked", reason: "x", result: null, ...over,
});

/**
 * The order that mattered before the bus and must keep holding:
 * - attempt scope, registered by createWriterFinish: settle (rule-forms) before the writer's own
 *   skill metric + materialize cleanup.
 * - task scope, registered by createWriterStart: stability's failure record → the area's writer
 *   record → the after-acceptance graph; and the failed-task emit happens before the receipts and
 *   refreshRun, the accepted-task emit after them (start.ts recordOutcome).
 * - a failed reaction is logged and the rest still run; a reaction returning void stays fire-and-forget.
 */
describe("attempt-finished bus", () => {
  it("runs subscribers in registration order, awaiting each before the next", async () => {
    const core = ctx();
    const order: string[] = [];
    const gate = { release: false };
    onAttemptFinished(core, async () => { while (!gate.release) await new Promise((wake) => setTimeout(wake, 1)); order.push("first"); });
    onAttemptFinished(core, () => { order.push("second"); });
    onAttemptFinished(core, () => { order.push("third"); });
    const emitting = emitAttemptFinished(core, event());
    gate.release = true;
    await emitting;
    expect(order).toEqual(["first", "second", "third"]);
    expect(attemptFinishedSubscriberCount(core)).toBe(3);
  });

  it("a throwing subscriber is logged and does not stop the rest", async () => {
    const core = ctx();
    const order: string[] = [];
    onAttemptFinished(core, () => { order.push("before"); });
    onAttemptFinished(core, () => { throw new Error("boom"); });
    onAttemptFinished(core, async () => { order.push("after"); });
    await emitAttemptFinished(core, event());
    expect(order).toEqual(["before", "after"]);
    expect((core as { log: ReturnType<typeof vi.fn> }).log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("a fire-and-forget subscriber does not block the next one", async () => {
    const core = ctx();
    const order: string[] = [];
    onAttemptFinished(core, () => { void new Promise((wake) => setTimeout(() => { order.push("slow"); wake(undefined); }, 30)); order.push("sync"); });
    onAttemptFinished(core, () => { order.push("next"); });
    await emitAttemptFinished(core, event());
    expect(order).toEqual(["sync", "next"]);
    await new Promise((wake) => setTimeout(wake, 60));
    expect(order).toEqual(["sync", "next", "slow"]);
  });

  it("locks the production reaction order: finish mounts settle before writer cleanup; start mounts stability, area, then after-accept", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const finishCore = { bb, db: {}, getThreadBounded: vi.fn(), host: {}, log: vi.fn(), state: { disposed: false } };
    createWriterFinish(finishCore as never, {} as never);
    expect(attemptFinishedSubscriberNames(finishCore as never)).toEqual([
      "rule-forms:settle-stopped-writer",
      "writer:skill-metric-and-materialize",
      "writer:failed-lesson",
    ]);
    const startCore = { log: vi.fn(), state: { disposed: false } };
    mountStabilityAttemptFinished(startCore as never, { stability: {} } as never);
    mountWriterTaskFinished(startCore as never, {} as never, { noteAccepted: vi.fn() } as never);
    mountWorkflowAttemptFinished(startCore as never, { onAttemptFinished, startAfterAcceptance: vi.fn() } as never);
    expect(attemptFinishedSubscriberNames(startCore as never)).toEqual([
      "stability:task-failed",
      "writer:area-accepted",
      "workflow:after-accept",
    ]);
  });
});
