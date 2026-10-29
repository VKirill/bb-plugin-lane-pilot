import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { baselineMetrics, renderBaseline } from "../src/rooms/bench/baseline";
import { createAttempt, createRun, createTask, openDatabase } from "../src/rooms/storage";

// SMA conformance audit C-07: the map pointed «baseline metric bench» (k_lib_bench) at the weekly model bench (weekArm), which measures none
// of the card's three numbers. They are now read from the pipeline's own records, with no model.
function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h1', writer_workspace_path='/repo' WHERE id='run1'").run();
  const accepted = (id: string, expected: string[], changed: string[], merge: string | null) => {
    createTask(db, { id, runId: "run1", kind: "bb", contract: { id, expected_outputs: expected } });
    createAttempt(db, { id: `att-${id}`, runId: "run1", taskId: id });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted', updated_at=? WHERE id=?").run(Date.now() - 3_600_000, `att-${id}`);
    db.prepare("INSERT INTO lane_pilot_attempt_change(attempt_id,run_id,task_id,merge_commit,outcome,changed_json,recorded_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(`att-${id}`, "run1", id, merge, merge ? "merged" : null, JSON.stringify(changed.map((path) => ({ path, status: "M" }))), 1, 1);
  };
  accepted("good", ["src/a.ts"], ["src/a.ts"], "a".repeat(40));
  accepted("phantom", ["src/b.ts", "docs/"], ["docs/x.md"], "b".repeat(40));
  accepted("broke", ["src/c.ts"], ["app/src/c.ts"], "c".repeat(40));
  accepted("reverted", [], [], null);
  db.prepare("INSERT INTO lane_pilot_regression(found_at,updated_at,project_id,run_id,task_id,command,kind,bisect_status,culprit_task) VALUES (1,1,'projA','run1','other','npm test','regression','found','broke')").run();
  db.prepare("INSERT INTO lane_pilot_task_receipt(at,kind,project_id,run_id,task_id,state,summary) VALUES (1,'revert','projA','run1','reverted','merged','reverted')").run();
  createTask(db, { id: "good-mainfix", runId: "run1", kind: "bb", contract: { id: "good-mainfix" } });
  return db;
}

describe("the baseline metric bench", () => {
  it("[sma:k_lib_bench] measures false-done, phantom writes and git loss recoverability with no model", async () => {
    const db = world();
    const ran: string[] = [];
    const host = { run: async (_host: string, _cwd: string, command: string) => { ran.push(command); return { exitCode: 0, stdout: `ok ${"a".repeat(40)}\nok ${"b".repeat(40)}\nlost ${"c".repeat(40)}\n`, stderr: "" }; } };
    const m = await baselineMetrics(db as never, host);
    expect(m.accepted).toBe(4);
    // a regression with the task as culprit, a merged revert, a -mainfix made for it: three of four accepted tasks are contradicted.
    expect(m.falseDone).toMatchObject({ count: 3, rate: 0.75 });
    expect(m.falseDone.tasks.sort()).toEqual(["broke", "good", "reverted"]);
    // src/b.ts was promised and not changed; a nested project's path (app/src/c.ts) holds its output.
    expect(m.phantomWrites.attempts).toEqual([{ attemptId: "att-phantom", taskId: "phantom", missing: ["src/b.ts"] }]);
    expect(m.gitLoss).toMatchObject({ merged: 3, checked: 3, recoverable: 2, lost: ["c".repeat(40)] });
    expect(ran).toHaveLength(1);
    expect(renderBaseline(m)).toContain("false-done rate 75%");
  });

  it("checks no git without a host and says so", async () => {
    const m = await baselineMetrics(world() as never, null);
    expect(m.gitLoss).toMatchObject({ checked: 0, rate: null, unchecked: 3 });
  });
});
