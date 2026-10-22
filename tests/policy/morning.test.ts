import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { composeMorningList } from "../../src/rooms/policy/morning";

const NOW = Date.UTC(2026, 9, 22, 7, 0, 0);
const HOUR = 3_600_000;

function seeded() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  db.exec("PRAGMA foreign_keys=OFF");
  const attempt = (id: string, state: string, at: number) =>
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(id, "run_1", `task_${id}`, state, at, at);
  attempt("a1", "accepted", NOW - 2 * HOUR);
  attempt("a2", "accepted", NOW - 3 * HOUR);
  attempt("a3", "accepted", NOW - 30 * HOUR); // yesterday's, outside the window
  attempt("a4", "validation_failed", NOW - 4 * HOUR);
  attempt("a5", "validation_failed", NOW - 5 * HOUR);
  attempt("a6", "provider_error", NOW - 6 * HOUR);
  attempt("a7", "running", NOW - HOUR); // not red, not accepted
  attempt("a8", "validation_failed", NOW - 40 * HOUR); // old red
  const rule = (id: string, state: string) => db.prepare("INSERT INTO lane_pilot_rule_proposal(id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, "proj_1", id, "r", "model", state, 1, 1, "[]", NOW, NOW, NOW);
  rule("r1", "proposed"); rule("r2", "proposed"); rule("r3", "accepted");
  const event = (rule_id: string, action: string, at: number) => db.prepare("INSERT INTO lane_pilot_rule_event(project_id,rule_id,action,at) VALUES ('proj_1',?,?,?)").run(rule_id, action, at);
  event("r3", "adopted", NOW - 2 * HOUR); event("r3", "adopted", NOW - 50 * HOUR); event("r3", "confirmed", NOW - HOUR);
  db.prepare("INSERT INTO lane_pilot_learning_item(id,obs_id,project_id,thread_id,kind,text,reach,state,evidence,created_at) VALUES ('i1','o1','proj_1','t','preference','p','owner','pending_owner','e',?)").run(NOW);
  const deferral = (id: string, kind: string, state: string, dueAt: number | null) => db.prepare("INSERT INTO lane_pilot_deferral(id,project_id,what,kind,state,due_at,created_at,updated_at) VALUES (?,NULL,'w',?,?,?,?,?)").run(id, kind, state, dueAt, NOW, NOW);
  deferral("d1", "skipped_test", "needs_owner_term", null); deferral("d2", "plan_decision", "needs_owner_term", null);
  deferral("d3", "gate", "overdue", NOW - HOUR); deferral("d4", "gate", "open", NOW + HOUR); deferral("d5", "memory_conflict", "needs_owner_term", null);
  db.prepare("INSERT INTO lane_pilot_memory_conflict(id,project_id,note_a,note_b,kind,subject,state,detected_at) VALUES ('mc1','proj_1','a','b','value','s','held',?)").run(NOW);
  db.prepare("INSERT INTO lane_pilot_owner_item(key,source,kind,what,why,state,created_at) VALUES ('night:1','night','proposal','w','y','open',?)").run(NOW);
  return db;
}

describe("the morning list", () => {
  it("is four lines: the owner's decisions waiting, what went red, what was accepted, the other things only he can decide", () => {
    expect(composeMorningList(seeded(), NOW)).toEqual([
      "Только владелец: ждут решения правил — 2, пунктов обучения — 1.",
      "Красное за ночь: 3 попыток (provider_error 1, validation_failed 2).",
      "Принято: 2 попыток, правил на пробу 1, подтверждено 1.",
      "Ещё ждут владельца: отсрочек без срока — 2, просроченных — 1, конфликтов памяти — 1, от ночного цикла — 1. Подробно: экран «Ждут владельца».",
    ]);
  });

  it("says «ничего» for a quiet night and works on an empty database", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    expect(composeMorningList(db, NOW)).toEqual([
      "Только владелец: ждут решения правил — 0, пунктов обучения — 0.",
      "Красное за ночь: ничего.",
      "Принято: 0 попыток, правил на пробу 0, подтверждено 0.",
      "Ещё ждут владельца: отсрочек без срока — 0, просроченных — 0, конфликтов памяти — 0, от ночного цикла — 0. Подробно: экран «Ждут владельца».",
    ]);
  });

  it("scripts/lp-morning.sql (used by the daily report) prints the same four lines", () => {
    const db = seeded();
    db.exec(`CREATE TEMP TABLE lp_morning(since integer, now integer); INSERT INTO lp_morning VALUES (${NOW - 24 * HOUR}, ${NOW})`);
    const sql = readFileSync(join(__dirname, "..", "..", "scripts", "lp-morning.sql"), "utf8").split("\n").filter((line) => !line.startsWith("--")).join("\n");
    const lines = sql.split(";").map((statement) => statement.trim()).filter(Boolean)
      .map((statement) => Object.values(db.prepare(statement).get() as Record<string, string>)[0]);
    expect(lines).toEqual(composeMorningList(db, NOW));
  });
});
