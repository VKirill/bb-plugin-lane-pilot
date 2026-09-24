import { describe, expect, it } from "vitest";
import { critiquePrompt, parseCritique } from "../../src/stages/critique";
import { sha256, stageTransition, validateStageReceipt } from "../../src/stages/contract";

describe("versioned stage contract", () => {
  it("requires typed critic output and rejects prose or malformed JSON", () => {
    expect(parseCritique('{"decision":"approve","summary":"Complete plan","findings":[]}').decision).toBe("approve");
    expect(() => parseCritique("looks fine")).toThrow();
    expect(() => parseCritique('{"decision":"maybe","summary":"x","findings":[]}')).toThrow();
  });

  it("keeps gate behavior explicit and terminal stages immutable", () => {
    expect(stageTransition("pending", "running")).toBe(true);
    expect(stageTransition("running", "blocked")).toBe(true);
    expect(stageTransition("passed", "running")).toBe(false);
    expect(stageTransition("running", "skipped")).toBe(false);
  });

  it("validates exact contract version, identities, and hashes", () => {
    const input = {
      contractVersion:1 as const, runId:"run_1", taskId:"task_1", stageId:"plan-critique" as const,
      state:"passed" as const, inputSha256:sha256("plan"), outputSha256:sha256("receipt"), attempt:1,
      providerId:"codex", model:"gpt-6-luna", threadId:"thread_1", result:{decision:"approve"},
      reason:null, updatedAt:1,
    };
    expect(validateStageReceipt(input).contractVersion).toBe(1);
    expect(() => validateStageReceipt({ ...input, contractVersion:2 })).toThrow();
    expect(critiquePrompt({ plan:"plan", task:{ id:"task_1" },agent:"security-critic" })).toContain("You are security-critic");
    expect(critiquePrompt({ plan:"plan", task:{ id:"task_1" } })).toContain("CANONICAL PLAN");
  });
});
