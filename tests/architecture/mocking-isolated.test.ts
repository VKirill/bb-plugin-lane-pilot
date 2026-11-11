import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// The node tests share one module cache (vitest.config.ts: isolate false). A vi.mock there either replaces the module for
// every other file of the worker, or does not take effect because an earlier file loaded it: red in a full run, green alone.
const ROOT = join(__dirname, "..", "..");
const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const full = join(dir, name);
  if (name === "node_modules") return [];
  return statSync(full).isDirectory() ? walk(full) : /\.test\.ts$/.test(name) ? [full] : [];
});

describe("module mocks run isolated", () => {
  it("every node test file that calls vi.mock or vi.doMock is in the isolated list of vitest.config.ts", () => {
    const config = readFileSync(join(ROOT, "vitest.config.ts"), "utf8");
    const mocking = [...walk(join(ROOT, "tests")), ...walk(join(ROOT, "src/rooms")), ...walk(join(ROOT, "packages"))]
      .filter((file) => /^\s*vi\.(mock|doMock)\(/m.test(readFileSync(file, "utf8")))
      .map((file) => relative(ROOT, file));
    expect(mocking.filter((file) => !config.includes(`"${file}"`))).toEqual([]);
  });
});
