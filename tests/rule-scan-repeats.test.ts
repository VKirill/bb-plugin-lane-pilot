import { describe, expect, it } from "vitest";
import { analyzerPrompt, parseAnalyzerOutput } from "../src/rooms/self-repair/server/rule-scan";

/** The rules analyzer names which failures repeat an existing rule: the rule trial counts these to revise or retire it (Jev did this before 0.1.540). */
describe("rules analyzer repeats", () => {
  it("numbers the existing rules r1, r2… and asks which failures repeat one", () => {
    const prompt = analyzerPrompt({ category: "verification", locale: "en", group: [], others: [], rules: ["Run the spec next to the file.", "Keep the lock file."] });
    expect(prompt).toContain("r1: Run the spec next to the file.");
    expect(prompt).toContain("r2: Keep the lock file.");
    expect(prompt).toContain('"repeats":[{"taskId":"...","rule":"r1"}]');
  });
  it("reads repeats by rule number and drops malformed ones", () => {
    const parsed = parseAnalyzerOutput(JSON.stringify({ rules: [], not_writer: [], repeats: [{ taskId: "t1", rule: "r2" }, { taskId: "t2", rule: "two" }, { rule: "r1" }] }));
    expect(parsed.repeats).toEqual([{ taskId: "t1", rule: 2 }]);
    expect(parseAnalyzerOutput(JSON.stringify({ rules: [] })).repeats).toEqual([]);
  });
});
