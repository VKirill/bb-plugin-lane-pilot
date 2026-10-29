import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runPlanCritique, runPmRead } from "../src/rooms/critique/server/critique-runs";
import { recordStage, resetHelperStages } from "../src/rooms/runs/server/stage-records";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveProjectSetting } from "../src/rooms/storage";

// 2026-10-29 audit (lane-pilot-roast F-001, F-003): quick paid the catalog and the coverage scan for a critic it skipped; pm-read
// handed back the summary of the old read_first; a resumed dispatch bought a passed plan critique again. A receipt also kept the
// hash of its first input forever (saveStageReceipt did not update input_sha256), so no reuse by input could ever match.
const task = { schema_version:2, id:"t1", title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:["new.ts"], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[], objective:"write", acceptance:["file exists"], verify:"none", verification:[] } as never;
const config = { projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo", pmProviderId:"codex", pmModel:"test-model", writerProviderId:"codex", writerModel:"test-model" } as never;
const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0)) await dispose(); });

function world() {
  const calls: string[] = [];
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{
    providers:{ list:async () => { calls.push("providers.list"); return [{ id:"codex", available:true, capabilities:{ supportsServiceTier:false }, serviceTiers:[] }]; },
      models:async () => { calls.push("providers.models"); return { models:[{ id:"test-model", model:"test-model", supportedReasoningEfforts:[{ reasoningEffort:"medium" }] }] }; } },
    threads:{ send:async () => ({}) },
    files:{ write:async () => ({}), read:async () => { calls.push("files.read"); return { content:"tiny", contentEncoding:"utf8" }; } },
  } as never });
  bb.hosts.experimental_client = (() => ({ call:async (method: string) => { calls.push(method); return method === "inspectCritiqueCoverage" ? { status:"complete", pathCount:1, findings:[] } : {}; } })) as never;
  const db = openDatabase(bb);
  createRun(db, "r", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"r", kind:"bb", contract:task });
  createAttempt(db, { id:"a", runId:"r", taskId:"t1" });
  disposals.push(() => harness.lifecycle.dispose());
  return { bb, db, calls };
}

describe("helper stages decide before they prepare, and reuse only a receipt of the same input", () => {
  it("quick skips the plan critique without asking the provider catalog or scanning coverage", async () => {
    const w = world();
    const result = await runPlanCritique({ ...w, projectId:"P", runId:"r", taskId:"t1", config, task:{ ...(task as object), quality_mode:"quick" } as never, plan:"write note" });
    expect(result.allowed).toBe(true);
    expect(w.calls).toEqual([]);
    expect(listStageReceipts(w.db, "r", "t1").find((row) => row.stageId === "plan-critique")?.reason).toBe("quality_mode_quick");
  });

  it("pm-read reads again when read_first changed, and reuses the receipt of the same input", async () => {
    const w = world();
    saveProjectSetting(w.db, "P", "pm_read.enabled", true);
    for (const state of ["pending", "running", "passed"] as const) recordStage(w.db, { runId:"r", taskId:"t1", stageId:"pm-read", input:"old-input", state, ...(state === "passed" ? { result:{ summary:"OLD SUMMARY" } } : {}) });
    const fresh = await runPmRead({ ...w, projectId:"P", runId:"r", taskId:"t1", pmThreadId:"pm", config, task });
    expect(fresh.summary).not.toBe("OLD SUMMARY");
    expect(w.calls).toContain("files.read");
    w.calls.length = 0;
    const again = await runPmRead({ ...w, projectId:"P", runId:"r", taskId:"t1", pmThreadId:"pm", config, task });
    expect(again.state).toBe(fresh.state);
    expect(w.calls).toEqual([]);
  });

  it("a plan critique that passed on the same input is reused, not run again (before: illegal stage transition passed -> pending)", async () => {
    const w = world();
    await runPlanCritique({ ...w, projectId:"P", runId:"r", taskId:"t1", config, task, plan:"write note" });
    w.db.prepare("UPDATE lane_pilot_stage_receipt SET state='passed', result_json=? WHERE run_id='r' AND task_id='t1' AND stage_id='plan-critique'").run(JSON.stringify({ decision:"approve" }));
    const again = await runPlanCritique({ ...w, projectId:"P", runId:"r", taskId:"t1", config, task, plan:"write note" });
    expect(again).toEqual({ allowed:true, critique:{ decision:"approve" } });
  });

  // SMA audit N-06: an advisory «changes requested» is stored as passed; the reuse handed it back as allowed after the project switched to gate.
  it("a kept advisory «changes requested» blocks once the project gates", async () => {
    const w = world();
    saveProjectSetting(w.db, "P", "plan_critique.mode", "advisory");
    await runPlanCritique({ ...w, projectId:"P", runId:"r", taskId:"t1", config, task, plan:"write note" });
    w.db.prepare("UPDATE lane_pilot_stage_receipt SET state='passed', result_json=? WHERE run_id='r' AND task_id='t1' AND stage_id='plan-critique'").run(JSON.stringify({ decision:"changes_requested", mode:"advisory", summary:"fix the boundary" }));
    saveProjectSetting(w.db, "P", "plan_critique.mode", "gate");
    const again = await runPlanCritique({ ...w, projectId:"P", runId:"r", taskId:"t1", config, task, plan:"write note" });
    expect(again.allowed).toBe(false);
    expect(again.reason).toBeTruthy();
  });

  // SMA audit R-06: a kept advisory approval with a structural error was reused under a gate that blocks the same input without it.
  it("a structural error blocks under a gate even over a kept advisory approval", async () => {
    const w = world();
    const bad = { ...(task as Record<string, unknown>), expected_outputs:["src/outside.ts"] } as never;
    saveProjectSetting(w.db, "P", "plan_critique.mode", "advisory");
    await runPlanCritique({ ...w, projectId:"P", runId:"r", taskId:"t1", config, task:bad, plan:"write note" });
    const receipt = listStageReceipts(w.db, "r", "t1").find((row) => row.stageId === "plan-critique")!;
    expect((receipt.result as { structuralFindings: Array<{ severity: string }> }).structuralFindings.some((row) => row.severity === "error")).toBe(true);
    w.db.prepare("UPDATE lane_pilot_stage_receipt SET state='passed', result_json=? WHERE run_id='r' AND task_id='t1' AND stage_id='plan-critique'").run(JSON.stringify({ ...(receipt.result as object), decision:"approve", mode:"advisory" }));
    saveProjectSetting(w.db, "P", "plan_critique.mode", "gate");
    const cached = await runPlanCritique({ ...w, projectId:"P", runId:"r", taskId:"t1", config, task:bad, plan:"write note" });
    expect(cached).toMatchObject({ allowed:false, reason:"structural_plan_critique_blocked" });
  });

  it("resetHelperStages keeps a passed plan critique and specialist review and drops the rest", async () => {
    const w = world();
    for (const stageId of ["plan-critique", "specialist-review", "pm-read"] as const) {
      for (const state of ["pending", "running", stageId === "pm-read" ? "failed" : "passed"] as const) recordStage(w.db, { runId:"r", taskId:"t1", stageId, input:"same", state });
    }
    await resetHelperStages(w.db, async () => undefined, { runId:"r", taskId:"t1" });
    expect(listStageReceipts(w.db, "r", "t1").map((row) => row.stageId).sort()).toEqual(["plan-critique", "specialist-review"]);
  });
});
