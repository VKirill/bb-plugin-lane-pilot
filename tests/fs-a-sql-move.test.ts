// fs-a regressions: moved SQL must keep the old result shape and the old failure behaviour.
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { openDatabase, createRun, createTask, createAttempt, saveStageReceipt, transitionAttempt } from "../src/rooms/plugin-db";
import { readHubRows } from "../src/rooms/platform/server/hub";
import { recheckPlanFact } from "../src/rooms/writer/server/plan-fact";

const task = (id: string) => ({ schema_version: 2 as const, id, title: id, risk: "low" as const, lane: "writer" as const, project_cwd: "/x", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: [], owns_paths: [`${id}/`], never_touch: [], depends_on: [], objective: id, acceptance: [id], verify: "x", verification: [] });

function hubDb() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

describe("moved SQL keeps the old behaviour", () => {
  it("hub row stored as the JSON string \"1\" reads back as \"1\" (no double parse)", () => {
    const db = hubDb();
    db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,?,?)")
      .run(GLOBAL_SETTINGS_PROJECT_ID, "", "writer.model", JSON.stringify("1"), 1, Date.now());
    expect(readHubRows(db, ["writer.model"]).get("writer.model")?.value).toBe("1");
  });

  it("recheckPlanFact runs past a \"{\" sibling receipt (column-only read)", async () => {
    const db = hubDb();
    createRun(db, "run-1", "proj-1");
    createTask(db, { id: "t1", runId: "run-1", kind: "bb", contract: task("t1") });
    saveStageReceipt(db, { runId: "run-1", taskId: "t1", stageId: "plan-fact", contractVersion: 1, state: "failed",
      inputSha256: "i", outputSha256: null, attempt: 1, providerId: null, model: null, threadId: null,
      result: { rules: 99 }, reason: "r", updatedAt: 1 });
    db.prepare("INSERT INTO lane_pilot_stage_receipt(run_id,task_id,stage_id,contract_version,state,input_sha256,output_sha256,attempt,provider_id,model,thread_id,result_json,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run("run-1", "t1", "verification", 1, "running", "i", null, 1, null, null, null, "{", null, 1);
    const state = await recheckPlanFact({ db } as never, { projectId: "proj-1", runId: "run-1", taskId: "t1", hostId: "h" });
    expect(state).toBeNull();
  });
});
