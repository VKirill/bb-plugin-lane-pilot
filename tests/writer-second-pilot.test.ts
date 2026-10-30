import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { countChargedAttempts, createAttempt, createRun, createTask, getAttempt, listUnansweredWriterQuestions, openDatabase, savePrototypeConfig, saveProjectSetting, saveTaskPlan, setRunThread } from "../src/rooms/storage/database";
import { collectOwnerWaiting } from "../src/rooms/owner-waiting";
import { listReturns } from "../src/rooms/stage-return";
import { SAFE_DEFAULT_ANSWER, WRITER_QUESTION_WAIT_MS, wasAnsweredByDefault } from "../src/rooms/writer/server/question-default";
import { createWriterQuestionTimeout } from "../src/rooms/writer/server/question-timeout";
import { heuristicOutcome, narrowedTask, parsePilotDecision } from "../src/rooms/writer/server/second-pilot";
import type { Consult, PilotDecision } from "../src/rooms/writer/server/second-pilot";

const WORKSPACE = "/ws";
const T0 = 1_800_000_000_000;
const CONTRACT_Q = "needs_human: May I add tests/x.test.ts to owns_paths? Its assertion pins the old count.";
const PRODUCT_Q = "needs_human: Should a pending payment be cancelled when the customer switches the payment method?";

const task: TaskV2 = {
  schema_version:2, id:"T1", title:"Add the fixture", risk:"low", lane:"writer", project_cwd:WORKSPACE, read_first:[], interfaces:[], invariants:[], out_of_scope:["the admin page"],
  expected_outputs:["a.txt"], owns_paths:["a.txt", "b/**"], never_touch:[], depends_on:[], objective:"Make a.txt and b/c.txt", acceptance:["a.txt exists", "b/c.txt exists"], verify:"tests",
  verification:[{ command:"npm test", cwd:WORKSPACE }, { command:"npm run lint", cwd:WORKSPACE }],
};

function world(options: { reason?: string; decision?: PilotDecision | null | Error; pmUpdatedAt?: number; settings?: Record<string, string> } = {}) {
  const reason = options.reason ?? CONTRACT_Q;
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
  const sends: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
  harness.sdk.stub("threads.get", async (args:{ threadId:string }) => args.threadId === "thr_w" ? { id:args.threadId, status:"idle" }
    : args.threadId === "thr_pm" ? { id:args.threadId, status:"idle", updatedAt:options.pmUpdatedAt ?? 0 } : null);
  harness.sdk.stub("threads.send", async (args:unknown) => { sends.push(args as never); return undefined; });
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("files.read", async () => { throw new Error("file does not exist"); });
  harness.sdk.stub("files.write", async () => undefined);
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, { projectId:"proj1", hostId:"h1", pmWorkspacePath:WORKSPACE, writerWorkspacePath:WORKSPACE, pmProviderId:"p", pmModel:"pm", writerProviderId:"p", writerModel:"wm" });
  for (const [key, value] of Object.entries(options.settings ?? {})) saveProjectSetting(db, "proj1", key, value);
  createTask(db, { id:"T1", runId:"run1", kind:"bb", contract:task });
  saveTaskPlan(db, "T1", "Plan for T1");
  createAttempt(db, { id:"a1", runId:"run1", taskId:"T1" });
  db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, thread_id='thr_w', workspace_path='/ws/worktrees/a1', updated_at=? WHERE id='a1'").run(reason, T0);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId:"run1", taskId:"T1", stageId, state:"failed", input:"Plan for T1", reason });
  const abandoned: string[] = [];
  const dispatchWriter = vi.fn(async (args: { task?: TaskV2 }) => ({ runId:"run1", taskId:args.task?.id, state:"queued" }));
  const services = { activeWriterTasks:new Set<string>(), startWriterTask:vi.fn(), dispatchWriter, providerRetry:{ abandon:async (id:string) => { abandoned.push(id); } } } as unknown as Services;
  const consult = vi.fn<Consult>(async () => { if (options.decision instanceof Error) throw options.decision; return options.decision ?? null; });
  return { bb, db, ctx, sends, abandoned, dispatchWriter, services, consult, timeout: createWriterQuestionTimeout(ctx, services, consult) };
}

describe("the second pilot on a writer's unanswered question", () => {
  it("answer: the answer goes in through the PM's door, the same writer goes on, no attempt is spent, one stage_return row", async () => {
    const w = world({ decision:{ outcome:"answer", answer:"Keep owns_paths as written; the pinned count is updated by task T2, so leave tests/x.test.ts alone and report the unmet item.", grounds:"the plan assigns the test file to T2" } });
    expect(await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS - 1)).toEqual([]);
    expect(await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"pilot_answer" }]);
    expect(w.consult).toHaveBeenCalledTimes(1);
    expect(w.consult.mock.calls[0]![0]).toMatchObject({ taskId:"T1", attemptId:"a1", plan:"Plan for T1", question:"May I add tests/x.test.ts to owns_paths? Its assertion pins the old count." });
    expect(getAttempt(w.db, "a1")?.state).toBe("running");
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.threadId).toBe("thr_w");
    expect(w.sends[0]!.input[0]!.text).toContain("the plan assigns the test file to T2");
    expect(w.sends[0]!.input[0]!.text).toContain("leave tests/x.test.ts alone");
    expect(countChargedAttempts(w.db, "run1", "T1")).toBe(1);
    expect(listUnansweredWriterQuestions(w.db)).toEqual([]);
    // A second question after this one ends as it does after the safe default (finish.ts reads the same marker).
    expect(await wasAnsweredByDefault(w.bb.storage.kv as never, "run1", "T1")).toBe(true);
    const rows = listReturns(w.db, "run1", "T1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ by:"second-pilot", to:"writer", attemptId:"a1", state:"restarted", projectId:"proj1" });
    expect(rows[0]!.detail).toMatch(/^answer: the plan assigns/);
  });

  it("narrow: a new task with the narrowed contract is dispatched, the original ends as superseded", async () => {
    const w = world({ decision:{ outcome:"narrow", objective:"Make a.txt only", acceptance:["a.txt exists"], out_of_scope:["b/c.txt, which needs tests/x.test.ts widened"], owns_paths:["a.txt", "tests/x.test.ts"], keep_checks:[0], grounds:"a.txt needs no test change" } });
    expect(await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"pilot_narrow" }]);
    expect(w.dispatchWriter).toHaveBeenCalledTimes(1);
    const sent = w.dispatchWriter.mock.calls[0]![0] as { threadId:string; projectId:string; task:TaskV2; plan:string; birth:string };
    expect(sent).toMatchObject({ threadId:"thr_pm", projectId:"proj1", birth:"redo" });
    expect(sent.task.id).toBe("T1.n");
    expect(sent.task.objective).toContain("Make a.txt only");
    expect(sent.task.objective).toContain("Narrowed from T1");
    expect(sent.task.acceptance).toEqual(["a.txt exists"]);
    expect(sent.task.out_of_scope).toEqual(["the admin page", "b/c.txt, which needs tests/x.test.ts widened"]);
    // Never wider than the original: the test file the pilot named is outside it and is dropped.
    expect(sent.task.owns_paths).toEqual(["a.txt"]);
    expect(sent.task.verification).toEqual([{ command:"npm test", cwd:WORKSPACE }]);
    const row = getAttempt(w.db, "a1")!;
    expect(row.state).toBe("blocked");
    expect(row.reason).toMatch(/^verdict_block: question_unanswered: superseded by T1\.n: the second pilot narrowed the task/);
    expect(countChargedAttempts(w.db, "run1", "T1")).toBe(0);
    expect(w.abandoned).toEqual(["thr_w"]);
    expect(w.sends).toEqual([]);
    expect(listReturns(w.db, "run1", "T1")[0]).toMatchObject({ by:"second-pilot", state:"restarted" });
    expect(listReturns(w.db, "run1", "T1")[0]!.detail).toContain("T1.n");
  });

  it("owner: one PM note while the chat is warm, the attempt ends uncharged, nothing on the morning list", async () => {
    const w = world({ reason:PRODUCT_Q, pmUpdatedAt:T0 + WRITER_QUESTION_WAIT_MS - 60_000, decision:{ outcome:"owner", question:"Cancel the pending payment on a method switch, or keep it?", grounds:"the contract says nothing about pending payments" } });
    expect(await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"pilot_owner" }]);
    expect(w.sends).toHaveLength(1);
    expect(w.sends[0]!.threadId).toBe("thr_pm");
    expect(w.sends[0]!.input[0]!.text).toContain("Cancel the pending payment on a method switch, or keep it?");
    expect(collectOwnerWaiting(w.db, T0 + WRITER_QUESTION_WAIT_MS).items).toEqual([]);
    const row = getAttempt(w.db, "a1")!;
    expect(row.state).toBe("blocked");
    expect(row.reason).toMatch(/^verdict_block: question_unanswered: left to the owner by the second pilot/);
    expect(countChargedAttempts(w.db, "run1", "T1")).toBe(0);
    expect(listReturns(w.db, "run1", "T1")[0]).toMatchObject({ by:"second-pilot", state:"handed_to_pm" });
  });

  it("owner with a cold PM chat: the morning list gets the line instead, without a wake", async () => {
    const w = world({ reason:PRODUCT_Q, pmUpdatedAt:T0, decision:{ outcome:"owner", question:"Cancel or keep the pending payment?", grounds:"not in the contract" } });
    await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS);
    expect(w.sends).toEqual([]);
    const items = collectOwnerWaiting(w.db, T0 + WRITER_QUESTION_WAIT_MS).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source:"writer", kind:"product_decision", wake:false });
    expect(items[0]!.what).toContain("Cancel or keep the pending payment?");
  });

  it("never lets the machine answer a product decision: a helper's «answer» becomes the owner's", async () => {
    const w = world({ reason:PRODUCT_Q, pmUpdatedAt:T0 + WRITER_QUESTION_WAIT_MS, decision:{ outcome:"answer", answer:"Cancel it.", grounds:"seems safest" } });
    expect(await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"pilot_owner" }]);
    expect(w.sends[0]!.threadId).toBe("thr_pm");
    expect(getAttempt(w.db, "a1")?.state).toBe("blocked");
  });

  it("stands in with the heuristic when no helper can be read: a contract complaint goes to the owner, a report-shaped line is answered", async () => {
    const owner = world({ decision:new Error("critique_provider_or_model_unavailable"), pmUpdatedAt:T0 + WRITER_QUESTION_WAIT_MS });
    expect(await owner.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"pilot_owner" }]);
    expect(owner.sends[0]!.threadId).toBe("thr_pm");
    const report = world({ reason:"needs_human: main is already green, nothing to fix", decision:null });
    expect(await report.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"pilot_answer" }]);
    expect(report.sends[0]!.threadId).toBe("thr_w");
    expect(report.sends[0]!.input[0]!.text).toContain(SAFE_DEFAULT_ANSWER.split("\n")[1]!);
  });

  it("returns a task once: the next question of the same task takes the old path, and the pilot is not asked again", async () => {
    const w = world({ reason:PRODUCT_Q, pmUpdatedAt:T0 + WRITER_QUESTION_WAIT_MS, decision:{ outcome:"owner", question:"Cancel or keep?", grounds:"not in the contract" } });
    await w.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS);
    createAttempt(w.db, { id:"a2", runId:"run1", taskId:"T1" });
    w.db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, thread_id='thr_w', workspace_path='/ws/worktrees/a2', updated_at=? WHERE id='a2'").run(CONTRACT_Q, T0 + 2 * WRITER_QUESTION_WAIT_MS);
    expect(await w.timeout.sweepWriterQuestions(T0 + 3 * WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"answered_by_default" }]);
    expect(w.consult).toHaveBeenCalledTimes(1);
    expect(listReturns(w.db, "run1", "T1")).toHaveLength(1);
  });

  it("is not returned: writer.auto_return off keeps the safe default, and a budget, wall-clock or verify-passes block never reaches the sweep", async () => {
    const off = world({ settings:{ "writer.auto_return":"off" }, decision:{ outcome:"owner", question:"x", grounds:"y" } });
    expect(await off.timeout.sweepWriterQuestions(T0 + WRITER_QUESTION_WAIT_MS)).toEqual([{ taskId:"T1", action:"answered_by_default" }]);
    expect(off.consult).not.toHaveBeenCalled();
    expect(listReturns(off.db, "run1", "T1")).toEqual([]);
    for (const reason of ["attempt_budget_exhausted: 3 of 3 attempts spent", "task_wall_clock: the task lived 720 minutes", "verify_passes_exhausted: 10 gate evaluations", "canceled by the owner", "verdict_block: code-critique: the change is not wanted"]) {
      const w = world({ reason, decision:{ outcome:"answer", answer:"go", grounds:"g" } });
      expect(await w.timeout.sweepWriterQuestions(T0 + 10 * WRITER_QUESTION_WAIT_MS)).toEqual([]);
      expect(w.consult).not.toHaveBeenCalled();
      expect(getAttempt(w.db, "a1")).toMatchObject({ state:"blocked", reason });
      expect(listReturns(w.db, "run1", "T1")).toEqual([]);
    }
  });

  it("waits writer.question_wait_min, read live: 30 acts at half an hour, the default is two hours", async () => {
    const quick = world({ settings:{ "writer.question_wait_min":"30" }, decision:{ outcome:"answer", answer:"go on", grounds:"g" } });
    expect(await quick.timeout.sweepWriterQuestions(T0 + 29 * 60_000)).toEqual([]);
    expect(await quick.timeout.sweepWriterQuestions(T0 + 30 * 60_000)).toEqual([{ taskId:"T1", action:"pilot_answer" }]);
    const slow = world({ decision:{ outcome:"answer", answer:"go on", grounds:"g" } });
    expect(WRITER_QUESTION_WAIT_MS).toBe(120 * 60_000);
    expect(await slow.timeout.sweepWriterQuestions(T0 + 119 * 60_000)).toEqual([]);
    saveProjectSetting(slow.db, "proj1", "writer.question_wait_min", "60");
    expect(await slow.timeout.sweepWriterQuestions(T0 + 119 * 60_000)).toEqual([{ taskId:"T1", action:"pilot_answer" }]);
  });
});

describe("the second pilot's pieces", () => {
  it("reads the helper's JSON and rejects a shape it cannot act on", () => {
    expect(parsePilotDecision('```json\n{"outcome":"answer","answer":"Keep the paths.","grounds":"the plan says so"}\n```')).toEqual({ outcome:"answer", answer:"Keep the paths.", grounds:"the plan says so" });
    expect(parsePilotDecision('{"outcome":"narrow","objective":"a only","acceptance":["a"],"out_of_scope":["b"],"keep_checks":[1],"grounds":"g"}')).toEqual({ outcome:"narrow", objective:"a only", acceptance:["a"], out_of_scope:["b"], keep_checks:[1], grounds:"g" });
    expect(parsePilotDecision('{"outcome":"owner","question":"Cancel?","grounds":"g"}')).toEqual({ outcome:"owner", question:"Cancel?", grounds:"g" });
    expect(parsePilotDecision('{"outcome":"narrow","objective":"a only","acceptance":[]}')).toBeNull();
    expect(parsePilotDecision('{"outcome":"answer"}')).toBeNull();
    expect(parsePilotDecision("I think you should widen the paths.")).toBeNull();
  });

  it("narrows a contract without widening it", () => {
    const narrowed = narrowedTask(task, { outcome:"narrow", objective:"a only", acceptance:["a.txt exists"], out_of_scope:["b"], owns_paths:["nope.ts"], keep_checks:[5], grounds:"g" }, "q");
    expect(narrowed.owns_paths).toEqual(task.owns_paths);
    expect(narrowed.verification).toEqual(task.verification);
    expect(narrowed.id).toBe("T1.n");
    expect(narrowed.expected_outputs).toEqual(["a.txt"]);
  });

  it("files a question by the heuristic: product → owner, report → answer, contract or sandbox → narrow, the rest → owner", () => {
    expect(heuristicOutcome("Should a pending payment be cancelled when the customer switches the payment method?")).toBe("owner");
    expect(heuristicOutcome("main is already green, nothing to fix")).toBe("answer");
    expect(heuristicOutcome("May I add tests/x.test.ts to owns_paths?")).toBe("narrow");
    expect(heuristicOutcome("npx tsc --noEmit fails in src/a.ts, outside owns_paths and not caused by this task")).toBe("narrow");
    expect(heuristicOutcome("check `npm test` cannot run in the sandbox: prisma db push blocked")).toBe("narrow");
    expect(heuristicOutcome("Can you make GitNexus impact analysis available so I can proceed?")).toBe("owner");
  });
});
