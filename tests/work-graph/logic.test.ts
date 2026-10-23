import { describe, expect, it } from "vitest";
import { graphStats, median, stageCells, taskGraph, type AttemptIn, type ReceiptIn, type StageEventIn, type Tokens } from "../../src/rooms/work-graph";

const ev = (stageId: string, state: string, at: number): StageEventIn => ({ stageId, state, at });
const rc = (stageId: string, state: string, over: Partial<ReceiptIn> = {}): ReceiptIn => ({ stageId, state, threadId: null, providerId: null, model: null, reason: null, updatedAt: 0, ...over });
const price = (_model: string, billed: Tokens) => (billed.fresh + billed.output) / 1_000_000;

describe("the cells of a task", () => {
  it("one per stage in the pipeline's order; a stage polled while running is one round, a retry is another", () => {
    const cells = stageCells(
      [ev("project-life", "running", 1), ev("project-life", "running", 2), ev("project-life", "passed", 3),
        ev("writer-agent", "running", 1), ev("writer-agent", "failed", 2), ev("writer-agent", "running", 3), ev("writer-agent", "passed", 4)],
      [rc("writer-agent", "passed"), rc("pm-read", "skipped"), rc("project-life", "passed"), rc("verification", "blocked")],
    );
    expect(cells.map((cell) => `${cell.stageId}:${cell.state}:${cell.rounds}:${cell.failures}`))
      .toEqual(["pm-read:skipped:0:0", "writer-agent:passed:2:1", "verification:failed:1:0", "project-life:passed:1:0"]);
  });
});

describe("who ran each stage", () => {
  const attempts: AttemptIn[] = [
    { id: "a1", no: 1, state: "failed", threadId: "thr_w", createdAt: 0, updatedAt: 60_000 },
    { id: "a2", no: 2, state: "accepted", threadId: "thr_w", createdAt: 60_000, updatedAt: 180_000 },
  ];
  const usage = (threadId: string) => threadId === "thr_w"
    ? { providerId: "claude-code", model: "claude-sonnet-5-5", billed: { fresh: 1000, cacheRead: 50_000, cacheWrite: 0, output: 2000 } }
    : threadId === "thr_c" ? { providerId: "acp-cursor", model: "composer-2.5", billed: { fresh: 0, cacheRead: 0, cacheWrite: 0, output: 0 } } : undefined;
  const graph = taskGraph({
    events: [ev("plan-critique", "running", 0), ev("plan-critique", "passed", 30_000), ev("verification", "running", 180_000), ev("verification", "passed", 185_000)],
    receipts: [rc("plan-critique", "passed", { threadId: "thr_c", model: "composer-2.5" }), rc("writer-agent", "passed", { threadId: "thr_w" }), rc("verification", "passed", { threadId: "thr_w" })],
    attempts, usage, price, turns: (threadId) => (threadId === "thr_w" ? 7 : 2),
  });

  it("a writer thread two attempts share carries its tokens on the last one; the earlier is partial", () => {
    const writer = graph.stages.find((stage) => stage.cell.stageId === "writer-agent")!.rows;
    expect(writer.map((row) => [row.round, row.costState, row.tokens?.output ?? null, row.turns, row.seconds])).toEqual([[1, "partial", null, null, 60], [2, "measured", 2000, 7, 120]]);
    expect(writer[1]!.costUsd).toBeCloseTo(0.003);
  });

  it("a provider that reports no usage is not measured, never zero; a code stage runs no model", () => {
    const critic = graph.stages.find((stage) => stage.cell.stageId === "plan-critique")!.rows[0]!;
    expect(critic).toMatchObject({ role: "reviewer", costState: "not_measured", tokens: null, costUsd: null, seconds: 30, turns: 2 });
    const checks = graph.stages.find((stage) => stage.cell.stageId === "verification")!.rows[0]!;
    expect(checks).toMatchObject({ role: "code", model: null, threadId: null, costState: null, seconds: 5 });
  });

  it("the summary adds the measured cost, says it is partial, and counts returns", () => {
    expect(graph.summary).toMatchObject({ returns: 0, costState: "partial", seconds: 215, models: ["composer-2.5", "claude-sonnet-5-5"] });
    expect(graph.summary.costUsd).toBeCloseTo(0.003);
  });
});

describe("stages and models over many tasks", () => {
  it("counts green and red per stage, and per model the green share, or for a reviewer the blocking share", () => {
    const make = (writer: string, critic: string, model: string) => taskGraph({
      events: [], attempts: [{ id: "a", no: 1, state: writer === "passed" ? "accepted" : "failed", threadId: "thr_w", createdAt: 0, updatedAt: 1000 }],
      receipts: [rc("writer-agent", writer, { threadId: "thr_w", model }), rc("plan-critique", critic, { threadId: "thr_r", model: "gpt-6-astra" })],
      usage: () => undefined, price,
    });
    const stats = graphStats([make("passed", "passed", "sonnet"), make("failed", "failed", "sonnet"), make("passed", "passed", "grok")]);
    expect(stats.stages.find((row) => row.stageId === "writer-agent")).toMatchObject({ green: 2, red: 1, greenShare: 0.667, medianRounds: 1 });
    expect(stats.models.find((row) => row.model === "sonnet")).toMatchObject({ n: 2, share: 0.5, shareKind: "green" });
    expect(stats.models.find((row) => row.model === "gpt-6-astra")).toMatchObject({ role: "reviewer", n: 3, share: 0.333, shareKind: "blocking" });
    expect(median([3, 1, 2, 10])).toBe(2.5);
  });
});
