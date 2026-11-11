/**
 * Regenerate the house-words baseline after a clean-up: UPDATE_BASELINES=1 npx vitest run tests/contract-fields-read.test.ts tests/guard-tools.test.ts
 * (it rewrites tests/fixtures/house-words-baseline.json and tests/fixtures/unread-fields-baseline.json; review the diff before you commit it).
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { countHouseWordHits, freshHouseWordHits, houseWordHits, internalIds, isGeneratedFile, leakFindings, parityGaps, sourceWordHits, type HouseWordBaseline } from "./helpers/guard-tools";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../src/rooms/native-agent/native-session-hooks";
import { PM_CORE_TOOLS, PM_FAMILY_TOOLS } from "../src/rooms/platform/server/pm-tool-families";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? (name === "node_modules" ? [] : walk(path)) : [path]; });

describe("guard tools", () => {
  it("leak scanner: no secret-shaped string in the sources and docs that ship", () => {
    // leakFindings is the same scan lp-ship's publishable runs: a planted secret fails both.
    expect(leakFindings(".")).toEqual([]);
  });

  it("internal ids forbidden in the texts a person reads", async () => {
    const i18n = await import("../packages/i18n/src/i18n");
    const catalogs = Object.values(i18n).filter((value) => value && typeof value === "object" && !Array.isArray(value)) as Array<Record<string, unknown>>;
    const strings = Object.fromEntries(catalogs.flatMap((catalog) => Object.entries(catalog).filter(([, value]) => typeof value === "string")) as Array<[string, string]>);
    expect(internalIds(strings)).toEqual([]);
  });

  it("leak scanner: no house word, old brand or colour literal in the texts a person reads and the comments around them", async () => {
    const i18n = await import("../packages/i18n/src/i18n");
    const catalogs = Object.values(i18n).filter((value) => value && typeof value === "object" && !Array.isArray(value)) as Array<Record<string, unknown>>;
    const strings = Object.fromEntries(catalogs.flatMap((catalog) => Object.entries(catalog).filter(([, value]) => typeof value === "string")) as Array<[string, string]>);
    expect(houseWordHits(strings)).toEqual([]);
    // Comments and tests: today's hits are baselined by file + matched text + how many times (not by line, which another branch moves);
    // a NEW occurrence outside the baseline turns the suite red. Shrink the baseline as the old texts are cleaned.
    const file = join("tests/fixtures/house-words-baseline.json");
    const files = [...walk("src"), ...walk("docs"), ...walk("tests")].filter((path) => /\.(ts|tsx|md|json)$/.test(path) && !path.includes("guard-tools") && !path.includes("house-words-baseline") && !isGeneratedFile(path));
    const found = countHouseWordHits(files.flatMap((path) => sourceWordHits(path, readFileSync(path, "utf8"))));
    if (process.env.UPDATE_BASELINES === "1") writeFileSync(file, `${JSON.stringify(found, null, 2)}\n`);
    expect(freshHouseWordHits(found, JSON.parse(readFileSync(file, "utf8")) as HouseWordBaseline)).toEqual([]);
  });

  it("permission rules parity: the PM's tools are the same in a BB session and in the folded terminal list", () => {
    expect(parityGaps(NATIVE_LP_BRIDGE_PM_TOOLS.filter((tool) => tool !== "lane_pilot_tool_search"), [...PM_CORE_TOOLS, ...PM_FAMILY_TOOLS])).toEqual({ onlySession: [], onlyTerminal: [] });
  });
});
