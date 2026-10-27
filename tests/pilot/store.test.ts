import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { pilotOf, pilotUnderWall, runTasks } from "../../src/rooms/pilot";

describe("runTasks reads the owned paths of the PM's tasks and which of them ended canceled", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE lane_pilot_task(id TEXT PRIMARY KEY, run_id TEXT, contract_json TEXT, created_at INTEGER, birth TEXT);
    CREATE TABLE lane_pilot_attempt(id TEXT PRIMARY KEY, run_id TEXT, task_id TEXT, state TEXT, created_at INTEGER, attempt_no INTEGER)`);
  const task = (id: string, at: number, birth = "pm", owns = ["scripts/gamedata/"]) => db.prepare("INSERT INTO lane_pilot_task VALUES (?,?,?,?,?)").run(id, "r", JSON.stringify({ owns_paths: owns, depends_on: [] }), at, birth);
  const attempt = (taskId: string, state: string, no: number) => db.prepare("INSERT INTO lane_pilot_attempt VALUES (?,?,?,?,?,?)").run(`${taskId}-${no}`, "r", taskId, state, no, no);
  task("a", 1); task("b", 2); task("c", 3); task("c-mainfix", 4); task("wf", 5, "workflow"); task("old", 0);
  attempt("old", "canceled", 1); attempt("a", "canceled", 1); attempt("a", "accepted", 2); attempt("b", "queued", 1);

  it("gives a PM task its paths, leaves a mainfix and a workflow's task out of a wave, and marks only a task whose latest attempt is canceled", () => {
    const tasks = runTasks(db, "r");
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

describe("pilotUnderWall", () => {
  const wallDb = new Database(":memory:");
  wallDb.exec("CREATE TABLE lane_pilot_wall(wall_key TEXT, kind TEXT, state TEXT, pack_json TEXT)");
  const wall = (key: string, state: string, meta: Record<string, unknown>) => wallDb.prepare("INSERT INTO lane_pilot_wall VALUES (?,?,?,?)").run(key, "task", state, JSON.stringify({ meta }));
  wall("task:a", "stopped", { runId: "r", family: "p0" });
  wall("loop:topic:b", "hunting", { runId: "r", topic: "scripts/gamedata/rules.py" });
  wall("loop:topic:c", "hunted", { runId: "r", topic: "game/done.luau" });
  wall("task:d", "stopped", { runId: "other", family: "p9" });

  it("holds a family with a task wall in this run, and a pilot that owns the file of a running hunt; a finished hunt or another run's wall holds nothing", () => {
    expect(pilotUnderWall(wallDb, "r", "p0", [])).toBe(true);
    expect(pilotUnderWall(wallDb, "r", "p1", ["scripts/gamedata/"])).toBe(true);
    expect(pilotUnderWall(wallDb, "r", "p1", ["game/done.luau"])).toBe(false);
    expect(pilotUnderWall(wallDb, "r", "p9", [])).toBe(false);
    expect(pilotUnderWall(new Database(":memory:"), "r", "p0", [])).toBe(false);
  });
});
