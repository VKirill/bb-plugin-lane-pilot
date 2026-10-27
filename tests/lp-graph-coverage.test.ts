import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SQL = readFileSync(new URL("../scripts/lp-graph-coverage.sql", import.meta.url), "utf8");
const DAILY = readFileSync(new URL("../scripts/lp-metrics-daily.sh", import.meta.url), "utf8");
const NOW = Date.UTC(2026, 9, 27, 9, 0, 0);
const HOUR = 3_600_000;

/** The slice of BB's core database the line reads: thread_plugin_metadata and threads. */
function core(threads: Array<{ id: string; role: string | null; graph?: boolean; plugin?: string; at?: number }>) {
  const db = new Database(":memory:");
  db.exec(`attach ':memory:' as core;
    create table core.threads(id text primary key, created_at integer not null);
    create table core.thread_plugin_metadata(thread_id text not null, plugin_id text not null, metadata_json text not null, primary key(thread_id, plugin_id));
    create temp table lp_cover(since integer);`);
  db.prepare("insert into lp_cover values (?)").run(NOW - 24 * HOUR);
  for (const thread of threads) {
    db.prepare("insert into core.threads values (?, ?)").run(thread.id, thread.at ?? NOW - HOUR);
    const metadata = { ...(thread.role ? { role: thread.role } : {}), ...(thread.graph ? { lanePilotWorkflowRunId: "wfrun_1" } : {}) };
    db.prepare("insert into core.thread_plugin_metadata values (?, ?, ?)").run(thread.id, thread.plugin ?? "lane-pilot", JSON.stringify(metadata));
  }
  return db;
}
const line = (db: Database.Database) => (db.prepare(SQL).all() as Array<Record<string, string>>).map((row) => Object.values(row)[0]);

describe("the graph coverage line of the daily report", () => {
  it("counts per role the threads of the last day that ran outside a graph, out of all", () => {
    const rows = [
      ...[1, 2, 3].map((n) => ({ id: `mem${n}`, role: "memory-maintainer" })),
      { id: "w1", role: "writer", graph: true }, { id: "w2", role: "writer", graph: true }, { id: "w3", role: "writer" },
      { id: "e1", role: "errand", graph: true },
      // Not counted: a PM chat, a workspace holder, a thread of another plugin, one older than a day, one with no role.
      { id: "pm", role: "pm" }, { id: "wp", role: "workspace-provisioner" }, { id: "x", role: "writer", plugin: "other-plugin" },
      { id: "old", role: "errand", at: NOW - 30 * HOUR }, { id: "norole", role: null },
    ];
    expect(line(core(rows))).toEqual(["Покрытие графами за сутки (потоков вне графа из всех, по ролям): memory-maintainer 3/3, writer 1/3, errand 0/1; всего вне графа 4 из 7."]);
  });

  it("reads a core database that keeps seconds as well as one that keeps milliseconds", () => {
    expect(line(core([{ id: "a", role: "writer", at: Math.floor((NOW - HOUR) / 1000) }]))).toEqual(["Покрытие графами за сутки (потоков вне графа из всех, по ролям): writer 1/1; всего вне графа 1 из 1."]);
  });

  it("prints nothing when no Lane Pilot thread ran", () => {
    expect(line(core([]))).toEqual([]);
  });

  it("is wired into the daily report after the wall lines, and never blocks it", () => {
    expect(DAILY).toContain("graph-coverage.sql");
    expect(DAILY).toMatch(/cover=\$\([^\n]*\|\| cover=""/);
    expect(DAILY).toContain('[ -z "$cover" ] || text=');
  });
});
