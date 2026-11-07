import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { SMA_NODES, SMA_REGIONS } from "../src/rooms/sma-map";
import { SMA_LIVE, darkClockExpr, darkTableNames, darkTables, readSmaLive, tableClocks } from "../src/rooms/sma-map/live";
import { openDatabase } from "../src/rooms/plugin-db";

const groups = () => {
  const seen = new Map<string, { region: string; group: string; nodes: number }>();
  for (const [, region, group] of SMA_NODES) {
    const key = `${SMA_REGIONS[region]} | ${group}`;
    const row = seen.get(key) ?? { region: SMA_REGIONS[region]!, group, nodes: 0 };
    row.nodes += 1;
    seen.set(key, row);
  }
  return [...seen.values()];
};

describe("live evidence of the SMA map", () => {
  it("names a source for every group of the map, and only for groups that exist", () => {
    const keys = new Set(groups().map((row) => `${row.region} | ${row.group}`));
    expect([...keys].filter((key) => !SMA_LIVE[key])).toEqual([]);
    expect(Object.keys(SMA_LIVE).filter((key) => !keys.has(key))).toEqual([]);
  });
  it("every query runs on the real schema", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const rows = readSmaLive(openDatabase(bb) as never, groups(), 0);
    expect(rows.filter((row) => row.error)).toEqual([]);
  });
});

describe("dark tables (W32 rank 9)", () => {
  // Every table a migration creates must be a watched instrument: tableClocks reads the live schema, so coverage is
  // derived, not listed — and the clock it names must be a real column ("" counts the table in full).
  it("names every lane_pilot_* table the migrations create", async () => {
    const fs = await import("node:fs"), path = await import("node:path");
    const root = path.join(import.meta.dirname, "..");
    // The live schema is the referee: a CREATE ..._next rename, a DROP or a later ALTER would fool any text scan.
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const dbc = openDatabase(bb) as unknown as { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
    const seen = new Set<string>((dbc.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_%'").all() as Array<{ name: string }>).map((row) => row.name));
    const clocks = tableClocks(dbc as never);
    const missing = [...seen].filter((name) => !/_next$|_nv$|_v$|_fts/.test(name) && !(name in clocks));
    expect(missing).toEqual([]);
    // The clock a map row names must be a real column ("" counts the table in full).
    const wrongClock = Object.entries(clocks).filter(([table, clock]) => {
      if (!clock || !seen.has(table)) return false;
      const cols = (dbc.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>).map((row) => row.name);
      return !cols.includes(clock);
    }).map(([table]) => table);
    expect(wrongClock).toEqual([]);
    const sql = fs.readFileSync(path.join(root, "scripts/lp-wall-morning.sql"), "utf8");
    expect([...seen].filter((name) => !/_next$|_nv$|_v$|_fts/.test(name) && !sql.includes(`'${name}'`))).toEqual([]);
  });
  it("counts every named table on the real schema, dark or lit", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb) as never;
    expect(darkTables(db, Date.now() - 30 * 86_400_000).length).toBeGreaterThan(80);
    expect(darkTableNames(db, Date.now() - 30 * 86_400_000).length).toBeGreaterThan(0);
    expect(darkClockExpr("lane_pilot_token_daily")).toContain("strftime");
  });
});

describe("sma-map --live", () => {
  it("renders the regions and the silent groups", async () => {
    const { runSmaLiveCli } = await import("../src/rooms/sma-map");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const out = runSmaLiveCli(openDatabase(bb) as never, ["--live", "--days", "3"]);
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/live in the last 3 day/);
    expect(out.stdout).toMatch(/Phase graph/);
    expect(out.stdout).not.toMatch(/queries that failed/);
  });
});
