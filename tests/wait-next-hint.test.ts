import { expect, it } from "vitest";
import { liveFolderLockNote, nextStep } from "../src/failure-class";

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
