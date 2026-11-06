import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { StoredWorkflow } from "@lane-pilot/workflow-engine";
import { openDatabase, type LanePilotDatabase } from "../src/rooms/storage/database";
import { diagnosisLines, errandsDiagnosis, errandsDiagnosisMorningLine } from "../src/rooms/errands/diagnosis";

/**
 * The errand diagnosis (stage-1 stream F, plan R7): one inline journal reproduces every section — outcomes and the
 * unknown-verdict share, cost and time, failure classes, repeats with «second cheaper than first», router near misses,
 * skills offered but unused and fixture litter in the catalog. The phase-D columns are read through a PRAGMA check, so
 * the second world drops them and the same call must answer «нет данных» instead of throwing.
 */
const PROJECT = "proj-1";
const NOW = Date.now();
const MIN = 60_000;
const DAY = 86_400_000;

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { db: openDatabase(bb) };
}

type RunSpec = {
  id: string; workflowId?: string; status?: string; projectId?: string | null;
  inputs?: Record<string, unknown>; output?: unknown; reason?: string | null;
  costMicro?: number; createdAt?: number; updatedAt?: number;
};

function addRun(db: LanePilotDatabase, spec: RunSpec) {
  const created = spec.createdAt ?? NOW - DAY;
  db.prepare(`INSERT INTO lane_pilot_wf_run
    (id, idem_key, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, reason, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(spec.id, `key-${spec.id}`, spec.workflowId ?? "errand", 1, "sha", "{}", spec.projectId === undefined ? PROJECT : spec.projectId,
      spec.status ?? "succeeded", spec.reason ?? null, JSON.stringify(spec.inputs ?? {}),
      spec.output === undefined ? null : JSON.stringify(spec.output), 0, spec.costMicro ?? 0, created, spec.updatedAt ?? created + 10 * MIN);
}

function addEpisode(db: LanePilotDatabase, runId: string, fields: { workflowId?: string; processKey?: string | null; processKeyProposed?: string | null; failureClass?: string | null; summary?: unknown } = {}) {
  db.prepare(`INSERT INTO lane_pilot_errand_episode
    (run_id, extractor_version, project_id, workflow_id, status, outcome, verified, enrichment_state, created_at, updated_at,
     process_key, process_key_proposed, failure_class, summary_json)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(runId, 1, PROJECT, fields.workflowId ?? "errand", "succeeded", "done", JSON.stringify("done_checked"), "done",
      NOW - DAY, NOW - DAY, fields.processKey ?? null, fields.processKeyProposed ?? null, fields.failureClass ?? null,
      fields.summary === undefined ? null : JSON.stringify(fields.summary));
}

const catalogItem = (id: string, status: string, origin: StoredWorkflow["origin"] = "project"): StoredWorkflow =>
  ({ workflow: { id, status, internal: false } as StoredWorkflow["workflow"], origin, source: id, sha256: "", warnings: [] });

/** The full fixture: every diagnosis section has at least one positive and one negative row. */
function fullWorld() {
  const { db } = world();
  const done = { state: "done" };
  // The repeated process «deploy|site»: the second run is cheaper than the first.
  addRun(db, { id: "wfrun-a", inputs: { task: "Deploy the site", kind: "devops", routeTop: "deploy-site:75" }, output: { ...done, verified: "done_checked" }, costMicro: 100_000, createdAt: NOW - 6 * DAY, updatedAt: NOW - 6 * DAY + 10 * MIN });
  addEpisode(db, "wfrun-a", { processKey: "deploy|site", summary: { skills: [{ name: "ssh-keys", offered: true, used: false }, { name: "browser-qa", offered: true, used: true }] } });
  addRun(db, { id: "wfrun-b", inputs: { task: "Deploy the site again", kind: "devops" }, output: { ...done, verified: "done_unchecked" }, costMicro: 40_000, createdAt: NOW - 5 * DAY, updatedAt: NOW - 5 * DAY + 20 * MIN });
  addEpisode(db, "wfrun-b", { processKey: "deploy|site", summary: { skills: [{ name: "ssh-keys", offered: true, used: false }] } });
  // A repeated process where the second run is NOT cheaper — the negative half of the share.
  addRun(db, { id: "wfrun-i", inputs: { task: "Weekly report", kind: "research" }, output: done, costMicro: 20_000, createdAt: NOW - 4 * DAY, updatedAt: NOW - 4 * DAY + 8 * MIN });
  addEpisode(db, "wfrun-i", { processKey: "report|weekly" });
  addRun(db, { id: "wfrun-j", inputs: { task: "Weekly report again", kind: "research" }, output: done, costMicro: 90_000, createdAt: NOW - 3 * DAY, updatedAt: NOW - 3 * DAY + 9 * MIN });
  addEpisode(db, "wfrun-j", { processKey: "report|weekly" });
  // Near misses: 60 and 75 count, 90 and a missing routeTop do not.
  addRun(db, { id: "wfrun-c", status: "failed", inputs: { task: "Check the CRM export", kind: "research", routeTop: "api-recon:60" }, costMicro: 200_000, createdAt: NOW - 2 * DAY, updatedAt: NOW - 2 * DAY + 25 * MIN });
  addEpisode(db, "wfrun-c", { processKeyProposed: "crm|export", failureClass: "tool_error" });
  addRun(db, { id: "wfrun-d", inputs: { task: "Read the cabinet", kind: "browser" }, output: { state: "blocked", reason: "no access" }, costMicro: 80_000, createdAt: NOW - DAY, updatedAt: NOW - DAY + 15 * MIN });
  addEpisode(db, "wfrun-d", { failureClass: "no_access" });
  addRun(db, { id: "wfrun-e", status: "canceled", inputs: { task: "Send the report", kind: "message" }, costMicro: 30_000, createdAt: NOW - DAY + MIN, updatedAt: NOW - DAY + 6 * MIN });
  addRun(db, { id: "wfrun-f", status: "running", inputs: {}, costMicro: 10_000, createdAt: NOW - MIN, updatedAt: NOW - MIN });
  addRun(db, { id: "wfrun-g", workflowId: "api-recon", inputs: {}, output: done, costMicro: 60_000, createdAt: NOW - 12 * 60 * MIN, updatedAt: NOW - 12 * 60 * MIN + 30 * MIN });
  addEpisode(db, "wfrun-g", { workflowId: "api-recon", processKey: "recon|site" });
  addRun(db, { id: "wfrun-h", inputs: { task: "Unique one-off", kind: "computer", routeTop: "odd-graph:90" }, output: { ...done, verified: "done_checked" }, costMicro: 50_000, createdAt: NOW - 20 * 60 * MIN, updatedAt: NOW - 20 * 60 * MIN + 12 * MIN });
  // Outside the window: must not count anywhere.
  addRun(db, { id: "wfrun-old", inputs: { task: "Ancient errand", kind: "devops" }, output: done, costMicro: 999_000, createdAt: NOW - 10 * DAY, updatedAt: NOW - 10 * DAY + MIN });
  return db;
}

const workflows = (): StoredWorkflow[] => [
  catalogItem("errand", "published", "builtin"),
  catalogItem("pm-fixture-crm", "published"),
  catalogItem("fixture-old", "tested"),
  catalogItem("pm-fixture-deprecated", "deprecated"),
  catalogItem("pm-fixture-builtin", "published", "builtin"),
  catalogItem("api-recon", "published"),
];

describe("errandsDiagnosis", () => {
  it("counts every section of the period with its N", () => {
    const d = errandsDiagnosis(fullWorld(), { days: 7, projectId: PROJECT }, { workflows: workflows() });
    expect(d.runs).toBe(10);
    expect(d.ended).toBe(9);
    expect(d.outcomes).toEqual({ running: 1, done: 6, blocked: 1, failed: 1, canceled: 1 });
    // verified: done_checked a+h, done_unchecked b, unknown the rest; among the 9 ended, unknown is c,d,e,g,i,j = 6.
    expect(d.verified).toEqual({ done_checked: 2, done_unchecked: 1, blocked: 0, unknown: 7 });
    expect(d.unknownVerified).toEqual({ count: 6, of: 9 });
    expect(d.cost.totalUsd).toBeCloseTo(0.68, 5);
    expect(d.cost.medianUsd).toBeCloseTo(0.06, 5);
    expect(d.cost.medianMinutes).toBe(12);
    const devops = d.cost.byKind.find((row) => row.kind === "devops")!;
    expect(devops).toMatchObject({ runs: 2, costUsd: 0.14 });
    // The routed run lands under its graph's name, not under «none».
    expect(d.cost.byKind.find((row) => row.kind === "api-recon")).toMatchObject({ runs: 1 });
    // Failure classes from the episode column.
    expect(d.failureClasses).toEqual({ available: true, counts: [{ name: "no_access", count: 1 }, { name: "tool_error", count: 1 }] });
    // Repeats: «deploy|site» cheaper-second yes, «report|weekly» no; the rest are singletons.
    expect(d.repeats.groups).toBe(2);
    expect(d.repeats.comparable).toBe(2);
    expect(d.repeats.cheaperSecond).toEqual({ count: 1, of: 2 });
    // Near misses: 75 and 60 count; 90 and the runs without routeTop do not.
    expect(d.nearMisses).toEqual({ count: 2, of: 3, byTarget: [{ name: "api-recon", count: 1 }, { name: "deploy-site", count: 1 }] });
    // Skills offered but unused: ssh-keys twice, browser-qa was used and does not count.
    expect(d.skillsUnused).toEqual({ available: true, of: 2, counts: [{ name: "ssh-keys", count: 2 }] });
    // Catalog litter: published/tested user fixtures only — the deprecated and the builtin ones stay out.
    expect(d.catalog).toEqual({ available: true, count: 2, ids: ["fixture-old", "pm-fixture-crm"] });
  });

  it("prints plain Russian lines with the same numbers for the CLI", () => {
    const lines = diagnosisLines(errandsDiagnosis(fullWorld(), { days: 7 }, { workflows: workflows() }));
    const text = lines.join("\n");
    expect(text).toContain("Поручений за 7 дн.: 10");
    expect(text).toContain("второй прогон дешевле первого — 1 из 2");
    expect(text).toContain("уверенность 60–89): 2 из 3");
    expect(text).toContain("ssh-keys ×2");
    expect(text).toContain("pm-fixture-crm");
    expect(lines.length).toBeGreaterThan(8);
  });

  it("answers «нет данных» for the phase-D sections when the episode columns are missing, without throwing", () => {
    const db = new Database(":memory:") as LanePilotDatabase;
    db.exec(`CREATE TABLE lane_pilot_wf_run (
      id TEXT PRIMARY KEY, idem_key TEXT, workflow_id TEXT, workflow_version INTEGER, workflow_sha256 TEXT, definition_json TEXT,
      project_id TEXT, status TEXT, reason TEXT, inputs_json TEXT, output_json TEXT, tokens_used INTEGER, cost_micro_usd INTEGER,
      created_at INTEGER, updated_at INTEGER)`);
    db.exec(`CREATE TABLE lane_pilot_errand_episode (
      run_id TEXT NOT NULL, extractor_version INTEGER NOT NULL, project_id TEXT, workflow_id TEXT NOT NULL, status TEXT NOT NULL,
      outcome TEXT NOT NULL, verified TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, extractor_version))`);
    addRun(db, { id: "wfrun-x", inputs: { task: "Deploy the site", kind: "devops", routeTop: "deploy-site:75" }, output: { state: "done", verified: "done_checked" }, costMicro: 100_000 });
    addRun(db, { id: "wfrun-y", workflowId: "api-recon", inputs: {}, output: { state: "done" }, costMicro: 50_000 });
    db.prepare("INSERT INTO lane_pilot_errand_episode (run_id, extractor_version, project_id, workflow_id, status, outcome, verified, created_at, updated_at) VALUES ('wfrun-y',1,?,?, 'succeeded','done',NULL,?,?)")
      .run(PROJECT, "api-recon", NOW - DAY, NOW - DAY);
    const d = errandsDiagnosis(db, { days: 7 });
    expect(d.runs).toBe(2);
    expect(d.outcomes.done).toBe(2);
    expect(d.failureClasses.available).toBe(false);
    expect(d.skillsUnused.available).toBe(false);
    expect(d.catalog.available).toBe(false);
    // Without the process-key columns the stem still groups repeats.
    expect(d.repeats.groups).toBe(0);
    const text = diagnosisLines(d).join("\n");
    expect(text).toContain("нет данных");
    db.close();
  });

  it("the morning line is null under 5 errands and a plain line from 5", () => {
    const few = world().db;
    for (let index = 0; index < 4; index += 1) {
      addRun(few, { id: `few-${index}`, inputs: { task: `Errand number ${index}`, kind: "research" }, output: { state: "done", verified: "done_checked" }, costMicro: 10_000 });
    }
    expect(errandsDiagnosisMorningLine(few)).toBeNull();
    addRun(few, { id: "few-4", inputs: { task: "Fifth errand", kind: "research" }, output: { state: "done", verified: "done_checked" }, costMicro: 10_000 });
    const line = errandsDiagnosisMorningLine(few);
    expect(line).toContain("Поручения за неделю: 5");
    expect(line).toContain("$0.05");
    const many = fullWorld();
    expect(errandsDiagnosisMorningLine(many)).toContain("Поручения за неделю: 10");
  });
});
