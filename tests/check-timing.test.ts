import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { sha256Buffer } from "@lane-pilot/kit";
import { checkHistoryKey, createAttempt, createRun, createTask, listCheckDurations, listCheckTimeouts, openDatabase, recordCheckDuration, transitionAttempt } from "../src/rooms/storage/database";
import { CHECK_TIMEOUT_CAP_SEC, checkTimeoutSec, historyTimeoutSec, orderChecksForFailFast, p95 } from "../src/rooms/writer/check-timing";

const ROOT = "/work/proj";
const STUDIO = "python3 -I scripts/studio_test.py";
const rowsOf = (db: ReturnType<typeof openDatabase>, projectId: string) => (db.prepare("SELECT COUNT(*) n FROM lane_pilot_check_duration WHERE project_id=?").get(projectId) as { n: number }).n;

describe("check timeout from history", () => {
  it("takes the nearest-rank 95th percentile", () => {
    expect(p95([])).toBe(0);
    expect(p95([5])).toBe(5);
    expect(p95(Array.from({ length: 20 }, (_, i) => (i + 1) * 1000))).toBe(19_000);
  });

  it("keeps the configured timeout until enough runs are known", () => {
    expect(historyTimeoutSec(120, [])).toBe(120);
    expect(historyTimeoutSec(120, [200_000, 200_000])).toBe(120);
  });

  it("is max(configured, p95 x 2), capped, and never below the configured value", () => {
    expect(historyTimeoutSec(120, [10_000, 12_000, 11_000])).toBe(120);
    expect(historyTimeoutSec(120, [100_000, 110_000, 90_000, 95_000])).toBe(220);
    expect(historyTimeoutSec(120, [2_000_000, 2_000_000, 2_000_000])).toBe(CHECK_TIMEOUT_CAP_SEC);
    expect(historyTimeoutSec(3600, [2_000_000, 2_000_000, 2_000_000])).toBe(3600);
  });

  it("reads the limits a check timed out at from the final reasons of its attempts and the task contract's folder, per project (a timeout is kept in no duration row)", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "runA", "A");
    createRun(db, "runB", "B");
    const attempt = (run:string, id:string, reason:string, verification:Array<{ command:string; cwd:string }> = [{ command:STUDIO, cwd:ROOT }]) => {
      createTask(db, { id, runId:run, kind:"cli", contract:{ project_cwd:ROOT, verification } });
      createAttempt(db, { id, runId:run, taskId:id });
      transitionAttempt(db, id, "blocked", { reason });
    };
    attempt("runA", "a1", `verification failed (${STUDIO}): verification timed out after 120s`);
    attempt("runA", "a2", `turn limit 5 reached: verification failed (${STUDIO}): verification timed out after 600s`);
    attempt("runA", "a3", `verification failed (${STUDIO}): exit 1`);
    attempt("runA", "a4", `verification failed (${STUDIO} --filter X): verification timed out after 90s`, [{ command:`${STUDIO} --filter X`, cwd:ROOT }]);
    attempt("runB", "b1", `verification failed (${STUDIO}): verification timed out after 30s`);
    const at = (command:string, cwd = ROOT) => ({ command, cwd, root:ROOT });
    expect(listCheckTimeouts(db, "A", at(STUDIO)).sort((a, b) => a - b)).toEqual([120, 600]);
    expect(listCheckTimeouts(db, "A", at(`${STUDIO} --filter X`))).toEqual([90]);
    expect(listCheckTimeouts(db, "B", at(STUDIO))).toEqual([30]);
    expect(listCheckTimeouts(db, "A", at("npm test"))).toEqual([]);
    // The same check started from its folder is the same history; another folder is another check.
    expect(listCheckTimeouts(db, "A", at(`cd game && ${STUDIO}`)).sort((a, b) => a - b)).toEqual([]);
    expect(listCheckTimeouts(db, "A", at(STUDIO, `${ROOT}/game`))).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("places a timeout by the folder its task contract gave the command: appA and appB do not share it, root and game/ do", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "runA", "A");
    const attempt = (id:string, command:string, cwd:string, sec:number, extra:Array<{ command:string; cwd:string }> = []) => {
      createTask(db, { id, runId:"runA", kind:"cli", contract:{ project_cwd:ROOT, verification:[{ command, cwd }, ...extra] } });
      createAttempt(db, { id, runId:"runA", taskId:id });
      transitionAttempt(db, id, "blocked", { reason:`verification failed (${command}): verification timed out after ${sec}s` });
    };
    attempt("t1", "cd appA && npm test", ROOT, 120);
    attempt("t2", STUDIO, `${ROOT}/game`, 300);
    attempt("t3", "npm test", "appA", 60);
    // Two checks of one task with the same command at two folders: the reason cannot say which, so it counts for neither.
    attempt("t4", "npm run lint", ROOT, 45, [{ command:"npm run lint", cwd:"appB" }]);
    const at = (command:string, cwd = ROOT) => ({ command, cwd, root:ROOT });
    // t1 (cd appA from the root) and t3 (appA as the folder) are one check.
    expect(listCheckTimeouts(db, "A", at("npm test", "appA")).sort((a, b) => a - b)).toEqual([60, 120]);
    expect(listCheckTimeouts(db, "A", at("cd appA && npm test")).sort((a, b) => a - b)).toEqual([60, 120]);
    expect(listCheckTimeouts(db, "A", at("npm test", "appB"))).toEqual([]);
    expect(listCheckTimeouts(db, "A", at("cd appB && npm test"))).toEqual([]);
    expect(listCheckTimeouts(db, "A", at(`cd game && ${STUDIO}`))).toEqual([300]);
    expect(listCheckTimeouts(db, "A", at(STUDIO))).toEqual([]);
    expect(listCheckTimeouts(db, "A", at("npm run lint"))).toEqual([]);
    expect(listCheckTimeouts(db, "A", at("npm run lint", "appB"))).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("stores each passing run per project and check and reads the last 20, newest first", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const at = (command:string, extra:object = {}) => ({ command, cwd:ROOT, root:ROOT, ...extra });
    for (let i = 1; i <= 25; i += 1) recordCheckDuration(db, { projectId: "A", ...at("npm test"), durationMs: i * 1000, exitCode: 0, now: i });
    recordCheckDuration(db, { projectId: "A", ...at("npm run lint"), durationMs: 7_000, exitCode: 0, now: 30 });
    recordCheckDuration(db, { projectId: "B", ...at("npm test"), durationMs: 9_000, exitCode: 0, now: 31 });
    // A red run ends early and says nothing about how long a green one takes.
    recordCheckDuration(db, { projectId: "A", ...at("npm test"), durationMs: 1, exitCode: 1, now: 32 });
    const rows = listCheckDurations(db, "A", at("npm test"));
    expect(rows).toHaveLength(20);
    expect(rows[0]).toBe(25_000);
    expect(rows[19]).toBe(6_000);
    expect(listCheckDurations(db, "A", at("npm run lint"))).toEqual([7_000]);
    expect(listCheckDurations(db, "B", at("npm test"))).toEqual([9_000]);
    await harness.lifecycle.dispose();
  });

  it("keeps the durations of two folders apart and of one folder together, whether the cwd is the check's or a leading cd's", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    recordCheckDuration(db, { projectId: "A", command: "cd appA && npm test", cwd: ROOT, root: ROOT, durationMs: 111_000, exitCode: 0 });
    recordCheckDuration(db, { projectId: "A", command: "npm test", cwd: `${ROOT}/appB`, root: ROOT, durationMs: 5_000, exitCode: 0 });
    expect(listCheckDurations(db, "A", { command: "npm test", cwd: "appA", root: ROOT })).toEqual([111_000]);
    expect(listCheckDurations(db, "A", { command: "cd appB && npm test", cwd: ROOT, root: ROOT })).toEqual([5_000]);
    expect(listCheckDurations(db, "A", { command: "npm test", cwd: ROOT, root: ROOT })).toEqual([]);
    // checkTimeoutSec reads the same store: appA's slow history does not widen appB.
    for (let i = 0; i < 3; i += 1) recordCheckDuration(db, { projectId: "A", command: "npm test", cwd: `${ROOT}/appA`, root: ROOT, durationMs: 100_000, exitCode: 0 });
    expect(checkTimeoutSec(db, "A", { command: "npm test", cwd: `${ROOT}/appA`, root: ROOT }, 120)).toBe(222);
    expect(checkTimeoutSec(db, "A", { command: "npm test", cwd: `${ROOT}/appB`, root: ROOT }, 120)).toBe(120);
    await harness.lifecycle.dispose();
  });

  it("still reads the rows written before the folder joined the key, for the exact same command string only", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const legacy = (projectId:string, command:string, ms:number, at:number) => db.prepare("INSERT INTO lane_pilot_check_duration(project_id,command_key,duration_ms,exit_code,at) VALUES (?,?,?,?,?)").run(projectId, sha256Buffer(command.trim()), ms, 0, at);
    legacy("A", "npm test", 40_000, 1);
    legacy("A", "  npm test ", 41_000, 2);
    legacy("A", "npm  test", 99_000, 3);
    legacy("B", "npm test", 77_000, 4);
    const ref = { command: "npm test", cwd: ROOT, root: ROOT };
    expect(listCheckDurations(db, "A", ref)).toEqual([41_000, 40_000]);
    // New rows are written under the new key and win by recency; the old rows stay readable beside them.
    recordCheckDuration(db, { projectId: "A", ...ref, durationMs: 50_000, exitCode: 0, now: 10 });
    expect(listCheckDurations(db, "A", ref)).toEqual([50_000, 41_000, 40_000]);
    expect(listCheckDurations(db, "B", ref)).toEqual([77_000]);
    expect(rowsOf(db, "A")).toBe(4);
    await harness.lifecycle.dispose();
  });

  it("checkTimeoutSec widens a slow check from its own history and leaves a new one alone", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const ref = { command: "npm test", cwd: ROOT, root: ROOT };
    expect(checkTimeoutSec(db, "A", ref, 120)).toBe(120);
    for (const ms of [100_000, 105_000, 110_000, 98_000]) recordCheckDuration(db, { projectId: "A", ...ref, durationMs: ms, exitCode: 0 });
    expect(checkTimeoutSec(db, "A", ref, 120)).toBe(220);
    expect(checkTimeoutSec(db, "B", ref, 120)).toBe(120);
    await harness.lifecycle.dispose();
  });
});

describe("the identity of a check is (logical folder, command)", () => {
  const key = (command:string, cwd = ROOT) => checkHistoryKey({ command, cwd, root: ROOT });
  it("is one check with and without a leading cd, from the root or from the folder (wc35ef88c-T1, 2026-10-26)", () => {
    expect(key(`cd game && ${STUDIO}`)).toBe(key(STUDIO, `${ROOT}/game`));
    expect(key(`cd game && ${STUDIO}`)).toBe(key(STUDIO, "game"));
    expect(key(`  cd game &&   ${STUDIO}  `)).toBe(key(STUDIO, "game/"));
    expect(key("cd a && cd b && npm test")).toBe(key("npm test", "a/b"));
    expect(key("cd ../web && npm test", "api")).toBe(key("npm test", "web"));
    // The same folder reached from another worktree of the project is the same check.
    expect(checkHistoryKey({ command: STUDIO, cwd: "/wt/attempt-1/game", root: "/wt/attempt-1" })).toBe(key(STUDIO, `${ROOT}/game`));
    expect(key(`cd game && ${STUDIO} --filter Par030`)).not.toBe(key(STUDIO));
  });
  it("keeps different folders apart (Astra RECHECK-336 P2)", () => {
    expect(key("cd appA && npm test")).not.toBe(key("cd appB && npm test"));
    expect(key("npm test", "appA")).not.toBe(key("npm test", "appB"));
    expect(key("npm test", "appA")).not.toBe(key("npm test"));
    expect(key("cd /elsewhere && npm test")).not.toBe(key("npm test"));
  });
  it("never rewrites inside quotes or inside the command: only its outer whitespace goes", () => {
    expect(key(`node -e "console.log('a  b')"`)).not.toBe(key(`node -e "console.log('a b')"`));
    expect(key("echo   hi")).not.toBe(key("echo hi"));
    expect(key("  npm test \n")).toBe(key("npm test"));
    expect(key(`cd "my app" && npm test`)).toBe(key("npm test", "my app"));
    // a cd the key cannot resolve statically stays part of the command
    expect(key("cd $APP && npm test")).not.toBe(key("npm test"));
  });
});

describe("fail-fast ordering and timeout escalation (W30)", () => {
  const at = (command:string, cwd = ROOT) => ({ command, cwd, root:ROOT });
  it("orders by (p_fail+eps)/(mean green sec+delta): flaky-fast first, stable ties keep contract order", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    for (const [command, ms, code] of [["slow-green", 100_000, 0], ["flaky-fast", 5_000, 1], ["flaky-fast", 4_000, 0], ["mid", 20_000, 1]] as const)
      recordCheckDuration(db, { projectId: "A", ...at(command), durationMs: ms, exitCode: code });
    const ordered = orderChecksForFailFast(db, "A", [at("slow-green"), at("flaky-fast"), at("mid"), at("new")], ROOT);
    expect(ordered.map((row) => row.check.command)).toEqual(["new", "flaky-fast", "mid", "slow-green"]);
    await harness.lifecycle.dispose();
  });
  it("escalates timeout x1.5 per consecutive 124 up to the cap; a green run resets it", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const ref = at("npm test");
    expect(checkTimeoutSec(db, "A", ref, 120)).toBe(120);
    recordCheckDuration(db, { projectId: "A", ...ref, durationMs: 120_000, exitCode: 124, now: 1 });
    expect(checkTimeoutSec(db, "A", ref, 120)).toBe(180);
    recordCheckDuration(db, { projectId: "A", ...ref, durationMs: 180_000, exitCode: 124, now: 2 });
    expect(checkTimeoutSec(db, "A", ref, 120)).toBe(270);
    recordCheckDuration(db, { projectId: "A", ...ref, durationMs: 10_000, exitCode: 0, now: 3 });
    expect(checkTimeoutSec(db, "A", ref, 120)).toBe(120);
    for (let n = 4; n < 12; n += 1) recordCheckDuration(db, { projectId: "A", ...ref, durationMs: 120_000, exitCode: 124, now: n });
    expect(checkTimeoutSec(db, "A", ref, 120)).toBe(CHECK_TIMEOUT_CAP_SEC);
    await harness.lifecycle.dispose();
  });
});
