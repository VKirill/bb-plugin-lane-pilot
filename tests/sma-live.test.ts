import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { SMA_NODES, SMA_REGIONS } from "../src/rooms/sma-map";
import { SMA_LIVE, TABLE_CLOCKS, darkClockExpr, darkTableNames, darkTables, readSmaLive } from "../src/rooms/sma-map/live";
import { openDatabase } from "../src/rooms/storage";

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
  // Every table a migration creates must be a watched instrument: a key of TABLE_CLOCKS naming the column its
  // recency is read on ("" when it has none), and a row in the SQL twin of the morning report.
  it("names every lane_pilot_* table the migrations create", async () => {
    const fs = await import("node:fs"), path = await import("node:path");
    const root = path.join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (entry.name !== "tests" && entry.name !== "test") walk(p); } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) files.push(p);
      }
    };
    walk(path.join(root, "src")); walk(path.join(root, "packages"));
    const missing: string[] = [], seen = new Set<string>();
    for (const file of files) {
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        const m = /CREATE TABLE(?: IF NOT EXISTS)? `?(lane_pilot_[a-z_]+)`?/i.exec(line);
        if (!m || seen.has(m[1]!) || /_next$|_nv$|_v$|_fts/.test(m[1]!)) continue;
        seen.add(m[1]!);
        if (!(m[1]! in TABLE_CLOCKS)) missing.push(m[1]!);
      }
    }
    expect(missing).toEqual([]);
    // The clock a map row names must be a real column ("" counts the table in full); the live schema is the referee —
    // a CREATE ..._next rename or a later ALTER would fool any text scan.
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const dbc = openDatabase(bb) as unknown as { prepare(sql: string): { all(...args: unknown[]): unknown[] } };
    const wrongClock = Object.entries(TABLE_CLOCKS).filter(([table, clock]) => {
      if (!clock) return false;
      const cols = (dbc.prepare("SELECT name FROM pragma_table_info(?)").all(table) as Array<{ name: string }>).map((row) => row.name);
      return !cols.includes(clock);
    }).map(([table]) => table);
    expect(wrongClock).toEqual([]);
    const sql = fs.readFileSync(path.join(root, "scripts/lp-wall-morning.sql"), "utf8");
    expect([...seen].filter((name) => !sql.includes(`'${name}'`))).toEqual([]);
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
