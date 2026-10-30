import { describe, expect, it } from "vitest";
import { parseSpecialistResult, unreadableAnswer } from "../src/rooms/critique/specialist";

// magicseo T3.2 (2026-10-30): the reviewer answered rubric items, the parse threw, the task was blocked on the form alone.
describe("a specialist answer that does not read", () => {
  const caught = (output: string) => { try { parseSpecialistResult(output); return null; } catch (cause) { return cause; } };

  it("is told apart from a real failure, so the review runs once more instead of blocking the task", () => {
    expect(unreadableAnswer(caught('{"id":"r1","result":"pass","evidence":"read the plan"}'))).toBe(true);
    expect(unreadableAnswer(caught("I looked at the plan and it is fine."))).toBe(true);
    expect(unreadableAnswer(new Error("specialist_thread_timeout"))).toBe(false);
  });

  it("a well-formed answer still reads", () => {
    expect(parseSpecialistResult('{"status":"pass","summary":"ok","findings":[],"evidence":"plan"}').decision).toBe("approve");
  });
});
