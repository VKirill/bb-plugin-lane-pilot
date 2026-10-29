import { describe, expect, it } from "vitest";
import { runRecords, workflowFinish } from "@lane-pilot/workflow-engine";
import { journalDb, wf } from "./engine-helpers";

describe("business outcome", () => {
  it("F-004: a blocked emit does not increase the completed-work rate, and an escalation stays separate", () => {
    expect(workflowFinish({ status: "closed" }, null)).toMatchObject({ ok: true, kind: "done" });
    expect(workflowFinish({ status: "blocked" }, null)).toMatchObject({ ok: false, kind: "refused" });
    expect(workflowFinish({ status: "proposed" }, null)).toMatchObject({ ok: false, kind: "escalated" });
    expect(workflowFinish({ status: "partial" }, null)).toMatchObject({ ok: false, kind: "incomplete" });

    const db = journalDb();
    const def = JSON.stringify(wf());
    const insert = (id: string, status: string, output: unknown) => db.prepare(
      "INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,status,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(id, "issue-quick", 1, "x", def, status, output === null ? null : JSON.stringify(output), 1, 1);
    insert("closed", "succeeded", { status: "closed" });
    insert("blocked", "succeeded", { status: "blocked" });
    insert("proposed", "succeeded", { status: "proposed" });
    insert("partial", "succeeded", { status: "partial" });
    expect(runRecords(db).get("issue-quick")).toEqual({
      succeeded: 1, failed: 2, lastRunAt: 1, executed: 4, workDone: 1, refused: 1, escalated: 1,
    });
  });
});
