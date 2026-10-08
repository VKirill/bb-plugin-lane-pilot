import { describe, expect, it } from "vitest";
import type { StageReceiptRow } from "../../src/rooms/storage/database";
import { compactWaitResult } from "../../src/rooms/tools/server/tools";
import { compactDispatchReply, compactReceipt, compactStages, stageDetail, stageVerdict } from "../../src/rooms/runs/server/stage-brief";

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const row = (stageId: StageReceiptRow["stageId"], state: StageReceiptRow["state"], extra: Partial<StageReceiptRow> = {}): StageReceiptRow => ({
  runId: "lprun_0123456789abcdef0123456789abcdef", taskId: "P3-checkout", stageId, contractVersion: 1, state,
  inputSha256: sha("a"), outputSha256: state === "passed" ? sha("b") : null, attempt: 1, providerId: "codex", model: "gpt-6-luna",
  threadId: "thr_0123456789", result: null, reason: null, updatedAt: 1790876023517, ...extra,
});

/** A dispatch of a normal task as the PM gets it today: pm-read and plan-critique ran, the writer rows are placeholders. */
function dispatchStages(): StageReceiptRow[] {
  const finding = (severity: string, n: number) => ({ severity, finding: `Finding ${n}: the acceptance line ${n} names a behavior the verification command cannot show, so the critic cannot tell it from a stub`,
    criterion: "acceptance is checkable by a command", file: `src/checkout/step-${n}.ts`, line: 10 + n, evidence: "x".repeat(260) });
  const critique = {
    decision: "approve", summary: "The plan covers the objective and the owned paths; two acceptance lines are checkable only by reading code.",
    findings: [finding("medium", 1), finding("low", 2)], status: "pass", mode: "gate", structuralCoverage: { status: "covered", pathCount: 4 },
    structuralFindings: [], verdict: { status: "pass", summary: "ok", findings: [finding("medium", 1), finding("low", 2)] },
    rawOutput: JSON.stringify({ decision: "approve", findings: [finding("medium", 1), finding("low", 2)] }).repeat(3).slice(0, 4200),
  };
  return [
    row("acceptance-receipt", "pending"),
    row("plan-critique", "passed", { result: critique }),
    row("pm-read", "passed", { result: { summary: "s".repeat(520), keyFacts: ["a", "b", "c", "d"], openQuestions: ["Which currency does the cart use?"], selectedLines: 480, minLines: 350, packetSha256: sha("c") } }),
    row("specialist-review", "skipped", { reason: "below_critique_threshold", result: { policy: "task-risk-v1", score: 2 } }),
    row("verification", "pending"),
    row("writer-agent", "pending"),
  ];
}

describe("dispatch reply", () => {
  const reply = () => ({ runId: "lprun_0123456789abcdef0123456789abcdef", taskId: "P3-checkout", attemptId: "lpattempt_0123456789abcdef0123456789abcdef", writerThreadId: null,
    state: "queued", stages: dispatchStages(), warnings: ["owns_paths overlaps open task P2"], pmReadOpenQuestions: ["Which currency does the cart use?"],
    pmReadNote: "The writer does not see these questions." });

  it("keeps state, ids, warnings and the read stage's open questions; stages become one entry each", () => {
    const compact = compactDispatchReply(reply()) as Record<string, unknown>;
    expect(compact).toMatchObject({ runId: expect.any(String), taskId: "P3-checkout", attemptId: expect.any(String), state: "queued", warnings: ["owns_paths overlaps open task P2"],
      pmReadOpenQuestions: ["Which currency does the cart use?"], pmReadNote: expect.any(String) });
    expect(compact.stages).toEqual([
      { stageId: "plan-critique", state: "passed", verdict: "approve (2 findings): The plan covers the objective and the owned paths; two acceptance lines are checkable only by reading code." },
      { stageId: "pm-read", state: "passed", verdict: "4 facts, 1 open questions" },
      { stageId: "specialist-review", state: "skipped", reason: "below_critique_threshold" },
    ]);
  });

  it("is at least 85 percent smaller than the pretty-printed reply of before", () => {
    const before = JSON.stringify(reply(), null, 2).length;
    const after = JSON.stringify(compactDispatchReply(reply())).length;
    expect(before).toBeGreaterThan(6000);
    expect(after).toBeLessThan(1200);
    expect(after / before).toBeLessThan(0.15);
  });

  it("keeps a block's reason, clipped, and leaves a reply without stages as it is", () => {
    const blocked = compactStages([row("plan-critique", "blocked", { reason: `verdict_block:plan-critique: ${"r".repeat(900)}`, result: { decision: "changes_requested", findings: [{}] } })]);
    expect(String(blocked[0]!.reason).length).toBeLessThan(700);
    expect(blocked[0]).toMatchObject({ state: "blocked", verdict: "changes_requested (1 finding)" });
    const rejected = { runId: "r", state: "rejected", reason: "task.project_cwd must equal the configured writerWorkspacePath", unapplied: [{ key: "task.project_cwd" }] };
    expect(compactDispatchReply(rejected)).toBe(rejected);
  });
});

describe("wait reply", () => {
  const check = (n: number, exitCode = 0) => ({ command: `npx vitest run tests/part-${n}.test.ts`, exitCode, stdout: "PASS ".repeat(400), stderr: exitCode ? "boom ".repeat(200) : "",
    sandboxBackend: "macos-seatbelt", policySha256: sha("c"), workspacePath: "/work/tree" });
  const receipt = () => ({
    schemaVersion: 1, status: "accepted", lanePilotRunId: "lprun_x", lanePilotTaskId: "P3-checkout", attemptId: "lpattempt_x", pmThreadId: "thr_pm", writerThreadId: "thr_w",
    ownsPaths: ["src/checkout/**"], readFirst: [{ path: "README.md", windows: [{ startLine: 1, endLine: 40 }] }], output: "done ".repeat(600),
    verification: [check(1), check(2), check(3, 1)], runV2: { schemaVersion: 1, pools: { provider: 15, verification: 2 }, score: 2, risk: "low" },
    reasoning: [{ planSha256: sha("d"), providerId: "codex", model: "gpt-6-luna", effectiveReasoningLevel: "high" }], emergencyFallback: null, warnings: ["expected output docs/a.md was not produced"], turns: 2,
    acceptancePath: ".agents/runs/lprun_x/artifacts/P3-checkout/acceptance.json", acceptance: { schema_version: 2, report: "r".repeat(1800), checks: ["x".repeat(600)] },
  });

  it("drops the acceptance record and check logs but keeps what the PM acts on", () => {
    const compact = compactReceipt(receipt()) as Record<string, unknown>;
    expect(compact).toMatchObject({ status: "accepted", lanePilotTaskId: "P3-checkout", writerThreadId: "thr_w", acceptancePath: expect.stringContaining("acceptance.json"),
      warnings: ["expected output docs/a.md was not produced"], turns: 2, reasoning: [{ providerId: "codex" }] });
    expect(compact).not.toHaveProperty("acceptance");
    expect(compact).not.toHaveProperty("emergencyFallback");
    const checks = compact.verification as Array<Record<string, unknown>>;
    expect(checks.map((item) => item.exitCode)).toEqual([0, 0, 1]);
    expect(checks[0]).toEqual({ command: "npx vitest run tests/part-1.test.ts", exitCode: 0 });
    expect(String(checks[2]!.tail).length).toBeLessThanOrEqual(400);
    expect(String(compact.output).length).toBeLessThan(700);
  });

  it("compacts every task of a run receipt and is at least 70 percent smaller through the tool path", () => {
    const wait = { runId: "lprun_x", state: "accepted", receipt: { lanePilotRunId: "lprun_x", tasks: [receipt(), { ...receipt(), lanePilotTaskId: "P4" }] }, stages: dispatchStages(), nudged: 0,
      next: [{ taskId: "P5", state: "blocked", next: "answer_writer: lane_pilot_answer_writer" }] };
    const before = JSON.stringify(wait).length;
    const compact = compactWaitResult(wait) as Record<string, unknown>;
    expect((compact.receipt as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect(compact.next).toEqual(wait.next);
    expect(compact.stages).toEqual(expect.arrayContaining([{ taskId: "P3-checkout", stageId: "plan-critique", state: "passed" }]));
    expect(JSON.stringify(compact).length / before).toBeLessThan(0.3);
  });
});

describe("stage detail on request", () => {
  it("returns the stored result of one stage without the raw model output", () => {
    const detail = stageDetail("lprun_x", "plan-critique", dispatchStages()) as { receipts: Array<{ taskId: string; result: Record<string, unknown> }> };
    expect(detail.receipts).toHaveLength(1);
    expect(detail.receipts[0]!.result).toMatchObject({ decision: "approve", findings: expect.any(Array) });
    expect(detail.receipts[0]!.result).not.toHaveProperty("rawOutput");
  });

  it("says which stages exist when the asked one has no receipt", () => {
    expect(stageDetail("lprun_x", "code-critique", dispatchStages())).toMatchObject({ receipts: [], note: expect.stringContaining("plan-critique") });
  });

  it("has no verdict for a stage without a result", () => {
    expect(stageVerdict({ stageId: "verification", result: null })).toBeUndefined();
  });
});
