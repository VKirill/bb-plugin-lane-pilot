// Region 1 · Task graph, batch f (n320-n344, n1772): the ledger's ends and queues, the claim guards and the phase steps.
// Each test checks the result the node's card names (a row, a state, a list), on the real database where the card is about a row.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { FAILED_ATTEMPT_STATES, isFailedAttemptState, isOpenAttemptState, retryAction } from "../../src/rooms/contracts/state-machine";
import { failureClass } from "../../src/rooms/contracts/failure-class";
import { cancelAttemptById } from "../../src/rooms/runs/server/cancel";
import { markCancelCode, CANCEL_CODES } from "../../src/rooms/storage/cancel-code";
import { createAttempt, createRun, createTask, getAttempt, getTask, listAttemptsForTask, listStageReceipts, openDatabase, saveProjectSetting, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, setTaskClosedWords, transitionAttempt } from "../../src/rooms/plugin-db";
import { sha256Hex } from "@lane-pilot/kit";
import { ownerItemOutcome, postOwnerItem } from "../../src/rooms/owner-waiting/items";
import { deadLetters, laneQueueOf } from "../../src/rooms/tasks/rails";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createWriterReassign } from "../../src/rooms/writer/server/reassign";
import { createAttemptReopen } from "../../src/rooms/writer/server/reopen-attempt";
import { createStageReturn } from "../../src/rooms/stage-return/server";
import type { Services } from "../../server";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { fakeDb, taskOf } from "./r01-world-c";

const CLASSES = ["task", "provider", "merge", "dirty_base", "harness", "infra", "contract", "judgment", "budget", "limit", "reassign", "verification_timeout"];

describe("how an attempt ends", () => {
  it("[sma:tr_failed] an attempt that did not produce is one of the failed states, and its reason reads as one class of the closed list", () => {
    expect([...FAILED_ATTEMPT_STATES]).toEqual(["spawn_rejected", "provider_error", "timeout", "empty_output", "validation_failed", "blocked"]);
    for (const state of ["accepted", "canceled", "queued", "running", "cancel_requested", "spawn_requested", "spawn_unknown"]) expect(isFailedAttemptState(state)).toBe(false);
    const reasons: Record<string, [string | null, string]> = {
      spawn_rejected: ["writer_provider_unavailable: catalog down", "provider"],
      provider_error: ["thread status error", "provider"],
      timeout: [null, "provider"],
      empty_output: ["writer returned no output", "provider"],
      validation_failed: ["verification failed (npm test): expected 1 to be 2", "task"],
      blocked: ["retry_budget_exhausted: 4 attempts", "budget"],
    };
    for (const state of FAILED_ATTEMPT_STATES) {
      const [reason, klass] = reasons[state]!;
      expect(failureClass(state, reason), state).toBe(klass);
      expect(CLASSES).toContain(failureClass(state, reason));
    }
  });

  it("[sma:tr_cancelled] a person's cancel of an ended attempt is recorded as canceled with the first code stamped, and a canceled attempt is never retried", async () => {
    const { bb, db } = fakeDb();
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "blocked", { reason: "gate" });
    const ctx = { bb, db, cancelQueuedAttempt: () => ({ ok: false, state: "none", reason: null }) } as never;
    const result = await cancelAttemptById(ctx, "a1", undefined, "PM canceled: superseded by T2", "owner_cancel");
    expect(result).toMatchObject({ ok: true, state: "canceled" });
    const row = db.prepare("SELECT state, reason, cancel_code FROM lane_pilot_attempt WHERE id='a1'").get() as { state: string; reason: string; cancel_code: string };
    expect(row).toEqual({ state: "canceled", reason: "PM canceled: superseded by T2", cancel_code: "owner_cancel" });
    // The first stamp wins: a later generic code does not overwrite the person's.
    markCancelCode(db as never, "a1", "stuck");
    expect((db.prepare("SELECT cancel_code FROM lane_pilot_attempt WHERE id='a1'").get() as { cancel_code: string }).cancel_code).toBe("owner_cancel");
    createAttempt(db, { id: "a2", runId: "run1", taskId: "t1" });
    markCancelCode(db as never, "a2", "run_closed");
    markCancelCode(db as never, "a2", "owner_cancel");
    expect((db.prepare("SELECT cancel_code FROM lane_pilot_attempt WHERE id='a2'").get() as { cancel_code: string }).cancel_code).toBe("run_closed");
    expect(CANCEL_CODES).toEqual(["owner_cancel", "superseded", "run_closed", "wrong_contract", "stuck", "duplicate", "reassign", "unknown"]);
    // Never re-issued by the retry rules: canceled is no open state and no retry-eligible one.
    expect(isOpenAttemptState("canceled")).toBe(false);
    expect(() => retryAction("canceled" as never, 1)).toThrow(/not legal/);
  });

  it("[sma:tr_closed] closing in words stores the words on the task row and touches no other task", () => {
    const { db } = fakeDb();
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createTask(db, { id: "t2", runId: "run1", kind: "bb", contract: taskOf("t2") });
    setTaskClosedWords(db, "t1", "obsolete: the screen was removed");
    const words = (id: string) => (db.prepare("SELECT closed_words FROM lane_pilot_task WHERE id=?").get(id) as { closed_words: string | null }).closed_words;
    expect(words("t1")).toBe("obsolete: the screen was removed");
    expect(words("t2")).toBeNull();
    expect(getTask(db, "t1")).toBeTruthy();
  });

  it("[sma:tr_approval_row] a person-decision row reads awaiting, approved, returned, closed or stopped", () => {
    const { db } = fakeDb();
    for (const [i, outcome] of ["approved", "returned", "closed", "stopped"].entries()) {
      postOwnerItem(db as never, { key: `task-word:r:F:${i}`, source: "writer", kind: "task_word", projectId: "p", what: "w", why: "y" }, 1000 + i);
      db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_at=?, closed_by=? WHERE key=?").run(2000, `${outcome}:pm`, `task-word:r:F:${i}`);
    }
    postOwnerItem(db as never, { key: "task-word:r:F:open", source: "writer", kind: "task_word", projectId: "p", what: "w", why: "y" }, 1000);
    const read = (key: string) => ownerItemOutcome(db.prepare("SELECT state, closed_by FROM lane_pilot_owner_item WHERE key=?").get(key) as never);
    expect([0, 1, 2, 3].map((i) => read(`task-word:r:F:${i}`))).toEqual(["approved", "returned", "closed", "stopped"]);
    expect(read("task-word:r:F:open")).toBe("awaiting");
    // A closer that names no outcome (the janitor) reads as plain closed.
    db.prepare("UPDATE lane_pilot_owner_item SET state='closed', closed_by='janitor:term' WHERE key='task-word:r:F:open'").run();
    expect(read("task-word:r:F:open")).toBe("closed");
  });
});

describe("the queues", () => {
  it("[sma:tr_lanes] the kind of work decides which of the four lane queues it waits in", () => {
    const kinds: Array<[string | undefined, string]> = [["feature", "write"], [undefined, "write"], ["check", "check"], ["docs", "docs"], ["research", "research"]];
    expect(kinds.map(([kind]) => laneQueueOf(kind))).toEqual(kinds.map(([, lane]) => lane));
  });

  it("[sma:tr_dead] a task whose newest attempt is blocked or spawn_rejected is a dead letter after a day, not before", () => {
    const now = 10_000_000, day = 86_400_000;
    const rows = [
      { id: "old-blocked", state: "blocked", updatedAt: now - day },
      { id: "fresh-blocked", state: "blocked", updatedAt: now - day + 1 },
      { id: "old-rejected", state: "spawn_rejected", updatedAt: now - day * 3 },
      { id: "old-accepted", state: "accepted", updatedAt: now - day * 2 },
    ];
    expect(deadLetters(rows, now).map((row) => row.id)).toEqual(["old-blocked", "old-rejected"]);
    expect(deadLetters(rows, now, 2 * day).map((row) => row.id)).toEqual(["old-rejected"]);
  });
});

describe("the attempt row", () => {
  it("[sma:tr_attempt_no] the number is minted by the queue: counts every earlier attempt of the task (ended ones too), restarts per task", () => {
    const { db } = fakeDb();
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createTask(db, { id: "t2", runId: "run1", kind: "bb", contract: taskOf("t2") });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "cancel_requested");
    transitionAttempt(db, "a1", "canceled");
    createAttempt(db, { id: "a2", runId: "run1", taskId: "t1" });
    createAttempt(db, { id: "a-1", runId: "run1", taskId: "t2" });
    createAttempt(db, { id: "a3", runId: "run1", taskId: "t1" });
    expect(["a1", "a2", "a3"].map((id) => getAttempt(db, id)!.attempt_no)).toEqual([1, 2, 3]);
    expect(getAttempt(db, "a-1")!.attempt_no).toBe(1);
    expect(listAttemptsForTask(db, "run1", "t1").map((row) => row.id)).toEqual(["a1", "a2", "a3"]);
  });

  it("[sma:tr_token] an attempt id is its token: a stale close of a settled attempt changes nothing", () => {
    const { db } = fakeDb();
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
    createAttempt(db, { id: "A1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "A1", "cancel_requested");
    transitionAttempt(db, "A1", "canceled");
    createAttempt(db, { id: "A2", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "A2", "spawn_requested");
    transitionAttempt(db, "A2", "running", { threadId: "thr_w" });
    expect(transitionAttempt(db, "A1", "accepted")).toBe(false);
    expect(getAttempt(db, "A1")?.state).toBe("canceled");
    expect(getAttempt(db, "A2")?.state).toBe("running");
    expect(db.prepare("SELECT COUNT(*) n FROM lane_pilot_attempt_transition WHERE attempt_id='A1' AND refused=1").get()).toMatchObject({ n: 1 });
  });
});

// ---- returned work: the same task queues again, one attempt higher ----
const WORKSPACE = "/ws";
const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const returnContract = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

describe("a person returns the work", () => {
  it("[sma:tr_returned] a failed task returned to its writer queues again as attempt 2 with the person's note word for word, its judging stages reset", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const sent: string[] = [];
    harness.sdk.stub("threads.listRunning", async () => []);
    harness.sdk.stub("threads.stop", async () => ({}));
    harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
    harness.sdk.stub("threads.send", async (args: { input: Array<{ text: string }> }) => { sent.push(args.input[0]!.text); return undefined; });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", WORKSPACE);
    setRunThread(db, "run1", "thr_pm");
    savePrototypeConfig(db, config);
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: returnContract("T1") });
    saveTaskPlan(db, "T1", "Plan for T1");
    for (const stage of ["pm-read", "plan-critique", "specialist-review", "writer-agent", "verification"] as const) {
      recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state: "pending", input: "Plan for T1" });
      recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state: "running", input: "Plan for T1" });
      recordStage(db, { runId: "run1", taskId: "T1", stageId: stage, state: stage === "verification" ? "failed" : "passed", input: "Plan for T1", reason: stage === "verification" ? "boom" : null });
    }
    createAttempt(db, { id: "T1-a1", runId: "run1", taskId: "T1" });
    transitionAttempt(db, "T1-a1", "spawn_requested");
    setAttemptWorkspace(db, "T1-a1", { path: "/wt/T1", environmentId: null, decision: {} });
    transitionAttempt(db, "T1-a1", "running", { threadId: "thr_w" });
    transitionAttempt(db, "T1-a1", "validation_failed", { reason: "verification failed (npm test): boom" });
    const enqueued: string[] = [];
    const services = {
      activeWriterTasks: new Set<string>(), rollback: { noteStopped: async () => undefined }, startWriterTask: vi.fn(),
      enqueueResumedWriter: async (_project: string, attempt: { id: string }) => { enqueued.push(attempt.id); return true; },
      writerReassign: createWriterReassign(ctx),
    } as unknown as Services;
    Object.assign(services, { attemptReopen: createAttemptReopen(ctx, services) });
    const api = createStageReturn(ctx, services).stageReturn;
    const note = "The test is wrong, fix the test too.";
    const result = await api.returnTask({ ref: "T1", to: "writer", note, by: "owner" });
    expect(result).toMatchObject({ ok: true, state: "restarted" });
    const attempts = listAttemptsForTask(db, "run1", "T1");
    expect(attempts.map((row) => [row.attempt_no, row.state])).toEqual([[1, "validation_failed"], [2, "queued"]]);
    expect(enqueued).toEqual([attempts[1]!.id]);
    expect(api.status("T1").returns.map((row) => [row.to, row.by, row.note, row.state, row.attemptId])).toEqual([["writer", "owner", note, "restarted", attempts[1]!.id]]);
    const stage = (id: string) => listStageReceipts(db, "run1", "T1").find((row) => row.stageId === id)?.state;
    expect([stage("verification"), stage("writer-agent"), stage("pm-read")]).toEqual(["pending", "pending", "passed"]);
    await harness.lifecycle.dispose();
  });
});

// ---- a repeated enqueue coalesces ----
const DPROJECT = "project-test", DPM = "pm-thread", DRUN = "run-idem";
const dconfig = { projectId: DPROJECT, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" };
const dtask: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:suite-green", id: "suite-green", title: "Idempotent dispatch", risk: "low", lane: "writer", project_cwd: dconfig.writerWorkspacePath,
  read_first: ["README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["hello.txt"],
  owns_paths: ["hello.txt"], never_touch: [".git/**"], depends_on: [], objective: "create hello", acceptance: ["never"], verify: "none", verification: [],
};

describe("a repeated enqueue", () => {
  it("[sma:tr_coalesce] the same task sent again inside 30 minutes is that task (one row, one attempt, deduplicated); after the window it is refused, not doubled", async () => {
    process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50";
    let releaseBase!: () => void;
    const baseHeld = new Promise<void>((resolve) => { releaseBase = resolve; });
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { projects: {
        get: async ({ projectId }) => ({ id: projectId, sources: [{ hostId: dconfig.hostId, path: dconfig.writerWorkspacePath }] }),
      }, threads: {
        getPluginMetadata: async ({ threadId }) => threadId === DPM ? { role: "pm", lanePilotRunId: DRUN } : { role: "writer" },
        spawn: async () => ({ id: "writer-idem" }),
        wait: async () => new Promise(() => undefined),
        get: async ({ threadId }) => threadId === DPM ? { id: DPM, status: "idle", projectId: DPROJECT } as never : { id: threadId, status: "active" } as never,
        output: async () => ({ text: "" }),
        list: async () => [] as never,
        stop: async () => ({} as never),
      }, environments: { listProviders: async () => [] as never }, providers: {
        list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
        models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: ["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
      }, files: { read: async () => ({ content: "fixture\n" }), write: async () => ({ ok: true }) } },
      experimental_callHostRpc: async (call) => {
        if (call.method === "gitOwnershipBase") {
          await baseHeld;
          return { hostId: "host-test", status: "ready" as const, branch: "main", headSha: "a".repeat(40), baseRef: null, baseSha: null, compareCommitted: false, reason: null };
        }
        if (call.method === "classifyPlan") return { hostId: "host-test", status: "ok", effort: "xhigh", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
        if (call.method === "readBoundedFile") {
          const input = call.input as { relativePath?: string; offset?: number; maxLines?: number };
          const body = "fixture\n";
          const lines = body.replace(/\r\n?/g, "\n").split("\n");
          const offset = input.offset ?? 0, maxLines = input.maxLines ?? 2000;
          const selected = lines.slice(offset, offset + maxLines);
          const content = selected.join("\n");
          return { schemaVersion: 1, hostId: "host-test", path: input.relativePath, content, contentEncoding: "utf8",
            sha256: sha256Hex(body), sizeBytes: Buffer.byteLength(body), totalLines: lines.length,
            offset, maxLines, lineStart: offset + 1, lineEnd: selected.length === 0 ? offset : offset + selected.length,
            truncated: offset + selected.length < lines.length, returnedBytes: Buffer.byteLength(content) };
        }
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const command = String((call.input as { command?: string }).command ?? "");
        if (command.includes("python3 - <<'PY'")) {
          return { hostId: "host-test", exitCode: 0, stdout: JSON.stringify({ state: "localNoOrigin", cwd: dconfig.writerWorkspacePath, root: dconfig.writerWorkspacePath, hasCommit: true }), stderr: "" };
        }
        return { hostId: "host-test", exitCode: 0, stdout: command.includes("porcelain") ? "[]" : "", stderr: "" };
      },
    });
    try {
      const db = openDatabase(bb);
      savePrototypeConfig(db, dconfig);
      saveProjectSetting(db, DPROJECT, "plan_critique.enabled", false);
      saveProjectSetting(db, DPROJECT, "memory.enabled", false);
      createRun(db, DRUN, DPROJECT, "bb", dconfig.writerWorkspacePath, undefined, undefined, dconfig.hostId);
      setRunThread(db, DRUN, DPM);
      await plugin(bb);
      const dispatch = async () => JSON.parse(String(await harness.behavior.callAgentTool(
        "lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка диспетча", plan: "Plan for the idempotent dispatch", task: dtask }, { threadId: DPM, projectId: DPROJECT },
      ))) as Record<string, unknown>;
      const first = await dispatch();
      expect(first, JSON.stringify(first)).toHaveProperty("attemptId");
      const again = await dispatch();
      const third = await dispatch();
      expect(first.deduplicated).toBeUndefined();
      expect(again).toMatchObject({ taskId: "suite-green", attemptId: first.attemptId, state: "queued", deduplicated: true });
      expect(third).toMatchObject({ taskId: "suite-green", attemptId: first.attemptId, deduplicated: true });
      const count = (table: string) => (db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE run_id=?`).get(DRUN) as { n: number }).n;
      expect([count("lane_pilot_task"), count("lane_pilot_attempt")]).toEqual([1, 1]);
      // Past the window the repeat does not coalesce any more: it is refused while the first is open, and still no second row.
      db.prepare("UPDATE lane_pilot_task SET created_at=? WHERE id='suite-green'").run(Date.now() - 31 * 60_000);
      const later = await dispatch();
      expect(later.deduplicated).toBeUndefined();
      expect(later).toMatchObject({ ok: false, error: { code: "task_in_progress" } });
      expect([count("lane_pilot_task"), count("lane_pilot_attempt")]).toEqual([1, 1]);
    } finally {
      releaseBase();
      delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
      await harness.lifecycle.dispose();
    }
  });
});
