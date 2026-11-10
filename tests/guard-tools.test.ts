import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { houseWordHits, internalIds, leaks, parityGaps, sourceWordHits } from "./helpers/guard-tools";
import { NATIVE_LP_BRIDGE_PM_TOOLS } from "../src/rooms/native-agent/native-session-hooks";
import { PM_CORE_TOOLS, PM_FAMILY_TOOLS } from "../src/rooms/platform/server/pm-tool-families";

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => { const path = join(dir, name); return statSync(path).isDirectory() ? (name === "node_modules" ? [] : walk(path)) : [path]; });

describe("guard tools", () => {
  it("leak scanner: no secret-shaped string in the sources and docs that ship", () => {
    const files = [...walk("src"), ...walk("docs"), ...walk("packages/i18n/src")].filter((path) => /\.(ts|tsx|md|json)$/.test(path) && !path.includes("guard-tools"));
    const found = files.flatMap((path) => leaks(readFileSync(path, "utf8")).map((hit) => `${path}:${hit.line}`));
    expect(found).toEqual([]);
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
    // Comments and tests: today's hits are baselined (the old brand still appears where history or leftover-cleanup code names it);
    // a NEW occurrence outside the baseline turns the suite red. Shrink the baseline as the old texts are cleaned.
    const baseline = new Set(JSON.parse(readFileSync(join("tests/fixtures/house-words-baseline.json"), "utf8")) as string[]);
    const files = [...walk("src"), ...walk("docs"), ...walk("tests")].filter((path) => /\.(ts|tsx|md|json)$/.test(path) && !path.includes("guard-tools") && !path.includes("sma-map"));
    const found = files.flatMap((path) => sourceWordHits(path, readFileSync(path, "utf8"))).filter((hit) => !baseline.has(hit));
    expect(found).toEqual([]);
  });

  it("permission rules parity: the PM's tools are the same in a BB session and in the folded terminal list", () => {
    expect(parityGaps(NATIVE_LP_BRIDGE_PM_TOOLS.filter((tool) => tool !== "lane_pilot_tool_search"), [...PM_CORE_TOOLS, ...PM_FAMILY_TOOLS])).toEqual({ onlySession: [], onlyTerminal: [] });
  });
});
