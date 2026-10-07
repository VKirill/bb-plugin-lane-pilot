import { describe, expect, it } from "vitest";
import { STAT_WEIGHT, routeIntent, trackRecord } from "../../src/workflow/router";
import type { RunRecord } from "../../src/workflow/router";
import { runRecords } from "../../src/workflow/run-stats";
import { journalDb, wf } from "./engine-helpers";
import { workflow } from "./fixtures";
import { publishedCatalog } from "./router-catalog";

const twin = (id: string) => wf({
  ...workflow({ id }),
  status: "published", name: { en: "Weekly sales report", ru: "Недельный отчёт по продажам" }, description: { en: "Build the weekly sales report from the shop exports", ru: "Собрать недельный отчёт по продажам" },
  examples: { en: ["make the weekly sales report", "weekly sales report for the shop"], ru: ["сделай недельный отчёт по продажам"] },
});
const INTENT = "make the weekly sales report";
const NOW = Date.UTC(2026, 9, 7);
const record = (succeeded: number, failed: number, daysAgo: number | null): RunRecord => ({ succeeded, failed, lastRunAt: daysAgo === null ? null : NOW - daysAgo * 86_400_000 });

describe("the run record as a tiebreaker", () => {
  it("scores a reliable, recent workflow above a failing, old or unknown one, within 0 and 1", () => {
    const good = trackRecord(record(10, 0, 1), NOW), unknown = trackRecord(undefined, NOW), bad = trackRecord(record(0, 5, 60), NOW), lucky = trackRecord(record(1, 0, 1), NOW);
    expect(good).toBeGreaterThan(lucky);
    expect(lucky).toBeGreaterThan(unknown);
    expect(unknown).toBeGreaterThan(bad);
    for (const value of [good, unknown, bad, lucky]) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });

  it("orders two alike matches by how they have run, and by id without a record", async () => {
    const workflows = [twin("sales-a"), twin("sales-b")];
    const plain = await routeIntent({ intent: INTENT, workflows });
    expect(plain.candidates.map((candidate) => candidate.id)).toEqual(["sales-a", "sales-b"]);
    expect(plain.candidates[0]).not.toHaveProperty("stat");
    const stats = new Map([["sales-a", record(1, 4, 20)], ["sales-b", record(8, 0, 1)]]);
    const ranked = await routeIntent({ intent: INTENT, workflows, stats, now: NOW });
    expect(ranked.candidates.map((candidate) => candidate.id)).toEqual(["sales-b", "sales-a"]);
    expect(ranked.candidates[0]!.stat).toBeGreaterThan(ranked.candidates[1]!.stat!);
    // Their text scores are untouched: only the order moved.
    expect(ranked.candidates.map((candidate) => candidate.score).sort()).toEqual(plain.candidates.map((candidate) => candidate.score).sort());
  });

  it("never lets a worse text match win on its record, and leaves the real catalog's choices alone", async () => {
    const catalog = publishedCatalog();
    const intent = "Take ticket LP-210 from the tracker and resolve it, with a proper review";
    const before = await routeIntent({ intent, workflows: catalog });
    const stats = new Map(catalog.map((item) => [item.id, item.id === before.workflowId ? record(0, 6, 90) : record(30, 0, 0)]));
    const after = await routeIntent({ intent, workflows: catalog, stats, now: NOW });
    expect(after.workflowId).toBe(before.workflowId);
    expect(STAT_WEIGHT).toBeLessThan(0.05);
  });

  it("is read from the journal: real top-level runs only", () => {
    const db = journalDb();
    const def = JSON.stringify(wf());
    const insert = (id: string, workflowId: string, status: string, parent: string | null, at: number) => db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,parent_run_id,parent_step_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, workflowId, 1, "x", def, parent, parent ? `s${id}` : null, status, at, at);
    insert("a", "demo", "succeeded", null, 10); insert("b", "demo", "failed", null, 20); insert("c", "demo", "running", null, 30); insert("d", "demo", "succeeded", "a", 40); insert("e", "other", "blocked", null, 5);
    expect(runRecords(db).get("demo")).toEqual({ succeeded: 1, failed: 1, lastRunAt: 30 });
    expect(runRecords(db).get("other")).toEqual({ succeeded: 0, failed: 1, lastRunAt: 5 });
  });
});
