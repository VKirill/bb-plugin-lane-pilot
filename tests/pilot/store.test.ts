import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { pilotOf, pilotUnderWall, runTasks, type RunTask } from "../../src/rooms/pilot";
import { canceledLatestTaskIds, listRunTaskRows } from "../../src/rooms/storage";

describe("runTasks reads the owned paths of the PM's tasks and which of them ended canceled", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE lane_pilot_task(id TEXT PRIMARY KEY, run_id TEXT, contract_json TEXT, created_at INTEGER, birth TEXT);
    CREATE TABLE lane_pilot_attempt(id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, state TEXT, created_at INTEGER, attempt_no INTEGER)`);
  const task = (id: string, at: number, birth = "pm", owns = ["scripts/gamedata/"]) => db.prepare("INSERT INTO lane_pilot_task VALUES (?,?,?,?,?)").run(id, "r", JSON.stringify({ owns_paths: owns, depends_on: [] }), at, birth);
  const attempt = (taskId: string, state: string, no: number) => db.prepare("INSERT INTO lane_pilot_attempt VALUES (?,?,?,?,?,?)").run(`${taskId}-${no}`, "r", taskId, state, no, no);
  task("a", 1); task("b", 2); task("c", 3); task("c-mainfix", 4); task("wf", 5, "workflow"); task("old", 0);
  attempt("old", "canceled", 1); attempt("a", "canceled", 1); attempt("a", "accepted", 2); attempt("b", "queued", 1);

  it("gives a PM task its paths, leaves a mainfix and a workflow's task out of a wave, and marks only a task whose latest attempt is canceled", () => {
    const tasks = runTasks(listRunTaskRows(db, "r"), canceledLatestTaskIds(db, "r"));
    const byId = Object.fromEntries(tasks.map((row) => [row.id, row]));
    expect(byId.a).toMatchObject({ ownsPaths: ["scripts/gamedata/"] });
    expect(byId.a!.canceled).toBeUndefined();
    expect(byId.old!.canceled).toBe(true);
    expect(byId["c-mainfix"]!.ownsPaths).toBeUndefined();
    expect(byId.wf!.ownsPaths).toBeUndefined();
    // «old» was canceled, so the wave is a, b, c and a is its pilot; the mainfix waits for no one.
    expect(pilotOf("c", tasks)).toBe("a");
    expect(pilotOf("c-mainfix", tasks)).toBeNull();
  });
});

describe("a task sent again twice is one sibling of its base", () => {
  const task = (id: string, at: number): RunTask => ({ id, area: "feature:x", kind: "fix", createdAt: at, dependsOn: [] });

  it("does not count «P1.2.2» as a third sibling of «P1»", () => {
    // Four tasks of two families are not four siblings: the pilot rule needs three families, so it chooses none.
    expect(pilotOf("P2", [task("P1", 1), task("P1.2", 2), task("P1.2.2", 3), task("P2", 4)])).toBeNull();
  });

  it("still chooses the earliest task of a three-family wave as the pilot", () => {
    expect(pilotOf("P3", [task("P1", 1), task("P1.2", 2), task("P2", 3), task("P3", 4)])).toBe("P1");
  });
});

describe("pilotUnderWall", () => {
  const walls = [
    { state: "stopped", pack: { meta: { runId: "r", family: "p0" } } },
    { state: "hunting", pack: { meta: { runId: "r", topic: "scripts/gamedata/rules.py" } } },
    { state: "hunted", pack: { meta: { runId: "r", topic: "game/done.luau" } } },
    { state: "stopped", pack: { meta: { runId: "other", family: "p9" } } },
  ];
  it("holds a family with a task wall in this run, and a pilot that owns the file of a running hunt; a finished hunt or another run's wall holds nothing", () => {
    expect(pilotUnderWall(walls, "r", "p0", [])).toBe(true);
    expect(pilotUnderWall(walls, "r", "p1", ["scripts/gamedata/"])).toBe(true);
    expect(pilotUnderWall(walls, "r", "p1", ["game/done.luau"])).toBe(false);
    expect(pilotUnderWall(walls, "r", "p9", [])).toBe(false);
    expect(pilotUnderWall([], "r", "p0", [])).toBe(false);
  });
});
