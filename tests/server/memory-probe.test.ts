import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";
import { MEMORY_PATHS } from "../../src/rooms/memory";
import { createMemoryProbe, judge } from "../../src/rooms/memory-probe/server/memory-probe";
import { memoryProbeRpc } from "../../src/rooms/core/server/rpc-memory-probe";
import { SANDBOX_PROJECT_ID } from "../../src/rooms/stability/server/canary";
import { memoryUnanswered } from "../../src/rooms/learning/unanswered";
import { stickyTurnPromptWithRules } from "../../src/rooms/writer/server/writer-knowledge";
import { taskV2Schema } from "../../src/rooms/contracts";
import { upsertLessonProposal } from "@lane-pilot/run-insights";
import { adoptRuleProposal } from "../../src/rooms/self-repair/server";
import { parseMemorySettings } from "../../src/rooms/memory";
import type { ServerCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { projects: { list: async () => [] } } as never });
  const db = openDatabase(bb);
  const host = { call: async () => { throw new Error("no host in this test"); } };
  const ctx = { bb, db, host } as unknown as ServerCore;
  const services = { docsPlaces: async () => [] } as unknown as Services;
  return { db, host, ctx, services, probe: createMemoryProbe(ctx, services) };
}

const probedIds = MEMORY_PATHS.filter((entry) => entry.status === "probed").map((entry) => entry.id);
const count = (db: ReturnType<typeof setup>["db"], sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;

describe("memory probe", () => {
  it("every probed path hands the planted note, core convention and rule to its agent, and the negative case pulls nothing of ours", async () => {
    const { probe } = setup();
    const report = await probe.run({ projectId: SANDBOX_PROJECT_ID });
    expect(report.problems).toEqual([]);
    expect(report.planted).toEqual({ note: true, core: true, rule: true });
    expect(report.results.map((row) => row.path).sort()).toEqual([...probedIds].sort());
    for (const row of report.results) expect(row, `${row.path}: ${row.detail}`).toMatchObject({ found: true });
    expect(report.results.filter((row) => row.negativeOk === false)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.skipped.map((row) => row.path).sort()).toEqual(MEMORY_PATHS.filter((entry) => entry.status === "exempt").map((entry) => entry.id).sort());
  });

  it("records one row per path in lane_pilot_memory_probe and leaves no probe record behind", async () => {
    const { probe, db } = setup();
    const report = await probe.run({ projectId: SANDBOX_PROJECT_ID, paths: ["writer.brief", "pm.start"] });
    const rows = db.prepare("SELECT path, found, negative_ok, lp_version, token, latency_ms FROM lane_pilot_memory_probe ORDER BY path").all() as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.path)).toEqual(["pm.start", "writer.brief"]);
    expect(rows.every((row) => row.found === 1 && row.token === report.token && typeof row.lp_version === "string" && Number(row.latency_ms) >= 0)).toBe(true);
    expect(count(db, "SELECT count(*) n FROM lane_pilot_memory WHERE origin='probe'")).toBe(0);
    expect(count(db, "SELECT count(*) n FROM lane_pilot_rule_proposal WHERE state='accepted' AND rule LIKE 'Probe rule%'")).toBe(0);
    expect(probe.report(SANDBOX_PROJECT_ID).results).toHaveLength(2);
  });

  it("a switched-off injection turns red exactly the paths that depend on it", async () => {
    const { probe, db } = setup();
    saveProjectSetting(db, SANDBOX_PROJECT_ID, "memory.inject", "false");
    const report = await probe.run({ projectId: SANDBOX_PROJECT_ID });
    const red = report.results.filter((row) => !row.found).map((row) => row.path).sort();
    expect(red).toEqual(["critic.code", "night.review", "writer.brief", "writer.repair", "writer.turn"]);
    expect(report.results.filter((row) => row.found).map((row) => row.path)).toContain("pm.start");
    expect(report.ok).toBe(false);
  });

  it("a registered path whose delivery is gone is found missing, with the kind that went missing", () => {
    const entry = MEMORY_PATHS.find((item) => item.id === "writer.brief")!;
    const tokens = { note: "tn", core: "tc", rule: "tr" };
    expect(judge(entry, { delivered: "has tc and tr", negative: "" }, tokens, 3)).toMatchObject({ found: false, detail: expect.stringContaining("MISSING note") });
    expect(judge(entry, { delivered: "tn tc tr", negative: "tn here, an unrelated task got the note" }, tokens, 3)).toMatchObject({ found: true, negativeOk: false });
    const search = MEMORY_PATHS.find((item) => item.id === "critic.code")!;
    expect(judge(search, { delivered: "tn tc", negative: "", pulled: 2 }, tokens, 1)).toMatchObject({ negativeOk: false });
  });

  it("writes only to a sandbox project unless forced; --keep leaves the records for the drill and clean removes them", async () => {
    const { probe, db } = setup();
    await expect(probe.run({ projectId: "proj_real" })).rejects.toThrow(/not a sandbox project/);
    await expect(probe.run({ projectId: SANDBOX_PROJECT_ID, paths: ["no.such.path"] })).rejects.toThrow(/unknown memory path/);
    const kept = await probe.run({ projectId: SANDBOX_PROJECT_ID, paths: ["pm.start"], keep: true });
    expect(kept.kept).toBe(true);
    expect(count(db, "SELECT count(*) n FROM lane_pilot_memory WHERE origin='probe' AND project_id=?", SANDBOX_PROJECT_ID)).toBe(2);
    const record = db.prepare("SELECT valid_until, trust, created_at FROM lane_pilot_memory WHERE origin='probe' AND kind='note'").get() as { valid_until: number; trust: string; created_at: number };
    expect(record.trust).toBe("confirmed");
    expect(Math.abs(record.valid_until - record.created_at - 24 * 3_600_000)).toBeLessThan(5_000);
    expect(probe.clean(SANDBOX_PROJECT_ID)).toBe(3);
    expect(count(db, "SELECT count(*) n FROM lane_pilot_memory WHERE origin='probe'")).toBe(0);
    const forced = await probe.run({ projectId: "proj_real", paths: ["pm.start"], force: true });
    expect(forced.ok).toBe(true);
  });

  it("the RPC runs, reports and cleans the same way", async () => {
    const { probe } = setup();
    const rpc = memoryProbeRpc({ memoryProbe: probe } as never);
    expect(await rpc.memory_probe({ projectId: SANDBOX_PROJECT_ID, paths: ["pm.start"], action: "run" })).toMatchObject({ ok: true });
    expect(await rpc.memory_probe({ projectId: SANDBOX_PROJECT_ID, action: "report" })).toMatchObject({ results: [{ path: "pm.start", found: true }] });
    expect(await rpc.memory_probe({ projectId: SANDBOX_PROJECT_ID, action: "clean" })).toEqual({ removed: 0 });
  });
});

describe("the turn that continues a writer thread", () => {
  const task = taskV2Schema.parse({
    schema_version: 2, id: "t1", title: "t", risk: "low", lane: "writer", project_cwd: "/tmp/x", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["a/b/c.txt"], owns_paths: ["a/b/c.txt"], never_touch: [], depends_on: [], objective: "o", acceptance: ["a"], verify: "none", verification: [],
  });

  it("carries the rules that apply to the next task, and none for a retry (the first brief holds them)", async () => {
    const { db, host } = setup();
    const lesson = upsertLessonProposal(db, "P", { rule: "Run npm ci in a writer worktree, never npm install, lockfile stays untouched", audience: "writer", always: true });
    adoptRuleProposal(db, "P", lesson.id);
    const deps = { db, host: host as never, chainForRun: async () => [] as string[] };
    const know = { projectId: "P", runId: "r1", hostId: "h", task, memorySettings: parseMemorySettings({}) };
    expect((await stickyTurnPromptWithRules(deps, know, { kind: "next-task", task }))([])).toContain("never npm install");
    expect((await stickyTurnPromptWithRules(deps, know, { kind: "retry", task }))([])).not.toContain("never npm install");
    expect((await stickyTurnPromptWithRules(deps, { ...know, memorySettings: parseMemorySettings({ "memory.inject": false }) }, { kind: "next-task", task }))([])).not.toContain("never npm install");
  });
});

describe("questions the memory did not answer", () => {
  it("counts the owner's repeats of what was in force and the questions another agent could have answered", () => {
    const { db } = setup();
    const now = 10 * 86_400_000;
    const item = db.prepare("INSERT INTO lane_pilot_learning_item(id,obs_id,project_id,thread_id,kind,text,reach,state,evidence,confirmations,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    item.run("i1", "o1", "P", "t", "rule", "x", "project", "duplicate", "e", 2, now - 86_400_000);
    item.run("i2", "o2", "P", "t", "rule", "y", "project", "adopted", "e", 0, now - 86_400_000);
    item.run("i3", "o3", "P", "t", "rule", "z", "project", "duplicate", "e", 1, now - 60 * 86_400_000);
    const signal = db.prepare("INSERT INTO lane_pilot_learning_signal(kind,project_id,ref,p,at) VALUES(?,?,?,?,?)");
    signal.run("owner_question", "P", "q1", 0.9, now - 1000);
    signal.run("owner_question", "P", "q2", 0.3, now - 1000);
    signal.run("owner_question", "Q", "q3", 0.9, now - 1000);
    expect(memoryUnanswered(db, "P", 30, now)).toEqual({ windowDays: 30, ownerRepeats: 1, repeatConfirmations: 2, routableQuestions: 1 });
  });
});
