import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { createAttempt, createRun, openDatabase } from "../../src/database";
import { cleanupFinishedAttemptEnvironments } from "../../src/server/run-finish";

it("releases worktrees of attempts that ended over 30 minutes ago in an open run, never a live or recent one", async () => {
  const archived: string[] = [], deleted: string[] = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ environments:{
    get:async ({ environmentId }: { environmentId:string }) => ({ id:environmentId, lifecycle:{ phase:"active" } }),
    archiveThreads:async ({ environmentId }: { environmentId:string }) => { archived.push(environmentId); },
    delete:async ({ environmentId }: { environmentId:string }) => { deleted.push(environmentId); },
  } } as never });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  const now = 10_000_000;
  const attempt = (id:string, env:string, state:string, age:number) => {
    createAttempt(db, { id, runId:"run", taskId:id });
    db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, state=?, updated_at=? WHERE id=?").run(env, state, now - age, id);
  };
  attempt("a-old", "env_done", "accepted", 3_600_000);
  attempt("b-old", "env_blocked", "blocked", 3_600_000);
  attempt("c-recent", "env_recent", "accepted", 60_000);
  attempt("d-live", "env_live", "running", 3_600_000);
  // A worktree shared by a finished and a running attempt stays.
  attempt("e-done", "env_shared", "blocked", 3_600_000);
  attempt("e-live", "env_shared", "running", 3_600_000);
  expect((await cleanupFinishedAttemptEnvironments(bb, db, now)).sort()).toEqual(["env_blocked", "env_done"]);
  expect(deleted.sort()).toEqual(["env_blocked", "env_done"]);
});
