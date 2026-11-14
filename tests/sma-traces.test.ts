import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { SMA_EVIDENCE } from "../src/rooms/sma-map/evidence";
import { openDatabase } from "../src/rooms/plugin-db";
import { changePoints, firstSeenAfter, newerVersion, traceAfter, versionSeen, type ProvenanceFile } from "../src/rooms/sma-map/provenance";
import { drill, gate, kv, outside, part, readDrills, readTrace, readTraces, receipt, rows, rpc, schedule, settingRow, stage, taskField, traceSql, transition, wfRun, wfStep, type TraceSource } from "../src/rooms/sma-map/traces";

const db = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb) as never as { prepare(sql: string): { get(): unknown; all(): unknown[]; run(...args: unknown[]): unknown } };
const every: TraceSource[] = [
  gate("accept", ["passed", "rejected"]), stage("verification", "failed"), receipt("code-critique", "pass"), transition({ from: "queued", to: "spawn_requested", reason: "x" }),
  taskField("state", "x"), wfRun("lp.plan", "completed"), wfStep("lp.plan", ["plan", "research"], "done"), part({ section: "decisions", kind: "note" }), schedule("nightly-docs", "ok"),
  settingRow("owner.words"), rows("lane_pilot_attempt", "updated_at", "failure_code IS NOT NULL"),
];

describe("node-level traces run on the real schema (sma-parity-tz.md §4, proof 4)", () => {
  it("every kind of source the database answers is valid SQL against the plugin's tables", () => {
    const handle = db();
    for (const source of every) {
      const reading = readTrace({ db: handle }, source, 0);
      expect(reading, JSON.stringify(source)).toMatchObject({ judged: true, n: 0, last: null });
      expect(reading.error).toBeUndefined();
    }
  });

  it("every trace of the evidence registry runs on the real schema", () => {
    const handle = db();
    const failed: string[] = [];
    for (const [id, evidence] of Object.entries(SMA_EVIDENCE)) {
      for (const source of evidence.trace === undefined ? [] : Array.isArray(evidence.trace) ? evidence.trace : [evidence.trace as TraceSource]) {
        const reading = readTrace({ db: handle }, source, 0);
        if (reading.error) failed.push(`${id}: ${reading.error}`);
      }
    }
    expect(failed).toEqual([]);
  });

  it("counts what fired in the window and the newest time; an older row is outside it", () => {
    const handle = db();
    handle.prepare("INSERT INTO lane_pilot_gate_event (project_id, run_id, task_id, gate, status, input_sha256, output_sha256, attempt, occurred_at) VALUES ('p','r','t','accept','passed','a','b',1,5000), ('p','r','t','accept','rejected','a','b',1,9000), ('p','r','t','accept','passed','a','b',1,100)").run();
    expect(readTrace({ db: handle }, gate("accept", ["passed", "rejected"]), 1000)).toMatchObject({ n: 2, last: 9000, judged: true });
    expect(readTrace({ db: handle }, gate("accept", "rejected"), 1000)).toMatchObject({ n: 1, last: 9000 });
    expect(readTrace({ db: handle }, gate("validate"), 1000)).toMatchObject({ n: 0, last: null, judged: true });
  });

  it("outside, KV and RPC are not judged without a reader; a drill counts only a passed scene in the window", () => {
    expect(readTrace({ db: db() }, outside("the BB thread"), 0)).toMatchObject({ judged: false });
    expect(readTrace({}, kv("x"), 0).judged).toBe(false);
    expect(readTrace({ rpc: () => ({ n: 3, last: 7 }) }, rpc("lane-pilot.x"), 0)).toMatchObject({ judged: true, n: 3, last: 7 });
    expect(traceSql(outside("x"))).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "sma-drills-"));
    writeFileSync(join(dir, "a.json"), JSON.stringify({ finishedAt: 5000, commit: "abc", scenarios: [{ name: "writer-accepts", result: "pass" }, { name: "rework", result: "fail" }] }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ finishedAt: 100, scenarios: [{ name: "writer-accepts", result: "pass" }] }));
    const drills = readDrills(dir);
    expect(readTrace({ drills }, drill("writer-accepts"), 1000)).toMatchObject({ judged: true, n: 1, last: 5000 });
    expect(readTrace({ drills }, drill("rework"), 0)).toMatchObject({ judged: true, n: 0 });
    expect(readDrills(join(dir, "absent"))).toBeNull();
    expect(readTraces({ drills }, [outside("x"), drill("writer-accepts")], 0)).toMatchObject({ judged: true, n: 2, last: 5000 });
  });
});

describe("change points: a trace counts only on a version that has the node's last change", () => {
  const file: ProvenanceFile = {
    generatedFrom: "x", version: "0.1.10", deploys: 3, lastDeployed: "0.1.10",
    nodes: { a: ["c1", 1, "0.1.8", 1000, "symbol", "h"], b: ["c2", 2, "0.1.9", 2000, "symbol", "h"], c: ["c3", 3, null, null, "file", "h"] },
  };
  const links = [["b", "a", "transition", ""]] as const;

  it("takes the later of the node's own change and its direct control predecessors'", () => {
    const points = changePoints(["a", "b", "c", "d"], links, () => undefined, "", file);
    expect(points.get("a")).toMatchObject({ state: "shipped", version: "0.1.9", from: "b" });
    expect(points.get("b")).toMatchObject({ state: "shipped", version: "0.1.9", from: "b" });
    expect(points.get("c")).toMatchObject({ state: "unshipped" });
    expect(points.get("d")).toEqual({ state: "unknown" });
    expect(traceAfter(points.get("a")!, 1500)).toBe(false);
    expect(traceAfter(points.get("a")!, 2500)).toBe(true);
    expect(traceAfter(points.get("c")!, 9e12)).toBe(false);
    expect(traceAfter(points.get("d")!, 1)).toBe(true);
    expect(traceAfter(points.get("d")!, null)).toBe(false);
  });

  it("on the hub, an unshipped change is dated by the first newer version an attempt ran", () => {
    const handle = db();
    handle.prepare("PRAGMA foreign_keys = OFF").run();
    handle.prepare("INSERT INTO lane_pilot_attempt (id, run_id, task_id, state, created_at, updated_at, attempt_no, harness_version) VALUES ('a1','r','t','running',4000,4000,1,'0.1.11'), ('a2','r','t','running',3000,3000,1,'0.1.10'), ('a3','r','t','running',5000,5000,1,'0.1.12')").run();
    const seen = versionSeen(handle);
    expect(seen.get("0.1.11")).toBe(4000);
    expect(firstSeenAfter(seen, "0.1.10")).toEqual({ version: "0.1.11", at: 4000 });
    expect(newerVersion("0.1.100", "0.1.99")).toBe(true);
    const points = changePoints(["c"], [], () => undefined, "", file, seen);
    expect(points.get("c")).toMatchObject({ state: "shipped", version: "0.1.11", deployedAt: 4000 });
  });
});
