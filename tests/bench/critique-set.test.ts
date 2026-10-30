import { describe, expect, it } from "vitest";
import { expectedFindings, findingsOfResult, judgeCriticFindings, critiqueRecallLine, loadSealedSet } from "../../src/rooms/bench/critique-set";
import { runValidator } from "../../src/rooms/bench/validator";
import { benchWorld } from "./helpers";
import { getSet } from "../../src/rooms/bench/store";
import manifest from "../../bench/known-bugs-v1.json";

describe("critic eval set: known-bugs-v1", () => {
  it("ships 20-30 tasks, each with a diff and a reference finding", () => {
    expect(manifest.tasks.length).toBeGreaterThanOrEqual(20);
    for (const t of manifest.tasks) {
      expect(t.diff.length).toBeGreaterThan(10);
      expect(expectedFindings(t as never).length).toBeGreaterThan(0);
    }
  });

  it("loads as a sealed set: critique stratum, critique_finds validator", () => {
    const { db } = benchWorld();
    const set = loadSealedSet(db, { version: manifest.version, manifest });
    expect(set.taskCount).toBe(manifest.tasks.length);
    const stored = getSet(db, manifest.version)!;
    expect(stored.tasks.every((t) => t.stratum === "critique" && t.validator === "critique_finds")).toBe(true);
  });

  it("scores recall: the finding that names the bug counts, a wrong file does not", () => {
    const expected = [{ file: "src/api/list.ts", keyword: "off by one boundary" }];
    const hit = [{ file: "src/api/list.ts", finding: "off-by-one boundary error reading past the end" }];
    const miss = [{ file: "src/other.ts", finding: "off-by-one boundary error" }];
    expect(judgeCriticFindings(hit, expected).found).toBe(1);
    expect(judgeCriticFindings(miss, expected).found).toBe(0);
    expect(judgeCriticFindings([], expected).missing).toEqual(["off by one boundary"]);
  });

  it("critique_finds validator accepts a findings JSON that covers the bugs, refuses an empty one", async () => {
    const expected = [{ file: "src/limit.ts", keyword: "inverted comparison" }];
    const artifact = JSON.stringify({ findings: [{ file: "src/limit.ts", finding: "inverted comparison operator" }] });
    expect((await runValidator("critique_finds", artifact, { expectedFindings: expected })).ok).toBe(true);
    expect((await runValidator("critique_finds", "[]", { expectedFindings: expected })).ok).toBe(false);
  });

  it("the recall line counts found bugs across the set for the arm report", () => {
    const { db } = benchWorld();
    loadSealedSet(db, { version: "v-test", manifest: manifest.tasks.slice(0, 3) });
    const tasks = getSet(db, "v-test")!.tasks;
    const receipt = () => ({ findings: [{ file: "src/api/list.ts", finding: "off by one boundary" }] });
    const recall = critiqueRecallLine(tasks, receipt);
    expect(recall.total).toBe(3);
    expect(recall.line).toMatch(/critique: found \d\/3 known bugs/);
  });

  it("findingsOfResult reads the receipt's findings array and nothing else", () => {
    expect(findingsOfResult({ findings: [{ file: "a" }] })).toEqual([{ file: "a" }]);
    expect(findingsOfResult({ findings: "nope" })).toEqual([]);
    expect(findingsOfResult(null)).toEqual([]);
  });
});
