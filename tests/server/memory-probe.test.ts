import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { MEMORY_PATHS } from "../../src/rooms/memory";
import { createMemoryProbe, judge } from "../../src/rooms/memory-probe/server";
import { memoryProbeRpc } from "../../src/rooms/core/server/rpc-memory-probe";
import { SANDBOX_PROJECT_ID } from "../../src/rooms/contracts";
import { storeMemoryRecords } from "@lane-pilot/memory-core";
import type { ServerCore } from "../../src/rooms/contracts/server";

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { projects: { list: async () => [] } } as never });
  const db = openDatabase(bb);
  const host = { call: async () => { throw new Error("no host in this test"); } };
  const ctx = { bb, db, host, log: () => undefined } as unknown as ServerCore;
  return { db, host, ctx, probe: createMemoryProbe(ctx) };
}

const probedIds = MEMORY_PATHS.filter((entry) => entry.status === "probed").map((entry) => entry.id);
const count = (db: ReturnType<typeof setup>["db"], sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

describe("memory probe", () => {
  it("every probed path hands the planted note and core convention to its agent, and the negative case pulls nothing of ours", async () => {
    const { probe } = setup();
    const report = await probe.run({ projectId: SANDBOX_PROJECT_ID });
    expect(report.problems).toEqual([]);
    expect(report.planted).toEqual({ note: true, core: true });
    expect(report.results.map((row) => row.path).sort()).toEqual([...probedIds].sort());
    for (const row of report.results) expect(row, `${row.path}: ${row.detail}`).toMatchObject({ found: true });
    expect(report.results.filter((row) => row.negativeOk === false)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.skipped.map((row) => row.path).sort()).toEqual(MEMORY_PATHS.filter((entry) => entry.status === "exempt").map((entry) => entry.id).sort());
  });

  it("records one row per path in lane_pilot_memory_probe and leaves no probe record behind", async () => {
    const { probe, db } = setup();
    const report = await probe.run({ projectId: SANDBOX_PROJECT_ID, paths: ["writer.brief", "pm.memory_tool"] });
    const rows = db.prepare("SELECT path, found, negative_ok, lp_version, token, latency_ms FROM lane_pilot_memory_probe ORDER BY path").all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.path)).toEqual(["pm.memory_tool", "writer.brief"]);
    expect(rows.every((row) => row.found === 1 && row.token === report.token && typeof row.lp_version === "string" && Number(row.latency_ms) >= 0)).toBe(true);
    expect(count(db, "SELECT count(*) n FROM lane_pilot_memory WHERE origin='probe'")).toBe(0);
    expect(probe.report(SANDBOX_PROJECT_ID).results).toHaveLength(2);
  });

  it("notes that the writers of earlier drills saved about the probe folder do not push the probe's core out", async () => {
    const { probe, db } = setup();
    const residue = [
      "Probe note 20261109-174530: lp-probe/memory/20261109-174530.md is a two-line drill memory delivery check.",
      "Probe note drill-20261108-174608-memory: lp-probe/memory/20261108-174608.md is a two-line memory delivery check (# Drill / ok: Drill).",
      "The port table of this sandbox lives in lp-probe/memory/ports.md and is rewritten by every drill.",
    ];
    storeMemoryRecords(db, { projectId: SANDBOX_PROJECT_ID, audience: "subagent", sourceSha256: "a".repeat(64), trust: "observed", origin: "session",
      entries: [...residue.map((content) => ({ kind: "note" as const, content, concepts: ["drill"] })), { kind: "note" as const, content: "The sandbox runs its checks with npm test.", concepts: ["drill"] }],
      coreBudget: 4000, noteBudget: 12000, indexBudget: 4000 });
    const report = await probe.run({ projectId: SANDBOX_PROJECT_ID, paths: ["writer.brief", "writer.repair"] });
    expect(report.results.map((row) => [row.path, row.found, row.detail.includes("MISSING")])).toEqual([["writer.brief", true, false], ["writer.repair", true, false]]);
    expect((db.prepare("SELECT content FROM lane_pilot_memory WHERE origin='session'").all() as Array<{ content: string }>).map((row) => row.content)).toEqual(["The sandbox runs its checks with npm test."]);
  });

  it("a switched-off injection turns red exactly the paths that depend on it", async () => {
    const { probe, db } = setup();
    saveProjectSetting(db, SANDBOX_PROJECT_ID, "memory.inject", "false");
    const report = await probe.run({ projectId: SANDBOX_PROJECT_ID });
    const red = report.results.filter((row) => !row.found).map((row) => row.path).sort();
    expect(red).toEqual(["critic.code", "writer.brief", "writer.repair"]);
    expect(report.results.filter((row) => row.found).map((row) => row.path)).toContain("bb.thread");
    expect(report.ok).toBe(false);
  });

  it("a registered path whose delivery is gone is found missing, with the kind that went missing", () => {
    const entry = MEMORY_PATHS.find((item) => item.id === "writer.brief")!;
    const tokens = { note: "tn", core: "tc" };
    expect(judge(entry, { delivered: "has tc", negative: "" }, tokens, 3)).toMatchObject({ found: false, detail: expect.stringContaining("MISSING note") });
    expect(judge(entry, { delivered: "tn tc", negative: "tn here, an unrelated task got the note" }, tokens, 3)).toMatchObject({ found: true, negativeOk: false });
    const search = MEMORY_PATHS.find((item) => item.id === "critic.code")!;
    expect(judge(search, { delivered: "tn tc", negative: "", pulled: 2 }, tokens, 1)).toMatchObject({ negativeOk: false });
  });

  it("writes only to a sandbox project unless forced; --keep leaves the records for the drill and clean removes them", async () => {
    const { probe, db } = setup();
    await expect(probe.run({ projectId: "proj_real" })).rejects.toThrow(/not a sandbox project/);
    await expect(probe.run({ projectId: SANDBOX_PROJECT_ID, paths: ["no.such.path"] })).rejects.toThrow(/unknown memory path/);
    const kept = await probe.run({ projectId: SANDBOX_PROJECT_ID, paths: ["pm.memory_tool"], keep: true });
    expect(kept.kept).toBe(true);
    expect(count(db, "SELECT count(*) n FROM lane_pilot_memory WHERE origin='probe' AND project_id=?", SANDBOX_PROJECT_ID)).toBe(2);
    const record = db.prepare("SELECT valid_until, trust, created_at FROM lane_pilot_memory WHERE origin='probe' AND kind='note'").get() as { valid_until: number; trust: string; created_at: number };
    expect(record.trust).toBe("confirmed");
    expect(Math.abs(record.valid_until - record.created_at - 24 * 3_600_000)).toBeLessThan(5_000);
    expect(probe.clean(SANDBOX_PROJECT_ID)).toBe(2);
    expect(count(db, "SELECT count(*) n FROM lane_pilot_memory WHERE origin='probe'")).toBe(0);
    const forced = await probe.run({ projectId: "proj_real", paths: ["pm.memory_tool"], force: true });
    expect(forced.ok).toBe(true);
  });

  it("the RPC runs, reports and cleans the same way", async () => {
    const { probe } = setup();
    const rpc = memoryProbeRpc({ memoryProbe: probe } as never);
    expect(await rpc.memory_probe({ projectId: SANDBOX_PROJECT_ID, paths: ["pm.memory_tool"], action: "run" })).toMatchObject({ ok: true });
    expect(await rpc.memory_probe({ projectId: SANDBOX_PROJECT_ID, action: "report" })).toMatchObject({ results: [{ path: "pm.memory_tool", found: true }] });
    expect(await rpc.memory_probe({ projectId: SANDBOX_PROJECT_ID, action: "clean" })).toEqual({ removed: 0 });
  });
});
