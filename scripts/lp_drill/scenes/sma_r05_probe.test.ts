// Probe of scenes/sma_r05.py (Region 5 · Daemon life): runs the REAL code of THIS checkout (the commit under drill) for the nodes of region 5 and writes what it
// found as one JSON file (SMA_R05_OUT). It judges nothing: the scene compares each value with the node card's expected result and prove()s it.
// Model-free, no hub write, no network: the plugin factory runs on the SDK's fake host, the units on a scratch SQLite database. It runs under vitest (the
// rooms import each other in cycles that plain tsx rejects: scenes/sma_r05.vitest.config.ts), and each section is independent: a section that throws
// reports its error and the scene fails only the nodes that read it.
// To add a node: compute its observed value in a new section of `sections`, and add its prove() line to the scene.
import { it } from "vitest";
import { writeFileSync } from "node:fs";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../../server";
import packageJson from "../../../package.json";
import { rpcContract } from "../../../src/rooms/contracts";
import { createCore } from "../../../src/rooms/core/server/core";
import { migrations } from "../../../src/rooms/migrations";
import { coupledSettingKeys, validateSettingChanges, validateSettingValue, validateSettingsObject } from "../../../src/rooms/settings";
import { openDatabase as openStorageDatabase, requireSettingValidator } from "../../../src/rooms/storage/database";
import { createAttempt, createRun, createTask, loadProjectSettings, openDatabase, saveProjectSetting, transitionAttempt } from "../../../src/rooms/plugin-db";
import { listAttemptsForTask } from "../../../src/rooms/storage/attempts-store/lifecycle";
import { buildRunPolicy } from "../../../src/rooms/tasks/run-policy";
import { PROCESS_KEY, STOP_KEY, recordStartGap } from "../../../src/rooms/outage/server/outage";
import { BEAT_KEY } from "../../../src/rooms/outage/logic";
import { listOutages } from "../../../src/rooms/outage/store";
import { createCanary, poolReadiness } from "../../../src/rooms/stability/server/canary";
import { createStability } from "../../../src/rooms/stability/server/stability";
import { createReconcile } from "../../../src/rooms/stability/server/reconcile";
import { mountOutbound, worldVersion } from "../../../src/rooms/relay/server/outbound";
import { TICK_DEPS, checkTickDeps } from "../../../src/rooms/platform/server/tick-deps";
import { scheduleIsolated } from "../../../src/rooms/platform/server/schedules";
import { cleanupFinishedAttemptEnvironments } from "../../../src/rooms/runs/server/run-finish";
import { DISPATCH_STAGES_PENDING } from "../../../src/rooms/runs";
import { conveyorStartLine, setConveyor } from "../../../src/rooms/runs/conveyor";
import { buildTaskBoard } from "../../../src/rooms/runs/server/task-board";
import { walkWriterChain } from "../../../src/rooms/writer/server/writer-hold";

const MIN = 60_000;
const VERSION = packageJson.version;
type Host = ReturnType<typeof fakeHost>;
type Booted = Awaited<ReturnType<typeof boot>>;

function fakeHost(over: { envDeleted?: string[]; hostCalls?: string[]; vk?: { startReason: string } } = {}) {
  const order: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: { list: async () => [], get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle" }), stop: async () => undefined },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "ovh", path: `/wt/${environmentId}`, lifecycle: { phase: "active" } }),
        archiveThreads: async () => undefined,
        delete: async ({ environmentId }: { environmentId: string }) => { over.envDeleted?.push(`${environmentId}@rpc${harness.registrations.rpcMethods.length}`); },
      },
    },
    experimental_callHostRpc: (async (call: { method: string }) => { over.hostCalls?.push(call.method); return { hostId: "ovh", status: "clean", path: null, dirty: 0, ahead: 0, reason: null }; }) as never,
  } as never);
  if (over.vk) (bb as unknown as { vk: unknown }).vk = over.vk;
  const wrap = (target: object, key: string, label: (args: unknown[]) => string) => {
    const original = (target as Record<string, (...args: unknown[]) => unknown>)[key]!.bind(target);
    (target as Record<string, unknown>)[key] = (...args: unknown[]) => { order.push(label(args)); return original(...args); };
  };
  wrap(bb.storage, "migrate", () => "migrate");
  wrap(bb.rpc, "register", () => "rpc.register");
  wrap(bb.background, "schedule", (args) => `schedule:${String(args[0])}`);
  wrap(bb.background, "service", (args) => `service:${String(args[0])}`);
  return { bb, harness, order };
}
async function boot(over: Parameters<typeof fakeHost>[0] = {}) {
  const host = fakeHost(over);
  await plugin(host.bb);
  return { ...host, db: openDatabase(host.bb) };
}
async function recover(host: Booted, done: () => boolean | Promise<boolean>) {
  const run = host.harness.runService("startup-recovery");
  const until = Date.now() + 20_000;
  try { while (!(await done()) && Date.now() < until) await new Promise((wake) => setTimeout(wake, 50)); }
  finally { run.controller.abort(); await run.done; }
}
const ctxOf = (bb: Host["bb"], db: ReturnType<typeof openDatabase>) => ({ bb, db, log: () => undefined } as never);
const scratch = (over: Record<string, unknown> = {}) => { const { bb } = createFakePluginHost({ pluginId: "lane-pilot", ...over } as never); return { bb, db: openDatabase(bb) }; };
const quiet = { warn: () => undefined, info: () => undefined };

const sections: Record<string, () => Promise<unknown>> = {
  // The plugin factory, booted once: entry (n440), composition (n442), boot order (n453), the queue's first enqueue (n455), the door (n450), the tick (n452), the board (n449), the stop (n471).
  async boot() {
    const fresh = fakeHost();
    const before = { rpc: fresh.harness.registrations.rpcMethods.length, schedules: fresh.harness.registrations.schedules.length, services: fresh.harness.registrations.services.length, logs: fresh.harness.logEntries.length };
    await plugin(fresh.bb);
    const db = openDatabase(fresh.bb);
    const out: Record<string, unknown> = {};
    out.entry = { before, loaded: fresh.harness.logEntries.some((entry) => entry.message === "Lane Pilot PM-to-writer pipeline loaded"), rpc: fresh.harness.registrations.rpcMethods.length };
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_%'").all() as Array<{ name: string }>).map((row) => row.name);
    const missingRpc = Object.keys(rpcContract).filter((name) => !fresh.harness.registrations.rpcMethods.includes(name));
    out.compose = { tables: ["lane_pilot_run", "lane_pilot_task", "lane_pilot_attempt", "lane_pilot_attempt_transition"].every((name) => tables.includes(name)), missingRpc, cli: fresh.harness.registrations.cli !== null, tools: fresh.harness.registrations.agentTools.length, tickDeps: await fresh.bb.storage.kv.get("lp.tick-deps") };
    const at = (label: string) => fresh.order.indexOf(label);
    out.order = { migrate: at("migrate"), door: at("rpc.register"), sweep: at("schedule:attempt-worktree-sweep"), service: at("service:startup-recovery"), tick: at("schedule:schedule-board-tick") };
    out.fk = (() => { try { createTask(db, { id: "t_orphan", runId: "no_such_run", kind: "bb", contract: {} }); return "accepted"; } catch (cause) { return /FOREIGN KEY/.test(String(cause)) ? "refused: foreign key" : String(cause); } })();
    out.front = { missing: missingRpc.length, canary: await fresh.harness.behavior.callRpc("canary_status", {}), conveyor: await fresh.harness.behavior.callRpc("conveyor", {}), world: await fresh.harness.behavior.callRpc("world_version", {}), expectWorld: worldVersion() };
    out.ticks = fresh.harness.registrations.schedules.filter((schedule) => schedule.name === "schedule-board-tick").map((schedule) => schedule.cron);
    createRun(db, "run_b", "proj_b", "bb", "/w");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run_b");
    for (const [id, age] of [["t_old", 2 * MIN], ["t_new", 0]] as const) {
      createTask(db, { id, runId: "run_b", kind: "bb", contract: { title: id, kind: "feature" } });
      createAttempt(db, { id: `a_${id}`, runId: "run_b", taskId: id });
      db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id=?").run(Date.now() - age, `a_${id}`);
    }
    const [first, second] = await Promise.all([1, 2].map(() => fresh.harness.behavior.callRpc("task_board", { projectId: "proj_b", doneHours: 24 }))) as Array<{ items: Array<{ taskId: string }> }>;
    out.board = { first: first!.items.map((item) => item.taskId), same: JSON.stringify(first) === JSON.stringify(second), direct: buildTaskBoard(db, { projectId: "proj_b", doneSince: Date.now() - 24 * 60 * MIN }).map((item) => item.taskId) };
    const writes: Array<[string, unknown]> = [];
    const kv = fresh.bb.storage.kv;
    const set = kv.set.bind(kv);
    (kv as { set: unknown }).set = (key: string, value: unknown) => { writes.push([key, value]); return set(key, value as never); };
    await fresh.harness.lifecycle.dispose();
    const stop = writes.find(([key]) => key === STOP_KEY)?.[1] as { reason: string; at: number } | undefined;
    const next = scratch();
    if (stop) { await next.bb.storage.kv.set(BEAT_KEY, stop.at - 1_000); await next.bb.storage.kv.set(STOP_KEY, stop); await recordStartGap(ctxOf(next.bb, next.db), stop.at + 20 * MIN); }
    out.stop = { reason: stop?.reason ?? null, next: listOutages(next.db, 0).map((row) => row.cause) };
    return out;
  },
  // The start-up recovery with two finished attempts' worktrees, one old and one recent (n456, n463, and the stamp of the version's first start, n453).
  async recovery() {
    const envDeleted: string[] = [];
    const hostCalls: string[] = [];
    const host = await boot({ envDeleted, hostCalls, vk: { startReason: "start" } });
    createRun(host.db, "run", "proj", "cli", "/repo");
    for (const [id, env, age] of [["a1", "env_done", 3_600_000], ["a2", "env_recent", 60_000]] as const) {
      createAttempt(host.db, { id, runId: "run", taskId: `t_${id}` });
      host.db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, state=?, updated_at=? WHERE id=?").run(env, "accepted", Date.now() - age, id);
    }
    await recover(host, () => envDeleted.length > 0);
    const since = await host.bb.storage.kv.get(`canary:since:${VERSION}`);
    const out = { deleted: envDeleted, doorMethods: host.harness.registrations.rpcMethods.length, snapshots: hostCalls.filter((method) => method === "gitWorktreeSnapshot").length, canarySince: typeof since };
    await host.harness.lifecycle.dispose();
    return out;
  },
  // A conveyor left off is said at the start (n466).
  async conveyor() {
    const host = await boot();
    await setConveyor(host.bb.storage.kv as never, false, "owner pause");
    const said = () => host.harness.logEntries.filter((entry) => entry.level === "warn" && entry.message.includes("the conveyor is OFF"));
    await recover(host, () => said().length >= 1);
    const out = { onLine: conveyorStartLine({ on: true, since: null, reason: null }), said: said().map((entry) => entry.message.replace(/since \S+ /, "since <time> ")) };
    await host.harness.lifecycle.dispose();
    return out;
  },
  async policy() {
    const { bb, db } = scratch();
    const ctx = createCore(bb, db);
    const frozen = buildRunPolicy({ "ops.pool_size": 7, "ops.verify_pool_size": 3, "writer.max_turns": 40 });
    createRun(db, "r_first", "proj", "bb", null, "none", frozen, null);
    createRun(db, "r_second", "proj", "bb", null, "none", buildRunPolicy({ "ops.pool_size": 2 }), null);
    return { frozen, kept: ctx.runPolicyFor("r_first"), second: ctx.runPolicyFor("r_second").pools.provider, defaults: buildRunPolicy({}).pools };
  },
  async passport() {
    const { bb, db } = scratch();
    createRun(db, "run", "proj", "bb", "/w");
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    return { canary: (await createCanary(ctxOf(bb, db)).status()).version, stamped: (db.prepare("SELECT harness_version AS v FROM lane_pilot_attempt WHERE id='a1'").get() as { v: string }).v, pkg: VERSION };
  },
  async queue() {
    const validator = { validateSettingValue, validateSettingsObject, coupledSettingKeys, validateSettingChanges };
    const wired = openStorageDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb, { migrations, validateSetting: validator });
    const unwired = (() => { try { requireSettingValidator(openStorageDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb, { migrations })); return "wired"; } catch { return "no validator"; } })();
    return { wired: requireSettingValidator(wired) === validator, unwired };
  },
  async migrate() {
    const applied: unknown[][] = [];
    const host = createFakePluginHost({ pluginId: "lane-pilot" });
    const original = (host.bb.storage as unknown as { migrate: (...args: unknown[]) => unknown }).migrate.bind(host.bb.storage);
    (host.bb.storage as unknown as { migrate: unknown }).migrate = (...args: unknown[]) => { applied.push(args); return original(...args); };
    openStorageDatabase(host.bb, { migrations });
    return { calls: applied.length, all: JSON.stringify(applied[0]?.[1]) === JSON.stringify(migrations), count: migrations.length };
  },
  async ledger() {
    const { db } = scratch();
    createRun(db, "run_l", "proj", "bb");
    createTask(db, { id: "tl", runId: "run_l", kind: "bb", contract: {} });
    createAttempt(db, { id: "a_first", runId: "run_l", taskId: "tl" });
    transitionAttempt(db, "a_first", "spawn_requested");
    transitionAttempt(db, "a_first", "running", { threadId: "thr_1" });
    transitionAttempt(db, "a_first", "blocked", { reason: "check failed" });
    createAttempt(db, { id: "a_second", runId: "run_l", taskId: "tl" });
    const frame = (task: string) => (db.prepare("SELECT field FROM lane_pilot_task_transition WHERE task_id=?").all(task) as Array<{ field: string }>).map((row) => row.field);
    return { attempts: listAttemptsForTask(db, "run_l", "tl").map((row) => `${row.id}:${row.attempt_no}:${row.state}`), journal: (db.prepare("SELECT to_state FROM lane_pilot_attempt_transition WHERE attempt_id='a_first' ORDER BY rowid").all() as Array<{ to_state: string }>).map((row) => row.to_state),
      taskJournal: frame("tl"), seq: (db.prepare("SELECT world_seq AS s FROM lane_pilot_task WHERE id='tl'").get() as { s: number }).s };
  },
  async world() {
    const { bb, db } = scratch();
    mountOutbound({ db, bb, log: () => undefined, isDisposed: () => false } as never);
    createRun(db, "run", "proj", "bb");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: {} });
    const w0 = worldVersion();
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const w1 = worldVersion();
    transitionAttempt(db, "a1", "spawn_requested");
    const w2 = worldVersion();
    transitionAttempt(db, "a1", "spawn_requested");
    return { steps: [w1 - w0, w2 - w1, worldVersion() - w2] };
  },
  async gaps() {
    const { bb, db } = scratch();
    const now = 10 * 60 * MIN;
    await bb.storage.kv.set(BEAT_KEY, now - 30 * MIN);
    await bb.storage.kv.set(STOP_KEY, { reason: "the plugin was reloaded (a deploy or a settings change)", at: now - 29 * MIN });
    await recordStartGap(ctxOf(bb, db), now);
    await bb.storage.kv.set(BEAT_KEY, now + 30 * MIN);
    await bb.storage.kv.set(STOP_KEY, { reason: "an old deploy", at: now - 600 * MIN });
    await recordStartGap(ctxOf(bb, db), now + 60 * MIN);
    await bb.storage.kv.set(BEAT_KEY, now + 61 * MIN);
    await recordStartGap(ctxOf(bb, db), now + 63 * MIN);
    const gaps = listOutages(db, 0).map((row) => `${row.minutes}:${row.cause}`);
    await recordStartGap(ctxOf(bb, db), 1_700_000_000_000);
    return { gaps, record: await bb.storage.kv.get(PROCESS_KEY), pid: process.pid, node: process.version };
  },
  async tickDeps() {
    const bag: Record<string, unknown> = {};
    const empty = checkTickDeps(bag);
    for (const name of TICK_DEPS) bag[name] = {};
    return { empty: empty.missing.length, full: checkTickDeps(bag), total: TICK_DEPS.length };
  },
  async isolated() {
    const calls: Array<{ name: string; cron: string; options: unknown }> = [];
    scheduleIsolated({ background: { experimental_vkSchedule: (name: string, cron: string, _fn: unknown, options: unknown) => { calls.push({ name, cron, options }); }, schedule: () => undefined } } as never, "schedule-board-tick", "* * * * *", () => undefined, { timeoutMs: 120_000 });
    return { calls };
  },
  async settings() {
    const { db } = scratch();
    saveProjectSetting(db, "*", "ops.pool_size", 9);
    const shared = loadProjectSettings(db, "proj_w")["ops.pool_size"];
    saveProjectSetting(db, "proj_w", "ops.pool_size", 4);
    const own = loadProjectSettings(db, "proj_w")["ops.pool_size"];
    const other = loadProjectSettings(db, "proj_other")["ops.pool_size"];
    saveProjectSetting(db, "proj_w", "ops.pool_size", 6);
    return { shared, own, other, changed: loadProjectSettings(db, "proj_w")["ops.pool_size"] };
  },
  async breaker() {
    const { bb, db } = scratch();
    createRun(db, "run", "proj", "bb");
    const { stability } = createStability({ bb, isDisposed: () => false, db, log: () => undefined } as never, { activeWriterTasks: new Set(), enqueueResumedWriter: async () => true } as never);
    const fault = (n: number) => `attempt_worktree_holder_ambiguous:page_cap lpattempt_${n}aaaaaaaaaaaa`;
    for (const [task, n] of [["T1", 1], ["T2", 2]] as const) await stability.onTaskFailed({ projectId: "proj", runId: "run", taskId: task, pmThreadId: "pm", state: "blocked", reason: fault(n) }, n * 1000);
    const early = stability.breakerHolds("proj", 3000);
    await stability.onTaskFailed({ projectId: "proj", runId: "run", taskId: "T3", pmThreadId: "pm", state: "blocked", reason: fault(3) }, 3000);
    return { early, held: stability.breakerHolds("proj", 4000), other: stability.breakerHolds("other", 4000) };
  },
  async orphans() {
    const { bb, db } = scratch({ sdk: { threads: { stop: async () => undefined, list: async () => [], get: async () => ({ status: "idle" }) } } });
    createRun(db, "run", "proj", "cli", "/repo");
    for (const id of ["a_half", "a_live"]) { createAttempt(db, { id, runId: "run", taskId: `t_${id}` }); db.prepare("UPDATE lane_pilot_attempt SET reason=? WHERE id=?").run(DISPATCH_STAGES_PENDING, id); }
    const reconcile = createReconcile({ acceptedTaskWorkspace: () => ({}), configForRun: async () => null, refreshRun: () => undefined, isDisposed: () => false, log: () => undefined, db, bb } as never,
      { resumeDispatch: async (id: string) => ({ resumed: id === "a_live", why: "its helpers are gone" }), rollback: { noteStopped: async () => ({ recorded: false }) }, startWriterTask: () => undefined } as never);
    const result = await reconcile.resumeOrphans("proj");
    return { result, half: db.prepare("SELECT state, reason FROM lane_pilot_attempt WHERE id='a_half'").get(), live: (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='a_live'").get() as { state: string }).state };
  },
  async sweep() {
    const run = async (status: "saved" | "failed") => {
      const events: string[] = [];
      const { bb, db } = scratch({ sdk: { environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "ovh", path: `/wt/${environmentId}`, lifecycle: { phase: "active" } }),
        archiveThreads: async () => { events.push("archive"); },
        delete: async ({ environmentId }: { environmentId: string }) => { events.push(`delete:${environmentId}`); },
      } } });
      bb.log.warn = () => undefined;
      createRun(db, "run", "proj", "cli", "/repo");
      createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
      db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, state=?, updated_at=? WHERE id=?").run("env_1", "accepted", 1_000, "a1");
      const removed = await cleanupFinishedAttemptEnvironments(bb, db, async (_host, path) => { events.push(`snapshot:${path}`); return { status, path: status === "saved" ? "/released/env_1.patch" : null, reason: status === "failed" ? "disk" : null }; }, 1_000 + 3_600_000);
      return { removed, events };
    };
    return { saved: await run("saved"), failed: await run("failed") };
  },
  async cancels() {
    const { bb, db } = scratch();
    createRun(db, "run", "proj", "cli", "/repo");
    const stops: string[] = [];
    let status = "active";
    const ctx = { acceptedTaskWorkspace: () => ({}), configForRun: async () => null, refreshRun: () => undefined, isDisposed: () => false, log: () => undefined, db,
      bb: { ...bb, log: quiet, sdk: { ...bb.sdk, threads: { stop: async (args: { threadId: string }) => { stops.push(args.threadId); return {}; }, get: async () => ({ status }), listRunning: async () => [] } }, storage: { kv: { get: async () => null, set: async () => undefined } } } } as never;
    const reconcile = createReconcile(ctx, { resumeDispatch: async () => ({ resumed: false, why: "test" }), rollback: { noteStopped: async () => ({ recorded: false }) }, startWriterTask: () => undefined } as never);
    for (const [id, thread, age] of [["att_old", "thr_old", 120_000], ["att_young", "thr_young", 5_000]] as const) {
      createAttempt(db, { id, runId: "run", taskId: `t_${id}` });
      db.prepare("UPDATE lane_pilot_attempt SET state='cancel_requested', thread_id=?, updated_at=? WHERE id=?").run(thread, Date.now() - age, id);
    }
    const whileActive = await reconcile.recheckCancels();
    status = "idle";
    const whenIdle = await reconcile.recheckCancels();
    return { whileActive, whenIdle, young: (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='att_young'").get() as { state: string }).state, stopped: stops };
  },
  async pool() {
    const { bb, db } = scratch();
    const canary = (blocked: Array<{ key: string; projectIds: string[]; reason: string }>) => createCanary({ bb: { ...bb, log: quiet }, db, isDisposed: () => false, log: () => undefined } as never, undefined, async () => ({ enabled: 2, blocked }));
    const held = await canary([{ key: "codex/gpt", projectIds: ["proj"], reason: "writer_provider_unavailable:breaker_open:codex/gpt" }]).status();
    const free = await canary([]).status();
    const deps = { breaker: { snapshot: (at = Date.now()) => [{ key: "codex/gpt", state: "open" as const, failures: 3, openedAt: at, lastOutcome: "exhausted" as const }] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true };
    const ready = await poolReadiness([{ projectId: "proj", hostId: "hub", settings: {}, members: [{ providerId: "claude-code", model: "sonnet" }, { providerId: "codex", model: "gpt" }] }], (members, input) => walkWriterChain(members, input, deps as never));
    return { held: held.green, free: free.green, enabled: ready.enabled, blocked: ready.blocked.map((row) => `${row.key}|${row.projectIds.join(",")}|${row.reason.split(":").slice(0, 2).join(":")}`) };
  },
};

it("probe of region 5", async () => {
  const out: Record<string, unknown> = {};
  for (const [name, section] of Object.entries(sections)) {
    try { out[name] = await section(); } catch (cause) { out[name] = { error: cause instanceof Error ? cause.message : String(cause) }; }
  }
  writeFileSync(process.env.SMA_R05_OUT ?? "/tmp/sma_r05_probe.json", JSON.stringify(out));
}, 600_000);
