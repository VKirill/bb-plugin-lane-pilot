import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createAttempt, createRun, openDatabase } from "../src/database";
import { familyFailureRecord } from "../src/server/writer/start";
import { repeatedFailureReason, taskFamily } from "../src/failure-class";

describe("a task family's earlier failure stops a redispatch that fails the same way", () => {
  it("seeds the repeated-failure check from the family's earlier attempts", () => {
    const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    const attempt = (id:string, task:string, state:string, reason:string|null, at:number) => {
      createAttempt(db, { id, runId:"run", taskId:task });
      db.prepare("UPDATE lane_pilot_attempt SET state=?, reason=?, created_at=? WHERE id=?").run(state, reason, at, id);
    };
    attempt("a1", "P1", "validation_failed", "verification failed (npm run typecheck): error TS2345", 1);
    expect(familyFailureRecord(db, "run", "P1")).toBeNull();
    // The redispatch «P1.2» and the mainfix «P1-mainfix.2» are of the same family as «P1».
    expect(familyFailureRecord(db, "run", "P1.2")).toEqual({ state:"validation_failed", reason:"verification failed (npm run typecheck): error TS2345" });
    expect(familyFailureRecord(db, "run", "P1-mainfix.2")).toEqual({ state:"validation_failed", reason:"verification failed (npm run typecheck): error TS2345" });
    attempt("a2", "P2", "validation_failed", "verification failed (npm run typecheck): error TS2345", 2);
    expect(familyFailureRecord(db, "run", "P1.2")).toEqual({ state:"validation_failed", reason:"verification failed (npm run typecheck): error TS2345" });
    attempt("a3", "P1.2", "validation_failed", "verification failed (npm run typecheck): error TS9999", 3);
    expect(familyFailureRecord(db, "run", "P1.3")).toEqual({ state:"validation_failed", reason:"verification failed (npm run typecheck): error TS9999" });
    // Only charged failure states seed the stop; accepted work never does.
    attempt("a4", "P1.3", "accepted", null, 4);
    expect(familyFailureRecord(db, "run", "P1.4")).toEqual({ state:"validation_failed", reason:"verification failed (npm run typecheck): error TS9999" });
  });

  it("blocks the family's second identical failure and keeps a different one going", () => {
    const earlier = familyFailureRecordOf("validation_failed", "verification failed (npm run typecheck): error TS2345 in thr_a at line 3");
    expect(repeatedFailureReason(earlier, { state:"validation_failed", reason:"verification failed (npm run typecheck): error TS2345 in thr_b at line 5" }))
      .toMatch(/^repeated_failure: verification failed \(npm run typecheck\)/);
    expect(repeatedFailureReason(earlier, { state:"validation_failed", reason:"verification failed (npm run vitest): other" })).toBeNull();
    expect(taskFamily("P1-mainfix.2")).toBe("P1");
  });
});

function familyFailureRecordOf(state:string, reason:string) {
  return { state, reason };
}
