import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { registeredTools } from "../../src/rooms/platform/server";
import { createPhaseDriver } from "../phase-driver";
import { createAttempt, createRun, createTask, openDatabase } from "../../src/rooms/plugin-db";
import { transitionAttempt } from "../../src/rooms/storage";
import { registerConversationTools } from "../../src/rooms/tasks/server/conversation-tools";
import { bindBacklogIssued, registerQueueTool } from "../../src/rooms/tasks/server/queue-tool";
import { backlogIssuedTo } from "../../src/rooms/backlog";
import { lintContract, type LintInput } from "../../src/rooms/tasks/server/contract-lint";
import { BIRTH_GATES, birthGates, birthFindings, factKind, priorityRank, queueOrder, STAGE_PRIORITY_RANK } from "../../src/rooms/tasks";
import { RunWriterPool } from "../../src/rooms/tasks/run-policy";
import { buildGateReport, type GateAck } from "../../src/rooms/tasks/gate-report";
import type { GateEventRow, StageEventRow } from "../../src/rooms/storage";
import type { TaskV2 } from "../../src/rooms/contracts";

const root = "/tmp/sma-a4";
const baseTask: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:sma", id: "sma-a4", title: "SMA", risk: "low", lane: "writer", project_cwd: root,
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/b.ts"],
  owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "change a", acceptance: ["done"],
  verify: "tests", verification: [],
};
const lint = (task: Partial<TaskV2> = {}, input: Partial<LintInput> = {}) =>
  lintContract({ task: { ...baseTask, ...task }, workspacePath: root, hostId: "h", sandboxUnsafe: [], openTasks: [], deadDependencies: [],
    kinds: new Map(), ...input });

const gateEvent = (over: Partial<GateEventRow>): GateEventRow => ({
  id: 0, projectId: "p", runId: "r", taskId: "t", gate: "accept", status: "passed", inputSha256: "i", outputSha256: null, attempt: 1, occurredAt: 50, ...over,
});

describe("parity a4-tasks", () => {
  it("[sma:pc_priority] a phase piece outranks an urgent backlog task by default, and a plan-set priority wins", () => {
    const rows = [
      { id: "urgent-pm", priority: "urgent", birth: "pm", queuedAt: 1 },
      { id: "phase-piece", birth: "phase", queuedAt: 5 },
      { id: "phase-low", priority: "low", birth: "phase", queuedAt: 3 },
    ];
    expect(queueOrder(rows).map((row) => row.id)).toEqual(["phase-piece", "urgent-pm", "phase-low"]);
    expect(priorityRank(undefined, "phase")).toBe(STAGE_PRIORITY_RANK);
    expect(priorityRank("urgent")).toBeLessThan(STAGE_PRIORITY_RANK);
    expect(priorityRank("low", "phase")).toBe(priorityRank("low"));
    expect(queueOrder([{ id: "piece-low", priority: "low", birth: "phase", queuedAt: 1 }, { id: "normal-pm", birth: "pm", queuedAt: 2 }]).map((row) => row.id))
      .toEqual(["normal-pm", "piece-low"]);
  });

  it("[sma:ap_design_kin] a task only follows a drawing confirmed for its own run, and a phase piece passes by construction", () => {
    const foreign = lint({ drawing: ["design/x.png"], kind: "feature" }, { confirmedDrawings: [{ paths: ["design/y.png"], sha256: "a" }] });
    expect(foreign.errors.map((error) => error.code)).toContain("drawing_kin");
    // No phase drew for this run: a standalone task follows its own mock-up — said in a warning, not refused.
    const none = lint({ drawing: ["design/x.png"] });
    expect(none.errors.map((error) => error.code)).not.toContain("drawing_kin");
    expect(none.warnings.map((warning) => warning.code)).toContain("drawing_unconfirmed");
    const kin = lint({ drawing: ["design/x.png"] }, { confirmedDrawings: [{ paths: ["design/x.png", "design/UI-SPEC.md"], sha256: "a" }] });
    expect(kin.errors.map((error) => error.code)).not.toContain("drawing_kin");
    expect(kin.warnings.map((warning) => warning.code)).not.toContain("drawing_unconfirmed");
    // A file of the confirmed drawing changed after the design stage confirmed it: the kinship is broken.
    const stale = lint({ drawing: ["design/x.png"] }, { confirmedDrawings: [{ paths: ["design/x.png"], sha256: "a", changed: true }] });
    expect(stale.errors.map((error) => error.code)).toContain("drawing_kin");
    const piece = lint({ drawing: ["design/x.png"] }, { birth: "phase", confirmedDrawings: [] });
    expect(piece.errors.map((error) => error.code)).not.toContain("drawing_kin");
  });

  it("[sma:tb_birth_kinds] the birth kind chooses the gates", () => {
    const task = { kind: "feature", risk: "medium" };
    expect(birthFindings(task, "pm").warnings.map((row) => row.code)).toContain("promise_missing");
    expect(birthFindings(task, "phase").errors.map((row) => row.code)).toContain("promise_missing");
    expect(birthFindings(task, "bench")).toEqual({ errors: [], warnings: [] });
    expect(birthGates("pm").topicLoop).toBe(true);
    expect(birthGates("workflow").topicLoop).toBe(true);
    expect(BIRTH_GATES.phase.topicLoop).toBe(false);
    // A redo gets the gates of the birth it redoes.
    expect(birthGates("redo", "phase").topicLoop).toBe(false);
    // A redo is the machine's own issue: the topic-loop guard never stops it, and a backlog issue is not the PM's repeated try.
    expect(birthGates("redo", "pm").topicLoop).toBe(false);
    expect(birthGates("redo", "pm").promise).toBe("warn");
    expect(birthGates("backlog").topicLoop).toBe(false);
    const screenTask = { kind: "feature", risk: "high", owns_paths: ["src/ui/a.tsx"], promise: { given: "g", when: "w", then: "t" } };
    expect(birthFindings(screenTask, "pm").warnings.map((row) => row.code)).toContain("drawing_needed");
    expect(birthFindings(screenTask, "phase").warnings.map((row) => row.code)).not.toContain("drawing_needed");
  });

  it("[sma:dt_idle] a busy pool is named, and a pass with no live phase says so", async () => {
    const pool = new RunWriterPool();
    expect(pool.busy("provider-pool:x", 1)).toBe(false);
    const release = await pool.acquire("provider-pool:x", 1);
    expect(pool.busy("provider-pool:x", 1)).toBe(true);
    release();
    expect(pool.busy("provider-pool:x", 1)).toBe(false);
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const { phases } = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services);
    const pass = await phases.tick();
    expect(pass).toMatchObject({ moved: 0, idle: "no live phase" });
    await harness.lifecycle.dispose();
  });

  it("[sma:m_ck_answer] a repeated check turn returns the receipt of the one run, a changed request starts another", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    let runs = 0;
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    bb.hosts.experimental_client = (() => ({
      call: async (method: string, input: { command: string }) => {
        if (method === "gitCreateWorktree") return { hostId: "host1", status: "ready", path: "/ws_chk", branch: "lane/chk", reason: null, baseSha: "abc123" };
        if (method === "gitRemoveWorktree") return { hostId: "host1", removed: true };
        if (method === "runCommand") {
          if (input.command.includes("rev-parse")) return { hostId: "host1", exitCode: 0, stdout: "abc123\n", stderr: "" };
          return { hostId: "host1", exitCode: 0, stdout: "---PKG---\n{}", stderr: "" };
        }
        runs += 1; return { hostId: "host1", backend: "linux-bubblewrap", exitCode: 0, stdout: `ok ${input.command}`, stderr: "", policySha256: "a".repeat(64) };
      },
    })) as never;
    const db = openDatabase(bb);
    createRun(db, "run1", "proj", "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host1");
    registerConversationTools({ db, bb } as never, { spendByModel: () => [] });
    const check = registeredTools(bb.agents).get("lane_pilot_check")!;
    const ctx = { threadId: "thr_pm", projectId: "proj", signal: new AbortController().signal };
    const commands = [{ command: "npm test", cwd: ".", timeoutSec: 30, expectExit: 0 }];
    const first = JSON.parse(String(await check.execute({ action: "run", request: "run tests", commands }, ctx)));
    const second = JSON.parse(String(await check.execute({ action: "run", request: "run tests", commands }, ctx)));
    expect(runs).toBe(1);
    expect(second.checkId).toBe(first.checkId);
    expect(second.deduplicated).toBe(true);
    expect(second.state).toBe("passed");
    const other = JSON.parse(String(await check.execute({ action: "run", request: "run tests", commands: [{ ...commands[0]!, command: "npm run lint" }] }, ctx)));
    expect(runs).toBe(2);
    expect(other.checkId).not.toBe(first.checkId);
    expect(other.deduplicated).toBeUndefined();
    // A minute later the same commands are a new check: the code may have been fixed, an old answer would hide it.
    const realNow = Date.now;
    Date.now = () => realNow() + 60_000;
    try {
      const later = JSON.parse(String(await check.execute({ action: "run", request: "run tests", commands }, ctx)));
      expect(runs).toBe(3);
      expect(later.deduplicated).toBeUndefined();
    } finally { Date.now = realNow; }
    await harness.lifecycle.dispose();
  });

  it("[sma:m_ce_classify] the stage question is answered from lane_pilot_phase by code, spend stays the limit", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const db = openDatabase(bb);
    const phasesOf = (pmThreadId: string) =>
      pmThreadId === "thr_pm" ? [{ id: "ph_1", title: "Sums", stage: "execution", state: "active", next: "wave 2: issue the pieces" }] : [];
    registerConversationTools({ db, bb } as never, { spendByModel: () => [], phasesOf });
    const facts = registeredTools(bb.agents).get("lane_pilot_facts")!;
    const ctx = { threadId: "thr_pm", projectId: "proj", signal: new AbortController().signal };
    const ask = async (question: string) => JSON.parse(String(await facts.execute({ question }, ctx)));
    expect(factKind("на каком этапе фаза?")).toBe("stage");
    const stage = await ask("на каком этапе фаза?");
    expect(stage.kind).toBe("stage");
    expect(stage.phases).toEqual([expect.objectContaining({ id: "ph_1", stage: "execution", next: "wave 2: issue the pieces" })]);
    expect(stage.sources[0]).toContain("lane_pilot_phase");
    expect(factKind("сколько потратили")).toBe("limit");
    const spend = await ask("сколько потратили");
    expect(spend.kind).toBe("limit");
    await harness.lifecycle.dispose();
  });

  it("[sma:m_in_close_line] a backlog line is closed only by an accepted task of the run it was issued to", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    let closed = 0;
    bb.hosts.experimental_client = (() => ({ call: async () => { closed += 1; return { status: "closed" }; } })) as never;
    const db = openDatabase(bb);
    createRun(db, "run1", "proj", "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host1");
    createTask(db, { id: "task-done", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a-done", runId: "run1", taskId: "task-done" });
    transitionAttempt(db, "a-done", "accepted");
    createTask(db, { id: "task-queued", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a-queued", runId: "run1", taskId: "task-queued" });
    transitionAttempt(db, "a-queued", "queued");
    db.prepare("INSERT INTO lane_pilot_backlog_issue(project_id,todo_id,pm_thread_id,estimate,issued_at) VALUES (?,?,?,?,?)").run("proj", "t-own", "thr_pm", "5", 1);
    db.prepare("INSERT INTO lane_pilot_backlog_issue(project_id,todo_id,pm_thread_id,estimate,issued_at) VALUES (?,?,?,?,?)").run("proj", "t-other", "thr_other_pm", "5", 1);
    // The backlog room hands its «issued to» reader to the queue tool when it starts; the test does the same.
    bindBacklogIssued(db, (projectId, todoId) => backlogIssuedTo(db, projectId, todoId));
    registerQueueTool({ db, bb } as never, { answer: () => undefined } as never);
    const queue = registeredTools(bb.agents).get("lane_pilot_queue")!;
    const ctx = { threadId: "thr_pm", projectId: "proj", signal: new AbortController().signal };
    const call = async (input: Record<string, unknown>): Promise<{ err?: string; out?: Record<string, unknown> }> => {
      try { return { out: JSON.parse(String(await (queue.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, ctx))) as Record<string, unknown> }; }
      catch (cause) { return { err: (cause as { code?: string }).code }; }
    };
    expect((await call({ action: "close_backlog", id: "t-own", taskId: "task-queued" })).err).toBe("not_accepted");
    expect(closed).toBe(0);
    expect((await call({ action: "close_backlog", id: "t-other", taskId: "task-done" })).err).toBe("not_issued");
    expect(closed).toBe(0);
    const ok = await call({ action: "close_backlog", id: "t-own", taskId: "task-done" });
    expect(ok.err).toBeUndefined();
    expect(closed).toBe(1);
    // A line the scanner handed to nobody (the PM took it on the owner's word) is closed by its accepted work.
    expect((await call({ action: "close_backlog", id: "t-by-hand", taskId: "task-done" })).err).toBeUndefined();
    expect(closed).toBe(2);
    await harness.lifecycle.dispose();
  });

  it("[sma:k_v_gates] an acked firing is a false alarm, and a task with every gate passed is marked full", () => {
    const gates: GateEventRow[] = [
      gateEvent({ id: 1, taskId: "t-ack", gate: "accept", status: "rejected", occurredAt: 60 }),
      gateEvent({ id: 2, taskId: "t-real", gate: "accept", status: "rejected", occurredAt: 70 }),
      ...(["owns-paths", "validate", "accept", "verification"] as const).map((gate, index) =>
        gateEvent({ id: 10 + index, taskId: "t-full", runId: "r", gate, status: "passed", attempt: 2, occurredAt: 80 })),
      ...(["owns-paths", "validate", "accept"] as const).map((gate, index) =>
        gateEvent({ id: 20 + index, taskId: "t-part", runId: "r", gate, status: "passed", attempt: 1, occurredAt: 90 })),
    ];
    const acks: GateAck[] = [{ eventId: 1, why: "the file was renamed before the task", by: "owner", at: 1 }];
    const report = buildGateReport({ projectId: "p", days: 1, now: 100 }, [] as StageEventRow[], gates, acks);
    const accept = report.byGate.find((row) => row.gate === "accept")!;
    expect(accept.byStatus.rejected).toBe(2);
    expect(accept.falseAlarms).toBe(1);
    expect(report.recentGateBlockers.map((row) => row.taskId)).toEqual(["t-real"]);
    const full = Object.fromEntries(report.fullGate!.map((row) => [row.taskId, row.full]));
    expect(full["t-full"]).toBe(true);
    expect(full["t-part"]).toBe(false);
  });
});
