import { describe, expect, it, vi } from "vitest";
import { attemptFinishedSubscriberCount, emitAttemptFinished, onAttemptFinished, type AttemptFinished } from "../src/rooms/writer/server/attempt-finished";

const ctx = () => ({ log: vi.fn(), state: { disposed: false }, isDisposed: () => false }) as never;

const event = (over: Partial<AttemptFinished> = {}): AttemptFinished => ({
  scope: "attempt", projectId: "p", runId: "r", taskId: "t", attemptId: "a",
  pmThreadId: "pm", writerThreadId: "w", task: {} as never, config: {} as never,
  status: "blocked", reason: "x", result: null, ...over,
});

/**
 * The order that mattered before the bus and must keep holding:
 * - attempt scope, registration order: rule-forms settle → verification landed → writer metric+materialize → finish-scan.
 * - task scope: stability onTaskFailed → writer area record → workflow after-accept, after the receipts and refreshRun.
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
});
