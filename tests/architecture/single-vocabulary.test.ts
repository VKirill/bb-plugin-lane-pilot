import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

function walkTsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkTsFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const SOURCE_FILES = [
  ...walkTsFiles(join(ROOT, "src")),
  ...walkTsFiles(join(ROOT, "packages")).filter((file) => !file.includes("/tests/")),
  join(ROOT, "server.ts"),
  join(ROOT, "host.ts"),
  join(ROOT, "app.tsx"),
].map((file) => ({
  rel: relative(ROOT, file).replace(/\\/g, "/"),
  text: readFileSync(file, "utf8"),
}));

const OUTSIDE_CONTRACTS = SOURCE_FILES.filter(({ rel }) => !rel.startsWith("packages/contracts/"));

function scanPattern(
  pattern: RegExp,
  options: { allow?: ReadonlySet<string>; ignoreComments?: boolean } = {},
): string[] {
  const hits: string[] = [];
  for (const { rel, text } of OUTSIDE_CONTRACTS) {
    if (options.allow?.has(rel)) continue;
    const lines = text.split("\n");
    lines.forEach((line, idx) => {
      if (options.ignoreComments && /^\s*(?:\/\/|\*)/.test(line)) return;
      if (pattern.test(line)) hits.push(`${rel}:${idx + 1}`);
    });
  }
  return hits;
}

describe("single home per vocabulary introduced by goal-driven-agent-graphs", () => {
  it("keeps the literal TOOL_TIERS array in packages/contracts only", () => {
    const literalTiers = /\[\s*["']R["']\s*,\s*["']D["']\s*,\s*["']L["']\s*,\s*["']S["']\s*\]/;
    expect(scanPattern(literalTiers)).toEqual([]);
  });

  it("keeps the literal TIER_RANK map in packages/contracts only", () => {
    const literalTierRank = /\{\s*["']?R["']?\s*:\s*[01]\s*,\s*["']?D["']?\s*:\s*[12]\s*,\s*["']?L["']?\s*:\s*[23]\s*,\s*["']?S["']?\s*:\s*[34]\s*\}/;
    // Python hook script string has an explicit parity test in tests/hooks/mcp-tier-guard.test.ts.
    const allow = new Set(["src/rooms/contracts/native-hook-sources.ts"]);
    expect(scanPattern(literalTierRank, { allow })).toEqual([]);
  });

  it("keeps the literal CARD_KINDS array in packages/contracts only", () => {
    const literalCardKinds = /\[\s*["']niche["']\s*,\s*["']brand["']\s*,\s*["']contact["']\s*,\s*["']platform["']\s*\]/;
    expect(scanPattern(literalCardKinds)).toEqual([]);
  });

  it("keeps the literal WORK_KINDS, LOOP_NAMES, LOOP_MODES, AUTONOMY_CLASSES, and OWNER_REFUSAL_REASONS arrays in packages/contracts only", () => {
    const patterns = [
      /\[\s*["']routine["']\s*,\s*["']employee["']\s*,\s*["']project["']\s*\]/,
      /\[\s*["']discovery["']\s*,\s*["']branches["']\s*,\s*["']evolve["']\s*,\s*["']employee["']\s*,\s*["']templates["']\s*\]/,
      /\[\s*["']on["']\s*,\s*["']report["']\s*,\s*["']off["']\s*\]/,
      /\[\s*["']observe["']\s*,\s*["']propose["']\s*,\s*["']bounded_auto["']\s*\]/,
      /\[\s*["']wrong_result["']\s*,\s*["']too_costly["']\s*,\s*["']off_brand["']\s*,\s*["']bad_timing["']\s*,\s*["']unsafe["']\s*,\s*["']other["']\s*\]/,
    ];
    for (const pattern of patterns) {
      expect(scanPattern(pattern)).toEqual([]);
    }
  });

  it("keeps the literal lp.workflow.run-finished event string in packages/contracts only", () => {
    const literalEvent = /["']lp\.workflow\.run-finished["']/;
    expect(scanPattern(literalEvent, { ignoreComments: true })).toEqual([]);
  });
});
