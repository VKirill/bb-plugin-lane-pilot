import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, listTaskTerminalStates, openDatabase } from "../src/rooms/storage/database";
import { aggregateRun } from "../src/rooms/runs/aggregation";
import type { AttemptState } from "../src/rooms/runs/state-machine";

// magicseo (2026-10-30): every family accepted, the run still ended «blocked» on the replaced T1.3, T3.2, T5…
describe("a run's state counts task families", () => {
  it("is accepted when the latest member of every family is", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    createRun(db, "run", "proj", "cli", "/repo");
    let at = 0;
    const task = (id: string, state: string) => {
      at += 1000;
      db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,?,'bb','{}',?)").run(id, "run", at);
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,reason,created_at,updated_at) VALUES(?,?,?,?,1,NULL,?,?)").run(`a-${id}`, "run", id, state, at, at);
    };
    task("T1.3", "blocked"); task("T1.4", "accepted");
    task("T3", "blocked"); task("T3.2", "blocked"); task("T3.3", "canceled"); task("T3.4", "accepted");
    task("F1", "accepted"); task("F1.2", "accepted");
    expect(listTaskTerminalStates(db, "run")).toEqual(["accepted", "accepted", "accepted"]);
    expect(aggregateRun(listTaskTerminalStates(db, "run") as AttemptState[])).toBe("accepted");
    task("T5.2", "blocked");
    expect(aggregateRun(listTaskTerminalStates(db, "run") as AttemptState[])).toBe("blocked");
  });
});
