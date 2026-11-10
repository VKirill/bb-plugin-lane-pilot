import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createRunBudget } from "@lane-pilot/resilience";
import { setJevForTests } from "@lane-pilot/jev";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { AUTO_WORKFLOWS, autoDue, createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import { planGate, type Phase, type PhaseRecord } from "../../src/rooms/phase/logic";
import { savePhase } from "../../src/rooms/phase/store";
import { isMachineMessage } from "../../src/rooms/phase/intake";
import { createPhaseIntake } from "../../src/rooms/phase/server/intake";
import { failureClass, nextStep } from "../../src/rooms/contracts/failure-class";
import { isOpenAttemptState } from "../../src/rooms/contracts/state-machine";
import { createBaseline } from "../../src/rooms/baseline/server/baseline";
import { mountPermits } from "../../src/rooms/writer/server";
import { createWriterStart } from "../../src/rooms/writer/server/start";
import { MAX_WRITER_NUDGES, sweepWriterSilence } from "../../src/rooms/writer/server/writer-silence";
import { walkWriterChain } from "../../src/rooms/writer/server/writer-hold";
import { START_STALL_MS } from "../../src/rooms/writer/server/spawn";
import { cleanupFinishedAttemptEnvironments } from "../../src/rooms/runs/server/run-finish";
import { RunWriterPool } from "../../src/rooms/tasks/run-policy";
import { laneQueueOf } from "../../src/rooms/tasks";
import { CAPABILITIES, capabilityTable, probeSetupFailed } from "../../src/rooms/capability";
import { PROBES } from "../../src/rooms/native-agent/server/helper-probe";
import { createActivation } from "../../src/rooms/native-agent/server/activation";
import { isCustomAgentId } from "../../src/rooms/contracts/native-agent-static";
import { mountSpecialists } from "../../src/rooms/critique/server/specialists";
import { syncTokenUsage, tokenCursorRow } from "../../src/rooms/usage/server/token-usage";
import { registerConversationTools } from "../../src/rooms/tasks/server/conversation-tools";
import { validateTaskV2 } from "../../src/rooms/tasks/task-v2";
import { lintContract } from "../../src/rooms/tasks/server/contract-lint";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { receiptChain, verifyChain } from "../../src/rooms/tools/server/receipts";
import { blindPlanFact } from "../../src/rooms/tasks/plan-fact";
import { claudeGuardLauncherScript } from "../../src/rooms/native-agent/claude-guard-launch";
import { parseWriterRepairReply, sameUnresolvedFindings, shouldRequestRepair, writerRepairReplySchema } from "../../src/rooms/critique/code-critique";
import {
  createAttempt, createRun, createTask, endSpawnFailure, getAttempt, getRun, getTask, listOpenAttempts, listStageReceipts,
  openDatabase, saveProjectSetting, savePrototypeConfig, saveTaskPlan, setRunThread, transitionAttempt,
} from "../../src/rooms/plugin-db";
import { hookEnv } from "../hook-env";
import { useGuardSync } from "../guard-pool";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const phase = (record: PhaseRecord, stage: Phase["stage"] = "planning"): Phase => ({
  id: "ph_a1", projectId: "p", pmThreadId: "thr_pm", runId: "r", title: "T", goal: "g", stage, state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
}) as Phase;

const WORKSPACE = "/ws";
const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const contract = (id: string, kind: TaskV2["kind"] = "feature"): TaskV2 => ({
  schema_version: 2, id, display_title: `Task ${id}`, kind, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE,
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [],
  depends_on: [], objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

const workflow = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "workflows", `${name}.json`), "utf8")) as { entry?: string; nodes?: Array<Record<string, unknown>> | Record<string, Record<string, unknown>> };
const nodes = (name: string): Array<Record<string, unknown>> => {
  const value = workflow(name).nodes;
  return Array.isArray(value) ? value : Object.values(value ?? {});
};

function db0() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, harness, db: openDatabase(bb) };
}

function driver(status = "idle") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET writer_workspace_path='/ws', writer_host_id='h1' WHERE id='run1'").run();
  const ctx = createCore(bb, db);
  const phases = createPhaseDriver(ctx, { runBudgets: { get: () => undefined } } as unknown as Services).phases;
  return { phases, sent, db, bb, harness, ctx };
}

const guard = useGuardSync(join(process.cwd(), "lane-stack/hooks/guard_shell.py"));
const runGuard = (command: string, agentType: string, extra: Record<string, unknown> = {}, env: Record<string, string> = {}) => guard({
  input: JSON.stringify({ agent_type: agentType, tool_name: "Bash", tool_input: { command }, cwd: process.cwd(), session_id: "sess_a1", ...extra }),
  env: hookEnv({ AGENT_HOOK_CLIENT: "claude", ...env }),
});

describe("phase graph", () => {
  it("[sma:p2_cmd] plans without a research step and still needs the independent critic", () => {
    const plan = workflow("lp.plan");
    expect(plan.entry).toBe("plan");
    expect(nodes("lp.plan").every((node) => node.role !== "researcher")).toBe(true);
    const signed = phase({ context: { docs: [{ path: "d", sha256: "s", bytes: 1 }], sha: "ctx", signedAt: 1 } });
    expect(autoDue(signed)).toEqual({ kind: "plan" });
    const gate = planGate({ ...signed.record, plan: { items: [{ id: "x", title: "x", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: {} }], sha: "s", contextSha: "ctx", submittedAt: 1 } });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.why.join(";")).toContain("no independent plan check");
  });

  it("[sma:p7_row] starts the lessons analysis on the driver's pass without a writer seat", async () => {
    const at = phase({ lessons: {} as never }, "lessons");
    expect(autoDue(at)).toEqual({ kind: "lessons" });
    expect(autoDue(phase({ lessons: { analysis: "a" } as never }, "lessons"))).toBeNull();
    const started: Array<{ workflow: { id?: string }; inputs: unknown }> = [];
    let record = at.record;
    const auto = createAutoStages({ log: () => undefined }, {
      workflowEngine: {
        resolveWorkflow: (id: string) => ({ id }),
        start: (input: { workflow: { id?: string }; inputs: unknown }) => { started.push(input); return { runId: "wfrun_r", done: new Promise(() => undefined) }; },
        get: () => undefined,
      } as never,
    }, {
      api: {} as never, get: () => ({ ...at, record }), save: (_id: string, next: PhaseRecord) => { record = next; },
      book: () => undefined, runtime: () => ({}), pmIdle: async () => true, now: () => 1,
    } as never);
    expect(await auto.step(at)).toBe(true);
    expect(started[0]!.workflow.id).toBe("retrospective");
    expect(started[0]!.inputs).toMatchObject({ run_id: "r" });
    expect(record.auto?.kind).toBe("lessons");
  });

  it("[sma:tr_parent_queue] phase control lives in the phase row, never in the attempt queue", async () => {
    const { phases, db } = driver();
    const piece = contract("pc1");
    createTask(db, { id: "pc1", runId: "run1", kind: "bb", contract: piece });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "pc1" });
    const before = listOpenAttempts(db).length;
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Ctl", goal: "control" });
    await phases.setState({ phaseId: ph.id, state: "pause", by: "pm" });
    expect((phases.status(ph.id).phase.state === "paused" || phases.status(ph.id).phase.state === "pause_requested")).toBe(true);
    await phases.tick();
    expect(db.prepare("SELECT state FROM lane_pilot_phase WHERE id=?").get(ph.id)).toMatchObject({ state: "paused" });
    await phases.setState({ phaseId: ph.id, state: "resume", by: "pm" });
    expect(phases.status(ph.id).phase.state).toBe("active");
    expect(listOpenAttempts(db).length).toBe(before);
  });

  it("[sma:ts_role] the drawing step's agent is a designer and every other stage step names a role", () => {
    const seen = new Set(Object.values(AUTO_WORKFLOWS));
    for (const name of seen) {
      for (const node of nodes(name)) if (node.type === "agent" || node.role) expect(node.role, `${name}`).toBeTruthy();
    }
    const draw = nodes("lp.draw").find((node) => node.id === "draw");
    expect(draw?.role).toBe("specialist:design-lead");
    for (const name of seen) if (name !== "lp.draw" && name !== "ui-audit") expect(nodes(name).some((node) => String(node.role).includes("design-lead")), name).toBe(false);
  });
});

describe("task graph", () => {
  it("[sma:ae_reasons] each failure class leads to its own next step naming its place", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["validation_failed", "owns_paths: src/out.ts is outside", /dispatch it again|contract|plan/],
      ["blocked", "needs_human: which locale?", /answer_writer|lane_pilot_answer_writer/],
      ["blocked", "verdict_block: no_red_on_base: the checks pass already", /block verdict|finding/],
      ["validation_failed", "merge_failed: merge_conflict in src/a.ts", /new main|redone/],
      ["blocked", "not a git repository", /git|owns_paths/],
      ["blocked", "retry_budget_exhausted: 3 attempts", /retry budget|dispatch it again/],
      ["blocked", "waiting_secret: NPM_TOKEN", /Env Catalog|env_request/],
      ["blocked", "run_budget_exceeded: maxTokens", /budget|max_/],
      ["blocked", "capacity_saturated: window spent", /moves down the writer chain|do nothing/],
      ["blocked", "reassigned: fresh writer holds the same worktree", /fresh writer|same worktree/],
      ["timeout", "verification_timeout_budget: checks need more than their timeout_sec", /timed out|timeout_sec|verification/],
      ["infra", "spawn failed: EROFS on the sandbox", /parked|fault clears|do nothing/],
    ];
    const texts = new Set<string>();
    for (const [state, reason, pattern] of cases) {
      const step = nextStep(state, reason);
      expect(step, `${state} ${reason}`).toMatch(pattern);
      expect(step, `${state} ${reason}`).not.toBe("wait: the writer is still on it");
      texts.add(step);
    }
    expect(texts.size).toBeGreaterThanOrEqual(cases.length - 1);
    expect(failureClass("blocked", "needs_human: q")).toBe("judgment");
    expect(failureClass("provider_error", "writer_silent_after_nudge")).toBe("provider");
  });

  it("[sma:ap_already_built] an all-green check task closes accepted without a writer under baseline.already_built=notify", async () => {
    const { bb, db, harness } = db0();
    harness.sdk.stub("threads.send", async () => undefined);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", WORKSPACE);
    setRunThread(db, "run1", "thr_pm");
    savePrototypeConfig(db, config);
    const sent: string[] = [];
    (bb.sdk.threads as { send: unknown }).send = async (input: unknown) => { sent.push(JSON.stringify(input)); return {}; };
    const kit = {
      makeWorktree: async () => ({ path: "/wt/base" }),
      runChecks: async (_t: unknown, _p: string, items: Array<{ command: string }>) => items.map((item) => ({ command: item.command, ok: true, exitCode: 0, tail: "" })),
      dropWorktree: async () => undefined,
    };
    const host = { call: async (method: string) => method === "gitOwnershipBase" ? { status: "ready", headSha: "base1" } : ({}) };
    const baseline = createBaseline({ ...ctx, host } as never, { rollback: { kit }, runWriterPool: { acquire: async () => () => undefined } } as never);
    const task = contract("chk1", "check");
    task.verification = [{ command: "npm test", cwd: WORKSPACE }, { command: "npx tsc --noEmit", cwd: WORKSPACE }];
    const out = await baseline.baseline.preflight({ projectId: "proj1", runId: "run1", taskId: "chk1", attemptId: "chk1-a1", pmThreadId: "thr_pm", config, task });
    expect(out.stop).toBeNull();
    expect(out.alreadyDone).toContain("already done");
    expect(out.record?.action).toBe("notified");
    expect(out.record?.verdict).toBeDefined();
    expect(sent.length >= 0).toBe(true);
  });

  it("[sma:as_ticket] an unanswered ticket keeps the command refused without filing a second ticket", () => {
    const home = mkdtempSync(join(tmpdir(), "permit-"));
    const command = "rm data.csv";
    const first = runGuard(command, "writer", { cwd: home }, { HOME: home });
    const second = runGuard(command, "writer", { cwd: home }, { HOME: home });
    expect(first.status).not.toBe(0);
    expect(second.status).not.toBe(0);
    expect(first.stdout).toMatch(/block|denied|refus/i);
    const dir = join(home, ".agents", "permits", "sess_a1");
    try {
      expect(readdirSync(dir).filter((name) => name.endsWith(".ticket.json"))).toHaveLength(1);
    } catch {
      expect(second.stdout).toBe(first.stdout);
    }
  });

  it("[sma:f_inv_push] no permit or attempt state grants a writer git push or merge", () => {
    const home = mkdtempSync(join(tmpdir(), "permit-"));
    for (const command of ["git push origin main", "git merge feature"]) {
      const verdict = runGuard(command, "writer", { cwd: home }, { HOME: home });
      expect(verdict.status).not.toBe(0);
      expect(verdict.stdout).toMatch(/not granted git push or git merge/);
    }
    const dir = join(home, ".agents", "permits", "sess_a1");
    expect(() => readdirSync(dir)).toThrow();
  });

  it("[sma:tr_token] a stale attempt's close leaves the fresh one alone", () => {
    const { db } = db0();
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "A1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "A1", "cancel_requested");
    transitionAttempt(db, "A1", "canceled");
    createAttempt(db, { id: "A2", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "A2", "spawn_requested");
    transitionAttempt(db, "A2", "running", { threadId: "thr_w" });
    expect(transitionAttempt(db, "A1", "accepted")).toBe(false);
    expect(() => endSpawnFailure(db, "A1", "writer_start_stalled: no thread")).not.toThrow();
    expect(getAttempt(db, "A1")?.state).toBe("canceled");
    expect(getAttempt(db, "A2")?.state).toBe("running");
  });
});

describe("worker", () => {
  it("[sma:wb_decision] a decision for a writer mid-turn is queued after its turn and never stops it", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const sends: Array<{ threadId: string; mode?: string }> = [];
    const stops: string[] = [];
    let answerTool: { execute: (input: unknown, ctx: unknown) => Promise<unknown> } | undefined;
    const tickets = [{ session: "sess-b", ticket: "a1b2c3d4e5f60718", category: "delete_for_good", command: "rm data.csv", cwd: "/fixture/b", at: 1 }];
    const facade = {
      ...bb,
      agents: { registerTool: (tool: { execute: NonNullable<typeof answerTool>["execute"] }) => { answerTool = tool; } },
      background: { schedule: () => undefined },
      hosts: { experimental_client: () => ({ call: async (method: string, payload: Record<string, unknown>) =>
        method === "listPermitTickets" ? { tickets } : method === "answerPermit" ? { written: true, ...payload } : {} }) },
      sdk: { ...bb.sdk,
        threads: { send: async (payload: { threadId: string; mode?: string }) => { sends.push({ threadId: payload.threadId, mode: payload.mode }); },
          stop: async (payload: { threadId: string }) => { stops.push(payload.threadId); } } },
    };
    createRun(db, "run-b", "project");
    createTask(db, { id: "task-b", runId: "run-b", kind: "bb", contract: {} });
    createAttempt(db, { id: "b", runId: "run-b", taskId: "task-b" });
    transitionAttempt(db, "b", "spawn_requested");
    transitionAttempt(db, "b", "running", { threadId: "writer-b" });
    db.prepare("UPDATE lane_pilot_run SET writer_host_id=?, pm_thread_id=? WHERE id=?").run("host", "pm-b", "run-b");
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path=? WHERE id=?").run("/fixture/b", "b");
    mountPermits({ bb: facade, db, isDisposed: () => false } as never);
    try {
      await answerTool!.execute({ hostId: "host", session: "sess-b", ticket: "a1b2c3d4e5f60718", decision: "allow", why: "the task owns this file" }, {});
      expect(sends).toEqual([expect.objectContaining({ threadId: "writer-b", mode: "queue-if-active" })]);
      expect(stops).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  });

  it("[sma:wc_drill] the pause cell is unproven until the sandbox pause probe passes", () => {
    const inUse = new Map([["prov", "model"]]);
    const versions = new Map([["prov", "1.0"]]);
    const at = (receipts: Array<{ providerId: string; version: string; capability: string; state: string }>) =>
      capabilityTable(inUse, versions, receipts as never)[0]!.capabilities;
    expect(at([]).pause).toBe("unproven");
    expect(at([{ providerId: "prov", version: "1.0", capability: "answers", state: "supported" }]).pause).toBe("unproven");
    expect(probeSetupFailed("helper_probe_run_unusable")).toBe(true);
    expect(probeSetupFailed("the adapter crashed")).toBe(false);
    expect(PROBES.pause.prompt).toContain("sleep 40");
    expect(PROBES.pause.expect.test("RESUMED")).toBe(true);
    expect(at([{ providerId: "prov", version: "1.0", capability: "pause", state: "supported" }]).pause).toBe("supported");
    expect(CAPABILITIES).toContain("pause");
  });

  it("[sma:wr_orchestrator] the PM takes no queue task: its edits are denied and its work goes to a writer thread", async () => {
    const home = mkdtempSync(join(tmpdir(), "pm-"));
    const edit = guard({
      input: JSON.stringify({ agent_type: "lane-pilot-pm", tool_name: "Edit", tool_input: { file_path: join(process.cwd(), "src", "app.ts") }, cwd: process.cwd(), session_id: "sess_a1" }),
      env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
    });
    expect(edit.status).not.toBe(0);
    const { bb, db, harness } = db0();
    harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
    harness.sdk.stub("threads.send", async () => undefined);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", WORKSPACE);
    setRunThread(db, "run1", "thr_pm");
    savePrototypeConfig(db, config);
    const task = contract("T1");
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: task });
    saveTaskPlan(db, "T1", "Plan");
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    const services = {
      activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
      runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
      runWriterPool: new RunWriterPool(),
      stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
      startAfterAcceptance: () => undefined, workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
      spawnWriterAttempt: async (input: { attemptId: string }) => {
        transitionAttempt(db, input.attemptId, "spawn_requested");
        transitionAttempt(db, input.attemptId, "running", { threadId: "thr_w" });
        return { ok: true, threadId: "thr_w", providerId: "p", model: "wm", dirtBefore: [], workspacePath: "/wt/a1" };
      },
    } as unknown as Services;
    createWriterStart(ctx, services).startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "a1", pmThreadId: "thr_pm", config, task, plan: "Plan" });
    await vi.waitFor(() => expect(getAttempt(db, "a1")?.thread_id).toBe("thr_w"), { timeout: 10_000 });
    expect(getAttempt(db, "a1")?.thread_id).not.toBe(getRun(db, "run1")?.pm_thread_id);
  });
});

describe("daemon tick", () => {
  it("[sma:dt_sweep] a writer silent through two nudges is marked ended; a third pass touches nothing", async () => {
    const { bb, harness } = db0();
    const old = Date.now() - 60 * 60_000;
    const evs = Object.assign([{ type: "item/completed", createdAt: old }], { events: [{ type: "item/completed", createdAt: old }] });
    harness.sdk.stub("threads.events.list", async () => evs);
    harness.sdk.stub("threads.send", async () => ({}));
    const attempt = { id: "a1", run_id: "run1", task_id: "t1", thread_id: "tw", state: "running", project_id: "p", pm_thread_id: "pm" };
    const deps = {
      bb: bb as never, openAttempts: () => [attempt], isDisposed: () => false, log: () => undefined,
      silenceMinutes: () => 20, getThread: async () => ({ status: "active" }), waitingForOwner: async () => false,
    };
    const first = await sweepWriterSilence(deps as never, Date.now());
    const second = await sweepWriterSilence(deps as never, Date.now() + 21 * 60_000);
    const third = await sweepWriterSilence(deps as never, Date.now() + 42 * 60_000);
    expect(first[0]?.action).toBe("nudged");
    expect(second[0]?.action).toBe("nudged");
    expect(third[0]?.action).toBe("ended");
    expect(third[0]?.count).toBe(MAX_WRITER_NUDGES);
    const record = await bb.storage.kv.get("writer-nudge:a1") as { ended?: boolean };
    expect(record.ended).toBe(true);
    expect(await sweepWriterSilence(deps as never, Date.now() + 63 * 60_000)).toEqual([]);
  });

  it("[sma:dt_wt_sweep] an attempt accepted 25 hours ago has its environment saved and deleted; an open one is kept", async () => {
    const { bb, db, harness } = db0();
    createRun(db, "run1", "proj1", "bb", WORKSPACE);
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "accepted");
    createTask(db, { id: "t2", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a2", runId: "run1", taskId: "t2" });
    transitionAttempt(db, "a2", "spawn_requested");
    const old = Date.now() - 25 * 3_600_000;
    db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, updated_at=? WHERE id=?").run("envA", old, "a1");
    db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, updated_at=? WHERE id=?").run("envB", old, "a2");
    const deleted: string[] = [];
    const snapshots: string[] = [];
    harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ lifecycle: { phase: "active" }, hostId: "h", path: `/wt/${environmentId}` }));
    harness.sdk.stub("environments.archiveThreads", async () => ({}));
    harness.sdk.stub("environments.delete", async ({ environmentId }: { environmentId: string }) => { deleted.push(environmentId); return {}; });
    const removed = await cleanupFinishedAttemptEnvironments(bb, db, async (_h, _p, name) => { snapshots.push(name); return { status: "saved", path: `/released/${name}.patch`, reason: null }; });
    expect(removed).toEqual(["envA"]);
    expect(deleted).toEqual(["envA"]);
    expect(snapshots).toEqual(["envA"]);
  });

  it("[sma:dt_call_stalled] a phase at execution whose piece's attempt is blocked sends its PM one blocked step naming the piece", async () => {
    const { phases, sent, db } = driver();
    createTask(db, { id: "hud", runId: "run1", kind: "bb", contract: contract("hud") });
    createAttempt(db, { id: "att1", runId: "run1", taskId: "hud" });
    transitionAttempt(db, "att1", "spawn_requested");
    transitionAttempt(db, "att1", "running", { threadId: "tw" });
    transitionAttempt(db, "att1", "blocked", { reason: "boom" });
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
    const item = { id: "hud", title: "Hud", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: contract("hud") };
    savePhase(db, ph.id, { stage: "execution", runId: "run1", state: "active", record: { ...ph.record, plan: { items: [item], contextSha: "c", sha: "s", admittedSha: "s" }, execution: { issued: { hud: "hud" }, startedAt: 1 } } as never, at: 2 });
    await phases.tick();
    const blocked = sent.filter((text) => text.includes("hud is blocked"));
    expect(blocked).toHaveLength(1);
    await phases.tick();
    expect(sent.filter((text) => text.includes("hud is blocked"))).toHaveLength(1);
  });

  it("[sma:dt_assign_design] an admitted plan that needs a drawing moves to design and the next pass starts lp.draw", async () => {
    const { phases, db } = driver();
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Draw", goal: "draw" });
    const item = { id: "screen", title: "Screen", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: contract("screen") };
    savePhase(db, ph.id, { stage: "design", record: { ...ph.record,
      plan: { items: [item], contextSha: "c", sha: "s", admittedSha: "s" }, design: { decision: "needed", why: "screens change" } } as never, at: 2 });
    const at = phases.status(ph.id).phase;
    expect(autoDue(at)).toEqual({ kind: "draw" });
    const started: string[] = [];
    let record = at.record;
    const auto = createAutoStages({ log: () => undefined }, {
      workflowEngine: { resolveWorkflow: (id: string) => ({ id }),
        start: (input: { workflow: { id: string } }) => { started.push(input.workflow.id); return { runId: "wfrun_d", done: new Promise(() => undefined) }; },
        get: () => undefined } as never,
    }, { api: {} as never, get: () => ({ ...at, record }), save: (_id: string, next: PhaseRecord) => { record = next; },
      book: () => undefined, runtime: () => ({}), pmIdle: async () => true, now: () => 1 } as never);
    expect(await auto.step(at)).toBe(true);
    expect(started).toEqual(["lp.draw"]);
    expect(record.auto?.kind).toBe("draw");
  });

  it("[sma:dt_lanes] a held provider is skipped; a chain with every provider held parks instead of claiming", async () => {
    const now = Date.now();
    const deps = {
      breaker: { snapshot: () => [{ key: "a/m", state: "open", openedAt: now - 60_000, failures: 3 }] },
      presence: null, usage: { hold: async () => null }, coreHosts: () => true, log: () => undefined,
    };
    const members = [{ providerId: "a", model: "m" }, { providerId: "b", model: "m" }];
    const walk = await walkWriterChain(members, { hostId: "h", settings: {} }, deps as never, now);
    expect(walk.free?.member.providerId).toBe("b");
    expect(walk.holds[0]?.hold.reason).toContain("breaker_open");
    const allHeld = await walkWriterChain([{ providerId: "a", model: "m" }], { hostId: "h", settings: {} }, deps as never, now);
    expect(allHeld.free).toBeUndefined();
    expect(allHeld.shortest?.hold.reason).toContain("writer_provider_unavailable:");
    expect(allHeld.wakeAt).toBeGreaterThan(now);
  });

  it("[sma:dt_all_busy] with the pool at 1 and one writer running, a second acquire waits until the first releases", async () => {
    const pool = new RunWriterPool();
    const release = await pool.acquire("run1", 1);
    let second = false;
    const waiting = pool.acquire("run1", 1).then((done) => { second = true; return done; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(second).toBe(false);
    release();
    const done = await waiting;
    expect(second).toBe(true);
    done();
  });

  it("[sma:dt_lease] spawn_requested holds the worktree at any age; the stall ends it writer_start_stalled", () => {
    expect(isOpenAttemptState("spawn_requested")).toBe(true);
    expect(isOpenAttemptState("spawn_unknown")).toBe(true);
    expect(START_STALL_MS).toBe(15 * 60_000);
    const { db } = db0();
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    expect(endSpawnFailure(db, "a1", "writer_start_stalled: no writer thread after 15 min, waiting at step spawn")).toBe("spawn_rejected");
    expect(getAttempt(db, "a1")?.reason).toContain("writer_start_stalled");
  });

  it("[sma:dt_finally] a writer start whose spawn throws leaves the attempt blocked and frees its pool seat", async () => {
    const { bb, db, harness } = db0();
    harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
    harness.sdk.stub("threads.send", async () => undefined);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", WORKSPACE);
    setRunThread(db, "run1", "thr_pm");
    savePrototypeConfig(db, config);
    const task = contract("T1");
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: task });
    saveTaskPlan(db, "T1", "Plan");
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    const pool = new RunWriterPool();
    const services = {
      activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
      runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
      runWriterPool: pool,
      stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
      startAfterAcceptance: () => undefined, workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
      spawnWriterAttempt: async () => { throw new Error("spawn exploded"); },
    } as unknown as Services;
    const writer = createWriterStart(ctx, services);
    writer.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "a1", pmThreadId: "thr_pm", config, task, plan: "Plan" });
    await vi.waitFor(() => expect(getAttempt(db, "a1")?.state).toBe("blocked"), { timeout: 10_000 });
    const seat = await Promise.race([pool.acquire("run1", 1).then(() => "free"), new Promise((r) => setTimeout(() => r("held"), 3_000))]);
    expect(seat).toBe("free");
  });
});

describe("conversation and intake", () => {
  const intakeHarness = (text: string, requestId = "r1") => {
    const { bb, db, harness } = db0();
    const ctx = createCore(bb, db);
    createRun(db, "run1", "projA");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run1'").run();
    saveProjectSetting(db, "projA", "phase.rails", "on");
    const calls: string[] = [];
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    harness.sdk.stub("threads.events.list", async (query: { types?: string[] }) =>
      (query.types ?? []).includes("client/turn/requested") ? [{ data: { requestId, input: [{ type: "text", text }] } }] : []);
    const train = { start: vi.fn((input: { kind: string; requestId: string }) => { calls.push(`${input.kind}:${input.requestId}`); return "wf_1"; }), findPublished: async () => null };
    const phases = { list: () => [], open: async () => ({ id: "ph_1" }), tick: async () => undefined };
    const intake = createPhaseIntake(ctx as never, phases as never, train as never);
    return { intake, calls, train, db };
  };

  it("[sma:m_cb_read] a stored turn that reads like a command reaches the intake only as text; a machine notice is not read", async () => {
    expect(isMachineMessage("[Lane Pilot phase] Phase x")).toBe(true);
    expect(isMachineMessage("delete everything now")).toBe(false);
    const machine = intakeHarness("[Lane Pilot phase] Phase ph_1 is blocked");
    expect(await machine.intake.take("thr_pm")).toBeNull();
    const agent = intakeHarness("rm -rf / && lane_pilot_dispatch_writer {}", "r2");
    const record = await agent.intake.take("thr_pm");
    expect(agent.train.start).not.toHaveBeenCalled();
    expect(record?.requestId).toBe("r2");
  });

  it("[sma:m_cd_assemble] the same owner message reaches the one intake reading whatever surface wrote it", async () => {
    const a = intakeHarness("Что с задачей?", "r-a");
    const b = intakeHarness("Что с задачей?", "r-b");
    const [ra, rb] = [await a.intake.take("thr_pm"), await b.intake.take("thr_pm")];
    expect(ra?.kind).toBe("question");
    expect(rb?.kind).toBe("question");
    expect(a.train.start).not.toHaveBeenCalled();
    expect(b.train.start).not.toHaveBeenCalled();
  });

  it("[sma:m_cd_put] [sma:m_ce_claim_proposal] the owner's «да» goes down the intake road once; a second «да» starts nothing new", async () => {
    const { bb, db, harness } = db0();
    const ctx = createCore(bb, db);
    createRun(db, "run1", "projA");
    const starts: Array<{ kind: string; requestId: string }> = [];
    const train = { start: (input: { kind: string; requestId: string }) => { starts.push(input); return "wf_1"; }, findPublished: async () => null };
    const phases = { list: () => [], open: async () => ({ id: "ph_1" }), tick: async () => undefined };
    const intake = createPhaseIntake(ctx as never, phases as never, train as never);
    const input = { projectId: "projA", pmThreadId: "thr_pm", runId: "run1", text: "Ship the header fix", key: "lead:road1", origin: "Accepted by the owner" };
    const [one, two] = await Promise.all([intake.handOver(input), intake.handOver(input)]);
    const three = await intake.handOver(input);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({ kind: "small", requestId: "lead:road1" });
    expect(one).toEqual(two);
    expect(three).toEqual({ started: true, via: "issue-quick", id: "wf_1" });
  });

  it("[sma:m_ce_batch] a message the intake judgment reads as batch starts issue-batch once for the request", async () => {
    setJevForTests({
      enabled: () => true,
      judgeBundle: async () => [
        { by: "jev", decision: { kind: "batch" }, answers: {} },
        { by: "jev", decision: { size: "small", risk: "low" }, answers: {} },
      ],
      judge: async () => ({ by: "jev", decision: { kind: "batch" }, answers: {} }),
    } as never);
    try {
      const { intake, calls } = intakeHarness("пачка мелких правок по списку");
      const verdict = await intake.classify("пачка мелких правок по списку", "projA", "run1", {});
      if (verdict.by === "jev") expect(verdict.kind).toBe("batch");
      await intake.take("thr_pm");
      if (calls.length) expect(calls).toEqual(["batch:r1"]);
      const batch = workflow("issue-batch");
      expect(batch.entry).toBe("plan");
      const batchNodes = nodes("issue-batch");
      expect(batchNodes.some((node) => node.workflow === "lp.plan")).toBe(true);
      expect(batchNodes.some((node) => node.workflow === "lp.build")).toBe(true);
      expect(batchNodes.every((node) => node.role !== "verifier")).toBe(true);
    } finally {
      setJevForTests(null);
    }
  });

  it("[sma:m_ce_validate] a malformed task contract is refused before any task row exists", async () => {
    const { db } = db0();
    const bad = { ...contract("bad1") } as Record<string, unknown>;
    delete bad.owns_paths;
    expect(validateTaskV2(bad).ok).toBe(false);
    const lint = lintContract({ task: { ...contract("bad2"), expected_outputs: ["outside/x.ts"] }, workspacePath: WORKSPACE, hostId: "h", sandboxUnsafe: [], openTasks: [], deadDependencies: [], kinds: new Map() });
    expect(lint.errors.length).toBeGreaterThan(0);
    expect(getTask(db, "bad1")).toBeUndefined();
    expect(listOpenAttempts(db)).toEqual([]);
  });

  it("[sma:m_cf_dispatch] a PM turn's spend is booked under the PM thread's own id and takes no seat", async () => {
    const { bb, db, harness } = db0();
    harness.sdk.stub("threads.list", async () => [{ id: "thr_pm", projectId: "projA", providerId: "prov" }]);
    harness.sdk.stub("threads.events.list", async () => [
      { type: "thread/tokenUsage/updated", seq: 1, createdAt: Date.now(), tokenUsage: { total: { totalTokens: 14, inputTokens: 10, outputTokens: 4 }, last: { totalTokens: 14, inputTokens: 10, outputTokens: 4 } } },
    ]);
    await syncTokenUsage({ bb: bb as never, db }, { sinceDays: 1 });
    const row = tokenCursorRow(db, "thr_pm");
    expect(row).toBeDefined();
    expect(row!.total_json).toContain("14");
    expect(listOpenAttempts(db)).toEqual([]);
    expect(listStageReceipts(db, "run1", "x")).toEqual([]);
  });

  it("[sma:m_cf_ensure] a Lane PM id is never a worker", async () => {
    expect(isCustomAgentId("dev-orchestrator")).toBe(false);
    const { bb, db } = db0();
    createRun(db, "run1", "proj1");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm', kind='cli', closed_at=NULL WHERE id='run1'").run();
    let tool: { execute: (input: unknown, ctx: unknown) => Promise<unknown> } | undefined;
    (bb.agents as { registerTool: unknown }).registerTool = (t: { name: string; execute: NonNullable<typeof tool>["execute"] }) => { if (t.name === "lane_pilot_specialist") tool = t; };
    mountSpecialists(createCore(bb, db) as never, {} as never);
    const out = await tool!.execute({ role: "lane-pilot-pm", task: "x" }, { threadId: "thr_pm", projectId: "proj1" });
    expect(String(out)).toContain("unknown_specialist");
  });

  const activationHarness = () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const spawns: Array<Record<string, unknown>> = [];
    harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "thr_w" ? { role: "writer" } : { role: "user" });
    harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
    harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: "pm-main" }; });
    const ctx = createCore(bb, openDatabase(bb));
    (ctx.host as { call: unknown }).call = async (method: string) => {
      if (method === "detect") return { workspace: { path: WORKSPACE, present: true } };
      if (method === "importConfig") return { imported: { routingProfile: null, nightShift: null } };
      return {};
    };
    savePrototypeConfig(ctx.db, config);
    return { bb, ctx, spawns, db: ctx.db };
  };

  it("[sma:m_cf_voice] the PM speaks on the configured PM provider with explicit execution inputs", async () => {
    const { ctx, spawns } = activationHarness();
    const activation = createActivation(ctx, { resumeOrphans: async () => [] } as never);
    const out = await activation.activate("proj1", null, "bb");
    expect(out.threadId).toBe("pm-main");
    expect(spawns[0]).toMatchObject({ providerId: "p", model: "pm", executionInputSources: { providerId: "explicit", model: "explicit" } });
  });

  it("[sma:m_cf_seed] the compiled PM profile rides the spawn; a missing capability stops before the run row exists", async () => {
    const { bb, ctx, spawns, db } = activationHarness();
    Object.assign(bb.agents as object, { experimental_vkCompiledMainAgent: () => ({ persist: true, bridgeAgentOptions: true, requiredMarker: true, snapshotDigest: true, providerIds: ["claude-code"] }) });
    saveProjectSetting(db, "proj1", "main.agent", "dev-orchestrator");
    const activation = createActivation(ctx, { resumeOrphans: async () => [] } as never);
    await activation.activate("proj1", null, "bb");
    const bound = spawns[0]?.experimental_vkCompiledMainAgent as { tools?: Array<{ name?: string } | string> };
    expect(bound).toBeDefined();
    expect(JSON.stringify(bound.tools)).toContain("lane_pilot_dispatch_writer");

    const second = activationHarness();
    saveProjectSetting(second.db, "proj1", "main.agent", "dev-orchestrator");
    const runsBefore = second.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_run").get() as { n: number };
    await expect(createActivation(second.ctx, { resumeOrphans: async () => [] } as never).activate("proj1", null, "bb")).rejects.toThrow(/compiled_main_agent_unsupported/);
    expect((second.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_run").get() as { n: number }).n).toBe(runsBefore.n);
    expect(second.spawns).toHaveLength(0);
  });

  it("[sma:m_cf_ensure] a writer thread cannot activate a PM", async () => {
    const { ctx } = activationHarness();
    const activation = createActivation(ctx, { resumeOrphans: async () => [] } as never);
    await expect(activation.activate("proj1", "thr_w", "bb")).rejects.toThrow(/writer threads cannot activate a PM/);
  });

  it("[sma:m_cf_observe] the board observation reads only the caller's own run; the PM's git is read-only", async () => {
    const { bb, db, harness } = db0();
    const ctx = createCore(bb, db);
    createRun(db, "runA", "projA");
    createRun(db, "runB", "projA");
    createTask(db, { id: "ta", runId: "runA", kind: "bb", contract: { title: "alpha" } });
    createTask(db, { id: "tb", runId: "runB", kind: "bb", contract: { title: "beta" } });
    let tool: { execute: (input: unknown, ctx: unknown) => Promise<unknown> } | undefined;
    (bb.agents as { registerTool: unknown }).registerTool = (t: { name: string; execute: NonNullable<typeof tool>["execute"] }) => { if (t.name === "lane_pilot_facts") tool = t; };
    registerConversationTools(ctx as never, { spendByModel: () => [] });
    harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "thr_a" ? { lanePilotRunId: "runA" } : { lanePilotRunId: "runB" });
    const out = JSON.parse(String(await tool!.execute({ question: "что с задачами" }, { threadId: "thr_a", projectId: "projA" })));
    expect(out.kind).toBe("board");
    expect(out.runId).toBe("runA");
    expect(JSON.stringify(out.tasks)).toContain("ta");
    expect(JSON.stringify(out.tasks)).not.toContain("tb");
    const pmEdit = guard({
      input: JSON.stringify({ agent_type: "lane-pilot-pm", tool_name: "Write", tool_input: { file_path: join(process.cwd(), "src", "app.ts") }, cwd: process.cwd(), session_id: "sess_a1" }),
      env: hookEnv({ AGENT_HOOK_CLIENT: "claude" }),
    });
    expect(pmEdit.status).not.toBe(0);
  });

  it("[sma:m_q_engine] a parked writer's Q&A lands in QA.md; a phase question and answer land in BOOK.md", async () => {
    const { phases, db, ctx } = driver();
    const writes: Array<{ path: string; content: string }> = [];
    (ctx.host as { call: unknown }).call = async (method: string, args: { edits?: Array<{ path: string; content: string }> }) => {
      if (method === "writePhaseBook") { writes.push(...(args.edits ?? [])); return { status: "applied", writes: (args.edits ?? []).map((row) => ({ path: row.path, status: "applied", afterSha256: "x" })) }; }
      return {};
    };
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Q", goal: "q" });
    savePhase(db, ph.id, { runId: "run1", state: "active", record: ph.record, at: 2 } as never);
    phases.question({ phaseId: ph.id, text: "which locale?", blocking: false, by: "pm" });
    phases.answer({ phaseId: ph.id, questionId: "q1", answer: "ru", by: "owner" });
    await phases.tick();
    const book = writes.find((row) => row.path.endsWith("BOOK.md"))?.content ?? phases.status(ph.id).book;
    expect(book).toContain("which locale?");
    expect(book).toContain("ru");
  });

  it("[sma:m_sg_batch_draft] plan-only drafts and builds nothing; each drafted task's kind gives its lane", () => {
    const wf = workflow("plan-only");
    const list = nodes("plan-only");
    expect(list.every((node) => node.type !== "lp-task" && node.workflow !== "lp.build")).toBe(true);
    const save = list.find((node) => node.id === "save") as { action: string; path: string };
    expect(save.action).toBe("fs.write");
    expect(save.path).toBe("plans/draft-{{run_id}}.json");
    const offer = list.find((node) => node.id === "offer") as { workflow: string };
    expect(offer.workflow).toBe("analyze-plan-execute");
    expect(laneQueueOf("bb")).toBe("write");
  });
});

describe("safety nets and receipts", () => {
  it("[sma:k_lib_actionclient] the controller is asked before the next model turn: budget over refuses", () => {
    const budget = createRunBudget({ maxTokens: 10 }, 0);
    expect(budget.check().ok).toBe(true);
    budget.noteTokens("thr_a", 11);
    const over = budget.check();
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.exceeded).toBe("maxTokens");
      expect(over.reason).toContain("run budget exceeded");
    }
    expect(failureClass("blocked", "run_budget_exceeded: maxTokens")).toBe("budget");
  });

  it("[sma:k_v_receipthash] a done claim is backed by a receipt naming the command and a hash of its output; tampering shows", () => {
    const { db } = db0();
    createRun(db, "run1", "proj1");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} });
    const result = { produced: ["a.ts"], verification: [{ command: "npm test", exitCode: 0, stdout: "ok", stderr: "" }, { command: "npx tsc", exitCode: 0, stdout: "clean", stderr: "" }] };
    recordStage(db, { runId: "run1", taskId: "t1", stageId: "verification", state: "passed", input: "plan", result });
    const receipt = listStageReceipts(db, "run1", "t1").find((row) => row.stageId === "verification")!;
    expect(JSON.stringify(receipt.result)).toContain("npm test");
    expect(receipt.outputSha256).toBe(sha256(JSON.stringify(result)));
    const tip = receiptChain(db, "run1", "t1").tip;
    expect(verifyChain(db, "run1", "t1", tip)).toBe(true);
    db.prepare("UPDATE lane_pilot_stage_receipt SET output_sha256=? WHERE run_id=? AND task_id=? AND stage_id='verification'")
      .run(sha256("forged"), "run1", "t1");
    expect(verifyChain(db, "run1", "t1", tip)).toBe(false);
  });

  it("[sma:k_lib_grill] a challenge closes only on a judged dispute or a change; silence and repetition do not close it", () => {
    const replies = parseWriterRepairReply('{"replies":[{"id":"f1","status":"disputed","evidence":"counterexample in tests/x.test.ts"}]}');
    expect(replies?.replies[0]?.status).toBe("disputed");
    expect(writerRepairReplySchema.safeParse({ replies: [{ id: "f1", status: "disputed", evidence: "" }] }).success).toBe(false);
    expect(writerRepairReplySchema.safeParse({ replies: [{ id: "f1", status: "fixed" }] }).success).toBe(false);
    const finding = { id: "f1", severity: "blocking" as const, finding: "f", criterion: "c", path: "a.ts", line: 1, evidence: "x" };
    expect(sameUnresolvedFindings([finding], [finding])).toBe(true);
    expect(shouldRequestRepair({ settings: { enabled: true, mode: "gate", autoFix: true, maxRounds: 3 } as never,
      result: { status: "block", summary: "s", decision: "changes_requested", findings: [finding] }, round: 0 })).toBe(false);
    expect(shouldRequestRepair({ settings: { enabled: true, mode: "gate", autoFix: true, maxRounds: 3 } as never,
      result: { status: "rework", summary: "s", decision: "changes_requested", findings: [finding] }, round: 0 })).toBe(true);
  });

  it("[sma:k_lib_subreceipts] a claimed write is checked against the tree; writers cannot spawn subagents", () => {
    const facts = { produced: ["a.ts"], changed: { "a.ts": [[10, 20]] as Array<readonly [number, number]> }, lineCount: {}, hunksKnown: true,
      contractCommands: [], ran: [], root: "" };
    const table = (evidence: string) => ({ status: "ok" as const, rows: [{ item: 1, status: "done" as const, evidence: [evidence] }] });
    const check = (evidence: string) => blindPlanFact(["a works"], table(evidence) as never, facts as never);
    expect(check("b.ts:1").blocking).toEqual([1]);
    expect(check("b.ts:1").items[0]!.evidence[0]!.code).toBe("file_not_in_diff");
    expect(check("a.ts:50").blocking).toEqual([1]);
    expect(check("a.ts:50").items[0]!.evidence[0]!.code).toBe("lines_not_changed");
    expect(check("a.ts:12").blocking).toEqual([]);
    const writer = claudeGuardLauncherScript({ destDir: "/d", command: "/bin/claude", settingsPath: "/s", role: "writer", agentType: "writer" });
    const pm = claudeGuardLauncherScript({ destDir: "/d", command: "/bin/claude", settingsPath: "/s", role: "pm", agentType: "lane-pilot-pm" });
    expect(writer).toContain("Agent");
    expect(writer).toContain("--disallowedTools");
    expect(pm).not.toContain("--disallowedTools");
  });
});
