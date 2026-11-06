import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { roomGraph } from "../../scripts/room-graph.mjs";

/**
 * The room-level coupling ratchet: the largest SCC and the count of mutually-importing room pairs may only go
 * down. File-level cycles are already at zero (boundaries.test.ts); this is the measure the untangle work moves.
 *
 * Improve it and the test still fails — on purpose: run `UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture`
 * to write the new (lower) numbers into room-graph-baseline.json and commit it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = join(ROOT, "tests/architecture/room-graph-baseline.json");

describe("room graph ratchet", () => {
  it("largest SCC and mutual pairs do not grow past the committed baseline", () => {
    const actual = roomGraph(ROOT).summary;
    if (process.env.UPDATE_ARCH_BASELINE === "1") writeFileSync(BASELINE_PATH, JSON.stringify(actual, null, 2) + "\n");
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as typeof actual;
    for (const metric of ["largestScc", "mutualPairs"] as const) {
      expect(
        actual[metric] <= baseline[metric],
        `${metric} grew ${baseline[metric]} -> ${actual[metric]}: untangle, do not add room-level import cycles`,
      ).toBe(true);
      expect(
        actual[metric] >= baseline[metric],
        `${metric} improved ${baseline[metric]} -> ${actual[metric]}: lower the baseline — run UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture and commit tests/architecture/room-graph-baseline.json`,
      ).toBe(true);
    }
    expect(actual.rooms).toBeGreaterThan(0);
  });
});
