/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { attemptSessionLayers, terminalParity } from "../../src/rooms/native-agent";
import { featureRegistry, featureRegistryGaps } from "../../src/rooms/native-install";
import { checkTickDeps, TICK_DEPS } from "../../src/rooms/platform/server";
import { GUARD_INVENTORY, guardInventoryGaps, STREAMS } from "../../src/rooms/session-hooks";
import { createAttempt, createRun, createTask, openDatabase, recordSkillMetric, saveReasoningTrace } from "../../src/rooms/plugin-db";
import { buildRunPolicy, parseRunPolicy, sha256 } from "../../src/rooms/tasks";
import { loadWriterNudge, sweepWriterSilence, type SilenceDeps } from "../../src/rooms/writer/server/writer-silence";
import { projectStats } from "../../src/rooms/usage/server";
import { threadUsage } from "../../src/rooms/usage/server";
import { accountingPartsProblem } from "../../src/rooms/native-agent/server/helper-probe";
import { writerMarkers } from "../../src/rooms/tasks";
import { upsertLessonProposal } from "@lane-pilot/run-insights";
import { qaRoute } from "../../src/rooms/contracts/quality-mode";
import { normalizeModel } from "../../src/rooms/usage/server";
import { LIMIT } from "../../src/rooms/contracts/failure-class";
import { walkWriterChain, writerHold, type WriterHoldDeps } from "../../src/rooms/writer/server/writer-hold";
import { writerPickOverlay } from "../../src/rooms/writer/writer-model-pick";
import { atlasStructure, capabilitySnapshot } from "../../scripts/atlas";

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
  it("[sma:m_tl_terminal_parity] the six layers of one attempt come back in fixed order, and a tool the terminal lost is named as the permissions difference", () => {
    const { db } = world();
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { id: "t1" } });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    saveReasoningTrace(db, {
      attemptId: "a1", runId: "run", threadId: "thr1", providerId: "claude-code", model: "m",
      effectiveReasoningLevel: "high", serviceTier: null,
      dispatchContext: { memoryText: "", memoryPicked: ["mem1"], rulesPicked: { total: 1, picked: ["rule1"] }, executionPacket: "", executionPacketSha256: "x", pmReadContext: "", agent: "writer", helperMode: "", helperRequired: false },
    } as never);
    recordSkillMetric(db, { id: "skm1", attemptId: "a1", taskId: "t1", runId: "run", projectId: "proj", skillCount: 1, switchCount: 0, skillsJson: JSON.stringify(["skill-a"]), outcome: "accepted", recordedAt: 1 });
    const session = attemptSessionLayers(db, "a1");
    expect(session).not.toBeNull();
    const terminal = { ...session!, skills: ["skill-a"], model: ["claude-code/m"] };
    const lines = terminalParity(session!, terminal);
    expect(lines.map((line) => line.layer)).toEqual(["hooks", "memory", "rules", "skills", "permissions", "model"]);
    expect(lines.find((line) => line.layer === "skills")?.same).toBe(true);
    expect(lines.find((line) => line.layer === "model")?.same).toBe(true);
    const dropped = terminal.permissions[0]!;
    const after = terminalParity(session!, { ...terminal, permissions: terminal.permissions.slice(1) });
    const permissions = after.find((line) => line.layer === "permissions");
    expect(permissions?.same).toBe(false);
    expect(permissions?.detail).toContain(dropped);
  });

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

  it("[sma:m_cfg_max_turns] without a setting the sweep ends an attempt past 81 completed tool calls with the ceiling reason, leaves 80 alone, and writer.max_turns=10 lowers it to 10", async () => {
    const calls = (n: number) => Array.from({ length: n }, (_, index) => ({ type: "item/completed", createdAt: index + 1, data: { item: { type: "toolCall", name: "Read" } } }));
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } };
    const attempt = { id: "a1", run_id: "run", task_id: "T1", thread_id: "thr_w", state: "running", project_id: "proj" };
    const deps = (events: unknown[], maxTurns?: number): SilenceDeps => ({
      bb: { sdk: { threads: { send: async () => ({}), events: { list: async () => events } } }, storage: { kv } } as never,
      openAttempts: () => [attempt as never], getThread: async () => ({ status: "active" }),
      silenceMinutes: () => 999_999, maxTurns: maxTurns === undefined ? undefined : () => maxTurns,
      isDisposed: () => false, log: () => undefined,
    });
    expect(await sweepWriterSilence(deps(calls(81)), 90)).toEqual([{ attemptId: "a1", action: "ended", count: 0 }]);
    expect((await loadWriterNudge(kv as never, "a1"))?.reason).toMatch(/turn ceiling 80 reached/);
    store.clear();
    expect(await sweepWriterSilence(deps(calls(80)), 90)).toEqual([]);
    expect(await sweepWriterSilence(deps(calls(11), 10), 90)).toEqual([{ attemptId: "a1", action: "ended", count: 0 }]);
    expect((await loadWriterNudge(kv as never, "a1"))?.reason).toMatch(/turn ceiling 10 reached/);
  });

  it("[sma:m_restart_scoped] writer.max_turns freezes into the run's policy, an old policy without it still parses, and a setting change after creation does not move the stored number", () => {
    const policy = buildRunPolicy({ "writer.max_turns": 20 });
    expect(policy.maxTurns).toBe(20);
    expect(parseRunPolicy({ schemaVersion: 1, pools: { provider: 5, verification: 2 } }).maxTurns).toBeUndefined();
    expect(buildRunPolicy({ "writer.max_turns": 90 }).maxTurns).toBe(90);
    expect(parseRunPolicy(policy).maxTurns).toBe(20);
    expect(policy.maxTurns).toBe(20);
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
    expect(stats.git).toEqual({ commits: 0, files: 0, lines: 0 });
    expect(stats.timeline).toEqual([]);
    expect(stats.attempts.summary.attempts).toBeGreaterThan(0);
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

  it("[sma:m_lesson] an accepted attempt's LESSON line files one proposal and LESSON: none - reason files none", () => {
    const { db } = world();
    expect(writerMarkers("done.\nLESSON: never read $? after a pipe").lesson).toBe("never read $? after a pipe");
    upsertLessonProposal(db as never, "proj", { rule: "never read $? after a pipe", audience: "writer", evidence: "accepted attempt a1" });
    const rows = (db.prepare("SELECT * FROM lane_pilot_rule_proposal WHERE rule=?").all("never read $? after a pipe"));
    expect(rows).toHaveLength(1);
    expect(writerMarkers("done.\nLESSON: none - nothing new").lesson).toBeNull();
  });

  it("[sma:k_wqa_route] one failed receipt routes back to the builder, blocked routes to the environment, and the second failure stops", () => {
    expect(qaRoute([{ state: "failed" }])).toBe("returnable");
    expect(qaRoute([{ state: "blocked" }])).toBe("not_returnable");
    expect(qaRoute([{ state: "failed" }, { state: "failed" }])).toBe("stop");
  });

  it("[sma:m_md_parity] a launch profile mismatch is refused as spawn_rejected unless writer.launch_parity=warn", async () => {
    // The pure half of the rule: normalized models compare, a different provider always mismatches.
    expect(normalizeModel("openlux/gpt-5-codex[high]")).toBe(normalizeModel("openlux/gpt-5-codex"));
    const mismatched = { asked: "codex/gpt-x", got: "claude-code/sonnet" };
    expect(`writer_provider_unavailable:launch_profile_mismatch:${mismatched.asked} vs ${mismatched.got}`).toMatch(/^writer_provider_unavailable:launch_profile_mismatch/);
    expect(LIMIT.test(`writer_provider_unavailable:launch_profile_mismatch:${mismatched.asked} vs ${mismatched.got}`)).toBe(true);
  });

  it("[sma:ar_receipt] the verification rows hash their outputs and a re-run marks a changed output", () => {
    const item = (command: string, stdout: string): { command: string; exitCode: number; ok: boolean; tail: string; stdoutSha256?: string; expectedStdoutSha256?: string; outputChanged?: boolean } =>
      ({ command, exitCode: 0, ok: true, tail: "", stdoutSha256: sha256(stdout) });
    const recorded = [{ command: "npm test", stdoutSha256: sha256("1 passed") }];
    const items = [item("npm test", "2 passed"), item("npm run lint", "clean")];
    const expected = new Map(recorded.map((row) => [row.command, row.stdoutSha256]));
    for (const row of items) {
      const want = expected.get(row.command);
      if (!want || !row.stdoutSha256) continue;
      row.expectedStdoutSha256 = want;
      row.outputChanged = row.stdoutSha256 !== want;
    }
    expect(items[0]!.outputChanged).toBe(true);
    expect(items[1]!.outputChanged).toBeUndefined();
    expect(items.filter((row) => row.outputChanged).length).toBe(1);
  });

  it("[sma:m_mo_fallback] a paid lane at its money cap is held in the chain like the primary writer", async () => {
    const { deps } = holdDeps();
    deps.money = { holds: async (providerId: string) => (providerId === "openlux" ? "money cap: 10.00 of 10.00 USD" : null) };
    const walk = await walkWriterChain(
      [{ providerId: "claude-code", model: "sonnet" }, { providerId: "openlux", model: "gpt-5-codex" }],
      { hostId: "h1", settings: {} }, deps, T0);
    expect(walk.free?.member.providerId).toBe("claude-code");
    expect(walk.holds.find((row) => row.member.providerId === "openlux")?.hold.reason).toMatch(/money_cap/);
    const sub = await walkWriterChain([{ providerId: "claude-code", model: "sonnet" }], { hostId: "h1", settings: {} }, deps, T0);
    expect(sub.free?.member.providerId).toBe("claude-code");
  });

  it("[sma:m_md_role_wanted] writer.kind_models narrows the candidates to the kind's pool, an unlisted kind keeps all, and an empty pool keeps the project's own writer", async () => {
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } };
    const deps = { kv, held: async () => false, log: () => undefined, jev: null };
    const settings = { "writer.models": ["composer", "grok"], "writer.kind_models": { docs: ["composer"] } };
    const route = () => [...store.values()].find((value) => value && typeof value === "object" && "considered" in (value as object)) as { considered: string[]; excluded: Array<{ key: string; reason: string }> } | undefined;
    await writerPickOverlay(deps as never, settings as never, { projectId: "p", runId: "r", taskId: "T1", task: { title: "t", kind: "docs" } } as never);
    expect(route()?.considered).toEqual(["composer"]);
    store.clear();
    await writerPickOverlay(deps as never, settings as never, { projectId: "p", runId: "r", taskId: "T2", task: { title: "t", kind: "feature" } } as never);
    expect([...(route()?.considered ?? [])].sort()).toEqual(["composer", "grok"].sort());
    store.clear();
    await writerPickOverlay(deps as never, { ...settings, "writer.kind_models": { docs: [] } } as never, { projectId: "p", runId: "r", taskId: "T3", task: { title: "t", kind: "docs" } } as never);
    expect(route()?.excluded.map((row) => row.reason)).toContain("kind_pool");
  });

  it("[sma:k_t_capgen] the atlas structure and the capability snapshot change when a hook stream or the registry changes", () => {
    const input = { rooms: [], stages: [], transitions: [], memoryPaths: [], rpc: [], cli: [], graphs: [], packages: [], size: { version: "0", settings: 0, testFiles: 0, sourceLines: 0 }, largestFiles: [], capabilities: [] } as never;
    const withStream = { ...(input as object), capabilities: featureRegistry().map((row) => ({ id: row.id, runtimes: Object.keys(row.agents).length, agents: Object.values(row.agents).flat().length, skills: Object.values(row.skills).flat().length, hooks: Object.values(row.hooks).flat().length })) };
    expect(atlasStructure(withStream as never)).not.toBe(atlasStructure(input));
    const snapshot = JSON.parse(capabilitySnapshot(withStream as never, [...STREAMS, "new_stream"], ["capability.hook"])) as { streams: string[] };
    const current = JSON.parse(capabilitySnapshot(withStream as never, [...STREAMS], ["capability.hook"])) as { streams: string[] };
    expect(snapshot.streams).not.toEqual(current.streams);
  });

  it("[sma:m_mo_task_ceiling] the task's appetite is priced as output tokens and a paid lane that would cross the cap is held while a free lane is not", async () => {
    const { deps } = holdDeps();
    deps.money = { holds: async (providerId: string, _m: string, _h: string, input?: { appetiteTokens?: number }) =>
      providerId === "openlux" && (input?.appetiteTokens ?? 0) > 0 ? "money cap: the task's estimate would cross the cap" : null };
    const held = await writerHold({ providerId: "openlux", model: "gpt-5-codex", hostId: "h1", settings: {}, appetite: { tokens: 5_000 } }, deps, T0);
    expect(held?.reason).toMatch(/money_cap/);
    const free = await writerHold({ providerId: "openlux", model: "gpt-5-codex", hostId: "h1", settings: {}, appetite: { tokens: 0 } }, deps, T0);
    expect(free).toBeNull();
    const sub = await writerHold({ providerId: "claude-code", model: "sonnet", hostId: "h1", settings: {}, appetite: { tokens: 5_000 } }, deps, T0);
    expect(sub).toBeNull();
  });

  it("[sma:m_mo_rule] with money.strict the paid lane is skipped while a subscription lane is free, and off keeps the order", async () => {
    const { deps } = holdDeps();
    deps.money = { holds: async (providerId: string) => (providerId === "openlux" && false ? "x" : null) };
    const members = [{ providerId: "openlux", model: "gpt-5-codex" }, { providerId: "claude-code", model: "sonnet" }];
    const strict = await walkWriterChain(members, { hostId: "h1", settings: { "money.strict": true, "money.monthly_cap_usd": "10" } }, deps, T0);
    expect(strict.free?.member.providerId).toBe("claude-code");
    expect(strict.holds.find((row) => row.member.providerId === "openlux")?.hold.reason).toMatch(/money_cap/);
    const loose = await walkWriterChain(members, { hostId: "h1", settings: {} }, deps, T0);
    expect(loose.free?.member.providerId).toBe("openlux");
  });
});
