import { mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { SMA_ENTRIES } from "../src/rooms/sma-map/entries";
import { SMA_EVIDENCE } from "../src/rooms/sma-map/evidence";
import { openDatabase } from "../src/rooms/plugin-db";
import { SMA_PROVENANCE, anchorText, changePoints, firstSeenAfter, hash12, localProof, newerVersion, traceAfter, versionSeen, type ProvenanceFile } from "../src/rooms/sma-map/provenance";
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

  it("outside, KV and RPC are not judged without a reader", () => {
    expect(readTrace({ db: db() }, outside("the BB thread"), 0)).toMatchObject({ judged: false });
    expect(readTrace({}, kv("x"), 0).judged).toBe(false);
    expect(readTrace({ rpc: () => ({ n: 3, last: 7 }) }, rpc("lane-pilot.x"), 0)).toMatchObject({ judged: true, n: 3, last: 7 });
    expect(traceSql(outside("x"))).toBeNull();
  });

  it("a drill counts for node N only when N's passed scene lists N with ok true in the window (a scene-level pass proves nothing)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sma-drills-"));
    const proved = (node: string, ok: boolean) => ({ node, ok, detail: "leak scan returned []" });
    writeFileSync(join(dir, "a.json"), JSON.stringify({ finishedAt: 5000, commit: "abc", scenarios: [
      { name: "writer-accepts", result: "pass" },                                                      // passed, proves nobody
      { name: "sma_r13", result: "pass", proved: [proved("n1036", true), proved("n1037", false)] },    // n1036 yes, n1037 no
      { name: "sma_r14", result: "fail", proved: [proved("n1040", true)] },                            // the scene failed: nothing counts
    ] }));
    writeFileSync(join(dir, "b.json"), JSON.stringify({ finishedAt: 100, scenarios: [{ name: "sma_r13", result: "pass", proved: [proved("n1036", true)] }] }));
    const drills = readDrills(dir);
    expect(readTrace({ drills }, drill("writer-accepts"), 0, "n1036")).toMatchObject({ judged: true, n: 0 });
    expect(readTrace({ drills }, drill("sma_r13"), 1000, "n1036")).toMatchObject({ judged: true, n: 1, last: 5000 });
    expect(readTrace({ drills }, drill("sma_r13"), 0, "n1036")).toMatchObject({ n: 2 });
    expect(readTrace({ drills }, drill("sma_r13"), 0, "n1037")).toMatchObject({ judged: true, n: 0 });
    expect(readTrace({ drills }, drill("sma_r13"), 0, "n1038")).toMatchObject({ n: 0 });
    expect(readTrace({ drills }, drill("sma_r13"), 0)).toMatchObject({ n: 0 });
    expect(readTrace({ drills }, drill("sma_r14"), 0, "n1040")).toMatchObject({ n: 0 });
    expect(readDrills(join(dir, "absent"))).toBeNull();
    expect(readTraces({ drills }, [outside("x"), drill("sma_r13")], 1000, "n1036")).toMatchObject({ judged: true, n: 1, last: 5000 });
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

  it("a version the hub knows only from a start record (a workflow run of an upkeep graph, a memory probe) dates the change point; a version nobody recorded stays unshipped", () => {
    const handle = db();
    handle.prepare("PRAGMA foreign_keys = OFF").run();
    handle.prepare("INSERT INTO lane_pilot_wf_run (id, workflow_id, workflow_version, workflow_sha256, definition_json, status, created_at, updated_at, harness_version) VALUES ('w1','lp.upkeep',1,'x','{}','succeeded',6000,6000,'0.1.13'), ('w2','lp.upkeep',1,'x','{}','succeeded',6500,6500,'0.1.13')").run();
    handle.prepare("INSERT INTO lane_pilot_memory_probe (at, project_id, token, path, found, latency_ms, lp_version) VALUES (5500, 'p', 't', 'x', 1, 1, '0.1.13')").run();
    const seen = versionSeen(handle);
    expect(seen.get("0.1.13")).toBe(5500);          // the earliest of the sources
    expect(seen.has("0.1.14")).toBe(false);
    const older: ProvenanceFile = { generatedFrom: "x", version: "0.1.12", deploys: 1, lastDeployed: "0.1.12", nodes: { c: ["c3", 3, null, null, "file", "h"], d: ["c4", 4, null, null, "file", "h"] } };
    const shipped = changePoints(["c"], [], () => undefined, "", older, seen).get("c")!;
    expect(shipped).toMatchObject({ state: "shipped", version: "0.1.13", deployedAt: 5500 });
    expect(traceAfter(shipped, 5400)).toBe(false);   // a receipt made before the version first ran
    expect(traceAfter(shipped, 5600)).toBe(true);    // one made after it
    // nothing recorded a version newer than the file: the change stays unshipped and no trace counts
    const none = changePoints(["d"], [], () => undefined, "", { ...older, lastDeployed: "0.1.13" }, seen).get("d")!;
    expect(none).toMatchObject({ state: "unshipped" });
    expect(traceAfter(none, 9e12)).toBe(false);
  });
});

describe("the separate local R08 trace", () => {
  it("accepts only the named node from a passed local or legacy scene, never a failed scene or n752", () => {
    const dir = mkdtempSync(join(tmpdir(), "r08-local-traces-"));
    writeFileSync(join(dir, "receipts.json"), JSON.stringify({ finishedAt: 5000, scenarios: [
      { name: "sma_r08_local", result: "pass", proved: [{ node: "n678", ok: true }, { node: "n685", ok: false }] },
      { name: "sma_r08_local", result: "fail", proved: [{ node: "n704", ok: true }] },
      { name: "sma_r08", result: "pass", proved: [{ node: "n678", ok: true }, { node: "n752", ok: true }] },
    ] }));
    const drills = readDrills(dir);
    const traces = SMA_EVIDENCE.n678!.trace as TraceSource[];
    expect(readTraces({ drills }, traces, 0, "n678")).toMatchObject({ judged: true, n: 2 });
    expect(readTraces({ drills }, SMA_EVIDENCE.n685!.trace as TraceSource[], 0, "n685")).toMatchObject({ n: 0 });
    expect(readTraces({ drills }, SMA_EVIDENCE.n704!.trace as TraceSource[], 0, "n704")).toMatchObject({ n: 0 });
    expect(readTrace({ drills }, SMA_EVIDENCE.n752!.trace as TraceSource, 0, "n752")).toMatchObject({ n: 1 });
    expect(readTrace({ drills }, drill("sma_r08_local"), 0, "n752")).toMatchObject({ n: 0 });
  });

  it("registers the new scene and fails on missing or failed proofs, including an unexpected live node", () => {
    const code = `
import json, sys
from types import SimpleNamespace
sys.path.insert(0, ${JSON.stringify(join(process.cwd(), "scripts"))})
from lp_drill.sma import discover
from lp_drill.prove import Proofs
from lp_drill.scenes.sma_r08_local import NODES
from lp_drill.scenes import sma_r08, sma_r08_core_b, sma_r08_local
from unittest.mock import patch

def sample(missing=None, bad=None, extra=None):
    p = Proofs()
    for node in NODES:
        if node != missing: p.prove(node, node != bad, "actual observation")
    if extra: p.prove(extra, False if extra == "n999" else True, "extra observation")
    with patch.object(sma_r08_local, "prove_local", lambda tmp, proofs: (proofs.items.extend(p.items), [])[1]):
        return sma_r08_local.scenario_sma_r08_local(None)

def local_stub(tmp, proofs):
    for node in NODES: proofs.prove(node, True, "local observation")
    return []
def local_stub_with(missing=None, bad=None, extra=None):
    def stub(tmp, proofs):
        for node in NODES:
            if node != missing: proofs.prove(node, node != bad, "actual observation")
        if extra: proofs.prove(extra, False if extra == "n999" else True, "extra observation")
        return []
    return stub
def registry_sentinel(*args, **kwargs):
    raise AssertionError("local scene called the live registry path")
scenes = discover()
def core_failure(proofs, tmp):
    proofs.prove("n752", False, "registry unavailable")
with patch.object(sma_r08_local, "prove_local", local_stub), patch.object(sma_r08, "prove_core_b", registry_sentinel), patch.object(sma_r08_core_b, "outdated", registry_sentinel):
    local = sma_r08_local.scenario_sma_r08_local(None)
    with patch.object(sma_r08_local, "prove_local", local_stub_with(missing=NODES[0])):
        missing = sma_r08_local.scenario_sma_r08_local(None)
    with patch.object(sma_r08_local, "prove_local", local_stub_with(bad=NODES[0])):
        failed = sma_r08_local.scenario_sma_r08_local(None)
    with patch.object(sma_r08_local, "prove_local", local_stub_with(extra="n999")):
        other_failure = sma_r08_local.scenario_sma_r08_local(None)
    with patch.object(sma_r08_local, "prove_local", local_stub_with(extra="n752")):
        live_node = sma_r08_local.scenario_sma_r08_local(None)
    with patch.object(sma_r08, "prove_local", lambda tmp, proofs: (proofs.prove("n678", True, "local observation"), [])[1]), patch.object(sma_r08, "prove_core_b", core_failure):
        original = sma_r08.scenario_sma_r08(None)
    nonzero = Proofs()
    with patch.object(sma_r08.subprocess, "run", lambda *args, **kwargs: SimpleNamespace(returncode=7, stdout='{"probe": "partial"}', stderr="probe failed")):
        nonzero_problems = sma_r08.prove_local(None, nonzero)
print(json.dumps({"registered": scenes["sma_r08_local"]["nodes"], "old": "sma_r08" in scenes, "local": local,
                  "original": original, "pass": sample(), "missing": missing, "failed": failed,
                  "other_failure": other_failure, "live_node": live_node, "nonzero": nonzero_problems,
                  "nonzeroProofs": nonzero.items}))
`;
    const run = spawnSync("python3", ["-I", "-c", code], { cwd: process.cwd(), encoding: "utf8" });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout);
    expect(out.old).toBe(true);
    expect(out.local.result).toBe("pass");
    expect(out.local.proved).toHaveLength(11);
    expect(out.local.proved.map((row: { node: string }) => row.node)).toEqual(out.registered);
    expect(out.local.notProved).toEqual({ n752: expect.stringContaining("not run") });
    expect(out.local.proved.some((row: { node: string }) => row.node === "n752")).toBe(false);
    expect(out.original.result).toBe("fail");
    expect(out.original.proved).toEqual(expect.arrayContaining([expect.objectContaining({ node: "n752", ok: false })]));
    expect(out.registered).toEqual(["n678", "n685", "n704", "n731", "n732", "n733", "n734", "n735", "n737", "n742", "n749"]);
    expect(out.pass.result).toBe("pass");
    expect(out.pass.notProved.n752).toContain("not run");
    expect(out.pass.proved.map((row: { node: string }) => row.node)).toEqual(out.registered);
    for (const key of ["missing", "failed", "other_failure", "live_node"]) expect(out[key].result, key).toBe("fail");
    expect(out.live_node.proved.some((row: { node: string }) => row.node === "n752")).toBe(false);
    expect(out.nonzero).toEqual([expect.stringContaining("exited 7")]);
    expect(out.nonzeroProofs).toEqual([]);
  });
});

describe("SMA_PROVENANCE anchor hash sync", () => {
  const logFix = (event: string, detail: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL === "debug" || process.env.DEBUG_FIX) {
      process.stderr.write(`[FIX:ts2345-sma-traces] ${event} ${JSON.stringify(detail)}\n`);
    }
  };

  it("keeps recorded symbol hashes and valid commit metadata for router.ts anchors aligned with current source", () => {
    const repoRoot = join(import.meta.dirname, "..");
    for (const id of ["n1234", "n1482"] as const) {
      const proof = SMA_ENTRIES[id]?.[2];
      logFix("input", { id, proof: proof ?? null });
      expect(localProof(proof), id).toBe(true);
      if (!localProof(proof)) {
        logFix("error", { id, reason: "missing_or_external_proof" });
        throw new Error(`Expected local proof string for ${id}`);
      }
      const anchor = anchorText(repoRoot, proof);
      expect(anchor, id).not.toBeNull();
      const recorded = SMA_PROVENANCE.nodes[id];
      expect(recorded, id).toBeDefined();
      expect(recorded![0]).toMatch(/^[0-9a-f]{12}$/);
      expect(recorded![4]).toBe("symbol");
      expect(recorded![5]).toBe(hash12(anchor!.text));
      logFix("success", { id, hash: recorded![5] });
    }
  });
});
