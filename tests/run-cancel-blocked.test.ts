import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { cancelRejection } from "../src/rooms/runs/server/run-finish";
import { createRun, getAttempt, openDatabase, setRunState } from "../src/rooms/storage/database";

// Live drill 2026-10-27: a drill run ended `blocked` with three attempts still `spawn_requested`. `lane-pilot finish` refused while
// attempts were open, `lane-pilot cancel` refused «cancel is not legal for blocked run», and the stuck run held the project's
// activation, so the next deploy's drill could not start its PM.
function world(state: string) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb", "/repo");
  setRunState(db, "run", state);
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('t','run','bb','{}',1)").run();
  db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,created_at,updated_at) VALUES('a','run','t','spawn_requested',1,1,1)").run();
  return db;
}

describe("cancelling the attempts of a run", () => {
  it("is legal in a blocked run that is not closed, so the run can be finished", () => {
    const db = world("blocked");
    expect(cancelRejection(db, getAttempt(db, "a")!)).toBeNull();
  });

  it("stays legal in a running run and refused in a closed one", () => {
    expect(cancelRejection(world("running"), getAttempt(world("running"), "a")!)).toBeNull();
    const db = world("blocked");
    db.prepare("UPDATE lane_pilot_run SET closed_at=2 WHERE id='run'").run();
    expect(cancelRejection(db, getAttempt(db, "a")!)).toMatch(/not legal/);
  });
});
