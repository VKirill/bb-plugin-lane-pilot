import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { decideReplay, type ArmVerdict } from "../src/rooms/pm-replay/decide";
import { importScenarios, parseHarvested } from "../src/rooms/pm-replay/harvest";
import { insertResult, insertScenario, latestVerdicts, listScenarios, replayStats, linkScenariosToRule, retireScenario } from "../src/rooms/pm-replay/store";
import { migrations, openDatabase } from "../src/rooms/plugin-db";

const NOW = Date.now();

function freshDb() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  return db;
}

const verdict = (v: string, sample = 1): ArmVerdict => ({ verdict: v, sample });

describe("pm-replay decideReplay (staged A/B)", () => {
  const active = ["s1", "s2", "s3"];
  it("waits while incident scenarios have no candidate verdict", () => {
    const d = decideReplay({ incidentIds: ["s1"], base: new Map(), candidate: new Map(), activeIds: active });
    expect(d.action).toBe("wait");
  });
  it("adopts when the candidate fixes the incident and nothing regresses", () => {
    const d = decideReplay({
      incidentIds: ["s1"],
      base: new Map([["s1", verdict("FAIL")], ["s2", verdict("PASS")], ["s3", verdict("PASS")]]),
      candidate: new Map([["s1", verdict("PASS")], ["s2", verdict("PASS")], ["s3", verdict("PASS")]]),
      activeIds: active,
    });
    expect(d).toMatchObject({ action: "adopt" });
  });
  it("asks for a second sample on a single regression FAIL, then rejects when it reproduces", () => {
    const candidate = new Map([["s1", verdict("PASS")], ["s2", verdict("PASS")], ["s3", verdict("FAIL")]]);
    const d1 = decideReplay({ incidentIds: ["s1"], base: new Map([["s1", verdict("FAIL")], ["s3", verdict("PASS")]]), candidate, activeIds: active });
    expect(d1).toMatchObject({ action: "retry", scenarioIds: ["s3"] });
    candidate.set("s3#2", verdict("FAIL"));
    const d2 = decideReplay({ incidentIds: ["s1"], base: new Map([["s1", verdict("FAIL")], ["s3", verdict("PASS")]]), candidate, activeIds: active });
    expect(d2).toMatchObject({ action: "reject", retireIncident: false });
    // A FAIL already red on the base arm is not a regression.
    candidate.set("s3#2", verdict("FAIL"));
    const d3 = decideReplay({ incidentIds: ["s1"], base: new Map([["s1", verdict("FAIL")], ["s3", verdict("FAIL")]]), candidate, activeIds: active });
    expect(d3).toMatchObject({ action: "adopt" });
  });
  it("does not adopt a rule the base arm already passes without", () => {
    const candidate = new Map([["s1", verdict("PASS")], ["s2", verdict("PASS")], ["s3", verdict("PASS")]]);
    expect(decideReplay({ incidentIds: ["s1"], base: new Map([["s1", verdict("PASS")]]), candidate, activeIds: active })).toMatchObject({ action: "wait" });
  });
  it("retires the incident when its own scenario fails twice on the candidate", () => {
    const candidate = new Map([["s1", verdict("FAIL")], ["s1#2", verdict("FAIL")], ["s2", verdict("PASS")], ["s3", verdict("PASS")]]);
    const d = decideReplay({ incidentIds: ["s1"], base: new Map(), candidate, activeIds: active });
    expect(d).toMatchObject({ action: "reject", retireIncident: true });
  });
  it("waits for the rest of the active set before adopting", () => {
    const d = decideReplay({ incidentIds: ["s1"], base: new Map(), candidate: new Map([["s1", verdict("PASS")]]), activeIds: active });
    expect(d.action).toBe("wait");
  });
});

describe("pm-replay harvest parsing", () => {
  const tools = ["lane_pilot_dispatch_writer", "lane_pilot_errand", "lane_pilot_ask_owner"];
  const obs = { obsId: "obs:12", threadId: "thr_1", projectId: "p1", at: NOW, ownerMessage: "ты опять спрашиваешь то что сам решаешь", tools };
  it("builds a scenario from the model's JSON and keeps only known tools", () => {
    const reply = JSON.stringify({
      situation: "[Context] Project p1. The owner asked for a button on /pricing.",
      should: "Dispatch the change without asking.",
      fail_if: "Asked the owner for permission first.",
      expect: ["lane_pilot_dispatch_writer"],
      forbid: ["lane_pilot_ask_owner", "unknown_tool"],
      responses: { "lane_pilot_dispatch_writer": "task t1 queued", "bogus": "x" },
    });
    const s = parseHarvested(`prelude ${reply}`, obs, NOW)!;
    expect(s).not.toBeNull();
    expect(s.expect).toEqual(["lane_pilot_dispatch_writer"]);
    expect(s.forbid).toEqual(["lane_pilot_ask_owner"]);
    expect(Object.keys(s.responses!)).toEqual(["lane_pilot_dispatch_writer"]);
    expect(s.msg).toContain("owner asked for a button");
    expect(s.state).toBe("active");
  });
  it("appends the owner's message when the situation does not quote it", () => {
    const s = parseHarvested(JSON.stringify({ situation: "[Context] a long enough situation string here", should: "do the right thing now" }), obs, NOW)!;
    expect(s.msg).toContain(obs.ownerMessage);
  });
  it("drops unreadable or empty replies", () => {
    expect(parseHarvested("no json here", obs, NOW)).toBeNull();
    expect(parseHarvested(JSON.stringify({ situation: "short", should: "x" }), obs, NOW)).toBeNull();
  });
});

describe("pm-replay import + store", () => {
  it("imports the pm-live-eval scenario format and keeps it queryable", () => {
    const db = freshDb();
    const rows = [
      { id: "R1", msg: "[Context] a notice arrived that a run failed", expect: ["lane_pilot_workflow_status"], forbid: ["lane_pilot_workflow_amend"], should: "read the state first", fail_if: "re-ran blind", responses: { "lane_pilot_workflow_status": { status: "failed" } } },
      { id: "R2", msg: "the owner asks to just do it", argCheck: { lane_pilot_dispatch_writer: "/pricing" } },
      { id: "", msg: "no id" }, { id: "R3", msg: "short" },
    ];
    const scenarios = importScenarios(rows, "p1", NOW);
    expect(scenarios.map((s) => s.id)).toEqual(["imp_R1", "imp_R2"]);
    for (const s of scenarios) expect(insertScenario(db, s)).toBe(true);
    expect(listScenarios(db, { state: "active" })).toHaveLength(2);
    insertResult(db, { scenarioId: "imp_R1", arm: "base:x", sample: 1, verdict: "FAIL", why: "re-ran blind", calls: [{ tool: "lane_pilot_workflow_amend", args: {} }], costUsd: 0.42, at: NOW });
    insertResult(db, { scenarioId: "imp_R1", arm: "base:x", sample: 1, verdict: "PASS", why: "", calls: [], costUsd: 0.4, at: NOW + 1 });
    expect(latestVerdicts(db, { arm: "base:x" }).get("imp_R1")).toMatchObject({ verdict: "PASS" });
    expect(replayStats(db, NOW - 1000)).toMatchObject({ runs: 2, pass: 1, fail: 1 });
    expect(replayStats(db, NOW - 1000).costUsd).toBeCloseTo(0.82, 5);
    expect(linkScenariosToRule(db, ["imp_R1"], "rule_1")).toBe(1);
    expect(listScenarios(db, { ruleId: "rule_1" })).toHaveLength(1);
    expect(retireScenario(db, "imp_R1")).toBe(true);
    expect(listScenarios(db, { state: "active" })).toHaveLength(1);
  });
  it("an identical import twice inserts nothing the second time", () => {
    const db = freshDb();
    const rows = [{ id: "R1", msg: "same scenario message here" }];
    expect(importScenarios(rows, "*", NOW).map((s) => insertScenario(db, s))).toEqual([true]);
    expect(importScenarios(rows, "*", NOW).map((s) => insertScenario(db, s))).toEqual([false]);
  });
});
