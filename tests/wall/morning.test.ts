import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { composeWallMorning } from "../../src/rooms/wall/morning";
import { insertRepair, insertWall, saveNight, updateRepair, updateWall } from "../../src/rooms/wall/store";
import { HOUR, NOW, freshDb } from "./helpers";

const SQL = readFileSync(join(__dirname, "..", "..", "scripts", "lp-wall-morning.sql"), "utf8");

/** The SQL file the hub's daily script runs, executed here against the same database: its three lines. */
function sqlLines(db: ReturnType<typeof freshDb>["db"], since: number): string[] {
  db.exec("CREATE TEMP TABLE lp_morning(since integer)");
  db.exec("CREATE TEMP TABLE lp_morning_30(since integer)");
  db.prepare("INSERT INTO lp_morning VALUES (?)").run(since);
  db.prepare("INSERT INTO lp_morning_30 VALUES (?)").run(since - 29 * 86_400_000);
  const code = SQL.split("\n").filter((line) => !line.startsWith("--")).join("\n");
  const out = code.split(/;\s*\n/).map((statement) => statement.trim()).filter(Boolean)
    .map((statement) => Object.values(db.prepare(statement).get() as Record<string, string>)[0]!);
  db.exec("DROP TABLE lp_morning");
  db.exec("DROP TABLE lp_morning_30");
  return out;
}

describe("the night loop's three morning lines", () => {
  it("a quiet database says zeros", () => {
    const { db } = freshDb();
    const quiet = composeWallMorning(db, NOW);
    expect(quiet.slice(0, 3)).toEqual([
      "Ночная петля: классов с повтором 0, взято в ремонт 0; потрачено 0.0 из 0.0 млн токенов.",
      "Ремонты ночи: слито 0, adopt 0, hold 0, reject 0.",
      "Охранник цикла: охот 0, в беклоге 0, перепрогонов 0 (в списке 0).",
    ]);
    expect(quiet[3]).toMatch(/^Тёмные таблицы/);
  });

  it("counts what the night did, and the SQL of the daily report says the same", () => {
    const { db } = freshDb();
    const since = NOW - 24 * HOUR;
    db.prepare("INSERT INTO lane_pilot_wall_class (class_key,failure_class,reason_norm,origin,first_seen,last_seen,total,c10,c100,c500,w10,w100,w500,rung,state,recur7,recur1,updated_at) VALUES ('k1','harness','r','harness',1,1,9,9,9,9,10,10,10,0,'open',9,3,?)").run(NOW);
    db.prepare("INSERT INTO lane_pilot_wall_class (class_key,failure_class,reason_norm,origin,first_seen,last_seen,total,c10,c100,c500,w10,w100,w500,rung,state,recur7,recur1,updated_at) VALUES ('k2','task','r','task',1,1,1,1,1,1,10,10,10,3,'closed',1,0,?)").run(NOW);
    saveNight(db, { night: "2026-10-22", startedAt: NOW - HOUR, dryRun: false, classesSeen: 2, picked: [], morning: [], hunts: [], backlog: [], spendTokens: 7_340_000, capTokens: 20_000_000, stoppedBy: null }, NOW);
    const repair = (state: string, minutesAgo: number) => {
      const row = insertRepair(db, { classKey: "k1", signature: `night:${state}`, night: "2026-10-22", round: 1, role: "engineer", brief: {}, versionBefore: "0.1.268", tokensEst: 1, now: NOW - HOUR });
      updateRepair(db, row.id, { state: state as never }, NOW - minutesAgo * 60_000);
    };
    repair("merged", 10); repair("accepted", 20); repair("held", 30); repair("held", 40); repair("rolled_back", 50); repair("red", 60);
    insertWall(db, { key: "class:k1", kind: "class", subject: "k1", projectId: "", state: "hunting", moves: 2, now: NOW - 2 * HOUR });
    updateWall(db, "class:k1", { hunt: "usable", state: "backlog" }, NOW - HOUR);
    insertWall(db, { key: "task:old", kind: "task", subject: "old", projectId: "p", state: "backlog", moves: 2, now: NOW - 90 * HOUR });
    db.prepare("INSERT INTO lane_pilot_wall_rerun (id,class_key,project_id,run_id,task_id,attempt_id,scope,from_stage,state,created_at) VALUES ('a','k1','p','r','t','a1','sandbox','writer-agent','dispatched',?)").run(NOW - HOUR);
    db.prepare("INSERT INTO lane_pilot_wall_rerun (id,class_key,project_id,run_id,task_id,attempt_id,scope,from_stage,state,created_at) VALUES ('b','k1','p','r','t','a2','real','writer-agent','listed',?)").run(NOW - HOUR);
    db.prepare("INSERT INTO lane_pilot_wall_rerun (id,class_key,project_id,run_id,task_id,attempt_id,scope,from_stage,state,created_at) VALUES ('c','k1','p','r','t','a3','real','writer-agent','listed',?)").run(NOW - HOUR);

    const lines = composeWallMorning(db, NOW);
    expect(lines.slice(0, 3)).toEqual([
      "Ночная петля: классов с повтором 1, взято в ремонт 6; потрачено 7.3 из 20.0 млн токенов.",
      "Ремонты ночи: слито 1, adopt 1, hold 2, reject 2.",
      "Охранник цикла: охот 1, в беклоге 2, перепрогонов 1 (в списке 2).",
    ]);
    expect(lines[3]).toMatch(/^Тёмные таблицы/);
    expect(sqlLines(db, since)).toEqual(lines);
  });
});
