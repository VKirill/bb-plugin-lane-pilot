import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderFacts } from "../scripts/sma-hollow";
import { stage } from "../src/rooms/sma-map/evidence/types";
import { collectHollowFacts, SMA_HOLLOW_FACTS, type HollowFacts } from "../src/rooms/sma-map/hollow-facts";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/plugin-db";
import { hollowCounts, hollowFindings, readHollowLive, spanLine, type HollowLive } from "../src/rooms/sma-map/hollow";
import type { SmaRow } from "../src/rooms/sma-map/model";
import { defaultSettings, settingRegistry } from "../src/rooms/sma-map/settings-registry";
import { constantReturn } from "../src/rooms/sma-map/symbols";

const offSwitch = () => [...settingRegistry().values()].find((info) => info.switchLike && info.default === "off")!.key;

/** A checkout with one hollow graph, one healthy graph, a chain test and two functions. */
function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sma-hollow-"));
  mkdirSync(join(root, "workflows"));
  mkdirSync(join(root, "tests/workflow"), { recursive: true });
  mkdirSync(join(root, "src/rooms/fx"), { recursive: true });
  writeFileSync(join(root, "workflows/fx-bad.json"), JSON.stringify({
    id: "fx-bad", status: "draft",
    inputs: { shadow: { type: "bool", default: false, note: "a second opinion" } },
    nodes: [
      { id: "start", type: "action", action: "emit", map: { brief: "$inputs.brief", files: "$inputs.files" } },
      { id: "think", type: "agent", prompt: "TODO write the prompt" },
      { id: "judge", type: "agent", prompt: "Judge the change against its contract and return a status with the evidence.", out: { status: "pass|rework" } },
      { id: "extra", type: "agent", prompt: "Give a second opinion on {{judge.status}} with the reasons.", skip_when: "!$inputs.shadow" },
      { id: "done", type: "action", action: "write_receipt" },
    ],
    edges: [{ from: "start", to: "think" }, { from: "think", to: "judge" }, { from: "judge", to: "done", when: "judge.status == 'block'" }, { from: "judge", to: "extra", when: "judge.status == 'rework'" }, { from: "extra", to: "done" }],
  }, null, 2));
  writeFileSync(join(root, "workflows/fx-good.json"), JSON.stringify({
    id: "fx-good", status: "published", inputs: { mode: { type: "fast|deep", default: "fast" } },
    nodes: [
      { id: "plan", type: "agent", prompt: "Plan the change in steps and name the files each step touches.", out: { verdict: "go|stop" } },
      { id: "write", type: "action", action: "write_plan" },
      { id: "stop", type: "action", action: "emit", map: { reason: "plan.reason" } },
    ],
    edges: [{ from: "plan", to: "write", when: "plan.verdict == 'go'" }, { from: "plan", to: "stop", when: "plan.verdict == 'stop'" }],
  }, null, 2));
  writeFileSync(join(root, "tests/workflow/chains-fx.test.ts"), `it("walks", async () => { const r = await runSim("fx-good", {}); expect(pathOf(r)).toBe("plan write"); expect(pathOf(r2)).toBe("plan stop"); });\n`);
  writeFileSync(join(root, "src/rooms/fx/a.ts"), [
    "export function alwaysYes(input: string): boolean {", "  return true;", "}",
    "export function real(input: string): boolean {", "  return input.trim().length > 3;", "}",
    "export const shaped = (input: string) => ({ ok: input.length > 0, input });", "",
  ].join("\n"));
  return root;
}

const row = (id: string, status: SmaRow["status"], contracts: string[], proof?: string): SmaRow => ({ id, smaId: `fx_${id}`, region: "Task graph", group: "g", kind: "check", label: id, detail: "", unsure: false, status, ours: "x", ...(proof ? { proof } : {}), contracts, gaps: [] });

describe("the hollow detector (sma-parity-tz.md §4а)", () => {
  const root = fixtureRoot();
  const facts = collectHollowFacts(root, { n1: "src/rooms/fx/a.ts#alwaysYes", n2: "src/rooms/fx/a.ts#real", n3: "workflows/fx-bad.json" });

  it("catches a pass-through action, a stub-prompt agent, a never-true branch and a default-off step (signs 1 and 4)", () => {
    const bad = facts.workflowDefects.filter((defect) => defect.graph === "fx-bad");
    expect(bad).toContainEqual(expect.objectContaining({ node: "start", sign: 1, what: expect.stringContaining("only copies its input") }));
    expect(bad).toContainEqual(expect.objectContaining({ node: "think", sign: 1, what: expect.stringContaining("a stub prompt") }));
    expect(bad).toContainEqual(expect.objectContaining({ edge: ["judge", "done", "judge.status == 'block'"], sign: 1, what: expect.stringContaining("can never be true") }));
    expect(bad).toContainEqual(expect.objectContaining({ node: "extra", sign: 4, what: expect.stringContaining("skipped by default") }));
  });

  it("does not flag the healthy graph — a terminal emit is the output, a reachable enum branch is fine", () => {
    expect(facts.workflowDefects.filter((defect) => defect.graph === "fx-good")).toEqual([]);
    expect(facts.coverage["fx-good"]).toEqual(expect.arrayContaining(["plan", "write", "stop", "plan>write", "plan>stop"]));
  });

  it("catches a function that returns a constant whatever it is given, and not one that works (sign 3)", () => {
    expect(facts.anchorDefects.n1).toEqual([expect.stringContaining("returns the constant true")]);
    expect(facts.anchorDefects.n2).toBeUndefined();
    expect(facts.functionDefects.map((defect) => defect.path)).toEqual(["src/rooms/fx/a.ts#alwaysYes"]);
    expect(constantReturn("return { ok: true, n: 1 };")).toBe("{ ok: true, n: 1 }");
    expect(constantReturn("return { ok: input.length > 0 };")).toBeNull();
  });

  it("reports map nodes first: have with no behaviour test (5), an undeclared default-off gate (4), the node's own constant (3); a healthy node gets nothing", () => {
    const gate = offSwitch();
    const withGate: HollowFacts = { ...facts, settingReads: { n2: [gate] } };
    const rows = [row("n1", "have", ["t › a"], "src/rooms/fx/a.ts#alwaysYes"), row("n2", "have", ["t › b"], "src/rooms/fx/a.ts#real"), row("n4", "have", []), row("n5", "have", ["t › c"], "src/rooms/fx/a.ts#real")];
    const findings = hollowFindings({ rows, evidence: {}, facts: withGate, settings: defaultSettings() });
    const on = (id: string) => findings.filter((finding) => finding.mapNodes.includes(id) && finding.subject.type === "map-node").map((finding) => finding.sign);
    expect(on("n1")).toEqual([3]);
    expect(on("n2")).toEqual([4]);
    expect(on("n4")).toEqual([5]);
    expect(on("n5")).toEqual([]);
    const firstOff = findings.findIndex((finding) => !finding.onMap);
    expect(findings.slice(firstOff).every((finding) => !finding.onMap)).toBe(true);
    // A declared need silences the undeclared gate — and is then judged itself (it fails under the defaults).
    const declared = hollowFindings({ rows: [rows[1]!], evidence: { n2: { reach: { needs: { [gate]: "on" } } } }, facts: withGate, settings: defaultSettings() });
    expect(declared.filter((finding) => finding.onMap).map((finding) => finding.what)).toEqual([expect.stringContaining("declared needs fail")]);
  });

  it("guesses the kind of an off-map finding, and lays a graph defect on the map node whose proof names the graph", () => {
    const findings = hollowFindings({ rows: [row("n3", "have", ["t › d"], "workflows/fx-bad.json")], evidence: {}, facts, settings: defaultSettings() });
    const think = findings.find((finding) => finding.subject.path === "fx-bad.think")!;
    expect(think).toMatchObject({ onMap: true, mapNodes: ["n3"], sign: 1 });
    const off = hollowFindings({ rows: [], evidence: {}, facts, settings: defaultSettings() });
    expect(off.find((finding) => finding.subject.path === "fx-bad.think")).toMatchObject({ onMap: false, guess: "unfinished function" });
    expect(off.find((finding) => finding.subject.type === "function")).toMatchObject({ guess: "unfinished function", sign: 3 });
    // A default-off step off the map is the owner's per-run choice, not a finding.
    expect(off.some((finding) => finding.subject.path === "fx-bad.extra" && finding.sign === 4)).toBe(false);
  });

  it("live: a graph that never ran with nothing walking it, an untaken emergency edge, and a stage that never refuses (signs 2 and 6)", () => {
    const live: HollowLive = {
      days: 30, graphRuns: new Map([["fx-good", 4]]), nodeSteps: new Map([["fx-good|plan", 4], ["fx-good|write", 4]]), edgeSteps: new Map([["fx-good|plan|write|plan.verdict == 'go'", 4]]),
      verdicts: [{ type: "stage", id: "verification", runs: 40, refusals: 0 }, { type: "stage", id: "code-critique", runs: 40, refusals: 3 }, { type: "gate", id: "accept", runs: 5, refusals: 0 }],
    };
    const findings = hollowFindings({ rows: [], evidence: {}, facts, settings: defaultSettings(), live });
    expect(findings).toContainEqual(expect.objectContaining({ subject: { type: "workflow", path: "fx-bad" }, sign: 2, guess: "new unfinished graph" }));
    // fx-good's stop branch did not run, but a chain test walks it: waived.
    expect(findings.some((finding) => finding.subject.path.startsWith("fx-good"))).toBe(false);
    expect(findings.filter((finding) => finding.sign === 6).map((finding) => finding.subject.path)).toEqual(["verification"]);
    // A mutation test that shows the stage can refuse waives sign 6.
    const attested = hollowFindings({ rows: [row("n9", "have", ["t › e"])], evidence: { n9: { trace: stage("verification"), hollowAttested: { commit: "abc1234", test: "tests/x.test.ts › refuses" } } }, facts, settings: defaultSettings(), live });
    expect(attested.some((finding) => finding.sign === 6)).toBe(false);
    expect(hollowCounts(findings).bySign["2"]).toBeGreaterThan(0);
  });

  it("live: an edge out of the start, into the end or into a join is walked by what the journal records for it, not by a step of its target", () => {
    const graph = { id: "fx-edges", file: "workflows/fx-edges.json", status: "published",
      nodes: [["a", "agent"], ["b", "action"], ["fork", "parallel"], ["leaf", "action"], ["j", "join"], ["z", "action"]] as Array<[string, string]>,
      edges: [["start", "a", null], ["a", "b", "a.ok == true"], ["b", "end", null], ["a", "fork", "a.ok == false"], ["fork", "leaf", null], ["leaf", "j", null], ["j", "z", null], ["z", "end", "z.x == 1"], ["z", "end", "z.x == 2"]] as Array<[string, string, string | null]> };
    const withGraph: HollowFacts = { ...facts, graphs: [graph], coverage: {}, workflowDefects: [] };
    const base: HollowLive = { days: 30, graphRuns: new Map([["fx-edges", 9]]), nodeSteps: new Map(["a", "b", "fork", "leaf", "j", "z"].map((node) => [`fx-edges|${node}`, 9] as const)), edgeSteps: new Map([["fx-edges|a|b|a.ok == true", 9], ["fx-edges|fork|leaf|", 9], ["fx-edges|j|z|", 9], ["fx-edges|a|fork|a.ok == false", 9]]), verdicts: [] };
    const edges = (live: HollowLive) => hollowFindings({ rows: [], evidence: {}, facts: withGraph, settings: defaultSettings(), live }).filter((finding) => finding.sign === 2 && finding.subject.type === "workflow-edge");
    // The journal says nothing about the entry, the exits and the join: they are reported (the old behaviour, nothing to go on).
    expect(edges(base).map((finding) => finding.subject.path)).toEqual(expect.arrayContaining(["fx-edges: start → a", "fx-edges: b → end", "fx-edges: leaf → j"]));
    // With the entry step of `a`, an exit from a step of `b`, a branch arrival from `leaf`: the three edges are walked and not reported.
    const walked: HollowLive = { ...base, entries: new Map([["fx-edges|a", 9]]), exits: new Map([["fx-edges|b", 4]]), joinArrivals: new Map([["fx-edges|leaf", 9]]) };
    expect(edges(walked).map((finding) => finding.subject.path).filter((path) => /start → a|b → end|leaf → j/.test(path))).toEqual([]);
    // An exit never recorded for `b` keeps its edge reported, and a source with two edges to the end that left 5 times cannot be told apart: said so, not called never-fired.
    const partial = edges({ ...walked, exits: new Map([["fx-edges|z", 5]]) });
    expect(partial.map((finding) => finding.subject.path)).toContain("fx-edges: b → end");
    const ambiguous = partial.filter((finding) => finding.subject.path.startsWith("fx-edges: z → end"));
    expect(ambiguous).toHaveLength(2);
    expect(ambiguous.every((finding) => finding.what.includes("cannot tell which of the 2 edges") && !finding.what.includes("was not taken"))).toBe(true);
    // Two edges that left no exit at all are both truly never fired.
    expect(edges({ ...walked, exits: new Map([["fx-edges|b", 4]]) }).filter((finding) => finding.subject.path.startsWith("fx-edges: z → end")).every((finding) => finding.what.includes("was not taken"))).toBe(true);
    // A start edge the definitions call `$start` is matched by readHollowLive's normalised key (edge_index rows), covered on a database in the traces test of the hub.
  });

  it("readHollowLive reads the entry, exit and join records and the span from the journal", () => {
    const handle = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb) as never as { prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): unknown[] } };
    handle.prepare("PRAGMA foreign_keys = OFF").run();
    const definition = JSON.stringify({ edges: [{ from: "$start", to: "a" }, { from: "a", to: "$end" }] });
    handle.prepare("INSERT INTO lane_pilot_wf_run (id, workflow_id, workflow_version, workflow_sha256, definition_json, status, created_at, updated_at, harness_version) VALUES ('r1','fx',1,'sha',?, 'succeeded', 1000, 1000, '0.1.1'), ('r2','fx',1,'sha',?, 'succeeded', 86401000, 86401000, '0.1.1')").run(definition, definition);
    handle.prepare("INSERT INTO lane_pilot_wf_step (run_id, step_key, origin, node_id, visit, edge_index, state, started_at, updated_at) VALUES ('r1','a#1','o1','a',1,0,'succeeded',1000,1000), ('r2','a#1','o2','a',1,0,'skipped',null,1)").run();
    handle.prepare("INSERT INTO lane_pilot_wf_event (run_id, step_key, kind, at) VALUES ('r1','a#1','exit',1500), ('r2',null,'exit',1500)").run();
    handle.prepare("INSERT INTO lane_pilot_wf_step (run_id, step_key, origin, node_id, visit, scope, state, updated_at) VALUES ('r1','leaf#1~0','o3','leaf',1,'p~0','succeeded',1)").run();
    handle.prepare("INSERT INTO lane_pilot_wf_arrival (run_id, group_key, branch, from_step, data_json, at) VALUES ('r1','p#1',0,'leaf#1~0','{}',1600), ('r1','p#1',1,'leaf#1~0','{\"$failed\":\"boom\"}',1700)").run();
    const live = readHollowLive(handle, 0, 30);
    expect(live.edgeSteps.get("fx|start|a|")).toBe(1);        // `$start` / `$end` of the definitions are the facts' `start` / `end`
    expect(live.edgeSteps.get("fx|a|end|")).toBeUndefined();   // an edge into the end starts no step
    expect(live.entries?.get("fx|a")).toBe(2);                 // the entry step in any state, skipped too
    expect([...live.exits!]).toEqual(expect.arrayContaining([["fx|a", 1], ["fx|start", 1]]));
    expect(live.joinArrivals?.get("fx|leaf")).toBe(1);         // the failed branch walked no edge
    expect(live.span).toEqual({ first: 1000, last: 86401000, runs: 2, days: 1 });
  });

  it("the span the data covers is printed next to the requested days", () => {
    const young = { first: Date.UTC(2026, 9, 30), last: Date.UTC(2026, 10, 14), runs: 5725, days: 15 };
    expect(spanLine(young, 30)).toBe("data covers 2026-10-30 … 2026-11-14 (15 day(s), 5725 workflow run(s)) of the 30 requested — a young database: «did not fire in 30 days» only means 15");
    expect(spanLine({ ...young, days: 40 }, 30)).not.toContain("young database");
    expect(spanLine({ first: null, last: null, runs: 0, days: 0 }, 30)).toBe("the journal holds no workflow run");
    expect(spanLine(undefined, 30)).toBe("");
  });

  it("the shipped facts file has the shape the hub reads, one fact per line", () => {
    expect(SMA_HOLLOW_FACTS.graphs.length).toBeGreaterThan(50);
    const rendered = renderFacts(facts);
    expect(JSON.parse(rendered)).toEqual(facts);
    expect(rendered.split("\n").length).toBeGreaterThan(facts.workflowDefects.length);
  });
});
