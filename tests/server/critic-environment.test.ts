import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createAttempt, createRun, openDatabase } from "../../src/database";
import { attemptEnvironment } from "../../src/rooms/critique/server/critique-runs";

it("runs a code critic of a worktree attempt inside that attempt's BB environment", () => {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb", "/repo");
  createAttempt(db, { id:"a1", runId:"run", taskId:"t" });
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path=?, environment_id=? WHERE id=?").run("/bb/env_x/repo", "env_x", "a1");
  expect(attemptEnvironment(db, "run", "t", "/bb/env_x/repo")).toEqual({ type:"reuse", environmentId:"env_x" });
  // A task in the project folder itself has no attempt environment: the critic gets the host path as before.
  expect(attemptEnvironment(db, "run", "t", "/repo")).toBeNull();
  expect(attemptEnvironment(db, "run", "other", "/bb/env_x/repo")).toBeNull();
});
