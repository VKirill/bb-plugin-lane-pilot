import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { pilotOf, runTasks } from "../../src/rooms/pilot";

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
