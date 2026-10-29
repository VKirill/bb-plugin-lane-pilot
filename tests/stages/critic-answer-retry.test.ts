import { describe, expect, it, vi } from "vitest";

vi.mock("@lane-pilot/thread-observe", async (original) => ({ ...(await original<object>()), waitThreadIdle: vi.fn(async () => undefined) }));

const { readCodeCritique } = await import("../../src/rooms/critique/server/critique-runs");
const { recordStage } = await import("../../src/rooms/runs/server");
const { createRun, createTask, listStageReceipts, openDatabase } = await import("../../src/rooms/storage");
const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");

// selfystudio 2026-10-30: a code critic's «pass» with an unescaped quote in its evidence was unreadable and the finished task was
// blocked with code_critique_failed. The critic is now asked once for the same verdict as valid JSON.
const broken = '{"status":"pass","summary":"ok","findings":[],"evidence":"lint "0 errors" (247 warnings)"}';
const fixed = JSON.stringify({ status: "pass", summary: "ok", findings: [], evidence: "lint 0 errors (247 warnings)" });

function fakeBb(answer: string | null) {
  const sent: string[] = [];
  const bb = { sdk: { threads: {
    send: async (args: { input: Array<{ text: string }> }) => { sent.push(args.input[0]!.text); return {}; },
    output: async () => ({ output: answer }),
  } } };
  return { bb: bb as never, sent };
}

describe("an unreadable code critic answer", () => {
  it("is sent back once with the parse error and the second answer is read", async () => {
    const { bb, sent } = fakeBb(fixed);
    const critique = await readCodeCritique(bb, "thr_critic", broken, undefined);
    expect(critique.decision).toBe("approve");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain("could not be read");
  });

  it("fails when the second answer is unreadable too, and without a thread it is not retried", async () => {
    const { bb, sent } = fakeBb(broken);
    await expect(readCodeCritique(bb, "thr_critic", broken, undefined)).rejects.toThrow();
    expect(sent).toHaveLength(1);
    const none = fakeBb(fixed);
    await expect(readCodeCritique(none.bb, null, broken, undefined)).rejects.toThrow();
    expect(none.sent).toHaveLength(0);
  });
});

describe("a critic running on an older candidate", () => {
  it("starts over as pending only when the caller stopped it (supersede)", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { id: "t1" } as never });
    const base = { runId: "run1", taskId: "t1", stageId: "code-critique" as const };
    recordStage(db, { ...base, state: "pending", input: "old" });
    recordStage(db, { ...base, state: "running", input: "old", threadId: "thr_old" });
    expect(() => recordStage(db, { ...base, state: "pending", input: "new", replaceOnNewInput: true })).toThrow(/running -> pending/);
    recordStage(db, { ...base, state: "pending", input: "new", replaceOnNewInput: true, supersede: true });
    expect(listStageReceipts(db, "run1", "t1").find((row) => row.stageId === "code-critique")?.state).toBe("pending");
  });
});
