import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { createWriterStart, copyRefusedKeyPrefix } from "../../src/rooms/writer/server/start";
import { createWriterVerify, acceptanceReceiptBase } from "../../src/rooms/writer/server/verify";
import { createWriterFinish } from "../../src/rooms/writer/server/finish";
import { barrierInputBody, executionChecklist } from "../../src/rooms/writer/server/finish";
import { emitAttemptFinished } from "../../src/rooms/writer/server/attempt-finished";
import { appendTaskQa } from "../../src/rooms/writer/server/reopen-attempt";
import { budgetSpentSweep } from "../../src/rooms/writer/server/budget-item";
import { createWriterState } from "../../src/rooms/writer/server/state";
import { createWriterSkillPick } from "../../src/rooms/writer/server/skill-pick";
import { progressJournal, PROGRESS_CAP } from "../../src/rooms/writer/progress-journal";
import { taskNeedsBrowser, BROWSER_BRIEF_LINE, writerPrompt } from "../../src/rooms/writer/server/writer-task";
import { createRunBudget } from "@lane-pilot/resilience";
import { postOwnerItem, listOpenOwnerItemKeys, closeOwnerItemsByPrefix } from "../../src/rooms/owner-waiting";
import { failureFingerprint } from "../../src/rooms/contracts/failure-class";
import { writerMarkers } from "../../src/rooms/tasks";
import { listRuleProposals } from "@lane-pilot/run-insights";
import { upsertLessonProposal } from "@lane-pilot/run-insights";
import {
  createAttempt, createRun, createTask, getAttempt, listGateEventsForTask, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, setTaskHeldUntil, transitionAttempt,
} from "../../src/rooms/plugin-db";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import type { Services } from "../../server";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { sha256Hex as sha256 } from "@lane-pilot/kit";
import { HOLD_FOREVER } from "../../src/rooms/tasks";
import { mountWriterAttemptFinished } from "../../src/rooms/writer/server/attempt-reactions";

const HOST = "host_test";
const WS = "/ws";
const config: PrototypeConfig = { projectId: "proj1", hostId: HOST, pmWorkspacePath: WS, writerWorkspacePath: WS, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const taskOf = (id: string, over: Partial<TaskV2> = {}): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WS, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`src/${id}.ts`], owns_paths: ["src/"], never_touch: [], depends_on: [],
  objective: "do it", acceptance: ["done"], verify: "tests", verification: [{ command: "true", cwd: WS }], ...over,
});

let scale: string | undefined;
beforeEach(() => { scale = process.env.LANE_PILOT_POLL_SCALE; process.env.LANE_PILOT_POLL_SCALE = "0.0005"; });
afterEach(() => { process.env.LANE_PILOT_POLL_SCALE = scale; });

function writerSetup(task: TaskV2, over: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.send", async () => undefined);
  harness.sdk.stub("threads.context", async () => ({ usage: null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WS);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  const spawned: string[] = [];
  const svc = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, onTaskFailed: async () => false, loadParked: async () => [], diskHolds: async () => null },
    startAfterAcceptance: () => undefined,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
    spawnWriterAttempt: async (input: { attemptId: string }) => {
      spawned.push(input.attemptId);
      setAttemptWorkspace(db, input.attemptId, { path: "/ws/wt", environmentId: null, decision: {} });
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId: "thr_w" });
      return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: "/ws/wt" };
    },
    finishWriterAttempt: async (input: { attemptId: string }) => {
      transitionAttempt(db, input.attemptId, "accepted");
      return { status: "accepted", produced: task.expected_outputs, verification: [] };
    },
    ...over,
  } as unknown as Services;
  createTask(db, { id: task.id, runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(db, task.id, "Plan");
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId: task.id, stageId, state: "pending", input: "Plan" });
  createAttempt(db, { id: "a1", runId: "run1", taskId: task.id });
  Object.assign(svc, createWriterStart(ctx, svc));
  svc.startWriterTask({ projectId: "proj1", runId: "run1", taskId: task.id, firstAttemptId: "a1", pmThreadId: "thr_pm", config, task, plan: "Plan" });
  return { bb, db, spawned, harness };
}

describe("claim and budget", () => {
  it("[sma:dt_claim] a task held while it waits for a full pool does not start when the slot frees", async () => {
    const task = taskOf("held-seat");
    let seatGate!: () => void;
    const seatTaken = new Promise<void>((resolve) => { seatGate = resolve; });
    let poolCalls = 0;
    const run = writerSetup(task, {
      runWriterPool: { acquire: async () => { poolCalls += 1; if (poolCalls === 1) await seatTaken; return () => undefined; } },
    });
    const { db, spawned, harness } = run;
    // While the acquire waits, the task is held forever via the queue hold.
    await vi.waitFor(() => expect(poolCalls).toBe(1), { timeout: 10_000 });
    setTaskHeldUntil(db, task.id, "run1", HOLD_FOREVER);
    seatGate();
    await vi.waitFor(() => expect(listStageReceipts(db, "run1", task.id).find((row) => row.stageId === "writer-agent")?.reason).toContain("waiting: held"), { timeout: 10_000 });
    expect(spawned).toEqual([]);
    // Release the hold: the admission runs again and the writer spawns.
    setTaskHeldUntil(db, task.id, "run1", null);
    await vi.waitFor(() => expect(spawned).toEqual(["a1"]), { timeout: 10_000 });
    await harness.lifecycle.dispose();
  });

  it("[sma:ac_pocket] a spent budget asks the owner once, and raising the limit closes the row", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", WS);
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createTask(db, { id: "t2", runId: "run1", kind: "bb", contract: taskOf("t2") });
    // The exhausted run: the owner item the writer's budget stop posts (same key, once per run).
    const item = {
      key: `run-budget:run1`, source: "writer", kind: "budget_spent", projectId: "proj1", wake: true,
      what: "Бюджет прогона исчерпан: потрачено 11 при лимите 10",
      why: `Лимит «run.max_tokens» исчерпан, а в прогоне остались открытые задачи. Поднимите лимит или завершите прогон.`,
      evidence: [{ kind: "run" as const, ref: "run1" }, { kind: "task" as const, ref: "t1" }],
    };
    expect(postOwnerItem(db, item).created).toBe(true);
    expect(postOwnerItem(db, item).created).toBe(false);
    expect(listOpenOwnerItemKeys(db, { kind: "budget_spent" })).toEqual(["run-budget:run1"]);
    // The sweep: a run whose budget still blocks keeps its row; a raised limit or a closed run closes it.
    const budgets = new Map();
    const runBudgetFor = (runId: string, settings: Record<string, unknown>) => {
      if (!budgets.has(runId)) budgets.set(runId, createRunBudget({ maxTokens: 10 }, Date.now()));
      return budgets.get(runId);
    };
    const spent = runBudgetFor("run1", {});
    spent.noteTokens("thr", 11);
    expect(spent.check().ok).toBe(false);
    const sweep = budgetSpentSweep({ runBudgetFor });
    expect(sweep(db, { key: "run-budget:run1", kind: "budget_spent", created_at: 0 })).toBeNull();
    // The owner raises run.max_tokens: a rebuilt budget passes and the sweep closes the row.
    budgets.set("run1", createRunBudget({ maxTokens: 100 }, Date.now()));
    budgets.get("run1").noteTokens("carry:previous-threads", 11);
    expect(sweep(db, { key: "run-budget:run1", kind: "budget_spent", created_at: 0 })).toBe("janitor:limit raised");
    await harness.lifecycle.dispose();
  });

  it("[sma:ac_pocket] runBudgetFor rebuilds the budget when the limits change and keeps the spend", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const ctx = createCore(bb, openDatabase(bb));
    const state = createWriterState(ctx);
    const first = state.runBudgetFor("r", { "run.max_tokens": 10 });
    first.noteTokens("thr", 11);
    expect(first.check().ok).toBe(false);
    const raised = state.runBudgetFor("r", { "run.max_tokens": 100 });
    expect(raised.check().ok).toBe(true);
    expect(raised.snapshot().tokens).toBe(11);
    // The same thread reports its running total again: it is counted once, not on top of a carried copy.
    raised.noteTokens("thr", 15);
    expect(raised.snapshot().tokens).toBe(15);
  });
});

describe("owner items and the worker's papers", () => {
  it("[sma:ap_copy_refusal] a worktree refusal puts the reason before the owner once per fingerprint, and a restart closes it", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1", "bb", WS);
    createTask(db, { id: "task.copy", runId: "run1", kind: "bb", contract: taskOf("task.copy") });
    const reason = "attempt_worktree_failed:path already exists";
    const post = () => postOwnerItem(db, { key: `${copyRefusedKeyPrefix("run1", "task.copy")}${failureFingerprint(reason)}`, source: "writer", kind: "copy_refused", projectId: "proj1", wake: true,
      what: "Рабочая копия для задачи task.copy не создалась", why: `Git ответил отказом: path already exists`, evidence: [{ kind: "task", ref: "task.copy" }] });
    expect(post().created).toBe(true);
    // The identical refusal adds nothing (the same fingerprinted key is already open).
    expect(post().created).toBe(false);
    expect(listOpenOwnerItemKeys(db, { kind: "copy_refused" })).toHaveLength(1);
    // A restart (a new attempt of the family leaves blocked) clears the family's refusals.
    expect(closeOwnerItemsByPrefix(db, copyRefusedKeyPrefix("run1", "task.copy"), "attempt left blocked")).toBe(1);
    expect(listOpenOwnerItemKeys(db, { kind: "copy_refused" })).toHaveLength(0);
  });

  it("[sma:ae_harvest] a failed attempt whose answer has a LESSON line files it as a writer proposal", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.output", async () => ({ text: "did the work\nAPPROACH: careful\nLESSON: run the migration before the seed" }));
    harness.sdk.stub("threads.events.list", async () => ({ events: [] }));
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", WS);
    createTask(db, { id: "t-lesson", runId: "run1", kind: "bb", contract: taskOf("t-lesson") });
    mountWriterAttemptFinished(ctx, {} as never);
    const event = (attemptId: string, status: string) => ({
      scope: "attempt" as const, projectId: "proj1", runId: "run1", taskId: "t-lesson", attemptId, pmThreadId: "thr_pm",
      writerThreadId: "thr_w", task: taskOf("t-lesson"), config, status, reason: "verification failed: boom", result: null,
    });
    await emitAttemptFinished(ctx, event("a-lesson", "validation_failed"));
    const proposals = listRuleProposals(db as never, "proj1", { state: "proposed" });
    expect(proposals.some((row) => row.rule.includes("run the migration before the seed") && JSON.stringify(row).includes("a-lesson"))).toBe(true);
    // An accepted attempt files nothing.
    await emitAttemptFinished(ctx, event("a-ok", "accepted"));
    expect(listRuleProposals(db as never, "proj1", { state: "proposed" })).toHaveLength(1);
    await harness.lifecycle.dispose();
  });

  it("[sma:m_q_exec_ckpt] a writer parked on NEEDS_HUMAN leaves an open entry in its QA.md", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const written: Array<{ path: string; content: string }> = [];
    harness.sdk.stub("files.read", async () => { throw Object.assign(new Error("file does not exist"), { code: "not_found" }); });
    harness.sdk.stub("files.write", async (args: unknown) => { written.push(args as { path: string; content: string }); return undefined; });
    await appendTaskQa(bb, { hostId: HOST, workspacePath: WS, taskId: "t-qa", question: "which locale?" });
    const qa = written.find((row) => row.path.endsWith(".agents/plans/items/t-qa/QA.md"));
    expect(qa).toBeTruthy();
    expect(qa!.content).toContain("Q (writer): which locale?");
    expect(qa!.content).toContain("A: open — the writer is parked here");
    // The answer appends under it in the same file.
    await appendTaskQa(bb, { hostId: HOST, workspacePath: WS, taskId: "t-qa", question: "which locale?", answer: "ru" });
    expect(written[1]!.content).toContain("A (PM): ru");
  });

  it("[sma:ap_skills] a UI task's writer gets the browser skill and the browser line beside the receipt, lesson and question rules", async () => {
    const ui = taskOf("ui-task", { qa_url: "http://localhost:3000/page", owns_paths: ["src/page.vue"] });
    const plain = taskOf("plain-task", { owns_paths: ["src/logic.ts"] });
    expect(taskNeedsBrowser(ui)).toBe(true);
    expect(taskNeedsBrowser(plain)).toBe(false);
    const brief = writerPrompt(ui);
    expect(brief).toContain(BROWSER_BRIEF_LINE);
    expect(brief).toContain("APPROACH:");
    expect(brief).toContain("LESSON:");
    expect(brief).toContain("NEEDS_HUMAN");
    expect(writerPrompt(plain)).not.toContain(BROWSER_BRIEF_LINE);
    // The pick adds browser-automation even when Jev names nothing.
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("skills.list", async () => ({ skills: [] }));
    const pick = createWriterSkillPick({ bb, host: { call: async () => ({}) } } as never);
    const chosen = await pick.pick({ attemptId: "a1", projectId: "proj1", hostId: HOST, projectCwd: WS, task: ui, });
    expect(chosen.skills).toContain("browser-automation");
    const plainChosen = await pick.pick({ attemptId: "a2", projectId: "proj1", hostId: HOST, projectCwd: WS, task: plain, });
    expect(plainChosen.skills).not.toContain("browser-automation");
    await harness.lifecycle.dispose();
  });
});

describe("attempt records", () => {
  it("[sma:ag_checklist] the checklist row holds every flag at once", () => {
    const checklist = executionChecklist({
      markers: writerMarkers("work done\nAPPROACH: careful\n"),
      planFact: { check: { items: [{ item: "handles errors", evidence: null }, { item: "done", evidence: "src/a.ts:1-3" }] } },
      priorReasons: ["verification failed: boom", "verification failed: boom"],
      produced: ["src/a.ts", "out/x.ts"],
      ownsPaths: ["src/"],
      referenceTestEdits: ["tests/old.test.ts"],
    });
    const flags = checklist as { promise: { approach: boolean; planFactUnproven: string[] }; stagnation: { sameKeyTurns: boolean }; scope: { outsideOwnsPaths: string[] }; referenceTestEdits: string[] };
    expect(flags.promise.approach).toBe(true);
    expect(flags.promise.planFactUnproven).toEqual(["handles errors"]);
    expect(flags.stagnation.sameKeyTurns).toBe(true);
    expect(flags.scope.outsideOwnsPaths).toEqual(["out/x.ts"]);
    expect(flags.referenceTestEdits).toEqual(["tests/old.test.ts"]);
  });

  it("[sma:av_inputs] the barrier's archived input carries diff, promise, contract, prior verdict and the receipt hash", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1", "bb", WS);
    createTask(db, { id: "t-barrier", runId: "run1", kind: "bb", contract: taskOf("t-barrier") });
    const source = JSON.stringify({ evidenceSha256: "e", agent: "code-critic", task: taskOf("t-barrier") });
    recordStage(db, { runId: "run1", taskId: "t-barrier", stageId: "code-critique", state: "blocked", input: source, reason: "changes_requested" });
    const receipt = listStageReceipts(db, "run1", "t-barrier").find((row) => row.stageId === "code-critique")!;
    const body = barrierInputBody({ state: "blocked", inputSha256: receipt.inputSha256, diff: { "src/a.ts": "+x" }, promise: { given: "g", when: "w", then: "t" }, contract: taskOf("t-barrier"), priorVerdict: { status: "changes_requested" } }) as Record<string, unknown>;
    expect(body.diff).toEqual({ "src/a.ts": "+x" });
    expect(body.promise).toEqual({ given: "g", when: "w", then: "t" });
    expect((body.contract as TaskV2).id).toBe("t-barrier");
    expect(body.priorVerdict).toEqual({ status: "changes_requested" });
    expect(body.inputSha256).toBe(receipt.inputSha256);
    expect(receipt.inputSha256).toBe(sha256(source));
  });

  it("[sma:wi_receipts] receipts of a worktree attempt land in the project's own artifacts folder too", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1", "bb", "/repo");
    createTask(db, { id: "t-wt", runId: "run1", kind: "bb", contract: { ...taskOf("t-wt"), project_cwd: "/wt/a" } });
    // The attempt worked in /wt/a while the run's base checkout is /repo: both roots get the receipts.
    expect(acceptanceReceiptBase(db, "run1", "t-wt", "/wt/a")).toBe("/repo");
    expect(acceptanceReceiptBase(db, "run1", "t-wt", "/repo")).toBeNull();
  });

  it("[sma:k_lib_workerprog] the progress journal lists touched files and commands and marks every cut", () => {
    const command = (n: number) => ({ data: { item: { type: "commandExecution", command: `cmd ${n}`, aggregatedOutput: `out ${n}` } } });
    const events = Array.from({ length: PROGRESS_CAP + 50 }, (_, i) => command(i));
    const journal = progressJournal({ attemptId: "a1", taskId: "t-prog", produced: ["src/a.ts"], events });
    expect(journal).toContain("- src/a.ts");
    expect(journal).toContain(`… 50 more not shown`);
    const long = progressJournal({ attemptId: "a1", taskId: "t-prog", produced: [], events: [{ data: { item: { type: "commandExecution", command: "x".repeat(10_000), aggregatedOutput: "y".repeat(10_000) } } }] });
    expect(long).toContain("[cut:");
    const clean = progressJournal({ attemptId: "a1", taskId: "t-prog", produced: [], events: [command(1)] });
    expect(clean).not.toContain("[cut:");
    expect(clean).not.toContain("more not shown");
  });
});
