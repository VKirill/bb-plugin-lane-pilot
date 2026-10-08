import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { failureClass } from "../src/failure-class";

// Audit round 2, item 19: the metrics count real projects only. The views of scripts/lp-metrics-views.sql classify an attempt the way
// failureClass() does and tell a sandbox or drill attempt from a real one; these tests keep both equal to the code.
const views = readFileSync(new URL("../scripts/lp-metrics-views.sql", import.meta.url), "utf8");

function database() {
  const db = new Database(":memory:");
  db.exec(`attach ':memory:' as core; create table core.projects(id text primary key, name text);
    create table lane_pilot_run(id text primary key, project_id text not null);
    create table lane_pilot_attempt(id text primary key, run_id text not null, task_id text not null, state text not null, reason text, created_at integer not null);
    create table lane_pilot_failure_triage(project_id text, attempt_id text, reason text, origin text, failed_at integer);
    create temp table lp_params(days integer); insert into lp_params values (7);`);
  db.exec(views);
  return db;
}

const REASONS: Array<[string, string]> = [
  ["blocked", "internal_error: boom"], ["blocked", "spawn failed: no such host"], ["blocked", "reconcile_page_cap"], ["blocked", "attempt_worktree_holder_ambiguous:page_cap"],
  ["blocked", "stale API handle"], ["blocked", "sticky_failed: x"], ["blocked", "ownership run scope invalid: bad contract"], ["blocked", "writer changed no files; its retry was lost in a plugin reload"],
  ["validation_failed", "verification failed (npm test): EROFS: read-only file system"], ["validation_failed", "verification failed (npm test): 3 tests failed"],
  ["validation_failed", "verification failed (npm test): environment: ENOSPC"], ["validation_failed", "verification failed (npm test): EACCES: permission denied"],
  ["blocked", "ENOSPC: no space left on device"], ["blocked", "fatal: Unable to create index.lock"], ["blocked", "EACCES: permission denied, open /x"], ["blocked", "host offline"],
  ["blocked", "merge_conflict: a.ts"], ["blocked", "retry limit 2 exhausted: merge_conflict: a.ts"], ["blocked", "error: would be overwritten by merge"],
  ["blocked", "merge_blocked: would be overwritten by merge"], ["blocked", "retry limit 3 exhausted: internal_error: x"],
  ["blocked", "needs_human: which destination?"], ["blocked", "run_budget_exceeded: max_tokens"], ["blocked", "retry_budget_exhausted: 5"],
  ["blocked", "writer_provider_limit: quota"], ["blocked", "writer_provider_unavailable:breaker_open"], ["blocked", "writer_provider_unavailable:other"],
  ["blocked", "writer_silent_after_nudge"], ["blocked", "not a git repository"], ["blocked", "waiting_secret:STRIPE"], ["blocked", "verdict_block: critic"],
  ["blocked", "missing expected_outputs a.ts"], ["blocked", "ownership run scope invalid: run task a: unsafe path ../x"],
  ["provider_error", "429 too many"], ["empty_output", "no files"], ["spawn_rejected", "internal_error: spawn_rejected"], ["blocked", ""],
];
const NAMED = new Set(["harness", "infra", "merge", "limit", "budget", "judgment"]);

describe("lp-metrics views", () => {
  it("classify a failed attempt as failureClass does, collapsing task, provider and contract into other", () => {
    const db = database();
    db.prepare("insert into core.projects values ('proj_real', 'SelfyStudio')").run();
    db.prepare("insert into lane_pilot_run values ('run1', 'proj_real')").run();
    const insert = db.prepare("insert into lane_pilot_attempt values (?, 'run1', 'task', ?, ?, ?)");
    REASONS.forEach(([state, reason], index) => insert.run(`a${index}`, state, reason, Date.now()));
    const rows = db.prepare("select id, cls from lp_attempt_class").all() as Array<{ id: string; cls: string }>;
    const byId = new Map(rows.map((row) => [row.id, row.cls]));
    const mismatches = REASONS.flatMap(([state, reason], index) => {
      const expected = failureClass(state, reason);
      const want = NAMED.has(expected) ? expected : "other";
      return byId.get(`a${index}`) === want ? [] : [`${state} / ${reason}: view ${byId.get(`a${index}`)}, failureClass ${expected}`];
    });
    expect(mismatches).toEqual([]);
  });

  it("gives accepted and canceled attempts no class, so they are never counted as failures", () => {
    const db = database();
    db.prepare("insert into lane_pilot_run values ('run1', 'proj_x')").run();
    db.prepare("insert into lane_pilot_attempt values ('a1', 'run1', 't', 'accepted', 'internal_error', 1)").run();
    db.prepare("insert into lane_pilot_attempt values ('a2', 'run1', 't', 'canceled', null, 1)").run();
    expect(db.prepare("select cls from lp_attempt_class").all()).toEqual([{ cls: null }, { cls: null }]);
  });

  it("puts sandbox projects, LP native projects and drill tasks apart from the real projects", () => {
    const db = database();
    const projects: Array<[string, string]> = [["proj_3tb652jpsi", "LP sandbox rules"], ["proj_a", "LP sandbox layout A3"], ["proj_b", "LP native NOGIT"], ["proj_c", "SelfyStudio"], ["proj_d", "BB-сервис"], ["proj_gone", "Renamed sandbox"]];
    for (const [id, name] of projects) {
      db.prepare("insert into core.projects values (?, ?)").run(id, name);
      db.prepare("insert into lane_pilot_run values (?, ?)").run(`run_${id}`, id);
      db.prepare("insert into lane_pilot_attempt values (?, ?, 'T-1', 'accepted', null, 1)").run(`a_${id}`, `run_${id}`);
    }
    db.prepare("insert into lane_pilot_attempt values ('a_drill', 'run_proj_c', 'drill-20261007-1', 'accepted', null, 1)").run();
    const scope = (id: string) => (db.prepare("select scope from lp_attempt where id = ?").get(id) as { scope: string }).scope;
    expect(["a_proj_3tb652jpsi", "a_proj_a", "a_proj_b", "a_drill"].map(scope)).toEqual(["sandbox", "sandbox", "sandbox", "sandbox"]);
    expect(["a_proj_c", "a_proj_d", "a_proj_gone"].map(scope)).toEqual(["real", "real", "real"]);
  });

  it("scopes a triaged failure by its attempt", () => {
    const db = database();
    db.prepare("insert into core.projects values ('proj_a', 'LP sandbox x')").run();
    db.prepare("insert into lane_pilot_run values ('r1', 'proj_a')").run();
    db.prepare("insert into lane_pilot_run values ('r2', 'proj_real')").run();
    db.prepare("insert into lane_pilot_attempt values ('a1', 'r1', 't', 'blocked', 'x', 1)").run();
    db.prepare("insert into lane_pilot_attempt values ('a2', 'r2', 't', 'blocked', 'x', 1)").run();
    db.prepare("insert into lane_pilot_failure_triage values ('proj_a', 'a1', 'x', 'writer', 1)").run();
    db.prepare("insert into lane_pilot_failure_triage values ('proj_real', 'a2', 'x', 'writer', 1)").run();
    expect(db.prepare("select attempt_id, scope from lp_triage order by attempt_id").all()).toEqual([{ attempt_id: "a1", scope: "sandbox" }, { attempt_id: "a2", scope: "real" }]);
  });
});
