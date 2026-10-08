import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { criticStats } from "../src/rooms/critique/critic-stats";
import { createRun, openDatabase } from "../src/rooms/storage/database";

it("counts blocks, what became of them, misses and first-try acceptance from recorded tasks", () => {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  let at = 1000;
  const task = (id:string) => db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,'run','bb','{}',?)").run(id, at++);
  const attempt = (taskId:string, state:string, reason:string | null = null) =>
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,reason,created_at,updated_at) VALUES(?,'run',?,?,1,?,?,?)").run(`a${at}`, taskId, state, reason, at, at++);
  const receipt = (taskId:string, state:string, decision:string | null) =>
    db.prepare(`INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,contract_version,state,input_sha256,attempt,result_json,updated_at)
      VALUES('run',?,'plan-critique',1,?,'x',0,?,?)`).run(taskId, state, decision ? JSON.stringify({ decision }) : null, 5000);
  task("A"); receipt("A", "blocked", "changes_requested");            // blocked, fixed as A.2 and accepted
  task("A.2"); receipt("A.2", "passed", "approve"); attempt("A.2", "accepted");
  task("B"); receipt("B", "passed", "approve"); attempt("B", "validation_failed", "missing expected_outputs: src/x.ts"); attempt("B", "accepted");
  task("C"); receipt("C", "blocked", "changes_requested");            // blocked and dropped
  task("D"); receipt("D", "skipped", null); attempt("D", "validation_failed", "verification failed"); attempt("D", "blocked", "retry limit 2 exhausted");
  task("E"); receipt("E", "passed", "approve"); attempt("E", "blocked", "depends_on X: that task ended blocked"); // not the critic's to catch
  const [plan] = criticStats(db as never, "proj", 0, ["plan-critique"]);
  expect(plan).toMatchObject({ runs:5, approved:3, blocked:2, skipped:1, blockShare:40,
    afterBlock:{ fixedAndAccepted:1, sentAgainNotAccepted:0, dropped:1 },
    missed:{ count:1, examples:[{ taskId:"B" }] },
    firstTryAccepted:{ reviewed:{ tasks:3, share:33 }, notReviewed:{ tasks:1, share:0 } } });
});
