import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { foreignSql } from "../../scripts/foreign-sql.mjs";

/**
 * The cross-room SQL ratchet: raw `.prepare(` sites naming a table another room owns may only go down.
 * Owner = the room whose migrations create the table. Improve it and the test still fails — on purpose:
 * run `UPDATE_ARCH_BASELINE=1 npx vitest run tests/architecture` to write the new (lower) numbers into
 * foreign-sql-baseline.json and commit it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BASELINE_PATH = join(ROOT, "tests/architecture/foreign-sql-baseline.json");

describe("foreign-table SQL ratchet", () => {
  it("raw prepare sites against another room's tables do not grow past the committed baseline", () => {
    const actual = foreignSql(ROOT).count;
    if (process.env.UPDATE_ARCH_BASELINE === "1") writeFileSync(BASELINE_PATH, JSON.stringify({ foreignSqlSites: actual }, null, 2) + "\n");
    const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as { foreignSqlSites: number };
    expect(
      actual <= baseline.foreignSqlSites,
      `foreign-table prepare sites grew ${baseline.foreignSqlSites} -> ${actual}: move the query into a named function of the owning room`,
    ).toBe(true);
  });
});
