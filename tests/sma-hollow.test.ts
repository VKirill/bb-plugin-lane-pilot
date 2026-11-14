import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderFacts } from "../scripts/sma-hollow";
import { stage } from "../src/rooms/sma-map/evidence/types";
import { collectHollowFacts, SMA_HOLLOW_FACTS, type HollowFacts } from "../src/rooms/sma-map/hollow-facts";
import { hollowCounts, hollowFindings, type HollowLive } from "../src/rooms/sma-map/hollow";
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

  it("the shipped facts file has the shape the hub reads, one fact per line", () => {
    expect(SMA_HOLLOW_FACTS.graphs.length).toBeGreaterThan(50);
    const rendered = renderFacts(facts);
    expect(JSON.parse(rendered)).toEqual(facts);
    expect(rendered.split("\n").length).toBeGreaterThan(facts.workflowDefects.length);
  });
});
