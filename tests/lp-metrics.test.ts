import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { failureClass } from "../src/failure-class";

// Audit round 2, item 19: the metrics count real projects only. The views of scripts/lp-metrics-views.sql classify an attempt the way
// failureClass() does and tell a sandbox or drill attempt from a real one; these tests keep both equal to the code.
const views = readFileSync(new URL("../scripts/lp-metrics-views.sql", import.meta.url), "utf8");

function database(since = "") {
  const db = new Database(":memory:");
  db.exec(`attach ':memory:' as core; create table core.projects(id text primary key, name text);
    create table lane_pilot_run(id text primary key, project_id text not null);
    create table lane_pilot_attempt(id text primary key, run_id text not null, task_id text not null, state text not null, reason text, created_at integer not null, harness_version text);
    create table lane_pilot_failure_triage(project_id text, attempt_id text, reason text, origin text, failed_at integer);
    create temp table lp_params(days integer, since_version text); insert into lp_params values (7, '${since}');`);
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
const NAMED = new Set(["dirty_base", "harness", "infra", "merge", "limit", "budget", "judgment"]);

describe("lp-metrics views", () => {
  it("classify a failed attempt as failureClass does, collapsing task, provider and contract into other", () => {
    const db = database();
    db.prepare("insert into core.projects values ('proj_real', 'SelfyStudio')").run();
    db.prepare("insert into lane_pilot_run values ('run1', 'proj_real')").run();
    const insert = db.prepare("insert into lane_pilot_attempt values (?, 'run1', 'task', ?, ?, ?, null)");
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
    db.prepare("insert into lane_pilot_attempt values ('a1', 'run1', 't', 'accepted', 'internal_error', 1, null)").run();
    db.prepare("insert into lane_pilot_attempt values ('a2', 'run1', 't', 'canceled', null, 1, null)").run();
    expect(db.prepare("select cls from lp_attempt_class").all()).toEqual([{ cls: null }, { cls: null }]);
  });

  it("puts sandbox projects, LP native projects and drill tasks apart from the real projects", () => {
    const db = database();
    const projects: Array<[string, string]> = [["proj_3tb652jpsi", "LP sandbox rules"], ["proj_a", "LP sandbox layout A3"], ["proj_b", "LP native NOGIT"], ["proj_c", "SelfyStudio"], ["proj_d", "BB-сервис"], ["proj_gone", "Renamed sandbox"]];
    for (const [id, name] of projects) {
      db.prepare("insert into core.projects values (?, ?)").run(id, name);
      db.prepare("insert into lane_pilot_run values (?, ?)").run(`run_${id}`, id);
      db.prepare("insert into lane_pilot_attempt values (?, ?, 'T-1', 'accepted', null, 1, null)").run(`a_${id}`, `run_${id}`);
    }
    db.prepare("insert into lane_pilot_attempt values ('a_drill', 'run_proj_c', 'drill-20261007-1', 'accepted', null, 1, null)").run();
    const scope = (id: string) => (db.prepare("select scope from lp_attempt where id = ?").get(id) as { scope: string }).scope;
    expect(["a_proj_3tb652jpsi", "a_proj_a", "a_proj_b", "a_drill"].map(scope)).toEqual(["sandbox", "sandbox", "sandbox", "sandbox"]);
    expect(["a_proj_c", "a_proj_d", "a_proj_gone"].map(scope)).toEqual(["real", "real", "real"]);
  });

  it("scopes a triaged failure by its attempt", () => {
    const db = database();
    db.prepare("insert into core.projects values ('proj_a', 'LP sandbox x')").run();
    db.prepare("insert into lane_pilot_run values ('r1', 'proj_a')").run();
    db.prepare("insert into lane_pilot_run values ('r2', 'proj_real')").run();
    db.prepare("insert into lane_pilot_attempt values ('a1', 'r1', 't', 'blocked', 'x', 1, null)").run();
    db.prepare("insert into lane_pilot_attempt values ('a2', 'r2', 't', 'blocked', 'x', 1, null)").run();
    db.prepare("insert into lane_pilot_failure_triage values ('proj_a', 'a1', 'x', 'writer', 1)").run();
    db.prepare("insert into lane_pilot_failure_triage values ('proj_real', 'a2', 'x', 'writer', 1)").run();
    expect(db.prepare("select attempt_id, scope from lp_triage order by attempt_id").all()).toEqual([{ attempt_id: "a1", scope: "sandbox" }, { attempt_id: "a2", scope: "real" }]);
  });

  // The owner's point (2026-10-08): all 659 real attempts of the window had harness_version NULL (before 0.1.177), so the numbers
  // described the old Lane Pilot. The headline is the current version and newer; older real attempts are one line beside it.
  describe("the version split", () => {
    function world(since: string, versions: Array<string | null>) {
      const db = database(since);
      db.prepare("insert into core.projects values ('proj_real', 'SelfyStudio')").run();
      db.prepare("insert into lane_pilot_run values ('run1', 'proj_real')").run();
      versions.forEach((version, index) => db.prepare("insert into lane_pilot_attempt values (?, 'run1', 'task', 'accepted', null, ?, ?)").run(`a${index}`, 1_000 + index, version));
      return db;
    }
    const split = (db: ReturnType<typeof database>) => db.prepare("select id, cur from lp_attempt order by id").all().map((row) => (row as { cur: number }).cur);

    it("counts NULL, malformed and lower versions as older, and compares versions as numbers (0.1.9 < 0.1.10)", () => {
      const db = world("0.1.193", [null, "0.1.176", "0.1.9", "0.1.192", "0.1.193", "0.1.194", "0.2.0", "0.1.1000", "garbage"]);
      expect(split(db)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 0]);
      expect(db.prepare("select v from lp_floor").get()).toEqual({ v: "0.1.193" });
      const numeric = world("0.1.10", ["0.1.9", "0.1.10", "0.1.11"]);
      expect(split(numeric)).toEqual([0, 1, 1]);
    });

    it("defaults to the version of the newest attempt, never below 0.1.193", () => {
      expect(split(world("", [null, "0.1.190", "0.1.194", "0.1.195"]))).toEqual([0, 0, 0, 1]);
      const low = world("", [null, "0.1.150", "0.1.170"]);
      expect(db_v(low)).toBe("0.1.193");
      expect(split(low)).toEqual([0, 0, 0]);
      expect(db_v(world("", [null]))).toBe("0.1.193");
    });

    it("an explicit since-version below the floor is respected", () => {
      expect(split(world("0.1.177", [null, "0.1.176", "0.1.177", "0.1.180"]))).toEqual([0, 0, 1, 1]);
    });

    it("takes the headline and the older line from the same attempts, and the window starts at the first current attempt", () => {
      const db = world("0.1.193", [null, null, "0.1.193", "0.1.194"]);
      db.prepare("update lane_pilot_attempt set state='blocked', reason='internal_error: x' where id='a1'").run();
      const count = (cur: number) => db.prepare("select count(*) n, sum(state='accepted') ok from lp_attempt where scope='real' and cur=?").get(cur);
      expect(count(1)).toEqual({ n: 2, ok: 2 });
      expect(count(0)).toEqual({ n: 2, ok: 1 });
      expect(db.prepare("select min(created_at) first from lp_attempt where scope='real' and cur=1").get()).toEqual({ first: 1_002 });
    });

    it("scopes a triaged failure to the current version through its attempt; one with no attempt counts as older", () => {
      const db = world("0.1.193", [null, "0.1.194"]);
      db.prepare("insert into lane_pilot_failure_triage values ('proj_real', 'a0', 'x', 'writer', 1)").run();
      db.prepare("insert into lane_pilot_failure_triage values ('proj_real', 'a1', 'x', 'writer', 1)").run();
      db.prepare("insert into lane_pilot_failure_triage values ('proj_real', 'gone', 'x', 'writer', 1)").run();
      expect(db.prepare("select attempt_id, cur from lp_triage order by attempt_id").all()).toEqual([{ attempt_id: "a0", cur: 0 }, { attempt_id: "a1", cur: 1 }, { attempt_id: "gone", cur: 0 }]);
    });

    it("runs the report and the daily queries on a database with the real shape", () => {
      const db = world("", [null, "0.1.194"]);
      const report = readFileSync(new URL("../scripts/lp-metrics.sql", import.meta.url), "utf8").split("\n").filter((line) => !line.startsWith(".")).join("\n");
      expect(() => db.exec(report)).not.toThrow();
    });
  });
});

function db_v(db: ReturnType<typeof database>): string {
  return (db.prepare("select v from lp_floor").get() as { v: string }).v;
}
