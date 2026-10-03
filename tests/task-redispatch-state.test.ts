import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createAttempt, createRun, latestTaskAttemptState, openDatabase } from "../src/database";

it("a dependency named by the plan id follows its latest redispatch, and only that", () => {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  const attempt = (id:string, task:string, state:string, at:number) => {
    createAttempt(db, { id, runId:"run", taskId:task });
    db.prepare("UPDATE lane_pilot_attempt SET state=?, created_at=? WHERE id=?").run(state, at, id);
  };
  attempt("a1", "P1.2", "running", 2);
  attempt("a2", "P10", "accepted", 3);
  attempt("a3", "P1.x", "accepted", 4);
  expect(latestTaskAttemptState(db, "proj", "P1")).toBe("running");
  attempt("a4", "P1.3", "accepted", 5);
  expect(latestTaskAttemptState(db, "proj", "P1")).toBe("accepted");
  expect(latestTaskAttemptState(db, "proj", "P1.2")).toBe("running");
  expect(latestTaskAttemptState(db, "proj", "P2")).toBeNull();
});
