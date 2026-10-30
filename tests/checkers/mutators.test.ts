import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFixture, type Fixture } from "../../src/rooms/checkers/fixture";
import { addedLineNumbers, changedRanges } from "../../src/rooms/checkers/linediff";
import { honestClaim, plantAll, plantDefect } from "../../src/rooms/checkers/mutators";
import { testFitFindings } from "../../src/rooms/tasks";
import { DEFECT_CLASSES, EXPECTED_CATCHERS, type PlantInput } from "../../src/rooms/checkers/types";

describe("line diff", () => {
  it("gives the lines of the new text that are not in the old", () => {
    expect(changedRanges(null, "a\nb\nc\n")).toEqual([[1, 3]]);
    expect(changedRanges("a\nb\nc\n", "a\nX\nc\nY\n")).toEqual([[2, 2], [4, 4]]);
    expect(changedRanges("a\nb\nc\n", "a\nb\nc\n")).toEqual([]);
    expect(addedLineNumbers("a\nb\n", "a\nb\nc\nd\n")).toEqual([3, 4]);
  });

  it("puts a pure deletion on the line before it, as git does for -U0", () => {
    expect(changedRanges("a\nb\nc\n", "a\nc\n")).toEqual([[1, 1]]);
  });
});

describe("planted defects", () => {
  let root = "", fixture: Fixture;
  beforeAll(async () => { root = await mkdtemp(join(tmpdir(), "lp-checkers-mut-")); fixture = await buildFixture(root); }, 30_000);
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });

  const clamp = (): PlantInput => fixture.candidates[0]!;
  const money = (): PlantInput => fixture.candidates[1]!;
  const after = (input: PlantInput, path: string) => input.changes.find((change) => change.path === path)?.after ?? null;

  it("plants each class once where it fits, and every class fits somewhere in the fixture", () => {
    const planted = new Set([...plantAll(clamp()), ...plantAll(money())].map((row) => row.defect.class));
    expect([...planted].sort()).toEqual([...DEFECT_CLASSES].sort());
  });

  it("is deterministic: the same candidate gives the same defects", () => {
    expect(JSON.stringify(plantAll(clamp()))).toBe(JSON.stringify(plantAll(clamp())));
  });

  it("records who must catch each class, from one table", () => {
    for (const row of plantAll(clamp())) expect(row.defect.expected).toEqual(EXPECTED_CATCHERS[row.defect.class]);
  });

  it("deletes one assertion of a test the candidate added", () => {
    const planted = plantDefect(clamp(), "test_assertion_deleted")!;
    const before = after(clamp(), "test/clamp.test.mjs")!, now = planted.changes.find((change) => change.path === "test/clamp.test.mjs")!.after!;
    expect((before.match(/assert\./g) ?? []).length - (now.match(/assert\./g) ?? []).length).toBe(1);
    expect(planted.defect.path).toBe("test/clamp.test.mjs");
    const changed = planted.changes.find((change) => change.path === "test/clamp.test.mjs")!;
    expect(testFitFindings([changed]).map((hit) => hit.kind)).toContain("assertion_removed");
  });

  it("shifts a comparison in code the candidate added", () => {
    const planted = plantDefect(clamp(), "off_by_one")!;
    expect(planted.defect.path).toBe("src/clamp.mjs");
    expect(after(clamp(), "src/clamp.mjs")).toContain("index >= size");
    expect(planted.changes.find((change) => change.path === "src/clamp.mjs")!.after).toContain("index > size");
  });

  it("adds a change outside owns_paths", () => {
    const planted = plantDefect(clamp(), "outside_owns")!;
    expect(planted.changes.map((change) => change.path)).toContain("lp-planted-unowned.txt");
    expect(clamp().contract.owns_paths).not.toContain("lp-planted-unowned.txt");
  });

  it("turns a thrown error into a log line", () => {
    const planted = plantDefect(clamp(), "swallowed_error")!;
    expect(planted.changes.find((change) => change.path === "src/clamp.mjs")!.after).toContain('console.warn(new Error("not a number: " + text));');
    expect(plantDefect(money(), "swallowed_error")).toBeNull();
  });

  it("masks the first check of the contract with || true and leaves the diff alone", () => {
    const planted = plantDefect(clamp(), "masked_check")!;
    expect(planted.contract.verification[0]!.command).toBe("node --test test/clamp.test.mjs || true");
    expect(planted.changes).toEqual(clamp().changes);
  });

  it("takes a changed code file out of the diff while the writer's table still claims it", () => {
    const planted = plantDefect(money(), "acceptance_missing")!;
    expect(planted.changes.map((change) => change.path)).not.toContain(planted.defect.path);
    expect(planted.claim.rows.flatMap((row) => row.evidence).some((entry) => entry.startsWith(`${planted.defect.path}:`))).toBe(true);
    expect(planted.claim).toEqual(honestClaim(money()));
  });

  it("replaces a returned expression with a constant the tests expect", () => {
    const planted = plantDefect(clamp(), "hardcoded_value")!;
    expect(planted.changes.find((change) => change.path === "src/clamp.mjs")!.after).toMatch(/return 4;/);
  });

  it("points an import at a module that does not exist", () => {
    const planted = plantDefect(clamp(), "broken_import")!;
    expect(planted.changes.find((change) => change.path === "src/clamp.mjs")!.after).toContain('"./limits.mjs-planted"');
  });

  it("plants nothing in a candidate with nothing to mutate", () => {
    const empty: PlantInput = { ...clamp(), changes: [{ path: "README.md", before: "a\n", after: "b\n" }] };
    expect(plantAll(empty).map((row) => row.defect.class)).toEqual(["outside_owns", "masked_check"]);
  });
});
