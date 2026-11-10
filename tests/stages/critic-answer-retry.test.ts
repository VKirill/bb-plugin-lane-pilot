import { describe, expect, it, vi } from "vitest";

vi.mock("@lane-pilot/thread-observe", async (original) => ({ ...(await original<object>()), waitThreadIdle: vi.fn(async () => undefined) }));

const { readAnswer, readCodeCritique } = await import("../../src/rooms/critique/server/critique-runs");
const { parseSpecialistResult } = await import("../../src/rooms/critique/specialist");
const { parsePmReadResult } = await import("../../src/rooms/critique/pm-read");
const { parseNightReviewResult } = await import("../../src/rooms/night/night");
const { recordStage } = await import("../../src/rooms/runs/server");
const { createRun, createTask, listStageReceipts, openDatabase } = await import("../../src/rooms/plugin-db");
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

// The hand-off standard (docs/guide/handoff.md): every stage reads its helper's answer the same way.
describe("one reading of a helper's answer for every stage", () => {
  it("asks any helper once, in its thread, to repeat the answer and not the work", async () => {
    const { bb, sent } = fakeBb(JSON.stringify({ summary: "how it works", keyFacts: [], openQuestions: [] }));
    expect((await readAnswer(bb, "thr_scout", "I read the files.", parsePmReadResult, "summary, keyFacts and openQuestions")).summary).toBe("how it works");
    expect(sent).toEqual([expect.stringMatching(/Do not redo the work: send the same answer again as one valid JSON object with the keys summary, keyFacts and openQuestions/)]);
  });

  it("takes the honest exit as «did not run», with what the helper needs, and never asks again", async () => {
    const blocked = 'The plan names a file that is not there.\n```json\n{"outcome":"blocked","blocker":{"needs":"the real path of src/pay/checkout.ts","from":"pm"},"handoff":"read src/pay/"}\n```';
    for (const parse of [(text: string) => parseSpecialistResult(text), parsePmReadResult]) {
      const { bb, sent } = fakeBb(fixed);
      await expect(readAnswer(bb, "thr", blocked, parse as never, "status")).rejects.toThrow("helper_blocked:needs the real path of src/pay/checkout.ts from pm");
      expect(sent).toHaveLength(0);
    }
    expect(() => parseNightReviewResult('{"outcome":"failed","handoff":"the accepted result is empty"}')).toThrow("helper_failed:the accepted result is empty");
  });

  it("reads an answer with the reasoning before the object", async () => {
    const { bb, sent } = fakeBb(null);
    const answer = `I opened the two files the plan changes.\n\n${JSON.stringify({ status: "pass", summary: "no risk found", findings: [], evidence: "read src/a.ts" })}`;
    expect((await readAnswer(bb, "thr", answer, (text) => parseSpecialistResult(text), "status")).status).toBe("pass");
    expect(sent).toHaveLength(0);
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
