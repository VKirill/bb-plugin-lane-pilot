import { expect, it } from "vitest";
import { FREE_CLASSES, failureClass, liveFolderLockNote, nextStep } from "../src/rooms/runs/failure-class";

it("a critic's block verdict is no free redo: its own class, and a message that says to change the approach", () => {
  const reason = "verdict_block:code-critique: The handler is a stub | src/a.ts:12 [critical] login only logs | stopped, not redone";
  expect(failureClass("blocked", reason)).toBe("contract");
  expect(FREE_CLASSES.has(failureClass("blocked", reason))).toBe(false);
  expect(nextStep("blocked", reason)).toMatch(/^stopped by a block verdict.*do not send the same task again/);
  expect(nextStep("blocked", "code_critique_blocked")).toMatch(/fix the contract/);
});

it("names the PM's next step by failure class", () => {
  expect(nextStep("running", null)).toMatch(/^wait/);
  expect(nextStep("blocked", "needs_human: which port?")).toMatch(/^answer_writer.*lane_pilot_answer_writer/);
  expect(nextStep("blocked", "spawn failed: HTTP 502")).toMatch(/^parked/);
  expect(nextStep("blocked", "writer_provider_limit: Upgrade your plan")).toMatch(/writer chain/);
  expect(nextStep("validation_failed", "verification failed (npx tsc): exit 2")).toMatch(/dispatch it again/);
});

it("tells the PM that an unanswered question locks a folder without git, and only then", () => {
  expect(liveFolderLockNote("blocked", "needs_human: which port?", true)).toMatch(/no git, so it stays locked.*queue until this question is answered/);
  expect(liveFolderLockNote("blocked", "needs_human: which port?", false)).toBe("");
  expect(liveFolderLockNote("blocked", "verification failed: exit 1", true)).toBe("");
  expect(liveFolderLockNote("running", null, true)).toBe("");
});
