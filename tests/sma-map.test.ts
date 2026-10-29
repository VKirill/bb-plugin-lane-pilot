import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { SMA_CARDS, SMA_CONTRACT_TESTS, SMA_LINKS, SMA_NODES, brokenProof, isDone, runSmaMapCli, smaHoles, smaRows } from "../src/rooms/sma-map";

// Only this repository's links: a link into Lane Stack or the core is navigation, and a rename there must not fail Lane Pilot's
// suite (2026-10-29 Grok audit F-004). What a card promises is checked by its [sma:<id>] contract test, not by its link.
const roots = { lanePilot: process.cwd() };

describe("the SMA map registry", () => {
  it("is the whole site map: every node, link and card, with one entry each and none left out", () => {
    expect(SMA_NODES.length).toBe(1798);
    expect(SMA_LINKS.length).toBe(2654);
    expect(SMA_LINKS.filter(([, , kind]) => kind === "retries")).toHaveLength(9);
    expect(SMA_NODES.filter(([id]) => !SMA_CARDS[id])).toEqual([]);
    expect(smaHoles()).toEqual([]);
  });

  it("links only nodes of the map", () => {
    const ids = new Set(SMA_NODES.map(([id]) => id));
    expect(SMA_LINKS.filter(([from, to]) => !ids.has(from) || !ids.has(to))).toEqual([]);
  });

  it("marks upstream only the nodes SMA itself leaves unwired", () => {
    expect(smaRows().filter((row) => row.status === "upstream" && !row.unsure).map((row) => row.smaId)).toEqual([]);
  });

  it("knows the contract tests: contracts.ts is current and every [sma:<id>] names a card of the map", () => {
    execFileSync("node", ["scripts/sma-contracts.mjs", "--check"], { stdio: "pipe" });
    const cards = new Set(Object.values(SMA_CARDS).map(([smaId]) => smaId));
    expect(Object.keys(SMA_CONTRACT_TESTS).filter((id) => !cards.has(id))).toEqual([]);
  });

  it("points every proof at a file that holds the named symbol", () => {
    const broken = smaRows().flatMap((row) => (row.proof ? [brokenProof(row.proof, roots)] : [])).filter(Boolean);
    expect(broken).toEqual([]);
  });

  it("is mapped: every node has a proof link, or SMA itself leaves it unwired", () => {
    const notDone = smaRows().filter((row) => !isDone(row)).map((row) => `${row.id} ${row.status} ${row.label}`);
    expect(notDone).toEqual([]);
  });

  it("prints the share done and the regions", () => {
    const result = runSmaMapCli([]);
    expect(result.stdout).toMatch(/SMA map \(code 481d75c2\): 1798 nodes, 2654 links — checked by a contract test \d+ \([\d.]+%\); mapped [\d.]+%/);
    expect(runSmaMapCli(["--region", "18", "--status", "missing"]).stdout).toContain("Claude Code session hooks");
  });
});
