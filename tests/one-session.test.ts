import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import { afterEach, expect, it, vi } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { countChargedAttempts, createAttempt, createRun, createTask, getAttempt, latestTaskAttemptState, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { SESSION_MAX_MS, SESSION_MAX_TURNS, failureClass } from "../src/rooms/runs/failure-class";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { createWriterDispatch } from "../src/rooms/writer/server/dispatch";
import { retryInSameThread } from "../src/rooms/writer/server/sticky";
import { createWriterStart } from "../src/rooms/writer/server/start";
import { createWriterUpdateTask } from "../src/rooms/writer/server/update-task";
import { classifyWriterOutput } from "../src/rooms/tasks/validate-output";

const WORKSPACE = "/ws";
const WORKTREE = "/ws/wt";

const contract = (id = "T1", dependsOn: string[] = []): TaskV2 => ({
  schema_version:2, id, title:`Task ${id}`, risk:"low", lane:"writer", project_cwd:WORKSPACE, read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["a.txt"], owns_paths:[`${id}/**`, "a.txt"], never_touch:[], depends_on:dependsOn,
  objective:`Make ${id}`, acceptance:["done"], verify:"tests", verification:[{ command:"npm test", cwd:WORKSPACE }],
});

const config: PrototypeConfig = { projectId:"proj1", hostId:"h1", pmWorkspacePath:WORKSPACE, writerWorkspacePath:WORKSPACE,
  pmProviderId:"p", pmModel:"pm", writerProviderId:"p", writerModel:"wm" };

type Send = { threadId:string; input:Array<{ text:string }> };
type Step = { accept?:true; reason?:string; diff?:string; advanceMs?:number };

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
  const sends: Send[] = [];
  harness.sdk.stub("threads.get", async (args:{ threadId:string }) => ({ id:args.threadId, status:"idle" }));
  harness.sdk.stub("threads.send", async (args:unknown) => { sends.push(args as Send); return undefined; });
  harness.sdk.stub("threads.context", async () => ({ usage:null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role:"pm", lanePilotRunId:"run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  return { bb, harness, db, ctx, sends };
}

/** Services whose writer follows `script`: one step per finished turn (a failure or an acceptance). */
function services(db:ReturnType<typeof openDatabase>, script:Step[]) {
  let turn = 0;
  const spawned: string[] = [];
  const base = {
    activeWriterTasks:new Set<string>(),
    providerBreaker:{ record:() => undefined },
    ...noOptionalPlugins,
    runBudgetFor:() => ({ check:() => ({ ok:true }), noteAttempt:() => undefined, noteTokens:() => undefined, snapshot:() => ({ limits:{} }) }),
    runWriterPool:{ acquire:async () => () => undefined },
    stability:{ breakerHolds:() => null, diskHolds:async () => null, onTaskFailed:async () => false, loadParked:async () => [] },
    maintainMemoryAfterAcceptance:() => undefined,
    maintainProjectLifeAfterAcceptance:() => undefined,
    workspaceDirt:async () => ({ ok:true, paths:[], snapshots:[] }),
    isLiveFolder:async () => false,
    spawnWriterAttempt:async (input:{ attemptId:string }) => {
      spawned.push(input.attemptId);
      setAttemptWorkspace(db, input.attemptId, { path:WORKTREE, environmentId:null, decision:{} });
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId:"thr_w" });
      return { ok:true, threadId:"thr_w", providerId:"p", model:"wm", dirtBefore:[], workspacePath:WORKTREE };
    },
    finishWriterAttempt:async (input:{ attemptId:string; writerThreadId:string }) => {
      const step = script[turn++] ?? { reason:"verification failed (npm test): boom", diff:`d${turn}` };
      if (step.advanceMs) clock += step.advanceMs;
      if (step.accept) { transitionAttempt(db, input.attemptId, "accepted"); return { status:"accepted", produced:["a.txt"], verification:[] }; }
      const reason = step.reason ?? "verification failed (npm test): boom";
      transitionAttempt(db, input.attemptId, "validation_failed", { reason });
      return { status:"validation_failed", reason, produced:["a.txt"], attemptId:input.attemptId, writerThreadId:input.writerThreadId,
        verification:[{ command:"npm test", exitCode:1, stdout:"", stderr:"AssertionError: boom" }],
        checkLogPath:".agents/plans/items/T1/logs/npm-test.log", diffKey:step.diff ?? `d${turn}` };
    },
  };
  const all = base as unknown as Services;
  return { all, spawned };
}

let clock = 0;
afterEach(() => { vi.restoreAllMocks(); });

function start(env:ReturnType<typeof setup>, svc:Services, taskId = "T1", dependsOn: string[] = []) {
  const task = contract(taskId, dependsOn);
  createTask(env.db, { id:taskId, runId:"run1", kind:"bb", contract:task });
  saveTaskPlan(env.db, taskId, `Plan for ${taskId}`);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
    recordStage(env.db, { runId:"run1", taskId, stageId, state:"pending", input:`Plan for ${taskId}` });
  }
  createAttempt(env.db, { id:`${taskId}-a1`, runId:"run1", taskId });
  Object.assign(svc, createWriterStart(env.ctx, svc));
  svc.startWriterTask({ projectId:"proj1", runId:"run1", taskId, firstAttemptId:`${taskId}-a1`, pmThreadId:"thr_pm", config, task, plan:`Plan for ${taskId}` });
}

const writerStage = (db:ReturnType<typeof openDatabase>, taskId = "T1") => listStageReceipts(db, "run1", taskId).find((row) => row.stageId === "writer-agent")!;

// 1. One writer session per task.

it("sends a failed check back to the same writer thread as a feedback turn, with the log path, and charges one attempt", async () => {
  const env = setup();
  // The same failure twice, but the writer's diff changes between turns, so the session goes on to acceptance.
  const { all, spawned } = services(env.db, [{ diff:"d1" }, { diff:"d2" }, { accept:true }]);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(spawned).toEqual(["T1-a1"]);
  expect(env.sends.map((send) => send.threadId)).toEqual(["thr_w", "thr_w"]);
  const turn = env.sends[0]!.input[0]!.text;
  expect(turn).toContain("Lane Pilot did not accept your last answer");
  expect(turn).toContain("Result: validation_failed: verification failed (npm test): boom");
  expect(turn).toContain("full log: .agents/plans/items/T1/logs/npm-test.log");
  expect(countChargedAttempts(env.db, "run1", "T1")).toBe(1);
  expect((writerStage(env.db).result as { turns?:number }).turns).toBe(3);
  await env.harness.lifecycle.dispose();
});

it(`stops at ${SESSION_MAX_TURNS} turns with the last reason and starts no other writer`, async () => {
  const env = setup();
  const { all, spawned } = services(env.db, Array.from({ length:8 }, (_, index) => ({ diff:`d${index}` })));
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
  expect(spawned).toHaveLength(1);
  expect(env.sends).toHaveLength(SESSION_MAX_TURNS - 1);
  const last = getAttempt(env.db, `T1-a1`);
  expect(last?.thread_id).toBe("thr_w");
  const reason = writerStage(env.db).reason ?? "";
  expect(reason).toBe(`turn limit ${SESSION_MAX_TURNS} reached: verification failed (npm test): boom`);
  expect(countChargedAttempts(env.db, "run1", "T1")).toBe(1);
  await env.harness.lifecycle.dispose();
});

it("stops early only when the failure and the diff are both unchanged between two turns", async () => {
  const env = setup();
  const { all, spawned } = services(env.db, [{ diff:"same" }, { diff:"same" }, { accept:true }]);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
  expect(spawned).toHaveLength(1);
  expect(env.sends).toHaveLength(1);
  expect(writerStage(env.db).reason).toMatch(/^no progress: the same failure and the same diff in two turns in a row: verification failed/);
  await env.harness.lifecycle.dispose();
});

it("a changed failure with an unchanged diff does not stop the session", async () => {
  const env = setup();
  const { all } = services(env.db, [{ diff:"same", reason:"verification failed (npm test): first" },
    { diff:"same", reason:"verification failed (npm test): different" }, { accept:true }]);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(env.sends).toHaveLength(2);
  await env.harness.lifecycle.dispose();
});

it("stops at the wall-time cap", async () => {
  const env = setup();
  clock = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  const { all } = services(env.db, [{ diff:"d1", advanceMs:SESSION_MAX_MS + 1 }, { diff:"d2" }, { accept:true }]);
  start(env, all);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
  expect(env.sends).toHaveLength(0);
  expect(writerStage(env.db).reason).toMatch(/^wall limit 120 min reached: verification failed/);
  await env.harness.lifecycle.dispose();
});

it("moves to a new writer only for a provider or limit fault, never for the task's own failure", () => {
  expect(retryInSameThread("validation_failed", "verification failed (npm test): boom")).toBe(true);
  expect(retryInSameThread("empty_output", "writer returned no output")).toBe(false);
  expect(failureClass("empty_output", "writer returned no output")).toBe("provider");
  expect(failureClass("spawn_rejected", "writer_provider_limit: Upgrade your plan to continue")).toBe("limit");
});

// 2. A missing expected output with green checks is a warning.

const outputTask = { ...contract(), expected_outputs:["a.txt", "b.txt"] };
const green = [{ command:"npm test", exitCode:0, stdout:"", stderr:"" }];

it("warns instead of rejecting a missing expected output when the checks are green and the files are owned", () => {
  const result = classifyWriterOutput({ task:outputTask, produced:["a.txt"], contents:{ "a.txt":"x\n" }, verifies:green });
  expect(result).toEqual({ ok:true, warnings:["missing expected_outputs: b.txt (checks are green and every changed file is inside owns_paths)"] });
  const all = classifyWriterOutput({ task:outputTask, produced:["T1/other.ts"], contents:{ "T1/other.ts":"x\n" }, verifies:green });
  expect(all).toMatchObject({ ok:true, warnings:[expect.stringContaining("a.txt, b.txt")] });
});

it("still rejects a missing expected output when a check fails, nothing was produced, or no check ran", () => {
  const failing = [{ command:"npm test", exitCode:1, stdout:"", stderr:"boom" }];
  expect(classifyWriterOutput({ task:outputTask, produced:["a.txt"], contents:{ "a.txt":"x\n" }, verifies:failing }))
    .toEqual({ ok:false, state:"validation_failed", reason:"missing expected_outputs: b.txt" });
  expect(classifyWriterOutput({ task:outputTask, produced:[], contents:{}, verifies:green }))
    .toMatchObject({ ok:false, state:"empty_output" });
  expect(classifyWriterOutput({ task:{ ...outputTask, verify:"none", verification:[] }, produced:["a.txt"], contents:{ "a.txt":"x\n" } }))
    .toEqual({ ok:false, state:"validation_failed", reason:"missing expected_outputs: b.txt" });
  // A file outside owns_paths is still a rejection, whatever the checks say.
  expect(classifyWriterOutput({ task:outputTask, produced:["a.txt", "src/x.ts"], contents:{ "a.txt":"x\n" }, verifies:green }))
    .toMatchObject({ ok:false, reason:expect.stringContaining("owns_paths rejected src/x.ts") });
});

// 4. Redispatching a family member while one runs or is parked.

function dispatcher(env:ReturnType<typeof setup>, parked:Array<Record<string, unknown>> = []) {
  const svc = { stability:{ loadParked:async () => parked } } as unknown as Services;
  return createWriterDispatch(env.ctx, svc).dispatchWriter;
}

it("refuses a redispatch of a family member while one runs, naming it and the tools to use", async () => {
  const env = setup();
  createTask(env.db, { id:"P1", runId:"run1", kind:"bb", contract:contract("P1") });
  createAttempt(env.db, { id:"p1-a", runId:"run1", taskId:"P1" });
  const result = await dispatcher(env)({ threadId:"thr_pm", projectId:"proj1", task:contract("P1.2"), plan:"again" });
  expect(result).toMatchObject({ ok:false, error:{ code:"task_in_progress", retryable:false, sideEffects:"none" }, runningTaskId:"P1" });
  expect(String(result.hint)).toContain("lane_pilot_update_task / lane_pilot_answer_writer");
  // Nothing was created for the refused dispatch.
  expect(env.db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE id LIKE 'P1.%'").get()).toEqual({ count:0 });
  // The same id as the running task is refused too, instead of becoming «P1.2».
  expect(await dispatcher(env)({ threadId:"thr_pm", projectId:"proj1", task:contract("P1"), plan:"again" }))
    .toMatchObject({ error:{ code:"task_in_progress" }, runningTaskId:"P1" });
  await env.harness.lifecycle.dispose();
});

it("refuses a redispatch while a member of the family is parked for a restart", async () => {
  const env = setup();
  createTask(env.db, { id:"P1", runId:"run1", kind:"bb", contract:contract("P1") });
  createAttempt(env.db, { id:"p1-a", runId:"run1", taskId:"P1" });
  transitionAttempt(env.db, "p1-a", "blocked", { reason:"internal_error: boom" });
  const parked = [{ projectId:"proj1", runId:"run1", taskId:"P1", klass:"harness" }];
  const result = await dispatcher(env, parked)({ threadId:"thr_pm", projectId:"proj1", task:contract("P1.2"), plan:"again" });
  expect(result).toMatchObject({ ok:false, error:{ code:"task_in_progress" }, runningTaskId:"P1" });
  expect(String(result.hint)).toContain("parked and restarts by itself");
  await env.harness.lifecycle.dispose();
});

// 5. A dependent waits for the family's next accepted member, or for the PM's «satisfied».

function blockedDependency(env:ReturnType<typeof setup>, id = "D1") {
  createTask(env.db, { id, runId:"run1", kind:"bb", contract:contract(id) });
  createAttempt(env.db, { id:`${id}-a`, runId:"run1", taskId:id });
  transitionAttempt(env.db, `${id}-a`, "blocked", { reason:"verification failed (npm test): boom" });
}

it("a dependent of a blocked dependency waits, and goes on once the family's next member is accepted", async () => {
  vi.useFakeTimers({ toFake:["setTimeout"] });
  const env = setup();
  blockedDependency(env);
  const { all, spawned } = services(env.db, [{ accept:true }]);
  start(env, all, "T2", ["D1"]);
  await vi.advanceTimersByTimeAsync(50);
  expect(spawned).toEqual([]);
  expect(writerStage(env.db, "T2")).toMatchObject({ state:"pending", reason:expect.stringContaining("D1 ended blocked") });
  // The PM sends the dependency again; its accepted «D1.2» is what the name «D1» now means.
  createTask(env.db, { id:"D1.2", runId:"run1", kind:"bb", contract:contract("D1.2") });
  createAttempt(env.db, { id:"d12-a", runId:"run1", taskId:"D1.2" });
  transitionAttempt(env.db, "d12-a", "accepted");
  expect(latestTaskAttemptState(env.db, "proj1", "D1")).toBe("accepted");
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
  await vi.waitFor(() => expect(spawned).toEqual(["T2-a1"]));
  await env.harness.lifecycle.dispose();
});

it("naming a redispatched member follows the family's later members", () => {
  const env = setup();
  for (const [index, [task, state]] of [["D1.2", "blocked"], ["D1.3", "running"], ["D1.2.2", "accepted"], ["D10", "blocked"]].entries()) {
    createAttempt(env.db, { id:`a${index}`, runId:"run1", taskId:task! });
    env.db.prepare("UPDATE lane_pilot_attempt SET state=?, created_at=? WHERE id=?").run(state, 10 + index, `a${index}`);
  }
  expect(latestTaskAttemptState(env.db, "proj1", "D1.2")).toBe("accepted");
  expect(latestTaskAttemptState(env.db, "proj1", "D1")).toBe("accepted");
  expect(latestTaskAttemptState(env.db, "proj1", "D10")).toBe("blocked");
});

it("lane_pilot_update_task satisfied:true lets a dependent of a blocked task start, without a follow-up task", async () => {
  vi.useFakeTimers({ toFake:["setTimeout"] });
  const env = setup();
  blockedDependency(env);
  const { all, spawned } = services(env.db, [{ accept:true }]);
  start(env, all, "T2", ["D1"]);
  await vi.advanceTimersByTimeAsync(50);
  expect(spawned).toEqual([]);
  const update = createWriterUpdateTask(env.ctx, all).updateTask;
  expect(await update({ projectId:"proj1", runId:"run1", pmThreadId:"thr_pm", taskId:"D1", satisfied:true }))
    .toMatchObject({ ok:true, taskId:"D1", state:"satisfied" });
  // The dependency itself stays blocked in the record.
  expect(latestTaskAttemptState(env.db, "proj1", "D1")).toBe("blocked");
  await vi.advanceTimersByTimeAsync(10_000);
  vi.useRealTimers();
  await vi.waitFor(() => expect(spawned).toEqual(["T2-a1"]));
  await vi.waitFor(() => expect(writerStage(env.db, "T2").state).toBe("passed"));
  await env.harness.lifecycle.dispose();
});

it("satisfied:true is only for a blocked task, and takes no task or plan", async () => {
  const env = setup();
  createTask(env.db, { id:"R1", runId:"run1", kind:"bb", contract:contract("R1") });
  createAttempt(env.db, { id:"r1-a", runId:"run1", taskId:"R1" });
  const update = createWriterUpdateTask(env.ctx, services(env.db, []).all).updateTask;
  expect(await update({ projectId:"proj1", runId:"run1", pmThreadId:"thr_pm", taskId:"R1", satisfied:true }))
    .toMatchObject({ ok:false, error:{ code:"not_blocked" } });
  transitionAttempt(env.db, "r1-a", "blocked", { reason:"x" });
  expect(await update({ projectId:"proj1", runId:"run1", pmThreadId:"thr_pm", taskId:"R1", satisfied:true, plan:"also edit" }))
    .toMatchObject({ ok:false, error:{ code:"validation_failed" } });
  await env.harness.lifecycle.dispose();
});
