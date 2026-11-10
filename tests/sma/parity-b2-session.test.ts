import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { claudeGuardLauncherScript, HELPER_DISALLOWED_TOOLS, WRITER_MAX_TURNS } from "../../src/rooms/native-agent/claude-guard-launch";
import { createWriterState } from "../../src/rooms/writer/server/state";
import { createWriterUpdateTask } from "../../src/rooms/writer/server/update-task";
import { pendingWordPush, pendingWordTake } from "../../src/rooms/writer/server/writer-task";
import { repeatedCallOf, sweepWriterSilence, writerFrame } from "../../src/rooms/writer/server/writer-silence";
import { recordGateEvaluation } from "../../src/rooms/runs/server/stage-records";
import { allowTestEditsOf, testEditAllowance, testEditHoldKey, testEditHoldOf, testFitFindings } from "../../src/rooms/tasks/test-fit";
import { createPhaseDriver } from "../phase-driver";
import {
  createAttempt, createRun, createTask, getAttempt, getReasoningTrace, openDatabase, savePrototypeConfig, saveReasoningTrace, saveTaskPlan,
  setAttemptWorkspace, setRunThread, transitionAttempt,
} from "../../src/rooms/plugin-db";
import { getPhase, savePhase } from "../../src/rooms/phase/store";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import type { PhaseRecord } from "../../src/rooms/phase/logic";
import type { Services } from "../../server";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import { sha256Hex } from "@lane-pilot/kit";

const HOST = "host_test";
const WS = "/ws";
const config: PrototypeConfig = { projectId: "proj1", hostId: HOST, pmWorkspacePath: WS, writerWorkspacePath: WS, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const taskOf = (id: string, over: Partial<TaskV2> = {}): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WS, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`src/${id}.ts`], owns_paths: ["src/"], never_touch: [], depends_on: [],
  objective: "do it", acceptance: ["done"], verify: "tests", verification: [{ command: "true", cwd: WS }], ...over,
});

function base() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_w", status: "idle" }));
  harness.sdk.stub("threads.send", async () => undefined);
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WS);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  const sent: Array<{ threadId: string; mode?: string; text: string }> = [];
  const services = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
    startWriterTask: vi.fn(),
    workflowEngine: null,
  } as unknown as Services;
  return { bb, harness, db, ctx, services, sent };
}

function taskAndAttempt(db: ReturnType<typeof openDatabase>, state: string, over: Record<string, unknown> = {}) {
  const task = taskOf("t1");
  createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(db, "t1", "Plan");
  createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
  setAttemptWorkspace(db, "a1", { path: `${WS}/wt`, environmentId: null, decision: {} });
  transitionAttempt(db, "a1", "spawn_requested");
  if (state === "running") transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
  else if (state === "blocked") { transitionAttempt(db, "a1", "running", { threadId: "thr_w" }); transitionAttempt(db, "a1", "blocked", over); }
  return task;
}

describe("parity b2-session", () => {
  it("[sma:as_build_args] a writer's launcher carries the turn ceiling and the deny list, a PM's carries neither", () => {
    const writer = claudeGuardLauncherScript({ destDir: "/d", command: "/bin/claude", settingsPath: "/s", role: "writer", agentType: "writer", maxTurns: 150 });
    const pm = claudeGuardLauncherScript({ destDir: "/d", command: "/bin/claude", settingsPath: "/s", role: "pm", agentType: "lane-pilot-pm" });
    expect(writer).toContain("--max-turns 150");
    expect(writer).toContain("--disallowedTools");
    expect(writer).toContain(HELPER_DISALLOWED_TOOLS);
    expect(pm).not.toContain("--max-turns");
    expect(pm).not.toContain("--disallowedTools");
    // The spawn reasoning trace records the same bounds beside the chosen model and effort.
    const { db } = base();
    taskAndAttempt(db, "running");
    saveReasoningTrace(db, { planSha256: "p", sentPlanSha256: null, sourceLength: 1, sentLength: null, jevStatus: "ok", jevDecision: null,
      requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null, providerId: "p", model: "wm",
      runId: "run1", attemptId: "a1", threadId: null, maxTurns: WRITER_MAX_TURNS, disallowedTools: HELPER_DISALLOWED_TOOLS } as never);
    const trace = getReasoningTrace(db, "a1") as Record<string, unknown> | null;
    expect(trace?.maxTurns).toBe(WRITER_MAX_TURNS);
    expect(trace?.disallowedTools).toBe(HELPER_DISALLOWED_TOOLS);
  });

  it("[sma:as_launchable] a drawing edited after the owner's yes does not launch", async () => {
    const { db, ctx, services } = base();
    const bag = services as unknown as Record<string, unknown>;
    const shas = new Map<string, string>();
    bag.readWriterWorkspaceFile = async ({ path }: { path: string }) => ({ sha256: shas.get(path) ?? sha256Hex(`${path}:v1`), sizeBytes: 100, content: "x" });
    const dispatched: string[] = [];
    bag.dispatchWriter = async () => { dispatched.push("x"); return { ok: true, taskId: "t1" }; };
    bag.runBudgets = { get: () => undefined };
    const { phases } = createPhaseDriver(ctx, services);
    const phase = await phases.open({ projectId: "proj1", pmThreadId: "thr_pm", title: "Draw", goal: "g" });
    const drawingPath = `.agents/phases/${phase.id}/design/UI-SPEC.md`;
    const drawingSha = sha256Hex(`${drawingPath}:${shas.get(drawingPath) ?? sha256Hex(`${drawingPath}:v1`)}`);
    // The record as the PM left it after design: drawing recorded, the owner's design yes and issue yes keyed on what was shown.
    const record: PhaseRecord = { ownerWords: true,
      plan: { items: [{ id: "p1", title: "piece", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: taskOf("t1") as never }], sha: "plansha", contextSha: "c", admittedSha: "plansha" },
      design: { decision: "needed", why: "ui", drawing: { paths: [drawingPath], sha256: drawingSha, designer: "d", reviewer: "r", feasible: true } },
      // No writer host in this test: the piece issues into main without a phase branch.
      candidate: { branch: "ph", trees: {}, off: "no writer host" } as never,
      words: [
        { turn: "design", decision: "yes", by: "owner", text: "да", at: 1, key: drawingSha },
        { turn: "issue", decision: "yes", by: "owner", text: "да", at: 2, key: "plansha" },
      ] };
    savePhase(db, phase.id, { stage: "execution", record, state: "active", at: Date.now() });
    // The file is edited between the yes and the launch: the re-read hash differs, nothing issues.
    shas.set(drawingPath, sha256Hex(`${drawingPath}:v2`));
    const held = await phases.drive(getPhase(db, phase.id)!);
    expect(dispatched).toEqual([]);
    const parts = db.prepare("SELECT kind,text FROM lane_pilot_phase_part WHERE phase_id=? AND kind='stale_consent'").all(phase.id) as Array<{ text: string }>;
    expect(parts.length).toBe(1);
    expect(parts[0]!.text).toContain("changed since it was recorded");
    // A second pass says nothing more, and a read that fails for another reason than a missing file is not a change.
    await phases.drive(getPhase(db, phase.id)!);
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_phase_part WHERE phase_id=? AND kind='stale_consent'").get(phase.id) as { n: number }).n).toBe(1);
    expect(held.record.execution?.issued ?? {}).toEqual({});
    // A new yes signs the drawing the owner now sees only after the PM records it again: simulate drawing() resubmitted.
    const fresh = getPhase(db, phase.id)!;
    savePhase(db, phase.id, { at: Date.now(), record: { ...fresh.record,
      design: { ...fresh.record.design!, drawing: { ...fresh.record.design!.drawing!, sha256: sha256Hex(`${drawingPath}:${sha256Hex(`${drawingPath}:v2`)}`) } },
      words: [...(fresh.record.words ?? []), { turn: "design", decision: "yes", by: "owner", text: "да", at: 3, key: sha256Hex(`${drawingPath}:${sha256Hex(`${drawingPath}:v2`)}`) }] } });
    await phases.drive(getPhase(db, phase.id)!);
    expect(dispatched.length).toBe(1);
  });

  it("[sma:as_wheel] the PM's note reaches a running writer now or at its next turn", async () => {
    const { bb, db, ctx, services, sent, harness } = base();
    taskAndAttempt(db, "running");
    harness.sdk.stub("threads.send", async (args: { threadId: string; mode?: string; input: Array<{ text: string }> }) => {
      sent.push({ threadId: args.threadId, mode: args.mode, text: args.input?.[0]?.text ?? "" });
      return undefined;
    });
    const { updateTask } = createWriterUpdateTask(ctx, services);
    const writes: Array<{ path: string; content: string }> = [];
    harness.sdk.stub("files.read", async () => { throw Object.assign(new Error("file does not exist"), { code: "not_found" }); });
    harness.sdk.stub("files.write", async (args: { path: string; content: string }) => { writes.push(args); return {}; });
    const input = { projectId: "proj1", runId: "run1", pmThreadId: "thr_pm", taskId: "t1" };
    const now = await updateTask({ ...input, note: "use the cached list", when: "now" });
    expect(now.ok).toBe(true);
    expect(now.delivered).toBe(true);
    const next = await updateTask({ ...input, note: "and log the ids", when: "next_turn" });
    expect(next.ok).toBe(true);
    expect(sent.map((row) => row.mode)).toEqual(["steer-if-active", "queue-if-active"]);
    expect(sent[0]!.threadId).toBe("thr_w");
    expect(sent[0]!.text).toContain("use the cached list");
    expect(getAttempt(db, "a1")!.state).toBe("running");
    expect((getAttempt(db, "a1") as Record<string, unknown>).reason ?? null).toBeNull();
    // The contract is unchanged and the words are in QA.md.
    const row = db.prepare("SELECT contract_json FROM lane_pilot_task WHERE id='t1'").get() as { contract_json: string };
    expect(JSON.parse(row.contract_json).acceptance).toEqual(["done"]);
    const qa = writes.filter((w) => w.path.endsWith("QA.md"));
    expect(qa.length).toBeGreaterThan(0);
    expect(qa.some((w) => w.content.includes("use the cached list"))).toBe(true);
    expect(qa.some((w) => w.content.includes("and log the ids"))).toBe(true);
  });

  it("[sma:as_redirect_deferred] a correction the running writer could not take rides the next attempt's brief once", async () => {
    const { bb, db, ctx, services, harness } = base();
    taskAndAttempt(db, "running");
    harness.sdk.stub("threads.send", async () => { throw new Error("thread gone"); });
    const { updateTask } = createWriterUpdateTask(ctx, services);
    const out = await updateTask({ projectId: "proj1", runId: "run1", pmThreadId: "thr_pm", taskId: "t1", note: "acceptance: also cover empty input", when: "now" });
    expect(out.ok).toBe(true);
    expect(out.delivered).toBe(false);
    // The kept word is what the next fresh-thread attempt's brief gets, once.
    const kv = bb.storage.kv as never;
    const brief = await pendingWordTake(kv, "run1", "t1");
    expect(brief).toContain("the PM corrected the task meanwhile");
    expect(brief).toContain("acceptance: also cover empty input");
    expect(await pendingWordTake(kv, "run1", "t1")).toBeNull();
  });

  it("[sma:as_effect_observe] after a reload the spend reserve counts the run's BB-recorded tokens", () => {
    const { db, ctx } = base();
    // Two attempt threads of the run, each with a recorded token cursor.
    for (const [attemptId, threadId] of [["a1", "thr_1"], ["a2", "thr_2"]] as const) {
      createAttempt(db, { id: attemptId, runId: "run1", taskId: "t1" });
      transitionAttempt(db, attemptId, "spawn_requested");
      transitionAttempt(db, attemptId, "running", { threadId });
      db.prepare("INSERT INTO lane_pilot_token_cursor (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at) VALUES (?,?,?,0,'{}',?,?,?, '',?)")
        .run(threadId, "proj1", "p", JSON.stringify({ total: 30000 }), "m", "p", Date.now());
    }
    const writer = createWriterState(ctx);
    const budget = writer.runBudgetFor("run1", { "run.max_tokens": 100000 });
    expect(budget.snapshot().tokens).toBe(60000);
    // A second call keeps the seeded spend, not a fresh zero.
    expect(writer.runBudgetFor("run1", { "run.max_tokens": 100000 }).snapshot().tokens).toBe(60000);
  });

  it("[sma:as_stagnation] frames read closed, spinning and progressing, and a spinning writer is nudged", async () => {
    const cmd = (n: number, command = "npm test") => ({ type: "item/completed", createdAt: Date.now() - n * 1000, data: { item: { type: "commandExecution", command } } });
    const fileChange = { type: "item/completed", createdAt: Date.now(), data: { item: { type: "fileChange", changes: {} } } };
    const six = [1, 2, 3, 4, 5, 6].map((n) => cmd(n));
    expect(writerFrame(six)).toBe("spinning");
    expect(repeatedCallOf(six)).toContain("npm test");
    // A check rerun three times, another call between, a file change, or one call seen as several events is ordinary work.
    expect(repeatedCallOf(six.slice(0, 3))).toBeNull();
    expect(repeatedCallOf([cmd(1), cmd(2), cmd(3), cmd(4, "git status"), cmd(5), cmd(6), cmd(7)])).toBeNull();
    expect(writerFrame([cmd(1), fileChange, ...six])).toBe("progressing");
    expect(repeatedCallOf(six.map((event) => ({ ...event, type: "item/updated" })))).toBeNull();
    // Calls made before the last nudge do not count again.
    expect(repeatedCallOf(six, Date.now() - 3500)).toBeNull();
    expect(writerFrame([{ type: "turn/completed", createdAt: Date.now() }, ...six])).toBe("closed");
    // The sweep nudges the spinning writer with the repeated call named.
    const { bb } = base();
    const sent: string[] = [];
    const deps = {
      bb: { sdk: { threads: {
        send: async (args: never) => { sent.push(JSON.stringify(args)); return {}; },
        events: { list: async () => six },
      } }, storage: { kv: bb.storage.kv } },
      openAttempts: () => [{ id: "a1", run_id: "run1", task_id: "t1", thread_id: "thr_w", state: "running", project_id: "proj1", pm_thread_id: "thr_pm" }],
      getThread: async () => ({ status: "active" }),
      silenceMinutes: () => 20,
      isDisposed: () => false,
      waitingForOwner: async () => false,
      log: () => undefined,
    };
    const done = await sweepWriterSilence(deps as never);
    expect(done).toEqual([{ attemptId: "a1", action: "nudged", count: 1 }]);
    expect(sent.join()).toContain("repeating");
    expect(sent.join()).toContain("npm test");
    // The next sweep, a minute later, says nothing more: the writer has ten minutes to change course.
    expect(await sweepWriterSilence(deps as never, Date.now() + 60_000)).toEqual([]);
  });

  it("[sma:av_test_edit_hold] a weakened reference test holds the hand-in until that exact edit is allowed", async () => {
    const { bb, db, ctx, services } = base();
    const before = "it(\"works\", () => {\n  expect(sum([1, 2])).toBe(3);\n});";
    const weakened = "it(\"works\", () => {\n  expect(sum([1, 2])).toBeTruthy();\n});";
    const hits = testFitFindings([{ path: "tests/sum.test.ts", before, after: weakened }]);
    expect(hits.length).toBe(1);
    taskAndAttempt(db, "blocked", { reason: `test_edit_hold: ${hits[0]!.path}` });
    const kv = bb.storage.kv as { get(key: string): Promise<unknown>; set(key: string, value: never): Promise<unknown> };
    await kv.set(testEditHoldKey("a1"), [{ path: hits[0]!.path, afterSha256: sha256Hex(weakened) }] as never);
    const { updateTask } = createWriterUpdateTask(ctx, services);
    // Another update while held is still refused.
    const refused = await updateTask({ projectId: "proj1", runId: "run1", pmThreadId: "thr_pm", taskId: "t1", task: taskOf("t1", { acceptance: ["other"] }) });
    expect(refused.ok).toBe(false);
    expect((refused.error as { code: string }).code).toBe("task_started");
    // The person allows that very edit: the allowance binds path + content sha, the attempt reopens.
    const allowed = await updateTask({ projectId: "proj1", runId: "run1", pmThreadId: "thr_pm", taskId: "t1", allowTestEdits: true });
    expect(allowed.ok).toBe(true);
    expect(allowed.state).toBe("running");
    const allowance = await testEditAllowance(kv, "a1");
    expect(allowance).toEqual([{ path: hits[0]!.path, afterSha256: sha256Hex(weakened) }]);
    // The same file edited again is a new edit: no allowance matches its new sha.
    expect(allowance.some((row) => row.path === hits[0]!.path && row.afterSha256 === sha256Hex(`${weakened}\n// more`))).toBe(false);
    expect(getAttempt(db, "a1")!.state).toBe("running");
    expect(services.startWriterTask).toHaveBeenCalled();
  });

  it("[sma:av_record] the barrier outcome lands on the attempt row", () => {
    const { db } = base();
    taskAndAttempt(db, "running");
    recordGateEvaluation(db, { attemptId: "a1", projectId: "proj1", runId: "run1", taskId: "t1", gate: "accept", status: "rejected",
      attempt: 1, input: "{}", summary: { writerStatus: "code_critique_blocked", reason: "critic asked for rework" },
      tree: "deadbeef", verdict: { status: "rework", summary: "missing error handling" } });
    const barrier = getAttempt(db, "a1")!.barrier!;
    expect(barrier.gate).toBe("accept");
    expect(barrier.status).toBe("rejected");
    expect(barrier.reason).toBe("critic asked for rework");
    expect(barrier.tree).toBe("deadbeef");
    expect(barrier.verdict).toEqual({ status: "rework", summary: "missing error handling" });
  });
});
