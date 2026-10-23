import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SMA_LINKS, SMA_NODES, brokenProof, isDone, runSmaMapCli, smaHoles, smaRows } from "../src/rooms/sma-map";

const roots = {
  lanePilot: process.cwd(),
  ...(existsSync(join(process.cwd(), "..", "claude-lane-stack")) ? { laneStack: join(process.cwd(), "..", "claude-lane-stack") } : {}),
  ...(existsSync(join(homedir(), ".local", "share", "bb-source-vk")) ? { core: join(homedir(), ".local", "share", "bb-source-vk") } : {}),
};

describe("the SMA map registry", () => {
  it("has one entry for every node of the map and a reason for every node not taken", () => {
    expect(SMA_NODES.length).toBe(1768);
    expect(smaHoles()).toEqual([]);
  });

  it("links only nodes of the map", () => {
    const ids = new Set(SMA_NODES.map(([id]) => id));
    expect(SMA_LINKS.filter(([from, to]) => !ids.has(from) || !ids.has(to))).toEqual([]);
  });

  it("points every proof at a file that holds the named symbol", () => {
    const broken = smaRows().flatMap((row) => (row.proof ? [brokenProof(row.proof, roots)] : [])).filter(Boolean);
    expect(broken).toEqual([]);
  });

  it("is done: every node is proven in the code or not taken with a reason", () => {
    const notDone = smaRows().filter((row) => !isDone(row)).map((row) => `${row.id} ${row.status} ${row.label}`);
    expect(notDone).toEqual([]);
  });

  it("prints the share done and the regions", () => {
    const result = runSmaMapCli([]);
    expect(result.stdout).toMatch(/SMA map: 1768 nodes — done [\d.]+%/);
    expect(runSmaMapCli(["--region", "18", "--status", "missing"]).stdout).toContain("Claude Code session hooks");
  });
});
