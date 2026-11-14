import { globSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";
import config from "../../vitest.config";

// n1738 (region 27): the card's `npm test` is the suite, then the badge check and the internal-trace scanner. Here `npm test` is the whole
// suite, and both checks are files of it: the README numbers against the code (tests/atlas.test.ts) and the leak scan (tests/guard-tools.test.ts).
it("[sma:k_v_npmtest] npm test runs every test file with no filter, and the README numbers check and the internal-trace scan are among them", () => {
  const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
  expect(scripts.test).toBe("vitest run");
  const projects = (config as { test: { projects: Array<{ test: { include: string[]; exclude?: string[] } }> } }).test.projects;
  const run = new Set(projects.flatMap(({ test }) => globSync(test.include, { exclude: test.exclude ?? [] })));
  expect(run.has("tests/atlas.test.ts")).toBe(true);
  expect(run.has("tests/guard-tools.test.ts")).toBe(true);
  expect(readFileSync("tests/guard-tools.test.ts", "utf8")).toContain('expect(leakFindings(".")).toEqual([]);');
});
