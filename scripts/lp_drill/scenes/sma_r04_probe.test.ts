// Probe of scenes/sma_r04.py (Region 4 · Daemon tick). It runs the REAL code of THIS checkout on a fake host (no hub, no model, no network) and
// prints what happened as one JSON line. It judges nothing: the scene compares each value with the node card's expected result and prove()s it.
//
// The card's «daemon pass» is, in this plugin, its registered schedules: the probe boots the plugin (or mounts the phase driver) on a fake core
// that keeps every registration and then FIRES THE SCHEDULE itself, so a result is read after the timer, not after a call to the function under test.
// Each section is independent (its own fake host and database); a section that throws reports the error, and the scene fails only its nodes.
import { it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../../server";
import { createCore } from "../../../src/rooms/core/server/core";
import { createPhaseDriver } from "../../../tests/phase-driver";
import { mountPhaseDriver } from "../../../src/rooms/phase/server/driver";
import { createReconcile } from "../../../src/rooms/stability/server/reconcile";
import { createStability } from "../../../src/rooms/stability/server/stability";
import { createWriterState } from "../../../src/rooms/writer/server/state";
import { createWriterStart } from "../../../src/rooms/writer/server/start";
import { walkWriterChain } from "../../../src/rooms/writer/server/writer-hold";
import { spawnWriterAttemptWatched, START_STALL_MS } from "../../../src/rooms/writer/server/spawn-watchdog";
import { RunWriterPool } from "../../../src/rooms/tasks";
import { setConveyor } from "../../../src/rooms/runs";
import { isHeld } from "../../../src/rooms/runs/server/runs-pause";
import { planSignature, designDecision, type PlanItem } from "../../../src/rooms/phase/logic";
import { listParts, savePhase, getPhase } from "../../../src/rooms/phase/store";
import { recordStage } from "../../../src/rooms/runs/server/stage-records";
import { runDailyWorktreePass } from "../../../src/rooms/stability/server/worktree-daily-pass";
import { gitRemoveWorktree, worktreeJanitor } from "../../../src/rooms/host-worker/host-handlers";
import { noOptionalPlugins } from "../../../tests/optional-plugin-stubs";
import { failedTasksAllProjects, listStageReceipts, saveProjectSetting, setAttemptWorkspace, setTaskHeldUntil } from "../../../src/rooms/storage";
import { HOLD_FOREVER } from "../../../src/rooms/tasks";
import {
  createAttempt, createRun, createTask, getAttempt, openDatabase, savePrototypeConfig, saveTaskPlan, setRunThread, transitionAttempt,
} from "../../../src/rooms/plugin-db";

const realNow = Date.now.bind(Date);
let skew = 0;
Date.now = () => realNow() + skew;
const DAY = 86_400_000;
process.env.LANE_PILOT_POLL_SCALE = "0.0005";

type Fire = (context: { signal: AbortSignal }) => unknown;
type Obj = Record<string, unknown>;
const out: Obj = {};
const section = async (name: string, work: () => Promise<unknown>) => {
  try { out[name] = await work(); } catch (cause) { out[name] = { error: cause instanceof Error ? `${cause.message}`.slice(0, 300) : String(cause) }; }
  skew = 0;
};

/** A fake host whose core keeps every isolated schedule it is given. */
function host(options: Obj = {}) {
  const made = createFakePluginHost({ pluginId: "lane-pilot", ...options } as never);
  const schedules = new Map<string, { options: Obj; fn: Fire }>();
  (made.bb.background as unknown as Obj).experimental_vkSchedule = (name: string, _cron: string, fn: Fire, opts: Obj) => { schedules.set(name, { options: opts, fn }); };
  const fire = (name: string) => Promise.resolve(schedules.get(name)!.fn({ signal: new AbortController().signal }));
  const logs: string[] = [];
  for (const level of ["info", "warn", "error"] as const) { const log = made.bb.log as unknown as Record<string, (...a: unknown[]) => void>; const keep = log[level]; log[level] = (...a: unknown[]) => { logs.push(`${level}: ${a.map(String).join(" ")}`.slice(0, 300)); return keep?.(...a); }; }
  return { ...made, schedules, fire, logs };
}

/** The phase driver as the plugin composes it, with the tick mounted on the schedule the plugin uses; the writer dispatch is a recorder. */
function phaseHost(opts: { budget?: { tokens: number; maxTokens: number }; services?: Obj; openAttempts?: number; threadStatus?: string } = {}) {
  const made = host();
  const { bb, harness } = made;
  const sent: Array<{ threadId: string; mode: string; text: string }> = [];
  harness.sdk.stub("threads.send", async (input: { threadId: string; mode: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, mode: input.mode, text: input.input[0]!.text }); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status: opts.threadStatus ?? "idle", environmentId: "env_pm" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("environments.get", async () => ({ path: "/work/bot", hostId: "h1" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  for (let n = 0; n < (opts.openAttempts ?? 0); n += 1) {
    createTask(db, { id: `seat-${n}`, runId: "run1", kind: "bb", contract: { id: `seat-${n}` } as never });
    createAttempt(db, { id: `att-seat-${n}`, runId: "run1", taskId: `seat-${n}` });
  }
  const dispatched: string[] = [];
  const started: string[] = [];
  const services = {
    runBudgets: { get: () => opts.budget ? { snapshot: () => ({ tokens: opts.budget!.tokens, limits: { maxTokens: opts.budget!.maxTokens } }) } : undefined },
    dispatchWriter: async (input: { task: { id: string } }) => { dispatched.push(input.task.id); return { taskId: input.task.id, runId: "run1" }; },
    workflowEngine: { resolveWorkflow: (id: string) => ({ id }), snapshot: () => null, get: () => null,
      start: (input: { workflow: { id: string } }) => { started.push(input.workflow.id); return { runId: "wf_fake", created: true, done: new Promise(() => undefined) }; } },
    ...(opts.services ?? {}),
  };
  const ctx = createCore(bb, db);
  const phases = createPhaseDriver(ctx, services as never).phases;
  mountPhaseDriver(ctx, phases);
  return { ...made, sent, db, phases, dispatched, started, ctx, tick: () => made.fire("phase-drive") };
}

const contractOf = (id: string, over: Obj = {}) => ({ id, owns_paths: ["src/**"], verification: [{ command: "npm test" }], acceptance: ["passes"], project_cwd: "/repo", ...over });
const itemOf = (id: string, over: Obj = {}): PlanItem => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: contractOf(id, over) as never });
const OFF = { branch: "phase/test", trees: {}, off: "no phase branch in this probe" };

/** A phase at execution with an admitted plan, ready to issue; its pass is the schedule's. */
async function issuing(items: PlanItem[], opts: { issueCap?: number; subagents?: boolean; budget?: { tokens: number; maxTokens: number }; openAttempts?: number } = {}) {
  const h = phaseHost({ budget: opts.budget, openAttempts: opts.openAttempts });
  const phase = await h.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Batch", goal: "pieces" });
  const sha = planSignature(items, "ctx");
  savePhase(h.db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, issueCap: opts.issueCap, subagents: opts.subagents, candidate: OFF,
    plan: { items, contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } } } as never, at: 2 });
  await h.tick();
  return { dispatched: h.dispatched, after: getPhase(h.db, phase.id)! };
}

it("sma_r04 probe", async () => {
// ---- n415: the plugin registers its pass isolated, and the fired timer drives a phase ----
await section("timer", async () => {
  const h = host();
  const sent: string[] = [];
  h.harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  h.harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  h.harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(h.bb);
  createRun(db, "run1", "projA");
  const driver = createPhaseDriver(createCore(h.bb, db), { runBudgets: { get: () => undefined } } as never).phases;
  const phase = await driver.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Tick", goal: "see the tick" });
  await plugin(h.bb);
  const options = h.schedules.get("phase-drive")?.options ?? null;
  const before = sent.filter((text) => text.includes("stage 1, discussion")).length;
  await h.fire("phase-drive");
  const after = sent.filter((text) => text.includes(`Phase ${phase.id}`) && text.includes("stage 1, discussion")).length;
  await h.fire("phase-drive");
  const again = sent.filter((text) => text.includes(`Phase ${phase.id}`) && text.includes("stage 1, discussion")).length;
  const names = [...h.schedules.keys()];
  await h.harness.lifecycle.dispose();
  return { options, before, after, again, names };
});

// ---- n416: the conveyor switch in front of the claim of a writer ----
function writerRig(over: Obj = {}) {
  const WS = "/ws";
  const made = createFakePluginHost({ pluginId: "lane-pilot" });
  const { bb, harness } = made;
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.send", async () => undefined);
  harness.sdk.stub("threads.context", async () => ({ usage: null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const config = { projectId: "proj1", hostId: "host_test", pmWorkspacePath: WS, writerWorkspacePath: WS, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
  createRun(db, "run1", "proj1", "bb", WS);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config as never);
  const task = { schema_version: 2, id: "belt", title: "Task belt", risk: "low", lane: "writer", project_cwd: WS, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["src/belt.ts"], owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "do it", acceptance: ["done"], verify: "tests", verification: [{ command: "true", cwd: WS }] };
  const spawned: string[] = [];
  const services = {
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
    finishWriterAttempt: async (input: { attemptId: string }) => { transitionAttempt(db, input.attemptId, "accepted"); return { status: "accepted", produced: task.expected_outputs, verification: [] }; },
    ...over,
  };
  createTask(db, { id: task.id, runId: "run1", kind: "bb", contract: task as never });
  saveTaskPlan(db, task.id, "Plan");
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId: task.id, stageId, state: "pending", input: "Plan" });
  createAttempt(db, { id: "a1", runId: "run1", taskId: task.id });
  const start = () => createWriterStart(ctx, services as never).startWriterTask({ projectId: "proj1", runId: "run1", taskId: task.id, firstAttemptId: "a1", pmThreadId: "thr_pm", config: config as never, task: task as never, plan: "Plan" });
  const receipt = () => listStageReceipts(db, "run1", task.id).find((row) => row.stageId === "writer-agent")?.reason ?? "";
  return { ...made, db, spawned, start, receipt, services, task };
}
const until = async (check: () => boolean, ms = 8000) => { const end = realNow() + ms; while (realNow() < end) { if (check()) return true; await new Promise((r) => setTimeout(r, 10)); } return check(); };

await section("conveyor", async () => {
  const rig = writerRig();
  await setConveyor(rig.bb.storage.kv as never, false, "owner stopped the line");
  rig.start();
  const waiting = await until(() => /waiting/.test(rig.receipt()));
  await new Promise((r) => setTimeout(r, 150));
  const whileOff = { spawned: [...rig.spawned], state: getAttempt(rig.db, "a1")?.state, receipt: rig.receipt(), held: await isHeld(rig.bb.storage.kv as never, "run1") };
  await setConveyor(rig.bb.storage.kv as never, true);
  const resumed = await until(() => rig.spawned.length === 1);
  await rig.harness.lifecycle.dispose();
  return { waiting, whileOff, resumed, spawned: rig.spawned };
});

// ---- n417: a restart: a fresh writer state counts the spend the token cursors already know ----
await section("spend", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "R", "P");
  createTask(db, { id: "T", runId: "R", kind: "bb", contract: {} });
  createAttempt(db, { id: "a1", runId: "R", taskId: "T" });
  db.prepare("UPDATE lane_pilot_attempt SET thread_id='thr_w' WHERE id='a1'").run();
  db.prepare("INSERT INTO lane_pilot_token_cursor (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at) VALUES ('thr_w','P','x',0,'{}','{\"total\":5000}','','', '', 0)").run();
  const state = createWriterState({ bb, db, log: () => undefined, isDisposed: () => false } as never);
  const seeded = state.runBudgetFor("R", {}).snapshot().tokens;
  state.runBudgetFor("R", {}).noteTokens("thr_w", 5200);
  const later = state.runBudgetFor("R", {}).snapshot().tokens;
  await harness.lifecycle.dispose();
  return { seeded, later };
});

// ---- n418: the silence sweep, fired by its schedule, three passes ----
await section("sweep", async () => {
  const h = host();
  const old = realNow() - 60 * 60_000;
  const events = Object.assign([{ type: "item/completed", createdAt: old }], { events: [{ type: "item/completed", createdAt: old }] });
  h.harness.sdk.stub("threads.events.list", async () => events);
  h.harness.sdk.stub("threads.interactions.list", async () => []);
  h.harness.sdk.stub("threads.send", async () => ({}));
  h.harness.sdk.stub("threads.get", async () => ({ status: "active" }));
  h.harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(h.bb);
  createRun(db, "run1", "p");
  createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} });
  createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId: "tw" });
  await plugin(h.bb);
  const read = async () => await h.bb.storage.kv.get("writer-nudge:a1") as { count?: number; ended?: boolean } | undefined;
  const seen: Array<{ count: number | null; ended: boolean | null }> = [];
  for (const minutes of [0, 21, 42, 63]) {
    skew = minutes * 60_000;
    await h.fire("writer-silence-sweep");
    const record = await read();
    seen.push({ count: record?.count ?? null, ended: record?.ended ?? null });
  }
  await h.harness.lifecycle.dispose();
  return { seen };
});

// ---- n419, n424: the five-minute reconcile: an attempt left with no thread is matched to BB's; a harness fault is parked and re-queued ----
await section("reconcile", async () => {
  const triple = { lanePilotRunId: "runR", lanePilotTaskId: "taskR", attemptId: "attR" };
  const h = host();
  h.harness.sdk.stub("threads.list", async () => [{ id: "writer-found" }]);
  h.harness.sdk.stub("threads.getPluginMetadata", async () => triple);
  h.harness.sdk.stub("threads.get", async () => ({ id: "writer-found", status: "active" }));
  h.harness.sdk.stub("threads.send", async () => ({}));
  const db = openDatabase(h.bb);
  savePrototypeConfig(db, { projectId: "projR", hostId: "h1", pmWorkspacePath: "/pm", writerWorkspacePath: "/ws", pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" } as never);
  createRun(db, "runR", "projR");
  setRunThread(db, "runR", "thr_pm");
  createTask(db, { id: "taskR", runId: "runR", kind: "bb", contract: {} });
  createAttempt(db, { id: "attR", runId: "runR", taskId: "taskR" });
  transitionAttempt(db, "attR", "spawn_requested");
  transitionAttempt(db, "attR", "spawn_unknown", { reason: "the plugin restarted while the spawn answer was lost" });
  createTask(db, { id: "taskQ", runId: "runR", kind: "bb", contract: {} });
  createAttempt(db, { id: "attQ", runId: "runR", taskId: "taskQ" });
  transitionAttempt(db, "attQ", "queued");
  const before = getAttempt(db, "attR")?.thread_id ?? null;
  const core = createReconcile(createCore(h.bb, db), { startWriterTask: () => undefined, resumeDispatch: async () => ({ resumed: false, why: "n/a" }), rollback: {} } as never);
  const done = await core.resumeOrphans("projR");
  const row = getAttempt(db, "attR");
  const queued = getAttempt(db, "attQ");
  await h.harness.lifecycle.dispose();
  return { before, thread: row?.thread_id ?? null, state: row?.state ?? null, resumed: done.resumed, queuedThread: queued?.thread_id ?? null, queuedState: queued?.state ?? null };
});

await section("autoretry", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm', writer_workspace_path='/repo', state='running' WHERE id='run'").run();
  db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1),('T2','run','bb','{}',1)").run();
  const resumed: string[] = [];
  const { stability } = createStability({ bb, isDisposed: () => false, db, log: () => undefined } as never, {
    activeWriterTasks: new Set<string>(),
    enqueueResumedWriter: async (_projectId: string, attempt: { task_id: string }) => { resumed.push(attempt.task_id); return true; },
  } as never);
  const base = { projectId: "proj", runId: "run", taskId: "T1", pmThreadId: "pm", state: "blocked" };
  const product = await stability.onTaskFailed({ ...base, reason: "acceptance rejected: the bar moved" });
  const harness1 = await stability.onTaskFailed({ ...base, reason: "spawn failed: helper down" });
  const early = await stability.sweep(realNow() + 3_600_000);
  const machine = await stability.onTaskFailed({ ...base, taskId: "T2", reason: "ENOSPC: no space left" });
  const late = await stability.sweep(realNow() + 11 * 60_000);
  await harness.lifecycle.dispose();
  return { product, harness: harness1, early, machine, late, resumed };
});

// ---- n420: the failure journal, asked through the queue tool the PM has ----
await section("bugs", async () => {
  const h = host();
  const db = openDatabase(h.bb);
  for (const [projectId, taskId] of [["p1", "t1"], ["p2", "t2"]] as const) {
    createRun(db, `run-${taskId}`, projectId);
    createTask(db, { id: taskId, runId: `run-${taskId}`, kind: "bb", contract: {} });
    for (const [index, reason] of ["first boom", "second boom"].entries()) {
      const attemptId = `a-${taskId}-${index}`;
      createAttempt(db, { id: attemptId, runId: `run-${taskId}`, taskId });
      transitionAttempt(db, attemptId, "spawn_requested");
      transitionAttempt(db, attemptId, "running", { threadId: "thr" });
      transitionAttempt(db, attemptId, "validation_failed", { reason });
    }
  }
  await plugin(h.bb);
  const answer = JSON.parse(String(await h.harness.behavior.callAgentTool("lane_pilot_queue", { action: "failures" }, { threadId: "thr_pm", projectId: "p1" }))) as { failures: Array<{ projectId: string; taskId: string; reason: string }> };
  const direct = failedTasksAllProjects(db, 0).length;
  await h.harness.lifecycle.dispose();
  return { lines: answer.failures.map((row) => [row.projectId, row.taskId, row.reason]).sort(), direct };
});

// ---- n421: the daily copy sweep on real git folders: merged and cancelled copies go, an unmerged one stays and is reported once ----
await section("copies", async () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
  const dir = mkdtempSync(join(tmpdir(), "lp-sma-r04-"));
  const home = process.env.HOME;
  process.env.HOME = dir;
  try {
    const base = join(dir, "projects", "app");
    mkdirSync(base, { recursive: true });
    git(base, "init", "-q", "-b", "main"); git(base, "config", "user.email", "t@t"); git(base, "config", "user.name", "t");
    writeFileSync(join(base, "a.txt"), "a\n"); git(base, "add", "."); git(base, "commit", "-qm", "init");
    const laneRoot = join(dir, ".lane-pilot", "worktrees");
    mkdirSync(laneRoot, { recursive: true });
    const add = (path: string, branch: string) => { git(base, "worktree", "add", "-q", "-b", branch, path, "HEAD"); return path; };
    const commit = (path: string, file: string) => { writeFileSync(join(path, file), `${file}\n`); git(path, "add", "."); git(path, "commit", "-qm", file); };
    const merged = add(join(laneRoot, "app", "lpattempt_m1"), "lane/lpattempt_m1"); commit(merged, "m1.txt");
    git(base, "merge", "-q", "--squash", "lane/lpattempt_m1"); git(base, "commit", "-qm", "squash m1");
    const unmerged = add(join(laneRoot, "app", "lpattempt_u1"), "lane/lpattempt_u1"); commit(unmerged, "u1.txt");
    const fake = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const db = openDatabase(fake);
    const bb = Object.assign(Object.create(Object.getPrototypeOf(fake)), fake, { sdk: { hosts: { list: async () => [{ id: "h1", name: "Machine", status: "connected" }] } } });
    const t0 = realNow() - 30 * DAY;
    db.prepare("INSERT INTO lane_pilot_run(id,project_id,state,created_at,updated_at,writer_workspace_path,writer_host_id) VALUES ('run1','p1','running',?,?,?, 'h1')").run(t0, realNow(), base);
    const handlers: Record<string, (input: never) => unknown> = { worktreeJanitor: (input) => worktreeJanitor(input, {} as never), gitRemoveWorktree: (input) => gitRemoveWorktree(input, {} as never), removeWorkerHome: async () => ({ removed: false }) };
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false, host: { call: async (method: string, input: never) => { const handler = handlers[method]; if (!handler) throw new Error(`no ${method}`); return await handler(input); } } } as never;
    const result = await runDailyWorktreePass(ctx, realNow() + 8 * DAY);
    const row = db.prepare("SELECT removed, kept_unmerged AS keptUnmerged FROM lane_pilot_janitor WHERE pass='daily'").get() as { removed: number; keptUnmerged: number } | undefined;
    return { status: result.status, mergedGone: !existsSync(merged), unmergedKept: existsSync(unmerged), row: row ?? null, reportNamesUnmerged: result.report.includes(unmerged) };
  } finally { process.env.HOME = home; }
});

// ---- n422: the backlog scan, fired by its schedule, issues the first ready item once a day when backlog.auto_issue is on ----
await section("intake", async () => {
  const meta = (id: string) => `__lp_todo__ .agents/todos/items/${id}/meta.yaml\nid: ${id}\ntitle: Item ${id}\nstatus: ready\npriority: high\nestimate: 3\n`;
  const calls: string[] = [];
  const h = host({ experimental_callHostRpc: (call: { method: string }) => {
    calls.push(call.method);
    if (call.method === "gateRun") return { hostId: "h", exitCode: 0, stdout: meta("t-01") + meta("t-02"), stderr: "", head: null };
    throw new Error(`unexpected ${call.method}`);
  } });
  const sent: string[] = [];
  h.harness.sdk.stub("threads.send", async (args: { input: Array<{ text: string }> }) => { sent.push(args.input[0]!.text); return undefined; });
  h.harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm" }));
  h.harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  h.harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(h.bb);
  savePrototypeConfig(db, { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "p", pmModel: "m", writerProviderId: "p", writerModel: "m" } as never);
  createRun(db, "run_cli", "P", "cli", "/repo");
  setRunThread(db, "run_cli", "thr_pm");
  saveProjectSetting(db, "P", "backlog.auto_issue", "on");
  await plugin(h.bb);
  const board = await h.harness.behavior.callRpc("backlog_board", { projectId: "P" }).catch((cause: unknown) => String(cause));
  await h.fire("backlog-scan");
  const issued = () => (db.prepare("SELECT todo_id FROM lane_pilot_backlog_issue WHERE project_id='P'").all() as Array<{ todo_id: string }>).map((row) => row.todo_id);
  const first = issued();
  skew = 2 * 3_600_000;
  await h.fire("backlog-scan");
  const second = issued();
  await h.harness.lifecycle.dispose();
  return { first, second, sent: sent.length, calls, board: JSON.stringify(board).slice(0, 400), logs: h.logs.slice(-3) };
});

// ---- n423 .. n426, n429 .. n431, n433 .. n434, n427, n437: the phase driver's pass, fired by its schedule ----
await section("aging", async () => {
  const h = phaseHost();
  const phase = await h.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Stats", goal: "stats module" });
  await h.tick();
  skew = 4 * DAY;
  await h.tick();
  const aging = () => listParts(h.db, phase.id).filter((part) => part.kind === "aging").map((part) => part.text);
  const four = aging();
  await h.tick();
  return { four, again: aging().length, stored: "agingSaidAt" in getPhase(h.db, phase.id)!.record };
});

await section("calls", async () => {
  const h = phaseHost();
  saveProjectSetting(h.db, "projA", "owner.words", "on");
  const phase = await h.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "sums" });
  savePhase(h.db, phase.id, { stage: "planning", record: { ...phase.record, ownerWords: true, plan: { items: [], sha: "s", contextSha: "c", critique: { decision: "approve", by: "critic" } } } as never, at: 2 });
  await h.tick();
  const row = h.db.prepare("SELECT key, kind, source FROM lane_pilot_owner_item").get() as Obj | undefined;
  const told = h.sent.some((message) => message.text.includes("owner's word"));
  return { row: row ?? null, told, phaseId: phase.id };
});

await section("stalled", async () => {
  const h = phaseHost();
  const piece = itemOf("hud");
  createTask(h.db, { id: "hud", runId: "run1", kind: "bb", contract: piece.task as never });
  createAttempt(h.db, { id: "att1", runId: "run1", taskId: "hud" });
  transitionAttempt(h.db, "att1", "spawn_requested");
  transitionAttempt(h.db, "att1", "running", { threadId: "tw" });
  transitionAttempt(h.db, "att1", "blocked", { reason: "boom" });
  const phase = await h.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  savePhase(h.db, phase.id, { stage: "execution", runId: "run1", state: "active", record: { ...phase.record, plan: { items: [piece], contextSha: "c", sha: "s", admittedSha: "s" }, execution: { issued: { hud: "hud" }, startedAt: 1 } } as never, at: 2 });
  await h.tick();
  const first = h.sent.filter((message) => message.text.includes("hud is blocked")).length;
  await h.tick();
  const second = h.sent.filter((message) => message.text.includes("hud is blocked")).length;
  return { first, second, to: h.sent.find((message) => message.text.includes("hud is blocked"))?.threadId ?? null };
});

await section("waves", async () => {
  const h = phaseHost();
  const piece = itemOf("hud", { acceptance: ["the bar stays"] });
  createTask(h.db, { id: "hud", runId: "run1", kind: "bb", contract: piece.task as never });
  createAttempt(h.db, { id: "att1", runId: "run1", taskId: "hud" });
  h.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
  const phase = await h.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  const sha = planSignature([piece], "ctx");
  savePhase(h.db, phase.id, { stage: "execution", runId: "run1", state: "active", record: { ...phase.record, plan: { items: [piece], contextSha: "ctx", sha, admittedSha: sha }, execution: { issued: { hud: "hud" }, startedAt: 1 } } as never, at: 2 });
  await h.tick();
  const lines = () => listParts(h.db, phase.id).filter((part) => part.kind === "wave_in");
  const once = lines().map((part) => part.text);
  await h.tick();
  return { once, twice: lines().length };
});

await section("stopwave", async () => {
  const h = phaseHost();
  createTask(h.db, { id: "piece1", runId: "run1", kind: "bb", contract: {} });
  createTask(h.db, { id: "piece2", runId: "run1", kind: "bb", contract: {} });
  createAttempt(h.db, { id: "att_q", runId: "run1", taskId: "piece1" });
  transitionAttempt(h.db, "att_q", "queued");
  createAttempt(h.db, { id: "att_r", runId: "run1", taskId: "piece2" });
  transitionAttempt(h.db, "att_r", "spawn_requested");
  transitionAttempt(h.db, "att_r", "running", { threadId: "thr_w" });
  const phase = await h.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Wave", goal: "wave" });
  const items = [itemOf("piece1"), itemOf("piece2")];
  savePhase(h.db, phase.id, { stage: "execution", runId: "run1", record: { ...phase.record, plan: { items, contextSha: "c", sha: "s", admittedSha: "s" }, execution: { issued: { piece1: "piece1", piece2: "piece2" } } } as never, at: 2 });
  const stopped = await h.phases.stopWave({ phaseId: phase.id });
  const toWriter = h.sent.filter((message) => message.threadId === "thr_w");
  const corrected = listParts(h.db, phase.id).some((part) => part.kind === "wave_live_corrected" && part.text.includes("piece2"));
  const dispatchedBefore = h.dispatched.length;
  await h.tick();
  // A driver built later over the same database reads the stop from the row, not from memory.
  const again = createPhaseDriver(createCore(h.bb, h.db), { runBudgets: { get: () => undefined } } as never).phases;
  return { canceled: stopped.canceled, toWriter: toWriter.map((message) => ({ mode: message.mode, wave: message.text.includes("wave is stopped") })), corrected,
    newDriverState: again.status(phase.id).phase.state, issuedAfter: h.dispatched.length - dispatchedBefore, stoppedPart: listParts(h.db, phase.id).some((part) => part.kind === "wave_stopped") };
});

await section("issue", async () => {
  const budgetHeld = await issuing([itemOf("a", { appetite: { tokens: 50 } }), itemOf("b", { appetite: { tokens: 50 } })], { budget: { tokens: 80, maxTokens: 100 } });
  const budgetFits = await issuing([itemOf("a", { appetite: { tokens: 10 } })], { budget: { tokens: 80, maxTokens: 100 } });
  const capped = await issuing([itemOf("a"), itemOf("b")], { issueCap: 1 });
  const open = await issuing([itemOf("a"), itemOf("b")], { issueCap: 8 });
  const taken = await issuing([itemOf("a"), itemOf("b")], { issueCap: 1, openAttempts: 1 });
  const inline = await issuing([itemOf("a"), itemOf("b")], { subagents: false, issueCap: 8 });
  const errors = (budgetHeld.after.record.execution?.issueErrors ?? {}) as Record<string, string>;
  return { budgetHeld: budgetHeld.dispatched, budgetError: errors.budget ?? null, budgetFits: budgetFits.dispatched, capped: capped.dispatched, open: open.dispatched, taken: taken.dispatched, inline: inline.dispatched };
});

await section("draftsman", async () => {
  const h = phaseHost();
  const phase = await h.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Draw", goal: "draw" });
  const screen = itemOf("screen", { owns_paths: ["src/ui/screen.tsx"] });
  const decision = designDecision([screen]);
  savePhase(h.db, phase.id, { stage: "design", runId: "run1", record: { ...phase.record, plan: { items: [screen], contextSha: "c", sha: "s", admittedSha: "s" }, design: { decision: "needed", why: "screens change" } } as never, at: 2 });
  await h.tick();
  const after = getPhase(h.db, phase.id)!;
  return { decision: decision.decision, started: h.started, auto: (after.record as { auto?: { kind?: string } }).auto?.kind ?? null };
});

await section("idle", async () => {
  const h = phaseHost({ threadStatus: "busy" });
  const none = await h.phases.tick();
  const phase = await h.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Wait", goal: "wait" });
  const waits = await h.phases.tick();
  const piece = itemOf("p1");
  createTask(h.db, { id: "p1", runId: "run1", kind: "bb", contract: piece.task as never });
  createAttempt(h.db, { id: "att1", runId: "run1", taskId: "p1" });
  transitionAttempt(h.db, "att1", "spawn_requested");
  transitionAttempt(h.db, "att1", "running", { threadId: "tw" });
  const sha = planSignature([piece], "ctx");
  savePhase(h.db, phase.id, { stage: "execution", runId: "run1", state: "active", record: { ...phase.record, plan: { items: [piece], contextSha: "ctx", sha, admittedSha: sha }, execution: { issued: { p1: "p1" }, startedAt: 1 } } as never, at: 2 });
  const work = await h.phases.tick();
  return { none, waits, work };
});

// ---- n432, n435: which providers may work; every seat of a pool taken ----
await section("lanes", async () => {
  const now = realNow();
  const deps = { breaker: { snapshot: () => [{ key: "a/m", state: "open", openedAt: now - 60_000, failures: 3 }] }, presence: null, usage: { hold: async () => null }, coreHosts: () => true, log: () => undefined };
  const walk = await walkWriterChain([{ providerId: "a", model: "m" }, { providerId: "b", model: "m" }], { hostId: "h", settings: {} }, deps as never, now);
  const all = await walkWriterChain([{ providerId: "a", model: "m" }], { hostId: "h", settings: {} }, deps as never, now);
  return { free: walk.free?.member.providerId ?? null, freeIndex: walk.free?.index ?? null, holds: walk.holds.map((row) => row.hold.reason), allFree: all.free?.member.providerId ?? null,
    allShortest: all.shortest?.hold.reason ?? null, wakeLater: (all.wakeAt ?? 0) > now };
});

await section("pool", async () => {
  const pool = new RunWriterPool();
  const release = await pool.acquire("run1", 1);
  let second = false;
  const waiting = pool.acquire("run1", 1).then((done) => { second = true; return done; });
  await new Promise((r) => setTimeout(r, 30));
  const whileTaken = second;
  release();
  const done = await waiting;
  const afterRelease = second;
  done();
  return { busy: pool.busy("run1", 1), whileTaken, afterRelease };
});

// ---- n436: a hold that arrives while the task waits for a seat is re-read at the claim ----
await section("claim", async () => {
  let poolCalls = 0;
  let seatGate!: () => void;
  const seatTaken = new Promise<void>((resolve) => { seatGate = resolve; });
  const rig = writerRig({ runWriterPool: { acquire: async () => { poolCalls += 1; if (poolCalls === 1) await seatTaken; return () => undefined; } } });
  rig.start();
  const waiting = await until(() => poolCalls === 1);
  setTaskHeldUntil(rig.db, rig.task.id, "run1", HOLD_FOREVER);
  seatGate();
  const heldNoted = await until(() => /waiting: held/.test(rig.receipt()));
  await new Promise((r) => setTimeout(r, 150));
  const whileHeld = [...rig.spawned];
  setTaskHeldUntil(rig.db, rig.task.id, "run1", null);
  const released = await until(() => rig.spawned.length === 1);
  await rig.harness.lifecycle.dispose();
  return { waiting, heldNoted, whileHeld, released };
});

// ---- n438: a start with no process yet holds its copy; the stall ends it ----
await section("lease", async () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "proj1");
  createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: {} });
  createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
  transitionAttempt(db, "a1", "spawn_requested");
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = ((fn: () => void) => realInterval(fn, 5)) as never;
  try {
    let settled: Obj | null = null;
    const watched = spawnWriterAttemptWatched({ db, log: () => undefined }, { attemptId: "a1" } as never, () => new Promise(() => undefined));
    void watched.then((result) => { settled = result as never; });
    skew = START_STALL_MS - 60_000;
    await new Promise((r) => setTimeout(r, 80));
    const young = { settled: settled !== null, state: getAttempt(db, "a1")?.state ?? null };
    skew = START_STALL_MS + 60_000;
    await until(() => settled !== null, 2000);
    const row = getAttempt(db, "a1");
    return { young, status: (settled as Obj | null)?.status ?? null, state: row?.state ?? null, reason: row?.reason ?? null };
  } finally { globalThis.setInterval = realInterval; await harness.lifecycle.dispose(); }
});

// ---- n439: a start whose spawn throws leaves the attempt blocked and frees its pool seat ----
await section("finally", async () => {
  const pool = new RunWriterPool();
  const rig = writerRig({ runWriterPool: pool, spawnWriterAttempt: async () => { throw new Error("spawn exploded"); } });
  rig.start();
  const blocked = await until(() => getAttempt(rig.db, "a1")?.state === "blocked");
  const seat = await Promise.race([pool.acquire("run1", 1).then(() => "free"), new Promise<string>((r) => setTimeout(() => r("held"), 3000))]);
  await rig.harness.lifecycle.dispose();
  return { blocked, seat };
});

  Date.now = realNow;
  writeFileSync(process.env.SMA_R04_OUT ?? "/tmp/sma_r04_probe.json", JSON.stringify(out));
}, 900_000);
