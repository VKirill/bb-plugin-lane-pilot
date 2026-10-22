import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listAttemptsForTask, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { renderReturnNotes } from "../../src/rooms/stage-return";
import { createStageReturn } from "../../src/rooms/stage-return/server";
import { runReturnCli } from "../../src/rooms/stage-return/server";
import { takeReassignRequest } from "../../src/rooms/writer/server/reassign";

// The stop is confirmed by asking the thread until it is idle (30 s at most); a test decides the answer.
const stopAnswer = vi.hoisted(() => ({ stopped: true }));
vi.mock("../../src/rooms/runs/server/writer-stop", () => ({
  STOP_CONFIRM_MS: 30_000,
  confirmWriterStopped: async () => ({ stopped: stopAnswer.stopped, status: stopAnswer.stopped ? "idle" : "active", waitedMs: 0 }),
}));

const WORKSPACE = "/ws";
const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

const STAGES = ["pm-read", "plan-critique", "specialist-review", "writer-agent", "verification", "code-critique", "plan-fact", "acceptance-receipt"] as const;

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const stops: string[] = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  harness.sdk.stub("threads.stop", async (args: { threadId: string }) => { stops.push(args.threadId); return {}; });
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.send", async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return undefined; });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: contract("T1") });
  saveTaskPlan(db, "T1", "Plan for T1");
  const enqueueResumedWriter = vi.fn(async () => true);
  const services = {
    activeWriterTasks: new Set<string>(), enqueueResumedWriter, rollback: { noteStopped: async () => undefined }, startWriterTask: vi.fn(),
  } as unknown as Services;
  const api = createStageReturn(ctx, services).stageReturn;
  return { bb, db, ctx, stops, sent, api, enqueueResumedWriter, services };
}

/** Every stage of the task's chain with the given states (a stage not named is passed). */
function receipts(db: ReturnType<typeof openDatabase>, states: Partial<Record<(typeof STAGES)[number], "passed" | "failed" | "pending" | "running" | "skipped">>) {
  for (const stage of STAGES) {
    const state = states[stage] ?? "passed";
    if (state === "pending") recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state: "pending", input: "Plan for T1" });
    else if (state === "running") { recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state: "pending", input: "Plan for T1" }); recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state: "running", input: "Plan for T1" }); }
    else {
      recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state: "pending", input: "Plan for T1" });
      if (state !== "skipped") recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state: "running", input: "Plan for T1" });
      recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state, input: "Plan for T1", reason: state === "failed" ? "boom" : null });
    }
  }
}
const stateOf = (db: ReturnType<typeof openDatabase>, stage: string) => listStageReceipts(db, "run1", "T1").find((row) => row.stageId === stage);

function running(db: ReturnType<typeof openDatabase>, id = "T1-a1", threadId = "thr_w") {
  createAttempt(db, { id, runId: "run1", taskId: "T1" });
  transitionAttempt(db, id, "spawn_requested");
  setAttemptWorkspace(db, id, { path: "/wt/T1", environmentId: null, decision: {} });
  transitionAttempt(db, id, "running", { threadId });
}

describe("return to an earlier stage", () => {
  it("refuses an empty note, an unknown task, an accepted task and a canceled one, and records nothing", async () => {
    const env = setup();
    receipts(env.db, {});
    expect(await env.api.returnTask({ ref: "T1", to: "planning", note: "  " })).toMatchObject({ ok: false, state: "refused" });
    expect(await env.api.returnTask({ ref: "nope", to: "planning", note: "x" })).toMatchObject({ ok: false, state: "refused" });
    running(env.db);
    transitionAttempt(env.db, "T1-a1", "accepted");
    const accepted = await env.api.returnTask({ ref: "T1", to: "writer", note: "x" });
    expect(accepted).toMatchObject({ ok: false, state: "refused" });
    expect(accepted.next).toContain("revert");
    expect(env.api.status("T1").returns).toEqual([]);
    expect(env.sent).toEqual([]);
  });

  it("planning: stops the running attempt (exit confirmed), resets the stale receipts and keeps the earlier ones, and gives the PM the note word for word", async () => {
    const env = setup();
    receipts(env.db, { "writer-agent": "running", verification: "pending", "code-critique": "pending", "plan-fact": "pending", "acceptance-receipt": "pending" });
    running(env.db);
    const result = await env.api.returnTask({ ref: "T1", to: "planning", note: "The owner wants the export as CSV, not JSON.", by: "owner" });
    expect(result).toMatchObject({ ok: true, state: "handed_to_pm", from: "plan-critique" });
    expect(result.reused).toEqual(["pm-read"]);
    expect(result.stale?.map((row) => row.stage)).toEqual(["plan-critique", "specialist-review", "writer-agent", "verification", "code-critique", "plan-fact", "acceptance-receipt"]);
    expect(env.stops).toEqual(["thr_w"]);
    expect(getAttempt(env.db, "T1-a1")?.state).toBe("canceled");
    // reused stays passed, the stale ones that had ended are pending with the reason
    expect(stateOf(env.db, "pm-read")?.state).toBe("passed");
    expect(stateOf(env.db, "plan-critique")).toMatchObject({ state: "pending", reason: expect.stringContaining("stale: returned to planning") });
    expect(stateOf(env.db, "specialist-review")?.state).toBe("pending");
    // the PM has the note, the stale and kept stages, and what to do
    expect(env.sent).toHaveLength(1);
    expect(env.sent[0]!.threadId).toBe("thr_pm");
    expect(env.sent[0]!.text).toContain("The owner wants the export as CSV, not JSON.");
    expect(env.sent[0]!.text).toContain("Stale receipts: plan-critique, specialist-review");
    expect(env.sent[0]!.text).toContain("Kept: pm-read");
    expect(env.sent[0]!.text).toContain("lane_pilot_update_task");
    // the intervention is on record
    expect(env.api.status("T1").returns).toMatchObject([{ to: "planning", by: "owner", note: "The owner wants the export as CSV, not JSON.", state: "handed_to_pm", from: "plan-critique" }]);
  });

  it("discussion: every stage of the task is stale, nothing is reused", async () => {
    const env = setup();
    receipts(env.db, { "acceptance-receipt": "failed" });
    running(env.db);
    transitionAttempt(env.db, "T1-a1", "validation_failed", { reason: "verification failed (npm test): boom" });
    const result = await env.api.returnTask({ ref: "T1", to: "discussion", note: "Different product: drop the export." });
    expect(result).toMatchObject({ ok: true, state: "handed_to_pm", from: "pm-read", reused: [] });
    expect(result.stale).toHaveLength(8);
    expect(env.stops).toEqual([]);
    expect(stateOf(env.db, "pm-read")?.state).toBe("pending");
    expect(env.sent[0]!.text).toContain("Talk it over with the owner again");
  });

  it("writer, running: replaces the writer by a fresh one in the same worktree (no attempt spent) and carries the note", async () => {
    const env = setup();
    receipts(env.db, { "writer-agent": "running", verification: "pending", "code-critique": "pending", "plan-fact": "pending", "acceptance-receipt": "pending" });
    running(env.db);
    // the loop's next writer, a moment after the stop
    setTimeout(() => {
      createAttempt(env.db, { id: "T1-a2", runId: "run1", taskId: "T1" });
      transitionAttempt(env.db, "T1-a2", "spawn_requested");
      transitionAttempt(env.db, "T1-a2", "running", { threadId: "thr_new" });
    }, 100);
    const result = await env.api.returnTask({ ref: "T1", to: "writer", note: "Use the existing csv helper in lib/csv.ts." });
    expect(result).toMatchObject({ ok: true, state: "restarted", restarted: { by: "writer", threadId: "thr_new" } });
    expect(result.reused).toEqual(["pm-read", "plan-critique", "specialist-review"]);
    expect(env.stops).toEqual(["thr_w"]);
    const request = await takeReassignRequest(env.bb.storage.kv as never, "T1-a1");
    expect(request?.reason).toContain("Use the existing csv helper in lib/csv.ts.");
    expect(env.sent[0]!.text).toContain("returned task T1 to the writer");
    // the note is what the next brief carries
    const notes = renderReturnNotes(env.api.status("T1").returns);
    expect(notes).toContain("Use the existing csv helper in lib/csv.ts.");
    expect(notes).toContain('stage="writer"');
  });

  it("writer, not running: a failed task gets a new attempt from the writer stage, with its judging stages reset", async () => {
    const env = setup();
    receipts(env.db, { verification: "failed", "code-critique": "skipped", "plan-fact": "skipped", "acceptance-receipt": "skipped" });
    running(env.db);
    transitionAttempt(env.db, "T1-a1", "validation_failed", { reason: "verification failed (npm test): boom" });
    const result = await env.api.returnTask({ ref: "T1", to: "writer", note: "The test is wrong, fix the test too." });
    expect(result).toMatchObject({ ok: true, state: "restarted", from: "writer-agent" });
    expect(result.reused).toEqual(["pm-read", "plan-critique", "specialist-review"]);
    expect(env.enqueueResumedWriter).toHaveBeenCalledTimes(1);
    expect(listAttemptsForTask(env.db, "run1", "T1")).toHaveLength(2);
    expect(stateOf(env.db, "verification")).toMatchObject({ state: "pending" });
    expect(stateOf(env.db, "writer-agent")?.state).toBe("pending");
    expect(stateOf(env.db, "pm-read")?.state).toBe("passed");
  });

  it("writer, a task whose attempt is queued: the note is on record for its first brief and nothing is stopped", async () => {
    const env = setup();
    receipts(env.db, { "writer-agent": "pending", verification: "pending", "code-critique": "pending", "plan-fact": "pending", "acceptance-receipt": "pending" });
    createAttempt(env.db, { id: "T1-a1", runId: "run1", taskId: "T1" });
    const result = await env.api.returnTask({ ref: "T1-a1", to: "writer", note: "Mind the cache." });
    expect(result).toMatchObject({ ok: true, state: "restarted" });
    expect(env.stops).toEqual([]);
    expect(renderReturnNotes(env.api.status("T1").returns)).toContain("Mind the cache.");
  });

  it("a stop that is not observed fails the return and says so, the note stays on record", async () => {
    const env = setup();
    receipts(env.db, {});
    running(env.db);
    stopAnswer.stopped = false;
    const result = await env.api.returnTask({ ref: "T1", to: "planning", note: "Change of plan." });
    stopAnswer.stopped = true;
    expect(result).toMatchObject({ ok: false, state: "failed" });
    expect(result.reason).toContain("could not be stopped");
    expect(env.api.status("T1").returns).toMatchObject([{ state: "failed", note: "Change of plan." }]);
    expect(env.sent).toEqual([]);
  });
});

describe("bb lane-pilot return", () => {
  it("reads --to and a --note that runs to the next flag, and refuses a stage it does not know", async () => {
    const env = setup();
    receipts(env.db, { "acceptance-receipt": "failed" });
    running(env.db);
    transitionAttempt(env.db, "T1-a1", "validation_failed", { reason: "verification failed (npm test): boom" });
    const bad = await runReturnCli(env.api, "return", ["T1", "--to", "later", "--note", "x"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("usage");
    const ok = await runReturnCli(env.api, "return", ["T1", "--to", "planning", "--note", "use", "the", "csv", "helper"]);
    expect(ok.exitCode).toBe(0);
    expect(JSON.parse(ok.stdout!)).toMatchObject({ ok: true, to: "planning", state: "handed_to_pm" });
    expect(env.sent[0]!.text).toContain("use the csv helper");
    const list = await runReturnCli(env.api, "returns", ["T1"]);
    expect(JSON.parse(list.stdout!).returns).toHaveLength(1);
    const empty = await runReturnCli(env.api, "return", ["T1", "--to", "writer"]);
    expect(empty.exitCode).toBe(1);
  });
});
