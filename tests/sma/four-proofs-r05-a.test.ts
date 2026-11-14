// Region 5 · Daemon life, batch a — the behaviour proofs of the map nodes n440–n471 (docs/sma-evidence.md). Each test checks the result
// a card names (what was stored, which line was said, which call came in which order), not that a function was called.
// The boot-level cards (entry, composition, boot order, door before sweeps, the start line, the orderly stop) run the real plugin factory
// `server.ts` on the SDK's fake host; the others run the unit the card names. A node whose card describes the old daemon process is proved
// by the part of Lane Pilot that serves it now (BB core owns the process, the window and the failure text: n469, n470 are core-resident).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import plugin from "../../server";
import packageJson from "../../package.json";
import { rpcContract } from "../../src/rooms/contracts";
import { createCore } from "../../src/rooms/core/server/core";
import { migrations } from "../../src/rooms/migrations";
import { validateSettingChanges, validateSettingValue, validateSettingsObject, coupledSettingKeys } from "../../src/rooms/settings";
import { openDatabase as openStorageDatabase, requireSettingValidator, HARNESS_VERSION } from "../../src/rooms/storage/database";
import { createAttempt, createRun, createTask, loadProjectSettings, openDatabase, saveProjectSetting, transitionAttempt } from "../../src/rooms/plugin-db";
import { listAttemptsForTask } from "../../src/rooms/storage/attempts-store/lifecycle";
import { buildRunPolicy, WRITER_TURN_CEILING_DEFAULT } from "../../src/rooms/tasks/run-policy";
import { PROCESS_KEY, STOP_KEY, recordStartGap } from "../../src/rooms/outage/server/outage";
import { BEAT_KEY } from "../../src/rooms/outage/logic";
import { listOutages } from "../../src/rooms/outage/store";
import { createCanary, poolReadiness } from "../../src/rooms/stability/server/canary";
import { createStability } from "../../src/rooms/stability/server/stability";
import { createReconcile } from "../../src/rooms/stability/server/reconcile";
import { mountOutbound, worldVersion } from "../../src/rooms/relay/server/outbound";
import { TICK_DEPS, checkTickDeps } from "../../src/rooms/platform/server/tick-deps";
import { scheduleIsolated } from "../../src/rooms/platform/server/schedules";
import { cleanupFinishedAttemptEnvironments } from "../../src/rooms/runs/server/run-finish";
import { conveyorStartLine, conveyorState, setConveyor } from "../../src/rooms/runs/conveyor";
import { buildTaskBoard } from "../../src/rooms/runs/server/task-board";
import { readThreadLive } from "../../src/rooms/runs/server/thread-live";
import { createDeployDrain } from "../../src/rooms/stability/server/deploy-drain";

const VERSION = packageJson.version;
const MIN = 60_000;

/** The SDK's fake host with a recorder: the order in which the factory touches storage, the door, the schedules and the services. */
function fakeHost(over: { vk?: { startReason: string; afterDrain?: boolean }; envDeleted?: string[]; hostCalls?: string[] } = {}) {
  const order: string[] = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: { list: async () => [], get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle" }) },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "ovh", path: `/wt/${environmentId}`, lifecycle: { phase: "active" } }),
        archiveThreads: async () => undefined,
        delete: async ({ environmentId }: { environmentId: string }) => { over.envDeleted?.push(`${environmentId}@rpc${harness.registrations.rpcMethods.length}`); },
      },
    },
    experimental_callHostRpc: (async (call: { method: string }) => { over.hostCalls?.push(call.method); return { hostId: "ovh", status: "clean", path: null, dirty: 0, ahead: 0, reason: null }; }) as never,
  } as never);
  if (over.vk) (bb as unknown as { vk: unknown }).vk = over.vk;
  const wrap = <T extends object>(target: T, key: keyof T, label: (args: unknown[]) => string) => {
    const original = (target[key] as unknown as (...args: unknown[]) => unknown).bind(target);
    (target as Record<string, unknown>)[key as string] = (...args: unknown[]) => { order.push(label(args)); return original(...args); };
  };
  wrap(bb.storage as never, "migrate", () => "migrate");
  wrap(bb.rpc as never, "register", () => "rpc.register");
  wrap(bb.background as never, "schedule", (args) => `schedule:${String(args[0])}`);
  wrap(bb.background as never, "service", (args) => `service:${String(args[0])}`);
  return { bb, harness, order };
}
async function boot(over: Parameters<typeof fakeHost>[0] = {}) {
  const host = fakeHost(over);
  await plugin(host.bb);
  return { ...host, db: openDatabase(host.bb) };
}
/** Runs the start-up recovery service until `done` holds, then stops it (its two-minute cancel re-check timer dies with the signal). */
async function recover(host: Awaited<ReturnType<typeof boot>>, done: () => boolean | Promise<boolean>) {
  const run = host.harness.runService("startup-recovery");
  try { await vi.waitFor(async () => { expect(await done()).toBe(true); }, { timeout: 15_000, interval: 50 }); }
  finally { run.controller.abort(); await run.done; }
}
const ctxOf = (bb: ReturnType<typeof fakeHost>["bb"], db: ReturnType<typeof openDatabase>) => ({ bb, db, log: () => undefined } as never);
const warnings = (host: { harness: { logEntries: Array<{ level: string; message: string }> } }) => host.harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);

describe("daemon boot: the entry, the composition and the order of the start", () => {
  it("[sma:m_entry] importing the plugin file starts nothing; calling the factory starts it and says so", async () => {
    const host = fakeHost();
    expect(typeof plugin).toBe("function");
    // The file is imported above: a fresh host holds no door, no schedule, no service and no log line yet.
    expect({ rpc: host.harness.registrations.rpcMethods.length, schedules: host.harness.registrations.schedules.length, services: host.harness.registrations.services.length, logs: host.harness.logEntries.length })
      .toEqual({ rpc: 0, schedules: 0, services: 0, logs: 0 });
    await plugin(host.bb);
    expect(host.harness.logEntries.map((entry) => entry.message)).toContain("Lane Pilot PM-to-writer pipeline loaded");
    expect(host.harness.registrations.rpcMethods.length).toBeGreaterThan(100);
    await host.harness.lifecycle.dispose();
  }, 60_000);

  it("[sma:m_compose] one call builds the queue, the ledger, the door, the CLI, the tools and the tick wiring", async () => {
    const host = await boot();
    const tables = (host.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_%'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["lane_pilot_run", "lane_pilot_task", "lane_pilot_attempt", "lane_pilot_attempt_transition", "lane_pilot_task_transition"]));
    expect(Object.keys(rpcContract).filter((name) => !host.harness.registrations.rpcMethods.includes(name))).toEqual([]);
    expect(host.harness.registrations.cli).not.toBeNull();
    expect(host.harness.registrations.agentTools.length).toBeGreaterThan(30);
    expect(await host.bb.storage.kv.get("lp.tick-deps")).toEqual({ wired: [...TICK_DEPS], missing: [] });
    await host.harness.lifecycle.dispose();
  }, 60_000);

  it("[sma:m_start] the start runs in order: the queue opens, the door opens, the schedules follow, the recovery service comes last and stamps the version's first start", async () => {
    const host = await boot();
    const at = (label: string) => host.order.indexOf(label);
    expect(at("migrate")).toBe(0);
    expect(at("rpc.register")).toBeGreaterThan(at("migrate"));
    expect(at("schedule:attempt-worktree-sweep")).toBeGreaterThan(at("rpc.register"));
    expect(at("schedule:schedule-board-tick")).toBeGreaterThan(at("schedule:task-reconcile"));
    expect(at("service:startup-recovery")).toBeGreaterThan(at("schedule:attempt-worktree-sweep"));
    expect(at("schedule:schedule-board-tick")).toBeGreaterThan(at("service:startup-recovery"));
    expect(await host.bb.storage.kv.get(`canary:since:${VERSION}`)).toBeUndefined();
    await recover(host, async () => typeof await host.bb.storage.kv.get(`canary:since:${VERSION}`) === "number");
    await host.harness.lifecycle.dispose();
  }, 60_000);

  it("[sma:m_listen] the door is open before the start-up recovery sweeps the worker's copies", async () => {
    const envDeleted: string[] = [];
    const host = await boot({ envDeleted });
    createRun(host.db, "run", "proj", "cli", "/repo");
    createAttempt(host.db, { id: "a1", runId: "run", taskId: "t1" });
    host.db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, state=?, updated_at=? WHERE id=?").run("env_old", "accepted", Date.now() - 3_600_000, "a1");
    await recover(host, () => envDeleted.length > 0);
    // `@rpcN` is the number of door methods registered at the moment the sweep deleted the copy: all of them.
    expect(envDeleted).toEqual([`env_old@rpc${host.harness.registrations.rpcMethods.length}`]);
    expect(host.harness.registrations.rpcMethods.length).toBeGreaterThan(100);
    await host.harness.lifecycle.dispose();
  }, 60_000);

  it("[sma:m_boot_wt_sweep] every start sweeps the finished attempts' worktrees: the changes are saved first, then the copy goes", async () => {
    const envDeleted: string[] = [];
    const hostCalls: string[] = [];
    const host = await boot({ envDeleted, hostCalls, vk: { startReason: "start" } });
    createRun(host.db, "run", "proj", "cli", "/repo");
    createAttempt(host.db, { id: "a1", runId: "run", taskId: "t1" });
    host.db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, state=?, updated_at=? WHERE id=?").run("env_done", "accepted", Date.now() - 3_600_000, "a1");
    createAttempt(host.db, { id: "a2", runId: "run", taskId: "t2" });
    host.db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, state=?, updated_at=? WHERE id=?").run("env_recent", "accepted", Date.now() - 60_000, "a2");
    await recover(host, () => envDeleted.length > 0);
    expect(envDeleted.map((line) => line.split("@")[0])).toEqual(["env_done"]);
    expect(hostCalls.filter((method) => method === "gitWorktreeSnapshot")).toHaveLength(1);
    await host.harness.lifecycle.dispose();
  }, 60_000);

  it("[sma:m_say_pipeline] one start line names the conveyor state and the way out of it; none while the conveyor is on", async () => {
    expect(conveyorStartLine({ on: true, since: null, reason: null })).toBeNull();
    const line = conveyorStartLine({ on: false, since: "2026-11-10T08:00:00.000Z", reason: "owner pause" });
    expect(line).toBe("Lane Pilot: the conveyor is OFF since 2026-11-10T08:00:00.000Z (owner pause): no new work is issued. Turn it on with: bb lane-pilot conveyor on");
    const off = await boot();
    await setConveyor(off.bb.storage.kv as never, false, "owner pause");
    const said = () => warnings(off).filter((message) => message.includes("the conveyor is OFF"));
    await recover(off, () => said().length === 1);
    expect(said()[0]).toContain("(owner pause): no new work is issued. Turn it on with: bb lane-pilot conveyor on");
    await off.harness.lifecycle.dispose();
    const on = await boot();
    await recover(on, async () => typeof await on.bb.storage.kv.get(`canary:since:${VERSION}`) === "number");
    expect(warnings(on).filter((message) => message.includes("the conveyor is OFF"))).toEqual([]);
    expect(await conveyorState(on.bb.storage.kv as never)).toEqual({ on: true, since: null, reason: null });
    await on.harness.lifecycle.dispose();
  }, 90_000);

  it("[sma:m_stop] an orderly stop names itself: the next start reads «reloaded», not «died»", async () => {
    const host = await boot();
    const before = Date.now();
    // What the stop writes is read as it is written: after the dispose the handle is stale, as it is for the real plugin.
    const writes: Array<[string, unknown]> = [];
    const kv = host.bb.storage.kv;
    const set = kv.set.bind(kv);
    (kv as { set: unknown }).set = (key: string, value: unknown) => { writes.push([key, value]); return set(key, value as never); };
    await host.harness.lifecycle.dispose();
    const stop = writes.find(([key]) => key === STOP_KEY)?.[1] as { reason: string; at: number };
    expect(stop.reason).toBe("the plugin was reloaded (a deploy or a settings change)");
    expect(stop.at).toBeGreaterThanOrEqual(before);
    // The next start, 20 minutes later on the same store: the gap is on record and carries the stop's words.
    const next = fakeHost();
    const db = openDatabase(next.bb);
    await next.bb.storage.kv.set(BEAT_KEY, stop.at - 1_000);
    await next.bb.storage.kv.set(STOP_KEY, stop);
    await recordStartGap(ctxOf(next.bb, db), stop.at + 20 * MIN);
    expect(listOutages(db, 0).map((row) => row.cause)).toEqual(["the plugin was reloaded (a deploy or a settings change)"]);
    expect(await next.bb.storage.kv.get(STOP_KEY)).toBeNull();
  }, 60_000);

  it("[sma:m_stop] a drain turned on holds the new checkout writes until the running one ends, then lets them through", async () => {
    let clock = 0;
    const drain = createDeployDrain(() => false, () => clock, 5);
    let release!: () => void;
    const running = drain.around("gitIntegrate", () => new Promise<string>((done) => { release = () => done("merged"); }));
    expect(drain.set(true)).toMatchObject({ draining: true, inFlight: [{ method: "gitIntegrate" }] });
    let started = false;
    const held = drain.around("gitCreateWorktree", async () => { started = true; return "created"; });
    await new Promise((wake) => setTimeout(wake, 20));
    expect(started).toBe(false);
    release();
    expect(await running).toBe("merged");
    expect(drain.status().inFlight).toEqual([]);
    drain.set(false);
    expect(await held).toBe("created");
  });

  it("[sma:m_front_build] the door takes every method of the contract, built from ready capabilities, and answers from them", async () => {
    const host = await boot();
    expect(Object.keys(rpcContract).filter((name) => !host.harness.registrations.rpcMethods.includes(name))).toEqual([]);
    expect(await host.harness.behavior.callRpc("canary_status", {})).toMatchObject({ version: VERSION, green: true, tripped: false });
    expect(await host.harness.behavior.callRpc("conveyor", {})).toEqual({ on: true, since: null, reason: null });
    expect(await host.harness.behavior.callRpc("world_version", {})).toEqual({ version: worldVersion() });
    await host.harness.lifecycle.dispose();
  }, 60_000);

  it("[sma:m_derive_share] two board requests at once get one and the same derivation, and the thread view is cut from the same board", async () => {
    const host = await boot();
    createRun(host.db, "run_b", "proj_b", "bb", "/w");
    host.db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run_b");
    for (const [id, age] of [["t_old", 2 * MIN], ["t_new", 0]] as const) {
      createTask(host.db, { id, runId: "run_b", kind: "bb", contract: { title: id, kind: "feature" } });
      createAttempt(host.db, { id: `a_${id}`, runId: "run_b", taskId: id });
      host.db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id=?").run(Date.now() - age, `a_${id}`);
    }
    const [first, second] = await Promise.all([host.harness.behavior.callRpc("task_board", { projectId: "proj_b", doneHours: 24 }), host.harness.behavior.callRpc("task_board", { projectId: "proj_b", doneHours: 24 })]) as Array<{ items: Array<{ taskId: string }> }>;
    expect(first.items.map((item) => item.taskId)).toEqual(["t_new", "t_old"]);
    expect(second).toEqual(first);
    expect(buildTaskBoard(host.db, { projectId: "proj_b", doneSince: Date.now() - 24 * 60 * MIN }).map((item) => item.taskId)).toEqual(["t_new", "t_old"]);
    const live = readThreadLive(host.db, "thr_pm", () => null as never);
    expect(live?.items.map((item) => item.taskId)).toEqual(["t_new", "t_old"]);
    await host.harness.lifecycle.dispose();
  }, 60_000);
});

describe("daemon boot: settings, passport, queue and ledger", () => {
  it("[sma:m_load_config] the settings are read once at the creation of a run: the run lives on that copy", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    const frozen = buildRunPolicy({ "ops.pool_size": 7, "ops.verify_pool_size": 3, "writer.max_turns": 40 });
    expect(frozen).toEqual({ schemaVersion: 1, pools: { provider: 7, verification: 3 }, maxTurns: 40 });
    // Nothing set: the factory defaults.
    expect(buildRunPolicy({})).toEqual({ schemaVersion: 1, pools: { provider: 15, verification: 2 }, maxTurns: WRITER_TURN_CEILING_DEFAULT });
    createRun(db, "r_first", "proj", "bb", null, "none", frozen, null);
    // The settings change after the run began: a run made now takes the new numbers, the first keeps its copy.
    createRun(db, "r_second", "proj", "bb", null, "none", buildRunPolicy({ "ops.pool_size": 2 }), null);
    expect(ctx.runPolicyFor("r_first")).toEqual(frozen);
    expect(ctx.runPolicyFor("r_second").pools.provider).toBe(2);
  });

  it("[sma:m_passport] the harness version is the plugin's own tree: the canary, the attempt stamp and package.json agree", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "bb", "/w");
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const stamped = (db.prepare("SELECT harness_version AS v FROM lane_pilot_attempt WHERE id='a1'").get() as { v: string }).v;
    const status = await createCanary(ctxOf(bb, db)).status();
    expect(status.version).toBe(packageJson.version);
    expect(stamped).toBe(packageJson.version);
    expect(HARNESS_VERSION).toBe(packageJson.version);
  });

  it("[sma:m_queue_build] the queue is the plugin's SQLite: its settings writes are validated by the validator the opener wired", () => {
    const validator = { validateSettingValue, validateSettingsObject, coupledSettingKeys, validateSettingChanges };
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openStorageDatabase(bb, { migrations, validateSetting: validator });
    expect(() => requireSettingValidator(db)).not.toThrow();
    expect(requireSettingValidator(db)).toBe(validator);
    const { bb: other } = createFakePluginHost({ pluginId: "lane-pilot" });
    expect(() => requireSettingValidator(openStorageDatabase(other, { migrations }))).toThrow(/need a validator/);
  });

  it("[sma:m_mkdirs] the schema is created by the migrations, all of them, before any write", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const applied: unknown[][] = [];
    const original = (bb.storage as unknown as { migrate: (...args: unknown[]) => unknown }).migrate.bind(bb.storage);
    (bb.storage as unknown as { migrate: unknown }).migrate = (...args: unknown[]) => { applied.push(args); return original(...args); };
    const db = openStorageDatabase(bb, { migrations });
    expect(applied).toHaveLength(1);
    expect(applied[0]![1]).toEqual(migrations);
    // A write right after the open finds its tables.
    expect(() => db.prepare("SELECT COUNT(*) FROM lane_pilot_run").get()).not.toThrow();
    expect(() => db.prepare("SELECT COUNT(*) FROM lane_pilot_attempt_transition").get()).not.toThrow();
  });

  it("[sma:m_durable_up] the queue is consistent from the first enqueue: a task for a run that does not exist is refused", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    expect(() => createTask(db, { id: "t_orphan", runId: "no_such_run", kind: "bb", contract: {} })).toThrow(/FOREIGN KEY/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_task").get()).toEqual({ n: 0 });
    createRun(db, "run", "proj", "bb");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: {} });
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_task").get()).toEqual({ n: 1 });
  });

  it("[sma:m_ledger_seam] the attempts of a task come from one ledger, in the order they were made, with their journal beside them", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "bb");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: {} });
    createAttempt(db, { id: "a_first", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a_first", "spawn_requested");
    transitionAttempt(db, "a_first", "running", { threadId: "thr_1" });
    transitionAttempt(db, "a_first", "blocked", { reason: "check failed" });
    createAttempt(db, { id: "a_second", runId: "run", taskId: "t1" });
    expect(listAttemptsForTask(db, "run", "t1")).toEqual([
      { id: "a_first", state: "blocked", attempt_no: 1, thread_id: "thr_1" },
      { id: "a_second", state: "queued", attempt_no: 2, thread_id: null },
    ]);
    const journal = db.prepare("SELECT to_state, reason FROM lane_pilot_attempt_transition WHERE attempt_id='a_first' ORDER BY rowid").all();
    expect(journal).toEqual([{ to_state: "spawn_requested", reason: null }, { to_state: "running", reason: null }, { to_state: "blocked", reason: "check failed" }]);
  });

  it("[sma:m_wrappers] a task write, its journal row and the world counter land in one frame; a refused write leaves none of them", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "bb");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: {} });
    const journal = (task: string) => db.prepare("SELECT field FROM lane_pilot_task_transition WHERE task_id=? ORDER BY rowid").all(task);
    expect(journal("t1")).toEqual([{ field: "created" }]);
    const seq = (task: string) => (db.prepare("SELECT world_seq AS s FROM lane_pilot_task WHERE id=?").get(task) as { s: number }).s;
    const first = seq("t1");
    createTask(db, { id: "t2", runId: "run", kind: "bb", contract: {} });
    expect(seq("t2")).toBe(first + 1);
    expect(journal("t2")).toEqual([{ field: "created" }]);
  });

  it("[sma:m_world_stamp] every write of an attempt raises the world number by one, and the door reads that number", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    mountOutbound({ db, bb, log: () => undefined, isDisposed: () => false } as never);
    createRun(db, "run", "proj", "bb");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: {} });
    const start = worldVersion();
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    expect(worldVersion()).toBe(start + 1);
    transitionAttempt(db, "a1", "spawn_requested");
    expect(worldVersion()).toBe(start + 2);
    // A move to the state the attempt is already in changes nothing and raises nothing.
    transitionAttempt(db, "a1", "spawn_requested");
    expect(worldVersion()).toBe(start + 2);
    await harness.lifecycle.dispose();
  });
});

describe("daemon boot: the process record, the tick, the start line and the workers", () => {
  it("[sma:m_death_nets] a start after a long silence puts the gap on record with the name of the way the last run ended", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const now = 10 * 60 * MIN;
    // The last run said why it stopped, a minute after its last beat: the gap carries those words.
    await bb.storage.kv.set(BEAT_KEY, now - 30 * MIN);
    await bb.storage.kv.set(STOP_KEY, { reason: "the plugin was reloaded (a deploy or a settings change)", at: now - 29 * MIN });
    await recordStartGap(ctxOf(bb, db), now);
    // The last run said nothing, and an old stop record from another day does not count: the gap is a death without a name.
    await bb.storage.kv.set(BEAT_KEY, now + 30 * MIN);
    await bb.storage.kv.set(STOP_KEY, { reason: "an old deploy", at: now - 600 * MIN });
    await recordStartGap(ctxOf(bb, db), now + 60 * MIN);
    // A gap under five minutes is no outage.
    await bb.storage.kv.set(BEAT_KEY, now + 61 * MIN);
    await recordStartGap(ctxOf(bb, db), now + 63 * MIN);
    expect(listOutages(db, 0).map((row) => ({ minutes: row.minutes, cause: row.cause }))).toEqual([
      { minutes: 30, cause: "the plugin was reloaded (a deploy or a settings change)" },
      { minutes: 30, cause: "остановился без предупреждения: сбой, зависание или машина выключилась" },
    ]);
  });

  it("[sma:m_pid_record] the start writes the process record: process number, runtime and start time", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    await recordStartGap(ctxOf(bb, db), 1_700_000_000_000);
    expect(await bb.storage.kv.get(PROCESS_KEY)).toEqual({ startedAt: 1_700_000_000_000, pid: process.pid, node: process.version });
    expect(await bb.storage.kv.get(BEAT_KEY)).toBe(1_700_000_000_000);
  });

  it("[sma:m_tick_deps] a bag with services missing names each missing one, a full bag names none", () => {
    const bag: Record<string, unknown> = {};
    expect(checkTickDeps(bag)).toEqual({ wired: [], missing: [...TICK_DEPS] });
    for (const name of TICK_DEPS) bag[name] = {};
    expect(checkTickDeps(bag)).toEqual({ wired: [...TICK_DEPS], missing: [] });
    bag.canary = null;
    expect(checkTickDeps(bag)).toEqual({ wired: TICK_DEPS.filter((name) => name !== "canary"), missing: ["canary"] });
  });

  it("[sma:m_run_daemon] the tick is a schedule of the core: isolated, one run at a time, with a time limit; every minute on the board's tick", async () => {
    const calls: Array<{ name: string; cron: string; options: unknown }> = [];
    const bb = { background: { experimental_vkSchedule: (name: string, cron: string, fn: unknown, options: unknown) => { calls.push({ name, cron, options }); void fn; }, schedule: () => { throw new Error("the plain schedule is the fallback only"); } } };
    scheduleIsolated(bb as never, "schedule-board-tick", "* * * * *", () => undefined, { timeoutMs: 120_000 });
    expect(calls).toEqual([{ name: "schedule-board-tick", cron: "* * * * *", options: { isolated: true, timeoutMs: 120_000, overlap: "skip" } }]);
    // A core without isolated schedules gets the ordinary one, same name and cron.
    const plain: string[] = [];
    scheduleIsolated({ background: { schedule: (name: string, cron: string) => { plain.push(`${name}@${cron}`); } } } as never, "schedule-board-tick", "* * * * *", () => undefined, { timeoutMs: 1 });
    expect(plain).toEqual(["schedule-board-tick@* * * * *"]);
    const host = await boot();
    expect(host.harness.registrations.schedules.filter((schedule) => schedule.name === "schedule-board-tick").map((schedule) => schedule.cron)).toEqual(["* * * * *"]);
    await host.harness.lifecycle.dispose();
  }, 60_000);

  it("[sma:m_sweep_worker_copies] a finished attempt's worktree is saved first and removed after; a copy whose save failed stays", async () => {
    const run = async (status: "saved" | "failed") => {
      const events: string[] = [];
      const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { environments: {
        get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "ovh", path: `/wt/${environmentId}`, lifecycle: { phase: "active" } }),
        archiveThreads: async () => { events.push("archive"); },
        delete: async ({ environmentId }: { environmentId: string }) => { events.push(`delete:${environmentId}`); },
      } } as never });
      vi.spyOn(bb.log, "warn").mockImplementation(() => undefined);
      const db = openDatabase(bb);
      createRun(db, "run", "proj", "cli", "/repo");
      createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
      db.prepare("UPDATE lane_pilot_attempt SET environment_id=?, state=?, updated_at=? WHERE id=?").run("env_1", "accepted", 1_000, "a1");
      const removed = await cleanupFinishedAttemptEnvironments(bb, db, async (_host, path) => { events.push(`snapshot:${path}`); return { status, path: status === "saved" ? "/released/env_1.patch" : null, reason: status === "failed" ? "disk" : null }; }, 1_000 + 3_600_000);
      return { removed, events };
    };
    expect(await run("saved")).toEqual({ removed: ["env_1"], events: ["snapshot:/wt/env_1", "archive", "delete:env_1"] });
    expect(await run("failed")).toEqual({ removed: [], events: ["snapshot:/wt/env_1"] });
  });

  it("[sma:m_project_watch] a settings change is picked up by the next read with no restart: the project's own value beats the shared one", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    saveProjectSetting(db, "*", "ops.pool_size", 9);
    expect(loadProjectSettings(db, "proj_w")["ops.pool_size"]).toBe(9);
    saveProjectSetting(db, "proj_w", "ops.pool_size", 4);
    expect(loadProjectSettings(db, "proj_w")["ops.pool_size"]).toBe(4);
    expect(loadProjectSettings(db, "proj_other")["ops.pool_size"]).toBe(9);
    saveProjectSetting(db, "proj_w", "ops.pool_size", 6);
    expect(loadProjectSettings(db, "proj_w")["ops.pool_size"]).toBe(6);
  });

  it("[sma:m_outsiders] a project whose writers keep failing on one fault gets no new writer and the hold names the fault; another project is untouched", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "bb");
    const { stability } = createStability({ bb, isDisposed: () => false, db, log: () => undefined } as never, { activeWriterTasks: new Set(), enqueueResumedWriter: async () => true } as never);
    const fault = (n: number) => `attempt_worktree_holder_ambiguous:page_cap lpattempt_${n}aaaaaaaaaaaa`;
    for (const [task, n] of [["T1", 1], ["T2", 2]] as const) await stability.onTaskFailed({ projectId: "proj", runId: "run", taskId: task, pmThreadId: "pm", state: "blocked", reason: fault(n) }, n * 1000);
    expect(stability.breakerHolds("proj", 3000)).toBeNull();
    await stability.onTaskFailed({ projectId: "proj", runId: "run", taskId: "T3", pmThreadId: "pm", state: "blocked", reason: fault(3) }, 3000);
    expect(stability.breakerHolds("proj", 4000)).toBe("several tasks failed on one Lane Pilot fault («attempt_worktree_holder_ambiguous:page_cap <id>»), waiting for its fix");
    expect(stability.breakerHolds("other", 4000)).toBeNull();
  });

  it("[sma:m_recover_jobs] a dispatch the last process left half done is ended on the new start with its reason on record", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { stop: async () => undefined, list: async () => [], get: async () => ({ status: "idle" }) } } } as never);
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    createAttempt(db, { id: "a_half", runId: "run", taskId: "t1" });
    const { DISPATCH_STAGES_PENDING } = await import("../../src/rooms/runs");
    db.prepare("UPDATE lane_pilot_attempt SET reason=? WHERE id=?").run(DISPATCH_STAGES_PENDING, "a_half");
    createAttempt(db, { id: "a_live", runId: "run", taskId: "t2" });
    const ctx = { acceptedTaskWorkspace: () => ({}), configForRun: async () => null, refreshRun: () => undefined, isDisposed: () => false, log: () => undefined, db, bb } as never;
    const reconcile = createReconcile(ctx, { resumeDispatch: async (id: string) => ({ resumed: id === "a_live", why: "its helpers are gone" }), rollback: { noteStopped: async () => ({ recorded: false }) }, startWriterTask: () => undefined } as never);
    db.prepare("UPDATE lane_pilot_attempt SET reason=? WHERE id=?").run(DISPATCH_STAGES_PENDING, "a_live");
    const result = await reconcile.resumeOrphans("proj");
    expect(result).toEqual({ resumed: ["a_live"], skipped: ["a_half"], finished: [] });
    const row = db.prepare("SELECT state, reason FROM lane_pilot_attempt WHERE id='a_half'").get() as { state: string; reason: string };
    expect(row.state).toBe("blocked");
    expect(row.reason).toBe("dispatch interrupted by a reload before pm-read and plan critique finished (its helpers are gone); send the task again");
    expect((db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='a_live'").get() as { state: string }).state).toBe("queued");
  });
});
