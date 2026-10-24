import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { SMA_NODES, SMA_REGIONS } from "../src/rooms/sma-map";
import { SMA_LIVE, readSmaLive } from "../src/rooms/sma-map/live";
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
