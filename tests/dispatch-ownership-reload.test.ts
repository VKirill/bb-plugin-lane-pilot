import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import type { ServerCore } from "../src/rooms/contracts/server";
import { parsePmReadSettings } from "../src/rooms/critique/pm-read";
import { createAttempt, createRun, createTask, getAttempt, getTaskGitBase, listAttemptsForTask, listStageReceipts, openDatabase,
  saveTaskGitBase, saveTaskPlan, setRunThread, transitionAttempt } from "../src/rooms/plugin-db";
import { DISPATCH_STAGES_PENDING } from "../src/rooms/runs/constants";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { createReconcile } from "../src/rooms/stability/server/reconcile";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { createWriterDispatch } from "../src/rooms/writer/server/dispatch";
import { registerDispatchExecutors } from "../src/rooms/writer/server/dispatch-workflow";
import incident from "./fixtures/dispatch-ownership-reload-2026-11-08.json";

async function world(stop: string | null = null) {
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ files:{ write:async () => ({ ok:true }) } } });
  const db = openDatabase(bb);
  const { projectId, pmThreadId, plan } = incident;
  const { run_id:runId, task_id:taskId, id:attemptId } = incident.attempt;
  const task = incident.task as TaskV2;
  const config = { projectId, hostId:"fixture-host", pmWorkspacePath:task.project_cwd, writerWorkspacePath:task.project_cwd,
    pmProviderId:"codex", pmModel:"fixture", writerProviderId:"codex", writerModel:"fixture" } as PrototypeConfig;
  createRun(db, runId, projectId, "cli", task.project_cwd);
  setRunThread(db, runId, pmThreadId);
  createTask(db, { id:taskId, runId, kind:"bb", contract:task });
  saveTaskPlan(db, taskId, plan);
  createAttempt(db, { id:attemptId, runId, taskId });
  transitionAttempt(db, attemptId, "queued", { reason:DISPATCH_STAGES_PENDING });
  // The real refusal proves this row existed; the SHAs are synthetic, not recovered hub data.
  saveTaskGitBase(db, taskId, { baseRef:"main", baseSha:"a".repeat(40), initialHeadSha:"a".repeat(40), branch:"main", compareCommitted:true });
  const originalBase = getTaskGitBase(db, taskId);
  const settings = { "pm_read.enabled":true, "plan_critique.enabled":false };
  const source = JSON.stringify({ taskId, readFirst:task.read_first, settings:parsePmReadSettings(settings) });
  for (const state of ["pending", "running", "passed"] as const) {
    recordStage(db, { runId, taskId, stageId:"pm-read", state, input:source, attempt:1,
      ...(state === "passed" ? { result:incident.pmReadResult } : {}) });
  }
  for (const receipt of incident.timeline.receipts.filter((row) => row.stageId !== "pm-read")) {
    const stageId = receipt.stageId as Parameters<typeof recordStage>[1]["stageId"];
    recordStage(db, { runId, taskId, stageId, state:"pending", input:plan });
    // Only the state before recovery: the three writer stages were still pending.
    if (receipt.state === "skipped") recordStage(db, { runId, taskId, stageId, state:"skipped", input:plan, reason:receipt.reason });
  }
  db.prepare(`INSERT INTO lane_pilot_wf_run(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,
    status,reason,inputs_json,created_at,updated_at) VALUES(? ,?,'lp-task-pipeline',1,'fixture','{}',?,?,?,?,'interrupted','interrupted_by_reload',?,?,?)`)
    .run("interrupted-pipeline", `lp-task:${attemptId}`, projectId, runId, taskId, attemptId,
      JSON.stringify({ taskId, attemptId, baseRef:"main" }), incident.attempt.created_at, incident.attempt.updated_at);
  const engine = new WorkflowEngine({ db, harnessVersion:"fixture", resolveWorkflow:builtinWorkflow });
  registerDispatchExecutors(engine, bb);
  engine.register("lp.qa-gate", { reentrant:true, run:async () => ({ output:{ run:false } }) });
  const baseline = vi.fn(async () => ({ stop, record:stop ? null : { checks:[] } }));
  const startWriterTask = vi.fn();
  const call = vi.fn(async (method: string) => method === "gitOwnershipBase"
    ? { status:"ready", baseRef:"main", baseSha:"b".repeat(40), headSha:"b".repeat(40), branch:"main", compareCommitted:true }
    : { exitCode:0, stdout:"", stderr:"" });
  const ctx = { bb, db, host:{ call }, configForRun:async () => config, refreshRun:() => {}, isDisposed:() => false } as unknown as ServerCore;
  const services = { workflowEngine:engine, stageHelperSettings:async () => settings, isLiveFolder:async () => false,
    baseline:{ preflight:baseline }, startWriterTask } as unknown as Parameters<typeof createWriterDispatch>[1];
  const { resumeDispatch } = createWriterDispatch(ctx, services);
  const reconcile = createReconcile(ctx, { resumeDispatch, startWriterTask } as unknown as Parameters<typeof createReconcile>[1]);
  const pipeline = () => {
    const row = db.prepare("SELECT id FROM lane_pilot_wf_run WHERE idem_key=?").get(`lp-task:${attemptId}:resume-1`) as { id:string } | undefined;
    return row ? engine.get(row.id) : null;
  };
  return { db, harness, reconcile, baseline, startWriterTask, originalBase, runId, taskId, attemptId, pipeline };
}

describe("armor-fit-1: reload after ownership capture, before the writer (2026-11-08)", () => {
  it("resumes the same attempt through baseline, retains the first base even if HEAD moved, and starts one writer", async () => {
    const w = await world();
    try {
      expect(await w.reconcile.resumeOrphans(incident.projectId)).toMatchObject({ resumed:[w.attemptId], skipped:[] });
      await vi.waitFor(() => expect(w.pipeline()?.status).toBe("waiting"));
      expect(w.baseline).toHaveBeenCalledOnce();
      expect(w.startWriterTask).toHaveBeenCalledOnce();
      expect(w.startWriterTask).toHaveBeenCalledWith(expect.objectContaining({ firstAttemptId:w.attemptId, taskId:w.taskId,
        pmReadContext:expect.stringContaining(incident.pmReadResult.summary) }));
      expect(getTaskGitBase(w.db, w.taskId)).toEqual(w.originalBase);
      expect(getAttempt(w.db, w.attemptId)).toMatchObject({ state:"queued", reason:null });
      expect(listAttemptsForTask(w.db, w.runId, w.taskId)).toHaveLength(1);
      expect(listStageReceipts(w.db, w.runId, w.taskId).find((row) => row.stageId === "pm-read"))
        .toMatchObject({ state:"passed", result:incident.pmReadResult });
    } finally { await w.harness.lifecycle.dispose(); }
  });

  it("still blocks before any writer if the resumed baseline rejects the task", async () => {
    const reason = "verdict_block: no_red_on_base: fixture check is green on the base";
    const w = await world(reason);
    try {
      expect(await w.reconcile.resumeOrphans(incident.projectId)).toMatchObject({ resumed:[w.attemptId] });
      await vi.waitFor(() => expect(w.pipeline()?.status).toBe("succeeded"));
      expect(w.baseline).toHaveBeenCalledOnce();
      expect(w.startWriterTask).not.toHaveBeenCalled();
      expect(getAttempt(w.db, w.attemptId)).toMatchObject({ state:"blocked", reason });
      expect(getTaskGitBase(w.db, w.taskId)).toEqual(w.originalBase);
    } finally { await w.harness.lifecycle.dispose(); }
  });
});
