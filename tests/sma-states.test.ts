import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { runSmaLiveCli, runSmaMapCli } from "../src/rooms/sma-map";
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
    expect(text.stdout).toMatch(/proof links \(the weaker ladder\): resolved \d+, broken 0/);
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
    const json = JSON.parse(runSmaLiveCli(db, ["--live", "--states", "--json"]).stdout!);
    expect(json.live).toBe(true);
    expect(json.states.observed).toBe(0);
    expect(json.states.outcomeVerified).toBe(0);
    expect(json.states.groupObserved).toBe(0);
    const hollow = JSON.parse(runSmaLiveCli(db, ["--live", "--hollow", "--json"]).stdout!);
    expect(hollow.live).toBe(true);
    expect(hollow.findings.some((finding: { sign: number }) => finding.sign === 2)).toBe(true);
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
