import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { runSmaLiveCli, runSmaMapCli } from "../src/rooms/sma-map";
import { anchorInfo } from "../src/rooms/sma-map/cli-proofs";
import { openDatabase } from "../src/rooms/plugin-db";
import { smaRows } from "../src/rooms/sma-map/model";
import { defaultSettings } from "../src/rooms/sma-map/settings-registry";
import { gapList, nodeStates, tallyStates } from "../src/rooms/sma-map/states";

describe("sma-map --states / --gaps / --hollow (sma-parity-tz.md §4)", () => {
  it("--states in a source checkout counts the four proofs on the registry defaults; observed needs a database", () => {
    const text = runSmaMapCli(["--states"]);
    expect(text.exitCode).toBe(0);
    expect(text.stdout).toMatch(/total 1798, available \d+, checked \d+, mutated \d+ \(stale \d+\), reachable \d+ \/ unreachable \d+/);
    expect(text.stdout).toMatch(/observed — \(node-level\), outcome-verified — \(node-level\), groupObserved —/);
    // Broken proof links are only region 10's Telegram text anchors (the ratchet in tests/sma-map.test.ts: 22 nodes), where
    // the plugin is checked out.
    expect(Number(/proof links \(the weaker ladder\): resolved \d+, broken (\d+)/.exec(text.stdout ?? "")?.[1])).toBeLessThanOrEqual(22);
    const json = JSON.parse(runSmaMapCli(["--states", "--json"]).stdout!);
    expect(json.states).toMatchObject({ total: 1798, observed: null, outcomeVerified: null, groupObserved: null });
    expect(json.states.mutated).toBeGreaterThanOrEqual(10);
    expect(json.states).toHaveProperty("proofResolved");
    expect(json.states).toHaveProperty("hollowOnMap");
    expect(json.regions).toHaveLength(29);
    expect(json.regions[1].mutated).toBeGreaterThanOrEqual(10);
  });

  it("--gaps lists per node which of the four proofs is missing, machine-readable and cut by region", () => {
    const json = JSON.parse(runSmaMapCli(["--gaps", "--json", "--region", "1"]).stdout!);
    expect(json.nodes.length).toBeGreaterThan(100);
    expect(json.nodes.every((node: { region: number }) => node.region === 1)).toBe(true);
    const n169 = json.nodes.find((node: { id: string }) => node.id === "n169");
    expect(n169.missing).toEqual(["reach", "trace"]);
    expect(n169.reachWhy).toMatch(/run\.max_tokens/);
    expect(json.nodes.find((node: { id: string }) => node.id === "n329").missing).toEqual(["trace"]);
    expect(runSmaMapCli(["--gaps", "--region", "99"]).exitCode).toBe(2);
  });

  it("--hollow lists findings with map nodes first", () => {
    const json = JSON.parse(runSmaMapCli(["--hollow", "--json"]).stdout!);
    expect(json.counts.total).toBe(json.findings.length);
    const firstOff = json.findings.findIndex((finding: { onMap: boolean }) => !finding.onMap);
    expect(json.findings.slice(firstOff).every((finding: { onMap: boolean }) => !finding.onMap)).toBe(true);
    expect(json.findings.some((finding: { sign: number }) => finding.sign === 2)).toBe(false);
  });

  it("with --live it reads the hub's settings, node-level traces and the live signs from the database", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb) as never;
    // An empty root: this checkout's own drill receipts carry per-node proofs and would count as traces.
    const bare = mkdtempSync(join(tmpdir(), "sma-bare-"));
    const json = JSON.parse(runSmaLiveCli(db, ["--live", "--states", "--json"], Date.now(), bare, bare).stdout!);
    expect(json.live).toBe(true);
    expect(json.states.observed).toBe(0);
    expect(json.states.outcomeVerified).toBe(0);
    expect(json.states.groupObserved).toBe(0);
    const hollow = JSON.parse(runSmaLiveCli(db, ["--live", "--hollow", "--json"], Date.now(), bare, bare).stdout!);
    expect(hollow.live).toBe(true);
    expect(hollow.findings.some((finding: { sign: number }) => finding.sign === 2)).toBe(true);
  });

  it("drill receipts are read from the plugin's own root, not from the directory the command was typed in", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb) as never;
    const plugin = mkdtempSync(join(tmpdir(), "sma-plugin-")), elsewhere = mkdtempSync(join(tmpdir(), "sma-cwd-"));
    mkdirSync(join(plugin, ".agents/runs/drills"), { recursive: true });
    writeFileSync(join(plugin, ".agents/runs/drills/a.json"), JSON.stringify({ finishedAt: Date.now(), scenarios: [] }));
    const from = (root?: string) => runSmaLiveCli(db, ["--live", "--states"], Date.now(), elsewhere, root).stdout!;
    expect(from()).toContain("no drill receipts here");
    expect(from(plugin)).toContain(`1 drill receipt(s) in ${join(plugin, ".agents/runs/drills")}`);
  });

  it("--gaps shows each anchor's resolved file and size and flags one under tests/ or the size of a dispatcher", () => {
    const root = mkdtempSync(join(tmpdir(), "sma-anchor-"));
    for (const dir of ["tests", "src"]) mkdirSync(join(root, dir));
    writeFileSync(join(root, "tests/helper.ts"), "export function small() {\n  return 1;\n}\n");
    writeFileSync(join(root, "src/small.ts"), "export function small() {\n  return 1;\n}\n");
    writeFileSync(join(root, "src/big.ts"), `export function dispatch(x: number) {\n${"  if (x) x += 1;\n".repeat(200)}  return x;\n}\n`);
    expect(anchorInfo("tests/helper.ts#small", root)).toMatchObject({ file: "tests/helper.ts", symbol: "small", lines: 3, flag: expect.stringContaining("under tests/") });
    expect(anchorInfo("src/small.ts#small", root)).toEqual({ file: "src/small.ts", symbol: "small", lines: 3 });
    expect(anchorInfo("src/big.ts#dispatch", root)).toMatchObject({ lines: 203, flag: expect.stringContaining("dispatcher") });
    expect(anchorInfo("src/gone.ts#x", root)).toMatchObject({ flag: "the anchor file does not exist" });
    expect(anchorInfo("core:x.ts#y", root)).toBeNull();
    const gaps = JSON.parse(runSmaMapCli(["--gaps", "--json", "--region", "13"]).stdout!);
    expect(gaps.nodes.some((node: { anchor?: { lines: number } }) => node.anchor && node.anchor.lines > 0)).toBe(true);
  });

  it("an exception closes a node without the four proofs; an unreviewed void is listed with voidReview missing", () => {
    const states = nodeStates({ rows: smaRows(), root: "", settings: defaultSettings() });
    const upstream = states.find((state) => state.status === "upstream")!;
    expect(upstream).toMatchObject({ exception: "upstream", missing: [] });
    const gaps = gapList(states);
    const voids = gaps.filter((gap) => gap.status === "void");
    expect(voids.length).toBeGreaterThan(0);
    expect(voids.every((gap) => gap.missing.includes("voidReview"))).toBe(true);
    expect(tallyStates(states, false).exceptions.upstream).toBe(states.filter((state) => state.status === "upstream").length);
  });
});
