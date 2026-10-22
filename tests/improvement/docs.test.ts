import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_SPECS, PROJECT_DEFAULT_KEYS } from "../../src/rooms/improvement";

const root = join(__dirname, "../..");
const doc = readFileSync(join(root, "docs/self-improvement-settings.md"), "utf8");
const lines = (path: string) => readFileSync(join(root, path), "utf8").split("\n");

describe("docs/self-improvement-settings.md", () => {
  it("every `path:line` citation points at a line that exists", () => {
    const citations = [...doc.matchAll(/`((?:src|packages|scripts|tests)\/[A-Za-z0-9_./-]+):(\d+)`/g)].map((m) => ({ path: m[1]!, line: Number(m[2]) }));
    expect(citations.length).toBeGreaterThan(40);
    for (const { path, line } of citations) expect(line, `${path}:${line}`).toBeLessThanOrEqual(lines(path).length);
  });

  it("in a table row the identifier next to a citation is within two lines of it", () => {
    const rows = [...doc.matchAll(/^\|[^\n]*?`((?:src|packages)\/[A-Za-z0-9_./-]+):(\d+)` \| `([^`]+)` \|$/gm)];
    expect(rows.length).toBeGreaterThanOrEqual(30);
    for (const [, path, line, symbol] of rows) {
      const around = lines(path!).slice(Math.max(0, Number(line) - 3), Number(line) + 2).join("\n");
      expect(around, `${path}:${line} should hold ${symbol}`).toContain(symbol!);
    }
  });

  it("names every control of the page", () => {
    for (const key of [...HUB_SPECS.map((spec) => spec.key), ...PROJECT_DEFAULT_KEYS, "plan_fact.mode", "critic.code.default_for_risk", "memory.note_budget"]) {
      expect(doc, key).toContain(`\`${key}\``);
    }
  });

  it("lists every file it cites as a source", () => {
    const sources = doc.split("sources:")[1]!.split("---")[0]!;
    for (const [, path] of sources.matchAll(/- (\S+)/g)) expect(() => lines(path!), path).not.toThrow();
  });
});
