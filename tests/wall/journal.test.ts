import { describe, expect, it } from "vitest";
import { collectEntries, listClasses, nightOf, refreshClasses, rungOf, writeEntries } from "../../src/rooms/wall/journal";
import { normaliseReason, originOf, pathKind, logSignature, wallSignature } from "../../src/rooms/wall/signature";
import { DAY, HOUR, NOW, freshDb, isReal } from "./helpers";

describe("the signature of a failure", () => {
  it("the stray files of owns_paths are one class whatever their number but not whatever their kind; red checks of different commands are one class", () => {
    const one = wallSignature("validation_failed", "owns_paths rejected apps/web/src/a.test.ts");
    const many = wallSignature("validation_failed", "retry limit 2 exhausted: owns_paths rejected apps/web/src/a.test.ts, packages/x/b.test.ts, c/__tests__/d.ts");
    expect(many.classKey).toBe(one.classKey);
    expect(one.reasonNorm).toBe("owns_paths rejected <paths:test>");
    // A shared locale file, a lockfile and a source file are other problems (the 2026-10-19 audit told them apart by hand).
    const locale = wallSignature("validation_failed", "owns_paths rejected apps/web/src/i18n/en.json");
    const lock = wallSignature("validation_failed", "owns_paths rejected package-lock.json");
    const source = wallSignature("validation_failed", "owns_paths rejected apps/web/src/pages/[slug].vue");
    expect(new Set([one.classKey, locale.classKey, lock.classKey, source.classKey]).size).toBe(4);
    expect([locale.reasonNorm, lock.reasonNorm, source.reasonNorm]).toEqual(["owns_paths rejected <paths:locale>", "owns_paths rejected <paths:lockfile>", "owns_paths rejected <paths:src>"]);
    expect(pathKind("tests/a.spec.ts")).toBe("test");
    const red1 = wallSignature("validation_failed", "verification failed (npx vitest run a): 3 failed");
    const red2 = wallSignature("validation_failed", "verification failed (node scripts/check.mjs --x 5): boom 12");
    expect(red1.classKey).toBe(red2.classKey);
    expect(red1.classKey).not.toBe(one.classKey);
  });

  it("ids, hashes and numbers do not split a class; the failure class is part of the key", () => {
    expect(normaliseReason("internal_error: lpattempt_1a2b3c at /home/x/repo 12")).toBe(normaliseReason("retry limit 2 exhausted: internal_error: lpattempt_9f9f9f at /tmp/y/z 40"));
    expect(wallSignature("blocked", "internal_error: x").failureClass).toBe("harness");
    expect(wallSignature("blocked", "internal_error: x").classKey.startsWith("harness:")).toBe(true);
    expect(logSignature("relay: send failed for thr_abc123").classKey).toMatch(/^log:/);
  });

  it("whose fault: the triage origin first, then the class", () => {
    expect(originOf("task", "orchestrator")).toBe("orchestrator");
    expect(originOf("harness", null)).toBe("harness");
    expect(originOf("infra", "writer")).toBe("infra");
    expect(originOf("task", "environment")).toBe("infra");
    expect(originOf("task", "writer")).toBe("writer");
    expect(originOf("merge", null)).toBe("flow");
    expect(originOf("task", null)).toBe("task");
  });
});

describe("the recurrence ladder 3/10, 5/100, 6/500", () => {
  it("rungs", () => {
    expect(rungOf([4, 4, 4])).toBe(0);
    expect(rungOf([3, 9, 9])).toBe(1);
    expect(rungOf([3, 5, 9])).toBe(2);
    expect(rungOf([3, 5, 6])).toBe(3);
    expect(rungOf([0, 0, 0])).toBe(3);
  });
});

describe("the journal", () => {
  function seeded() {
    const h = freshDb();
    const t = NOW - 5 * HOUR;
    // A class of Lane Pilot's own: 4 in the night, two versions, with a triage origin, a gate event and a failed receipt on the first.
    const a1 = h.attempt("blocked", "internal_error: another writer integration holds the base checkout lpattempt_aaa", t, { version: "0.1.267", task: "t1" });
    h.triage(a1, "orchestrator", t);
    h.gate("t1", "owns-paths", "rejected", t);
    h.receipt("t1", "writer-agent", "failed");
    h.attempt("blocked", "internal_error: another writer integration holds the base checkout lpattempt_bbb", t + 1000, { version: "0.1.268" });
    h.attempt("blocked", "retry limit 2 exhausted: internal_error: another writer integration holds the base checkout lpattempt_ccc", t + 2000, { version: "0.1.268" });
    h.attempt("blocked", "internal_error: another writer integration holds the base checkout lpattempt_ddd", t + 3000, { version: "0.1.268", run: "run_sand" });
    // The writers' own: red checks.
    h.attempt("validation_failed", "verification failed (npx vitest run x): 2 failed", t + 4000);
    h.attempt("validation_failed", "verification failed (npx vitest run y): 1 failed", t + 5000);
    // Accepted attempts and one outside the window.
    for (let i = 0; i < 20; i++) h.attempt("accepted", null, t - HOUR * 20 + i);
    h.attempt("blocked", "internal_error: old", NOW - 3 * DAY);
    return h;
  }

  it("groups the night by class, LP version and project, keeps sandbox traffic out, and counts the sources", () => {
    const { db } = seeded();
    const entries = collectEntries(db, { since: NOW - DAY, until: NOW, isReal, now: NOW });
    const harness = entries.filter((row) => row.failureClass === "harness");
    expect(harness.map((row) => [row.version, row.n]).sort()).toEqual([["0.1.267", 1], ["0.1.268", 2]]);
    const first = harness.find((row) => row.version === "0.1.267")!;
    expect(first.origin).toBe("orchestrator");
    expect(first.sources).toMatchObject({ attempt: 1, triage: 1, gate: 1, stage: 1 });
    expect(first.gates).toEqual({ "owns-paths:rejected": 1 });
    expect(first.stages).toEqual({ "writer-agent": 1 });
    const red = entries.find((row) => row.failureClass === "task")!;
    expect(red.n).toBe(2);
    expect(red.tasks).toBe(2);
    expect(entries.some((row) => row.projectId === "proj_sand")).toBe(false);
  });

  it("is idempotent for a night and adds the plugin log's failure lines as their own class", () => {
    const { db } = seeded();
    const logLines = [{ message: "relay: send failed for thr_abc123 (409)", at: NOW - 2 * HOUR, projectId: "-" }, { message: "relay: send failed for thr_def456 (409)", at: NOW - HOUR, projectId: "-" }];
    const run = () => writeEntries(db, collectEntries(db, { since: NOW - DAY, until: NOW, isReal, logLines, now: NOW }), NOW);
    run(); run();
    const rows = db.prepare("SELECT class_key, n, lp_version, night FROM lane_pilot_wall_entry WHERE failure_class='log'").all() as Array<{ n: number; night: string; lp_version: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.n).toBe(2);
    expect(rows[0]!.lp_version).toBe("0.1.268");
    expect(rows[0]!.night).toBe(nightOf(NOW - 1));
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_wall_entry").get() as { n: number }).n).toBe(rows.length + 3);
  });

  it("recurrence among the last 10 / 100 / 500 attempts decides open or closed", () => {
    const { db } = seeded();
    writeEntries(db, collectEntries(db, { since: NOW - DAY, until: NOW, isReal, now: NOW }), NOW);
    const classes = refreshClasses(db, { now: NOW, isReal });
    const harness = classes.find((row) => row.failureClass === "harness")!;
    // 3 harness failures (the sandbox one is not real) among 29 real finished attempts: the last 10 hold them all.
    expect(harness.counts[0]).toBe(3);
    expect(harness.rung).toBe(3);
    expect(harness.state).toBe("closed");
    expect(harness.recur1).toBe(3);
    expect(harness.origin).toBe("orchestrator");
    const red = classes.find((row) => row.failureClass === "task")!;
    expect(red.counts).toEqual([2, 2, 2]);
    // A flood opens a class: 6 more of the same in the last 10.
    for (let i = 0; i < 6; i++) db.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,state,reason,created_at,updated_at,harness_version) VALUES (?,?,?,?,?,?,?,?)")
      .run(`flood${i}`, "run_real", `tf${i}`, "blocked", "internal_error: another writer integration holds the base checkout lpattempt_zzz", NOW - 1000 + i, NOW - 1000 + i, "0.1.268");
    const after = refreshClasses(db, { now: NOW, isReal }).find((row) => row.failureClass === "harness")!;
    expect(after.counts[0]).toBeGreaterThan(3);
    expect(after.state).toBe("open");
    expect(after.rung).toBe(0);
    // Refreshing again keeps the ladder columns a night wrote.
    db.prepare("UPDATE lane_pilot_wall_class SET failed_moves=2, hunt_state='usable' WHERE class_key=?").run(after.classKey);
    const kept = refreshClasses(db, { now: NOW, isReal }).find((row) => row.classKey === after.classKey)!;
    expect([kept.failedMoves, kept.hunt]).toEqual([2, "usable"]);
    expect(listClasses(db, { state: "open" }).length).toBeGreaterThan(0);
  });

  it("a class that stopped happening closes", () => {
    const { db } = seeded();
    writeEntries(db, collectEntries(db, { since: NOW - DAY, until: NOW, isReal, now: NOW }), NOW);
    refreshClasses(db, { now: NOW, isReal });
    db.prepare("UPDATE lane_pilot_wall_class SET state='open', rung=0 WHERE failure_class='task'").run();
    for (let i = 0; i < 12; i++) db.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,state,created_at,updated_at,harness_version) VALUES (?,?,?,?,?,?,?)")
      .run(`ok${i}`, "run_real", `tok${i}`, "accepted", NOW + 1 + i, NOW + 1 + i, "0.1.268");
    db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE reason LIKE 'verification failed%'").run(NOW - 2 * DAY);
    const later = refreshClasses(db, { now: NOW + HOUR, isReal }).find((row) => row.failureClass === "task")!;
    expect(later.state).toBe("closed");
    expect(later.recur1).toBe(0);
  });
});
