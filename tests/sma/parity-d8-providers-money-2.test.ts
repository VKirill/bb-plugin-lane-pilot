/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { createProviderBreaker, breakerKey } from "@lane-pilot/resilience";
import { markOutputChanges, outputHashes, sha256Hex } from "@lane-pilot/kit";
import { collectAtlasInput } from "../../scripts/atlas-input";
import { createMoney } from "../../src/rooms/money/server";
import { createCore } from "../../src/rooms/core/server/core";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createWriterFinish } from "../../src/rooms/writer/server/finish";
import { createWriterSpawn } from "../../src/rooms/writer/server/spawn";
import { emitAttemptFinished } from "../../src/rooms/writer/server/attempt-finished";
import { mountWriterAttemptFinished } from "../../src/rooms/writer/server/attempt-reactions";
import { turnCeilingOfRun } from "../../src/rooms/writer/server/writer-silence";
import { listRuleProposals } from "@lane-pilot/run-insights";
import { migrations } from "../../src/rooms/plugin-db";
import { getAttempt, getRun, saveProjectSetting, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { upsertAttemptChange } from "../../src/rooms/rollback/store";
import { qaStopAfter } from "../../src/rooms/contracts/quality-mode";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { attemptSessionLayers, terminalParity } from "../../src/rooms/native-agent";
import { featureRegistry, featureRegistryGaps } from "../../src/rooms/native-install";
import { checkTickDeps, TICK_DEPS } from "../../src/rooms/platform/server";
import { GUARD_INVENTORY, guardInventoryGaps, STREAMS } from "../../src/rooms/session-hooks";
import { createAttempt, createRun, createTask, openDatabase, recordSkillMetric, saveReasoningTrace } from "../../src/rooms/plugin-db";
import { buildRunPolicy, parseRunPolicy, sha256 } from "../../src/rooms/tasks";
import { loadWriterNudge, sweepWriterSilence, type SilenceDeps } from "../../src/rooms/writer/server/writer-silence";
import { projectStats } from "../../src/rooms/tools/server/project-stats";
import { threadUsage } from "../../src/rooms/usage/server";
import { accountingPartsProblem } from "../../src/rooms/native-agent/server/helper-probe";
import { writerMarkers } from "../../src/rooms/tasks";
import { upsertLessonProposal } from "@lane-pilot/run-insights";
import { qaRoute } from "../../src/rooms/contracts/quality-mode";
import { normalizeModel } from "../../src/rooms/usage/server";
import { LIMIT } from "../../src/rooms/contracts/failure-class";
import { walkWriterChain, writerHold, type WriterHoldDeps } from "../../src/rooms/writer/server/writer-hold";
import { atlasStructure, capabilitySnapshot } from "../../scripts/atlas";
import { REQUIRED_CAPABILITIES } from "../../src/rooms/native-install/capabilities";
import { terminalSessionLayers } from "../../src/rooms/native-agent";

const T0 = 1_800_000_000_000;

function memKv() {
  const store = new Map<string, unknown>();
  return { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } };
}

function holdDeps() {
  const deps: WriterHoldDeps = {
    breaker: { snapshot: () => [] } as never,
    presence: undefined,
    usage: { hold: async () => null },
    coreHosts: () => true,
    log: () => undefined,
  };
  return { deps };
}

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb");
  return { bb, db };
}

describe("parity d8-2: providers and money", () => {
  it("[sma:k_t_capreg] every agent, skill and hook of the registry is shipped by the bundle, the streams or the capability contract, and an unknown skill is reported", () => {
    const registry = featureRegistry();
    expect(registry.length).toBeGreaterThan(1);
    const guard = registry.find((feature) => feature.id === "session-guard");
    expect(guard?.hooks.claude).toEqual([...STREAMS]);
    expect(guard?.hooks.opencode?.every((hook) => hook.startsWith("opencode.hook."))).toBe(true);
    expect(featureRegistryGaps(registry)).toEqual([]);
    const broken = [...registry, { id: "made-up", agents: {}, skills: { claude: ["no-such-skill"] }, hooks: {} }];
    expect(featureRegistryGaps(broken).some((gap) => gap.includes("no-such-skill"))).toBe(true);
  });

  it("[sma:m_tick_deps] an empty bag reports every tick dep missing and a full bag reports none", () => {
    expect(checkTickDeps({}).missing).toEqual([...TICK_DEPS]);
    const full = Object.fromEntries(TICK_DEPS.map((name) => [name, {}]));
    const report = checkTickDeps(full);
    expect(report.missing).toEqual([]);
    expect(report.wired).toEqual([...TICK_DEPS]);
  });

  it("[sma:k_d_ref_gates_inv] every stream and every pretask deny tag has a row with matcher, text and switch; an unknown deny tag is reported", () => {
    const ids = new Set(GUARD_INVENTORY.map((row) => row.id));
    for (const stream of STREAMS) expect(ids.has(stream)).toBe(true);
    for (const tag of ["execution-without-agent", "subagent-foreground", "subagent-cap"]) expect(ids.has(tag)).toBe(true);
    for (const row of GUARD_INVENTORY) {
      expect(row.matcher.length).toBeGreaterThan(0);
      expect(row.text.length).toBeGreaterThan(0);
      expect(row.switch.length).toBeGreaterThan(0);
    }
    expect(guardInventoryGaps(["no-such-deny"]).unknown).toEqual(["no-such-deny"]);
    expect(guardInventoryGaps().empty).toEqual([]);
  });

});

describe("parity d8-2: stats, lessons, routing, money", () => {
  it("[sma:k_c_stats] the project report carries phases, plans, requirements, git metrics, a timeline and the attempt metrics", () => {
    const { db } = world();
    createTask(db, { id: "T1", runId: "run", kind: "bb", contract: { title: "Task", objective: "obj" } } as never);
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    const stats = projectStats(db, "proj", 30);
    expect(stats.phases).toEqual([]);
    expect(stats.plans).toEqual({ pieces: 0, accepted: 0, withdrawn: 0 });
    expect(stats.requirements).toEqual({ covered: 0, total: 0 });
    expect(stats.git).toEqual({ commits: 0, files: 0 });
    expect(stats.timeline).toEqual([]);
    expect(stats.attempts.summary.attempts).toBeGreaterThan(0);
    // An accepted attempt whose merge is on the change ledger counts as a commit with its files, and lands on the timeline.
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr1" });
    transitionAttempt(db, "a1", "accepted");
    upsertAttemptChange(db, { attemptId: "a1", runId: "run", taskId: "T1" }, { mergeCommit: "abc123", changed: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "A" }] });
    const merged = projectStats(db, "proj", 30);
    expect(merged.git).toEqual({ commits: 1, files: 2 });
    expect(merged.timeline.map((row) => row.what)).toEqual(["accepted: T1"]);
  });

  it("[sma:m_tl_codex_lane] a usage event's breakdown becomes the four parts of the thread's usage, and the accounting probe names a missing part", async () => {
    const events = [{ seq: 1, createdAt: 1_000, type: "thread/tokenUsage/updated", data: { turnId: "turn-1", tokenUsage: { last: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, totalTokens: 15 }, total: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, totalTokens: 15 } } } }];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { events: { list: async (args: { threadId: string; afterSeq?: string; limit?: string }) => {
      const after = args.afterSeq ? Number(args.afterSeq) : 0;
      return (args.threadId === "thr" ? events : []).filter((event) => event.seq > after).slice(0, Number(args.limit ?? 100));
    } } } } } as never);
    const usage = await threadUsage(bb as never, "thr");
    expect(usage.parts).toEqual({ input: 10, output: 5, cached: 2, total: 15 });
    expect(accountingPartsProblem({ input: 10, output: 5, cached: 2, total: 15 })).toBeNull();
    expect(accountingPartsProblem({ input: 10, output: 5 } as never)).toMatch(/cached/);
  });
});

// ---- review fixes -------------------------------------------------------------------------------------------------

const MIN = 60_000;
const config: PrototypeConfig = { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test" };
const task: TaskV2 = {
  schema_version: 2, id: "t1", title: "Write", risk: "low", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [],
  objective: "write", acceptance: ["file exists"], verify: "none", verification: [],
};

/** A thread of completed tool calls, each a different call (one call repeated would read as a spin, not as work). */
function callEvents(from: number, count: number, createdAt: (seq: number) => number) {
  return Array.from({ length: count }, (_, index) => {
    const seq = from + index;
    return { type: "item/completed", seq, createdAt: createdAt(seq), data: { item: { type: "toolCall", name: "Read", input: { n: seq } } } };
  });
}

/** The thread's event list as BB serves it: newest first, `limit` per page, `beforeSeq` to walk back. */
function pagedThread(all: Array<{ seq: number }>, calls: Array<Record<string, unknown>>) {
  return async (args: { limit?: string; beforeSeq?: string }) => {
    calls.push(args as never);
    const before = args.beforeSeq ? Number(args.beforeSeq) : Infinity;
    return all.filter((event) => event.seq < before).sort((a, b) => b.seq - a.seq).slice(0, Number(args.limit ?? 50));
  };
}

function sweepWorld(events: Array<{ seq: number }>, options: { ceiling?: number | null; createdAt?: number } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  const kv = memKv();
  const attempt = { id: "a1", run_id: "run", task_id: "T1", thread_id: "thr_w", state: "running", project_id: "proj", created_at: options.createdAt ?? 0 };
  const deps: SilenceDeps = {
    bb: { sdk: { threads: { send: async () => ({}), events: { list: pagedThread(events, calls) } } }, storage: { kv } } as never,
    openAttempts: () => [attempt], getThread: async () => ({ status: "active" }), silenceMinutes: () => 999_999, isDisposed: () => false, log: () => undefined,
    ...(options.ceiling === undefined ? {} : { maxTurns: () => options.ceiling ?? null }),
  };
  return { deps, calls, kv };
}

describe("review fix 1: the turn ceiling is off unless a run froze one", () => {
  it("[sma:m_cfg_max_turns] with no ceiling the sweep makes main's single 50-event call and ends nothing, however many calls the thread shows", async () => {
    const events = callEvents(1, 300, (seq) => 1_000 + seq);
    for (const deps of [sweepWorld(events), sweepWorld(events, { ceiling: null })]) {
      expect(await sweepWriterSilence(deps.deps, 1_000 + 301)).toEqual([]);
      expect(deps.calls).toEqual([{ threadId: "thr_w", order: "desc", limit: "50" }]);
      expect(await loadWriterNudge(deps.kv as never, "a1")).toBeNull();
    }
  });

  it("[sma:m_cfg_max_turns] buildRunPolicy freezes the default ceiling when unset, none for 0 or off, a valid number as given, and a bad value never blocks the run", () => {
    // Unset is the measured default (300: twice the largest accepted attempt seen on the hub); 0 or off is the opt-out.
    for (const value of [undefined, "", null]) expect(buildRunPolicy({ "writer.max_turns": value }).maxTurns).toBe(300);
    expect(buildRunPolicy({}).maxTurns).toBe(300);
    for (const value of [0, "0", "off"]) expect("maxTurns" in buildRunPolicy({ "writer.max_turns": value })).toBe(false);
    expect(buildRunPolicy({ "writer.max_turns": "25" }).maxTurns).toBe(25);
    const warned: string[] = [];
    for (const bad of ["abc", 9999, -3, 2.5]) {
      const policy = buildRunPolicy({ "writer.max_turns": bad }, (line) => warned.push(line));
      expect("maxTurns" in policy).toBe(false);
      expect(policy.pools).toEqual({ provider: 15, verification: 2 });
    }
    // The same bad value is said once, not at every run.
    buildRunPolicy({ "writer.max_turns": "abc" }, (line) => warned.push(line));
    expect(warned.filter((line) => line.includes("abc"))).toHaveLength(1);
  });

  it("[sma:m_cfg_max_turns] a ceiling of 5 counts this attempt only: 300 calls of an earlier attempt on the same thread do not fire it, 6 of its own do", async () => {
    const earlier = callEvents(1, 300, () => 500);
    const own = (n: number) => callEvents(301, n, (seq) => 2_000 + seq);
    const quiet = sweepWorld([...earlier, ...own(3)], { ceiling: 5, createdAt: 1_000 });
    expect(await sweepWriterSilence(quiet.deps, 2_400)).toEqual([]);
    expect(await loadWriterNudge(quiet.kv as never, "a1")).toBeNull();
    const over = sweepWorld([...earlier, ...own(6)], { ceiling: 5, createdAt: 1_000 });
    expect(await sweepWriterSilence(over.deps, 2_400)).toEqual([{ attemptId: "a1", action: "ended", count: 0 }]);
    const record = await loadWriterNudge(over.kv as never, "a1");
    expect(record).toMatchObject({ ended: true, turnCeiling: 5 });
    expect(record?.reason).toMatch(/^run_budget_exceeded:turn ceiling 5 reached/);
  });

  it("[sma:m_cfg_max_turns] the count is right beyond one page of 200 events", async () => {
    const own = callEvents(1, 250, (seq) => 2_000 + seq);
    const fires = sweepWorld(own, { ceiling: 240, createdAt: 1_000 });
    expect(await sweepWriterSilence(fires.deps, 2_400)).toEqual([{ attemptId: "a1", action: "ended", count: 0 }]);
    expect(fires.calls.length).toBeGreaterThan(1);
    const holds = sweepWorld(own, { ceiling: 260, createdAt: 1_000 });
    expect(await sweepWriterSilence(holds.deps, 2_400)).toEqual([]);
  });

  it("[sma:m_cfg_max_turns] at the ceiling the attempt ends blocked like an appetite stop: thread stopped, breaker untouched, no provider hold, no retry spent", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo", "none", buildRunPolicy({ "writer.max_turns": 5 }));
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "writer-1" });
    saveReasoningTrace(db, { attemptId: "a1", runId: "run", threadId: "writer-1", providerId: "codex", model: "codex-test", effectiveReasoningLevel: "high", serviceTier: null } as never);
    // The sweep marks it, through the stored policy, on the real kv the watcher reads.
    const events = callEvents(1, 7, (seq) => 2_000 + seq);
    const calls: Array<Record<string, unknown>> = [];
    await sweepWriterSilence({
      bb: { sdk: { threads: { send: async () => ({}), events: { list: pagedThread(events, calls) } } }, storage: bb.storage } as never,
      openAttempts: () => [{ id: "a1", run_id: "run", task_id: "t1", thread_id: "writer-1", state: "running", project_id: "P", created_at: 0 }],
      getThread: async () => ({ status: "active" }), silenceMinutes: () => 999_999, isDisposed: () => false, log: () => undefined,
      maxTurns: (_project, runId) => turnCeilingOfRun(getRun(db, runId)),
    }, 2_400);
    const stopped: string[] = [];
    const ctx = {
      state: { disposed: false }, bb: { storage: bb.storage, log: { warn() {}, error() {} },
        sdk: { threads: { stop: async ({ threadId }: { threadId: string }) => { stopped.push(threadId); }, events: { list: async () => [] }, get: async () => ({ status: "active" }) } } },
      db, getThreadBounded: async () => ({ status: "active" }), host: { call: async () => ({}) },
    };
    const providerBreaker = createProviderBreaker();
    const finish = createWriterFinish(ctx as never, { validateWriterResult: async () => ({ status: "accepted" }), providerBreaker, runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }) } as never);
    const result = await finish.finishWriterAttempt({ projectId: "P", config, task, runId: "run", taskId: "t1", attemptId: "a1", pmThreadId: "pm", writerThreadId: "writer-1", dirtBefore: [] });
    expect(result).toMatchObject({ status: "blocked", attemptId: "a1" });
    expect(String(result.reason)).toMatch(/^run_budget_exceeded:turn ceiling 5 reached/);
    expect(stopped).toEqual(["writer-1"]);
    expect(getAttempt(db, "a1")).toMatchObject({ state: "blocked" });
    expect(providerBreaker.snapshot()).toEqual([]);
    expect(providerBreaker.decide(breakerKey("codex", "codex-test"))).toMatchObject({ allow: true, state: "closed" });
  });

  it("[sma:m_restart_scoped] the sweep reads the ceiling frozen in the run's stored policy: a later setting change does not move it, an old policy without the field has none", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "frozen", "proj", "bb", null, "none", buildRunPolicy({ "writer.max_turns": 5 }));
    createRun(db, "old", "proj", "bb", null, "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } });
    saveProjectSetting(db, "proj", "writer.max_turns", 100);
    const events = callEvents(1, 300, (seq) => 2_000 + seq);
    const sweep = async (runId: string) => {
      const world = sweepWorld(events);
      world.deps.openAttempts = () => [{ id: "a1", run_id: runId, task_id: "T1", thread_id: "thr_w", state: "running", project_id: "proj", created_at: 0 }];
      world.deps.maxTurns = (_project, id) => turnCeilingOfRun(getRun(db, id));
      return { done: await sweepWriterSilence(world.deps, 2_400), calls: world.calls };
    };
    const frozen = await sweep("frozen");
    expect(frozen.done).toEqual([{ attemptId: "a1", action: "ended", count: 0 }]);
    const old = await sweep("old");
    expect(old.done).toEqual([]);
    expect(old.calls).toEqual([{ threadId: "thr_w", order: "desc", limit: "50" }]);
  });
});

describe("review fix 2 and 4: money holds", () => {
  function moneyWorld(settings: Record<string, unknown>, windows: Record<string, unknown> = {}, spentUsd = 0) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    for (const [key, value] of Object.entries(settings)) saveProjectSetting(db, "*", key, value);
    // openlux is 0.5 USD per million input tokens.
    if (spentUsd) db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,input_tokens,output_tokens,cached_tokens,total_tokens) VALUES (?,?,?,?,?,0,0,?)")
      .run(new Date().toISOString().slice(0, 10), "proj", "openlux", "m", spentUsd * 2_000_000, spentUsd * 2_000_000);
    const hostCalls: string[] = [];
    const fakeBb = { hosts: { experimental_client: () => ({ call: async (method: string) => { hostCalls.push(method); return { windows }; } }) } };
    return { money: createMoney({ db: db as never, bb: fakeBb as never }).money, hostCalls };
  }
  const depsWith = (money: WriterHoldDeps["money"], usage?: WriterHoldDeps["usage"]) => ({ ...holdDeps().deps, money, ...(usage ? { usage } : {}) });
  const chain = [{ providerId: "openlux", model: "gpt-5-codex" }, { providerId: "claude-code", model: "sonnet" }];
  const everyMoneySetting = { "money.strict": true, "money.cap_unset_zero": "off", "money.silent_estimate_tokens": 200_000, "money.prices": "{}" };
  const unsetReason = /money_cap:no money cap is set: openlux is a paid lane and stays closed/;

  it("[sma:m_mo_rule] [sma:m_mo_unset] no cap and nothing set: the paid channel is not configured — a paid lane is held with that reason, the subscription lane takes the task, and no host call is made", async () => {
    const w = moneyWorld({}, {}, 0);
    const walk = await walkWriterChain(chain, { hostId: "h1", settings: {}, appetite: { tokens: 5_000_000 } }, depsWith(w.money), T0);
    expect(walk.free?.member.providerId).toBe("claude-code");
    // money.strict off keeps the chain order, and the order's first member is the closed paid lane: the walk passes it by.
    const off = await walkWriterChain(chain, { hostId: "h1", settings: { "money.strict": "off" }, appetite: { tokens: 5_000_000 } }, depsWith(w.money), T0);
    expect(off.free?.member.providerId).toBe("claude-code");
    expect(off.holds.map((held) => held.hold.reason).join()).toMatch(unsetReason);
    // Only the paid lane in the chain and no cap: nothing is free, and the reason names the cap, not a month to wait for.
    const paidOnly = await walkWriterChain([chain[0]!], { hostId: "h1", settings: {}, appetite: { tokens: 5_000_000 } }, depsWith(w.money), T0);
    expect(paidOnly.free).toBeUndefined();
    expect(paidOnly.shortest?.hold.reason).toMatch(unsetReason);
    expect(paidOnly.shortest?.hold.reason).not.toMatch(/next month/);
    expect(w.hostCalls).toEqual([]);
    // The window's figure stays «no cap set»: a zero was never typed by anyone.
    expect(w.money.status()).toMatchObject({ cap: null, capSet: false, unlimited: false });
  });

  it("[sma:m_mo_rule] money.cap_unset_zero=off is the old path: with no cap a paid lane is never held, money.strict only prefers a free subscription lane", async () => {
    const w = moneyWorld(everyMoneySetting, {}, 1_000);
    const strict = await walkWriterChain(chain, { hostId: "h1", settings: everyMoneySetting, appetite: { tokens: 5_000_000 } }, depsWith(w.money), T0);
    expect(strict.holds).toEqual([]);
    expect(strict.free?.member.providerId).toBe("claude-code");
    const order = { ...everyMoneySetting, "money.strict": "off" };
    const kept = await walkWriterChain(chain, { hostId: "h1", settings: order, appetite: { tokens: 5_000_000 } }, depsWith(w.money), T0);
    expect(kept.free?.member.providerId).toBe("openlux");
    // Only the paid lane in the chain: strict has nothing to prefer, and an unset cap holds it nowhere.
    const paidOnly = await walkWriterChain([chain[0]!], { hostId: "h1", settings: everyMoneySetting }, depsWith(w.money), T0);
    expect(paidOnly.free?.member.providerId).toBe("openlux");
    expect(paidOnly.holds).toEqual([]);
    expect(paidOnly.wakeAt).toBeNull();
    expect(w.hostCalls).toEqual([]);
  });

  it("[sma:m_mo_rule] the paid channel only when every subscription window is closed and the cap is set and not exceeded; money.strict: off, false, 0 are off, unset and anything else is on", async () => {
    const w = moneyWorld({ "money.monthly_cap_usd": 100 });
    const base = { hostId: "h1" };
    for (const off of ["false", "off", "0", false]) {
      const walk = await walkWriterChain(chain, { ...base, settings: { "money.strict": off } }, depsWith(w.money), T0);
      expect(walk.free?.member.providerId).toBe("openlux");
    }
    for (const on of [true, "true", "on", undefined, "maybe"]) {
      const walk = await walkWriterChain(chain, { ...base, settings: { "money.strict": on } }, depsWith(w.money), T0);
      expect(walk.free?.member.providerId).toBe("claude-code");
    }
    const closed: WriterHoldDeps["usage"] = { hold: async ({ providerId }) => (providerId === "claude-code" ? { percent: 99, window: "five_hour", resetsAt: new Date(T0 + MIN).toISOString() } as never : null) };
    // Windows closed, cap set and not exceeded: the paid lane runs.
    expect((await walkWriterChain(chain, { ...base, settings: { "money.strict": true } }, depsWith(w.money, closed), T0)).free?.member.providerId).toBe("openlux");
    // Windows closed, cap exceeded: nothing runs.
    const spent = moneyWorld({ "money.monthly_cap_usd": 100 }, {}, 101);
    expect((await walkWriterChain(chain, { ...base, settings: { "money.strict": true } }, depsWith(spent.money, closed), T0)).free).toBeUndefined();
    // Windows closed, no cap set: the paid channel is not configured, nothing runs and the reason says so.
    const unset = await walkWriterChain(chain, { ...base, settings: { "money.strict": true } }, depsWith(moneyWorld({}).money, closed), T0);
    expect(unset.free).toBeUndefined();
    expect(unset.holds.map((held) => held.hold.reason).join()).toMatch(unsetReason);
  });

  it("[sma:m_mo_fallback] with a cap set, a paid chain member over it is held until the first of next month and a subscription lane is not", async () => {
    const w = moneyWorld({ "money.monthly_cap_usd": 10 }, {}, 11);
    const walk = await walkWriterChain(chain, { hostId: "h1", settings: {} }, depsWith(w.money), T0);
    expect(walk.free?.member.providerId).toBe("claude-code");
    const hold = walk.holds.find((row) => row.member.providerId === "openlux")?.hold;
    expect(hold?.reason).toMatch(/^writer_provider_unavailable:money_cap:money cap:/);
    expect(hold?.until).toBe(Date.UTC(new Date(T0).getUTCFullYear(), new Date(T0).getUTCMonth() + 1, 1));
    expect(w.hostCalls).toEqual([]);
  });

  it("[sma:m_mo_task_ceiling] the estimate holds a paid lane only when a cap IS set and spent + estimate is over it; a fitting estimate and no appetite hold nothing, an unset cap holds by itself and not by the estimate", async () => {
    const hold = (settings: Record<string, unknown>, spent: number, tokens?: number) => {
      const w = moneyWorld(settings, {}, spent);
      return writerHold({ providerId: "openlux", model: "gpt-5-codex", hostId: "h1", settings: {}, ...(tokens === undefined ? {} : { appetite: { tokens } }) }, depsWith(w.money), T0);
    };
    // 1M output tokens of openlux = 1.5 USD.
    const on = { "money.task_ceiling": "on" };
    expect((await hold({ ...on, "money.monthly_cap_usd": 10 }, 9, 1_000_000))?.reason).toMatch(/estimate of 1\.50 USD/);
    expect(await hold({ ...on, "money.monthly_cap_usd": 10 }, 1, 1_000_000)).toBeNull();
    expect(await hold({ ...on, "money.monthly_cap_usd": 10 }, 9)).toBeNull();
    // No cap: the estimate has nothing to be measured against. The old path (cap_unset_zero off) holds nothing; the default closes the paid lane for the unset cap itself.
    expect(await hold({ ...on, "money.cap_unset_zero": "off" }, 9, 50_000_000)).toBeNull();
    expect((await hold({ ...on }, 9, 50_000_000))?.reason).toMatch(/no money cap is set/);
    expect(await hold({ ...on, "money.monthly_cap_usd": "unlimited" }, 9, 50_000_000)).toBeNull();
    // Unset is the default, on: a set cap holds a task whose estimate (50M output tokens = 75 USD) would cross it, with no cap the estimate holds nothing (the unset cap closes the lane by itself, and off opens it).
    expect((await hold({ "money.monthly_cap_usd": 10 }, 9, 50_000_000))?.reason).toMatch(/estimate of 75\.00 USD would cross the 10\.00 USD monthly cap/);
    expect(await hold({ "money.monthly_cap_usd": 10 }, 1, 1_000_000)).toBeNull();
    expect(await hold({ "money.cap_unset_zero": "off" }, 9, 50_000_000)).toBeNull();
    expect((await hold({}, 9, 50_000_000))?.reason).not.toMatch(/estimate/);
    // Off holds as on main: only once the cap is spent, whatever the task's estimate.
    expect(await hold({ "money.task_ceiling": "off", "money.monthly_cap_usd": 10 }, 9, 50_000_000)).toBeNull();
    expect((await hold({ "money.task_ceiling": "off", "money.monthly_cap_usd": 10 }, 11, 1))?.reason).toMatch(/^writer_provider_unavailable:money_cap:/);
    // A stored no of any spelling is the opt-out, as for every switch (false, 0, «false», «no», «off»).
    for (const no of ["false", false, 0, "no"]) expect(await hold({ "money.cap_unset_zero": no }, 9, 1_000_000)).toBeNull();
  });

  it("a chain of subscription members with nothing set makes main's host calls and takes main's path: no window read from the money hold, a window hold keeps its reason and reset time", async () => {
    const closed = { five_hour: { utilization: 99, resetsAt: new Date(T0 + 60 * MIN).toISOString() } };
    const w = moneyWorld({}, closed);
    const members = [{ providerId: "claude-code", model: "sonnet" }, { providerId: "claude-code", model: "opus" }];
    // Main's walk asks the usage source only; it says nothing here, so both members are free and no window is read for money.
    const free = await walkWriterChain(members, { hostId: "h1", settings: {} }, depsWith(w.money), T0);
    expect(free.holds).toEqual([]);
    expect(free.free?.member.model).toBe("sonnet");
    expect(w.hostCalls).toEqual([]);
    // The usage source holds every member at its window: main's soft path tries the first member anyway, and the hold is still a usage_window one.
    const reset = new Date(T0 + 90 * MIN).toISOString();
    const soft = await walkWriterChain(members, { hostId: "h1", settings: {} }, depsWith(w.money, { hold: async () => ({ percent: 99, window: "five_hour", resetsAt: reset }) as never }), T0);
    expect(soft.free?.member.model).toBe("sonnet");
    expect(soft.holds.map((row) => row.hold.reason.includes("usage_window"))).toEqual([true, true]);
    expect(soft.holds.every((row) => row.hold.until === Date.parse(reset))).toBe(true);
    expect(w.hostCalls).toEqual([]);
  });
});

describe("review fix 3: launch parity", () => {
  async function launch(parity: string | undefined, thread: Record<string, unknown>) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    setRunThread(db, "run", "pm");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    if (parity) saveProjectSetting(db, "P", "writer.launch_parity", parity);
    const warns: string[] = [];
    const stopped: string[] = [];
    const ctx = {
      bb: { storage: bb.storage, log: { info() {}, warn: (line: string) => warns.push(line) },
        sdk: { projects: { get: async () => ({ sources: [] }) },
          providers: { list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
            models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }) },
          files: { read: async () => ({ content: null }) },
          threads: { get: async ({ threadId }: { threadId: string }) => (threadId === "writer-1" ? thread : { id: "pm", projectId: "P", status: "idle" }),
            stop: async ({ threadId }: { threadId: string }) => { stopped.push(threadId); return {}; }, spawn: async () => ({ id: "writer-1" }) } } },
      db, host: { call: async (method: string) => method === "runCommand" ? { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" } : method === "gitCreateWorktree" ? { status: "ready", path: "/wt/a1/repo", branch: "lane/a1", reason: null } : {} },
      effectiveProjectSettings: async () => ({ values: { "memory.enabled": false, "adoc.040": "auto" } }),
    };
    // A breaker that was open long enough to be half-open: the spawn reserves the trial.
    const breaker = createProviderBreaker({ cooldownMs: 1 });
    breaker.record(breakerKey("codex", "codex-test"), "exhausted", Date.now() - 10);
    const released: number[] = [];
    const realRelease = breaker.releaseTrial;
    const services = { providerBreaker: { decide: breaker.decide, record: breaker.record, snapshot: breaker.snapshot, releaseTrial: (key: string, token: number) => { released.push(token); realRelease(key, token); } }, ruleScan: { chainForRun: async () => [] } };
    const writer = createWriterSpawn(ctx as never, services as never);
    const result = await writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config, task, plan: "write", pmThreadId: "pm",
      continuation: { workspacePath: "/wt/a1/repo", environmentId: "env-1", dirtBefore: [], fromThreadId: "old-thread", brief: "continue" } } as never).catch((cause: unknown) => { throw new Error(`${String(cause)} :: ${warns.join(" | ")}`); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { result, warns, stopped, db, breaker, released };
  }
  const swapped = { id: "writer-1", providerId: "claude-code", model: "sonnet" };

  it("[sma:m_md_parity] writer.launch_parity warn keeps main's warning: a swapped provider runs and is only logged", async () => {
    const run = await launch("warn", swapped);
    expect(run.result).toMatchObject({ ok: true, threadId: "writer-1" });
    expect(run.warns.some((line) => line.includes("launch profile mismatch"))).toBe(true);
    expect(run.stopped).toEqual([]);
    expect(getAttempt(run.db, "a1")?.state).toBe("running");
  });

  it("[sma:m_md_parity] unset writer.launch_parity, and a word the switch does not know, is the default refuse: a swapped provider ends the attempt and the thread is stopped", async () => {
    for (const parity of [undefined, "maybe"]) {
      const run = await launch(parity, swapped);
      expect(run.result).toMatchObject({ ok: false, status: "spawn_rejected" });
      expect(String((run.result as { reason?: string }).reason)).toMatch(/^writer_provider_unavailable:launch_profile_mismatch:codex\/codex-test\/.* vs claude-code\/sonnet/);
      expect(run.stopped).toEqual(["writer-1"]);
      expect(getAttempt(run.db, "a1")).toMatchObject({ state: "spawn_rejected" });
    }
  });

  it("[sma:m_md_parity] with refuse a different provider ends the attempt, stops the thread and holds the refused pair so the chain moves on", async () => {
    const run = await launch("refuse", swapped);
    expect(run.result).toMatchObject({ ok: false, status: "spawn_rejected" });
    expect(String((run.result as { reason?: string }).reason)).toMatch(/^writer_provider_unavailable:launch_profile_mismatch:codex\/codex-test\/.* vs claude-code\/sonnet/);
    expect(run.stopped).toEqual(["writer-1"]);
    expect(getAttempt(run.db, "a1")).toMatchObject({ state: "spawn_rejected" });
    // The pair is held: the next walk of a one-provider chain parks with a breaker hold instead of launching the same refused thread again.
    const hold = await writerHold({ providerId: "codex", model: "codex-test", hostId: "h", settings: {} }, { ...holdDeps().deps, breaker: run.breaker }, Date.now());
    expect(hold?.reason).toMatch(/breaker_open:codex\/codex-test/);
    // The half-open trial this start reserved was settled by that hold, not left in flight.
    expect(run.breaker.decide(breakerKey("codex", "codex-test"), Date.now() + 31 * MIN)).toMatchObject({ allow: true });
  });

  it("[sma:m_md_parity] with refuse a model alias or a clamped reasoning effort is only a warning, and the trial goes with the running writer", async () => {
    const alias = await launch("refuse", { id: "writer-1", providerId: "codex", model: "codex-test[high]", reasoningLevel: "xhigh" });
    expect(alias.result).toMatchObject({ ok: true, threadId: "writer-1" });
    expect(alias.warns.some((line) => line.includes("launch profile mismatch"))).toBe(true);
    expect(alias.stopped).toEqual([]);
    expect(alias.released).toEqual([]);
    expect(getAttempt(alias.db, "a1")?.state).toBe("running");
    const same = await launch("refuse", { id: "writer-1", providerId: "codex", model: "codex-test" });
    expect(same.result).toMatchObject({ ok: true });
    expect(same.warns.filter((line) => line.includes("launch profile mismatch"))).toEqual([]);
  });
});

describe("review fix 6: QA routing", () => {
  it("[sma:k_wqa_route] a blocked receipt earlier in the family does not make a later real failure unreturnable; the newest receipt classifies", () => {
    expect(qaRoute([{ state: "blocked", updatedAt: 1 }, { state: "failed", updatedAt: 2 }])).toBe("returnable");
    expect(qaRoute([{ state: "failed", updatedAt: 1 }, { state: "blocked", updatedAt: 2 }])).toBe("not_returnable");
    expect(qaRoute([{ state: "failed", updatedAt: 2 }, { state: "blocked", updatedAt: 1 }])).toBe("returnable");
  });

  it("[sma:k_wqa_route] the family stops at the number writer.qa_stop_after names, 2 when unset; 0 or off keeps the failed count from ever stopping", () => {
    const three = [{ state: "failed", updatedAt: 1 }, { state: "failed", updatedAt: 2 }, { state: "failed", updatedAt: 3 }];
    expect(qaRoute(three)).toBe("returnable");
    expect(qaRoute(three.slice(0, 1), 2)).toBe("returnable");
    expect(qaRoute(three.slice(0, 2), 2)).toBe("stop");
    // Unset (or unreadable) is 2: the second failed receipt stops the family.
    expect(qaStopAfter(undefined)).toBe(2);
    expect(qaStopAfter("")).toBe(2);
    expect(qaStopAfter("two")).toBe(2);
    expect(qaStopAfter(1.5)).toBe(2);
    expect(qaRoute(three.slice(0, 2), qaStopAfter(undefined))).toBe("stop");
    // Explicit off: the old advice, a follow-up however many receipts failed.
    expect(qaStopAfter(0)).toBeNull();
    expect(qaStopAfter("0")).toBeNull();
    expect(qaStopAfter("off")).toBeNull();
    expect(qaRoute(three, qaStopAfter("off"))).toBe("returnable");
    expect(qaStopAfter("3")).toBe(3);
    expect(qaStopAfter(2)).toBe(2);
  });
});

describe("review fix 7: capability docs", () => {
  it("[sma:k_t_capgen] the atlas input built from the checkout carries the registry's capabilities, not zero, and the snapshot file holds them", () => {
    const root = join(__dirname, "..", "..");
    const input = collectAtlasInput(root);
    expect(input.capabilities.length).toBeGreaterThan(0);
    expect(input.capabilities.map((row) => row.id)).toEqual(featureRegistry().map((row) => row.id));
    expect(input.capabilities.find((row) => row.id === "session-guard")?.hooks).toBeGreaterThan(0);
    expect(input.capabilities.every((row) => row.runtimes > 0)).toBe(true);
    const snapshot = readFileSync(join(root, "docs", "capabilities.snapshot.json"), "utf8");
    expect(snapshot).toBe(capabilitySnapshot(input, [...STREAMS], REQUIRED_CAPABILITIES));
    expect(JSON.parse(snapshot).capabilities.length).toBe(input.capabilities.length);
    // The structure (and so the docs hash) moves with the registry.
    expect(atlasStructure(input)).not.toBe(atlasStructure({ ...input, capabilities: [] }));
  });
});

describe("review fix 8 and 9: parity report and stats", () => {
  it("[sma:m_tl_terminal_parity] the permissions line says «not compared», never «same», and a real difference in another layer is named", () => {
    const { db } = world();
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { id: "t1" } });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    saveReasoningTrace(db, {
      attemptId: "a1", runId: "run", threadId: "thr1", providerId: "claude-code", model: "m", effectiveReasoningLevel: "high", serviceTier: null,
      dispatchContext: { memoryText: "", memoryPicked: ["mem1"], rulesPicked: { total: 1, picked: ["rule1"] }, executionPacket: "", executionPacketSha256: "x", pmReadContext: "", agent: "writer", helperMode: "", helperRequired: false },
    } as never);
    recordSkillMetric(db, { id: "skm1", attemptId: "a1", taskId: "t1", runId: "run", projectId: "proj", skillCount: 1, switchCount: 0, skillsJson: JSON.stringify(["skill-a"]), outcome: "accepted", recordedAt: 1 });
    const session = attemptSessionLayers(db, "a1")!;
    const terminal = terminalSessionLayers({ db, projectId: "proj", skills: ["skill-a", "skill-b"], model: "claude-code/m", harnessVersion: session.hooks![0]! });
    const lines = terminalParity(session, terminal);
    expect(lines.map((line) => line.layer)).toEqual(["hooks", "memory", "rules", "skills", "permissions", "model"]);
    const permissions = lines.find((line) => line.layer === "permissions")!;
    expect(permissions.same).toBeNull();
    expect(permissions.detail).toMatch(/^not compared/);
    expect(lines.filter((line) => line.same === null).map((line) => line.layer)).toEqual(["permissions"]);
    const skills = lines.find((line) => line.layer === "skills")!;
    expect(skills.same).toBe(false);
    expect(skills.detail).toContain("skill-b");
    expect(lines.find((line) => line.layer === "model")?.same).toBe(true);
  });

  it("bb lane-pilot stats --days with a missing or bad value is a usage error, a number or nothing runs the report", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    registerCli(createCore(bb, openDatabase(bb)), {} as never, migrations);
    for (const argv of [["stats", "--days"], ["stats", "proj", "--days", "abc"], ["stats", "--days", "0"], ["stats", "--days", "-3"]]) {
      const out = await harness.behavior.runCli(argv);
      expect(out.exitCode, argv.join(" ")).toBe(1);
      expect(out.stderr).toMatch(/--days takes a whole number/);
    }
    for (const argv of [["stats", "proj"], ["stats", "proj", "--days", "7"]]) {
      const out = await harness.behavior.runCli(argv);
      expect(out.exitCode, argv.join(" ")).toBe(0);
      expect(out.stdout).not.toContain("NaN");
    }
  });
});

describe("review fix: tests that proved nothing", () => {
  it("[sma:ar_receipt] verification rows hash both outputs, and a re-run marks exactly the item whose output differs from the recorded hash", () => {
    expect(outputHashes({ stdout: "1 passed", stderr: "" })).toEqual({ stdoutSha256: sha256Hex("1 passed"), stderrSha256: sha256Hex("") });
    expect(outputHashes({})).toEqual({ stdoutSha256: sha256Hex(""), stderrSha256: sha256Hex("") });
    const rerun = (command: string, stdout: string) => ({ command, ...outputHashes({ stdout }) } as { command: string; stdoutSha256?: string; expectedStdoutSha256?: string; outputChanged?: boolean });
    const items = [rerun("npm test", "2 passed"), rerun("npm run lint", "clean"), rerun("npm run build", "ok")];
    const changed = markOutputChanges(items, [
      { command: "npm test", stdoutSha256: sha256Hex("1 passed") },
      { command: "npm run lint", stdoutSha256: sha256Hex("clean") },
      { stdoutSha256: "no command" },
    ]);
    expect(changed).toBe(1);
    expect(items.map((row) => row.outputChanged)).toEqual([true, false, undefined]);
    expect(items[0]!.expectedStdoutSha256).toBe(sha256Hex("1 passed"));
    expect(markOutputChanges([rerun("npm test", "x")], undefined)).toBe(0);
  });

  it("[sma:m_lesson] the reaction files an accepted attempt's LESSON line unless writer.lesson_from_accepted is off (unset and any other word file it), and LESSON: none files nothing", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    let answer = "done.\nLESSON: run the migration before the seed";
    harness.sdk.stub("threads.output", async () => ({ text: answer }));
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    createRun(db, "run1", "proj1", "bb", "/repo");
    mountWriterAttemptFinished(ctx, {} as never);
    const accepted = (attemptId: string) => emitAttemptFinished(ctx, {
      scope: "attempt", projectId: "proj1", runId: "run1", taskId: "t1", attemptId, pmThreadId: "thr_pm", writerThreadId: "thr_w",
      task, config, status: "accepted", reason: null, result: null,
    });
    const proposals = () => listRuleProposals(db as never, "proj1", { state: "proposed" });
    saveProjectSetting(db, "proj1", "writer.lesson_from_accepted", "off");
    await accepted("a-off");
    expect(proposals()).toHaveLength(0);
    // Unset, in a project that never set it, is the default: filed.
    createRun(db, "run2", "proj2", "bb", "/repo2");
    await emitAttemptFinished(ctx, {
      scope: "attempt", projectId: "proj2", runId: "run2", taskId: "t2", attemptId: "a-unset", pmThreadId: "thr_pm", writerThreadId: "thr_w",
      task, config, status: "accepted", reason: null, result: null,
    });
    expect(listRuleProposals(db as never, "proj2", { state: "proposed" }).map((row) => row.rule)).toEqual(["run the migration before the seed"]);
    saveProjectSetting(db, "proj1", "writer.lesson_from_accepted", true); // a loose value is not «off»: the default applies
    await accepted("a-on");
    expect(proposals().map((row) => row.rule)).toEqual(["run the migration before the seed"]);
    expect(JSON.stringify(proposals()[0])).toContain("accepted attempt a-on");
    answer = "done.\nLESSON: none - nothing new";
    await accepted("a-none");
    expect(proposals()).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});
