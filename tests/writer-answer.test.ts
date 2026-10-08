import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import type { TaskV2 } from "../src/contracts";
import { countAttempts, countChargedAttempts, createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { LANE_PILOT_PM_SESSION } from "../src/native-agent-overlay";
import { NATIVE_LP_BRIDGE_PM_TOOLS, NATIVE_LP_BRIDGE_TOOLS } from "../src/native-session-hooks";
import { createCore } from "../src/server/core";
import type { Services } from "../src/server/services";
import { recordStage } from "../src/server/stage-records";
import { createWriterAnswer } from "../src/server/writer/answer";
import { createWriterStart } from "../src/server/writer/start";
import { answerTurnPrompt } from "../src/server/writer-task";
import { expect, it, vi } from "vitest";

const WORKSPACE = "/ws";
const QUESTION = "Which package for X?";
const REASON = `needs_human: ${QUESTION}`;

const contract = (): TaskV2 => ({
  schema_version:2,
  id:"T1",
  title:"Add the fixture",
  risk:"low",
  lane:"writer",
  project_cwd:WORKSPACE,
  read_first:[],
  interfaces:[],
  invariants:[],
  out_of_scope:[],
  expected_outputs:["a.txt"],
  owns_paths:["a.txt"],
  never_touch:[],
  depends_on:[],
  objective:"Make a.txt",
  acceptance:["a.txt exists"],
  verify:"tests",
  verification:[],
});

type Send = { threadId:string; input:Array<{ type:string; text:string }> };
type Write = { path:string; content:string };

function harnessFor() {
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
  const sends: Send[] = [];
  const writes: Write[] = [];
  harness.sdk.stub("threads.get", async (args:{ threadId:string }) => args.threadId === "thr_w" ? { id:args.threadId, status:"idle" } : null);
  harness.sdk.stub("threads.send", async (args:unknown) => { sends.push(args as Send); return undefined; });
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("files.read", async () => { throw new Error("file does not exist"); });
  harness.sdk.stub("files.write", async (args:unknown) => { writes.push(args as Write); return undefined; });
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, { projectId:"proj1", hostId:"h1", pmWorkspacePath:WORKSPACE, writerWorkspacePath:WORKSPACE,
    pmProviderId:"p", pmModel:"pm", writerProviderId:"p", writerModel:"wm" });
  createTask(db, { id:"T1", runId:"run1", kind:"bb", contract:contract() });
  saveTaskPlan(db, "T1", "Plan for T1");
  return { bb, harness, db, ctx, sends, writes };
}

function fakeServices(db:ReturnType<typeof openDatabase>, finish?:Services["finishWriterAttempt"]):Services {
  return {
    activeWriterTasks:new Set<string>(),
    providerBreaker:{ record:() => undefined },
    ...noOptionalPlugins,
    runBudgetFor:() => ({ check:() => ({ ok:true }), noteAttempt:() => undefined, noteTokens:() => undefined, snapshot:() => ({ limits:{} }) }),
    runWriterPool:{ acquire:async () => () => undefined },
    isLiveFolder:async () => false,
    stability:{ breakerHolds:() => null, diskHolds:async () => null, onTaskFailed:async () => false },
    finishWriterAttempt:finish ?? (async () => ({ status:"accepted" })),
    maintainMemoryAfterAcceptance:() => undefined,
    maintainProjectLifeAfterAcceptance:() => undefined,
  } as unknown as Services;
}

/** A task whose latest attempt stopped with a writer question, stages failed, like a finished needs_human attempt. */
function blockedQuestionAttempt(db:ReturnType<typeof openDatabase>) {
  createAttempt(db, { id:"a1", runId:"run1", taskId:"T1" });
  db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, thread_id='thr_w', workspace_path='/ws/worktrees/a1' WHERE id='a1'").run(REASON);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
    recordStage(db, { runId:"run1", taskId:"T1", stageId, state:"failed", input:"Plan for T1", reason:REASON });
  }
}

it("registers like the other PM tools and the overlay tells the PM to answer, not redispatch", () => {
  expect(NATIVE_LP_BRIDGE_TOOLS).toContain("lane_pilot_answer_writer");
  expect(NATIVE_LP_BRIDGE_PM_TOOLS).toContain("lane_pilot_answer_writer");
  expect(LANE_PILOT_PM_SESSION).toMatch(/## Receipts[\s\S]*needs_human: <question>: answer it with `lane_pilot_answer_writer`[\s\S]*Redispatch only when the contract itself must change/);
});

it("the answer turn carries the answer, the standing rules and the NEEDS_HUMAN escape hatch", () => {
  const turn = answerTurnPrompt("Use package X");
  expect(turn).toContain("The PM answered your question: Use package X. Continue the task in this worktree; the contract is unchanged.");
  expect(turn).toContain("only owns_paths, no commits or merges, no npm install");
  expect(turn).toContain("NEEDS_HUMAN:");
  expect(turn).toContain("Run the verification commands");
});

it("the PM's answer continues the same attempt in the same thread to acceptance, spending no attempt", async () => {
  const { db, ctx, harness, sends, writes } = harnessFor();
  blockedQuestionAttempt(db);
  const finished:Array<{ attemptId:string; writerThreadId:string }> = [];
  const services = fakeServices(db, async (input) => {
    finished.push({ attemptId:input.attemptId, writerThreadId:input.writerThreadId });
    transitionAttempt(db, input.attemptId, "accepted");
    return { status:"accepted", produced:["a.txt"], verification:[] };
  });
  Object.assign(services, createWriterStart(ctx, services));
  const answer = createWriterAnswer(ctx, services).answerWriter;

  const chargedBefore = countChargedAttempts(db, "run1", "T1");
  const result = await answer({ projectId:"proj1", runId:"run1", pmThreadId:"thr_pm", taskId:"T1", answer:"Use package X from the lockfile." });
  expect(result).toMatchObject({ ok:true, attemptId:"a1", writerThreadId:"thr_w", state:"running" });
  expect(getAttempt(db, "a1")?.state).toBe("running");

  // The answer went into the SAME writer thread, not a new one.
  expect(sends).toHaveLength(1);
  expect(sends[0]!.threadId).toBe("thr_w");
  expect(sends[0]!.input[0]?.text).toContain("The PM answered your question: Use package X from the lockfile.");

  // The question and the answer are kept in the task folder.
  expect(writes).toHaveLength(1);
  expect(writes[0]!.path).toBe(`${WORKSPACE}/.agents/plans/items/T1/QA.md`);
  expect(writes[0]!.content).toContain(`Q (writer): ${QUESTION}`);
  expect(writes[0]!.content).toContain("A (PM): Use package X from the lockfile.");

  // The normal wait → validate → accept loop resumed the same attempt.
  await vi.waitFor(() => expect(getAttempt(db, "a1")?.state).toBe("accepted"));
  expect(finished).toEqual([{ attemptId:"a1", writerThreadId:"thr_w" }]);

  // The answer round spent no attempt: same single attempt row, same charged count.
  expect(countAttempts(db, "run1", "T1")).toBe(1);
  expect(countChargedAttempts(db, "run1", "T1")).toBe(chargedBefore);

  // The reopened writer stages closed passed.
  const stages = Object.fromEntries(listStageReceipts(db, "run1", "T1").map((row) => [row.stageId, row.state]));
  expect(stages).toEqual({ "writer-agent":"passed", "verification":"passed", "acceptance-receipt":"passed" });
  await harness.lifecycle.dispose();
});

it("a task whose latest attempt is not blocked with a question is not answerable, and nothing moves", async () => {
  const { db, ctx, harness, sends, writes } = harnessFor();
  createAttempt(db, { id:"a1", runId:"run1", taskId:"T1" });
  db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason='retry limit 2 exhausted', thread_id='thr_w' WHERE id='a1'").run();
  const services = fakeServices(db);
  const answer = createWriterAnswer(ctx, services).answerWriter;

  const result = await answer({ projectId:"proj1", runId:"run1", pmThreadId:"thr_pm", taskId:"T1", answer:"Use package X." });
  expect(result).toEqual({ ok:false, error:{ code:"not_answerable", retryable:false, sideEffects:"none",
    hint:"the task's latest attempt is not blocked with a writer question; redispatch the task instead" } });
  expect(getAttempt(db, "a1")?.state).toBe("blocked");
  expect(sends).toEqual([]);
  expect(writes).toEqual([]);
  await harness.lifecycle.dispose();
});

it("a busy writer thread is not answerable", async () => {
  const { db, ctx, harness, sends, writes } = harnessFor();
  harness.sdk.stub("threads.get", async () => ({ id:"thr_w", status:"active" }));
  blockedQuestionAttempt(db);
  const answer = createWriterAnswer(ctx, fakeServices(db)).answerWriter;

  const result = await answer({ projectId:"proj1", runId:"run1", pmThreadId:"thr_pm", taskId:"T1", answer:"Use package X." });
  expect(result).toEqual({ ok:false, error:{ code:"not_answerable", retryable:false, sideEffects:"none",
    hint:"the writer thread is gone or busy; redispatch the task instead" } });
  expect(getAttempt(db, "a1")?.state).toBe("blocked");
  expect(sends).toEqual([]);
  expect(writes).toEqual([]);
  await harness.lifecycle.dispose();
});

it("a call from another PM thread is not answerable", async () => {
  const { db, ctx, harness, sends, writes } = harnessFor();
  blockedQuestionAttempt(db);
  const answer = createWriterAnswer(ctx, fakeServices(db)).answerWriter;

  const result = await answer({ projectId:"proj1", runId:"run1", pmThreadId:"thr_other", taskId:"T1", answer:"Use package X." });
  expect(result).toEqual({ ok:false, error:{ code:"not_answerable", retryable:false, sideEffects:"none",
    hint:"the run does not belong to this PM thread and project; redispatch the task instead" } });
  expect(getAttempt(db, "a1")?.state).toBe("blocked");
  expect(sends).toEqual([]);
  expect(writes).toEqual([]);
  await harness.lifecycle.dispose();
});
