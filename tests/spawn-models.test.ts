import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ROLE_IDS, ROLE_TABLE, consistentProvider, modelFamily, roleModelKey, type ModelCatalog } from "@lane-pilot/models";
import { resolveSpawnModel, spawnUsageOf, warmSpawnUsage } from "../src/rooms/core/server/spawn-model";
import { createWriterState } from "../src/rooms/writer/server/state";
import { USAGE_FETCH_METHOD, USAGE_LIST_METHOD } from "../src/rooms/usage/server/provider-usage";

/**
 * F4 of Astra's review (2026-10-27): the role -> model table must be what really spawns. Every place that starts a model thread is listed
 * here, either as going through the ONE resolver (`resolveSpawnModel`, packages/models/src/agent-model.ts behind it) or as a deliberate
 * exception with its reason. A new spawn site that is in neither list fails the first test; the second drives the generic helper (which
 * every graph step, the goal audit and the contract planner use) to its real spawn and compares what it sends with the resolver's answer.
 */
type Wrapper = { via: "resolver"; roles: readonly string[]; note?: string; source?: string } | { via: "table"; roles: readonly string[]; note: string } | { via: "exception"; note: string };

const WRAPPERS: Record<string, Wrapper> = {
  "src/rooms/workflow/server/workflow-agent.ts": { via: "resolver", roles: ["*"], note: "every graph helper: withResolvedModel; `run` resolves what was not resolved; a provider-limit fallback asks the resolver again without the failed provider" },
  "src/rooms/workflow/server/architect-start.ts": { via: "resolver", roles: ["workflow-architect"] },
  "src/rooms/council/server/council-graph.ts": { via: "resolver", roles: ["council"], note: "the chair; the SEATS keep the models they were given (exception: the owner's council.<role>.* or distinct stage selections), only the provider+model pair is made consistent by writerExecutionSelection" },
  "src/rooms/memory/server/memory.ts": { via: "resolver", roles: ["memory"] },
  "src/rooms/project-life/server/project-life.ts": { via: "resolver", roles: ["project-life"] },
  "src/rooms/docs/server/docs.ts": { via: "resolver", roles: ["docs-maintainer"] },
  "src/rooms/docs/server/docs-nightly.ts": { via: "resolver", roles: ["docs-maintainer"] },

  "src/rooms/qa/server/qa-thread.ts": { via: "resolver", roles: ["browser-qa"], source: "src/rooms/qa/server/qa.ts", note: "spawns the agent qa.ts resolved (the thread takes it as an input)" },
  "src/rooms/qa/server/errands.ts": { via: "resolver", roles: ["errand"], note: "what the schedule / tool named is a pin; nothing named is the errand row" },
  "src/rooms/self-repair/server/self-repair.ts": { via: "resolver", roles: ["repairer"], note: "the night plan's or the watcher's pick (which holds the repairer row) goes through as a pin" },
  "src/rooms/self-repair/server/rule-scan.ts": { via: "resolver", roles: ["rules-analyzer"], note: "the owner's stored analyzer is a pin; otherwise the row" },
  "src/rooms/critique/server/critique-runs.ts": { via: "table", roles: ["pm-reader", "plan-critic", "code-critic", "specialist-reviewer"], note: "roleSelection(): resolveRoleModel + the host catalog's `usable`, then criticAcrossFamilies; a critic left in the writer's family is warned about (same table, the stage's own effort/tier checks)" },
  "src/rooms/writer/server/spawn.ts": { via: "exception", note: "the writer is Jev's pick from the writers' anamnesis, not a row of the table" },
  "src/rooms/writer/server/finish.ts": { via: "exception", note: "a code-repair turn goes back to the writer's own recorded provider/model" },
  "src/rooms/native-agent/server/activation.ts": { via: "exception", note: "the PM chat runs on the owner's chosen model" },
  "src/rooms/native-agent/server/helper-probe.ts": { via: "exception", note: "a probe asks about exactly the provider/model it checks" },
  "src/rooms/stability/server/probes.ts": { via: "exception", note: "fixed probe threads of the stability drills" },
  "src/rooms/bench/server/plugin-ports.ts": { via: "exception", note: "the benchmark's own fixed writer" },
  "src/rooms/harness/server/harness.ts": { via: "exception", note: "the nightly harness editor and its trial arms use the harness' own selection (harness config), not a row" },
  "src/rooms/wall/server/wall.ts": { via: "exception", note: "wall service: hunter settings of the wall (another change owns it)" },
};

const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? walk(path) : /\.tsx?$/.test(name) ? [path] : [];
});
const ROOT = join(__dirname, "..");
const read = (file: string) => readFileSync(join(ROOT, file), "utf8");

describe("every place that spawns a model thread is accounted for", () => {
  it("lists exactly the files that call fullAccessSpawn", () => {
    const spawning = walk(join(ROOT, "src")).map((file) => relative(ROOT, file)).filter((file) => file !== "src/rooms/core/server/pm-spawn.ts" && /\bfullAccessSpawn\(/.test(read(file))).sort();
    expect(spawning).toEqual(Object.keys(WRAPPERS).sort());
  });

  it("a wrapper that goes through the resolver names the roles of the table it asks for", () => {
    for (const [file, wrapper] of Object.entries(WRAPPERS)) {
      if (wrapper.via !== "resolver") continue;
      const source = read(wrapper.source ?? file);
      expect(source, file).toMatch(/resolveSpawnModel\(|withResolvedModel\(/);
      for (const role of wrapper.roles) {
        if (role === "*") continue;
        expect(ROLE_IDS, `${file}: ${role}`).toContain(role);
        expect(source, file).toMatch(new RegExp(`role:\\s*"${role}"`));
      }
    }
  });

  it("no wrapper that is not an exception keeps a hard-coded model of its own", () => {
    for (const [file, wrapper] of Object.entries(WRAPPERS)) {
      if (wrapper.via === "exception") continue;
      expect(read(file), file).not.toMatch(/model:\s*"(?:claude-|gpt-)[^"]+"\s*,\s*effort/);
    }
  });
});

describe("a provider and a model are always a pair that can exist", () => {
  it("derives the provider from the model; the native providers cannot serve the other family's model", () => {
    expect(consistentProvider(undefined, "gpt-6.1-sol")).toBe("codex");
    expect(consistentProvider(null, "claude-opus-5-5")).toBe("claude-code");
    expect(consistentProvider("claude-code", "gpt-6.1-sol")).toBe("codex");
    expect(consistentProvider("codex", "claude-haiku-5-5")).toBe("claude-code");
    expect(consistentProvider("opencode2", "gpt-6.1-sol")).toBe("opencode2");
    expect(consistentProvider(undefined, "gemini-9", (model) => (model === "gemini-9" ? "opencode2" : null))).toBe("opencode2");
    expect(consistentProvider(undefined, "mystery")).toBeNull();
  });
});

const catalog = (hasSol: boolean, hasOpus: boolean): ModelCatalog => ({
  hosts: [{ id: "h1", name: "Mini", connected: true }],
  providers: [
    { id: "codex", displayName: "Codex", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["h1"],
      models: [{ id: "gpt-6.1-sol", model: "gpt-6.1-sol", displayName: "Sol", efforts: ["high"], defaultEffort: "high", isDefault: true, hostIds: hasSol ? ["h1"] : [] }] },
    { id: "claude-code", displayName: "Claude", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["h1"],
      models: [{ id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus", efforts: ["high"], defaultEffort: "high", isDefault: true, hostIds: hasOpus ? ["h1"] : [] }] },
  ],
});
const opus = { providerId: "claude-code", model: "claude-opus-5-5" };
const sol = { providerId: "codex", model: "gpt-6.1-sol" };

describe("the resolver's table of inputs (F4: R2, R3, R4)", () => {
  it.each([
    ["default: the planner is Opus, the plan critic Sol", "plan-critic", {}, opus, true, true, sol, []],
    ["the owner moved the author to Sol: the critic goes to Opus (R2)", "plan-critic", { [roleModelKey("planner")]: { model: "gpt-6.1-sol" } }, sol, true, true, opus, ["crossed_family"]],
    ["the peer is not on the machine: the critic stays and says it is not independent (R4)", "plan-critic", {}, sol, true, false, sol, ["same_family_judge"]],
    ["the table's Sol is gone and the fallback is the PM's Opus, the author is Opus: still the other family, never back in the author's", "plan-critic", {}, opus, false, true, opus, ["selection_unavailable", "same_family_judge"]],
    ["a cold catalog (nothing known) judges by the table", "plan-critic", {}, opus, null, null, sol, []],
  ])("%s", (_name, role, settings, author, hasSol, hasOpus, expected, issues) => {
    const cold = hasSol === null;
    const answer = resolveSpawnModel({ role, settings, author, pm: opus, ...(cold ? { catalog: null } : { catalog: catalog(hasSol as boolean, hasOpus as boolean), hostId: "h1" }) });
    expect({ providerId: answer.providerId, model: answer.model }).toEqual(expected);
    expect(answer.issues).toEqual(issues);
    // Whatever was answered is a pair that can exist.
    expect(consistentProvider(answer.providerId, answer.model)).toBe(answer.providerId);
  });

  it("an owner-created agent that names a GPT model and no provider runs on codex (R3), with or without a catalog", () => {
    for (const cat of [null, catalog(true, true)]) {
      const answer = resolveSpawnModel({ role: "specialist:mine", settings: {}, pm: opus, pinned: { model: "gpt-6.1-sol" }, catalog: cat, hostId: "h1" });
      expect({ providerId: answer.providerId, model: answer.model, source: answer.source }).toEqual({ providerId: "codex", model: "gpt-6.1-sol", source: "pinned" });
    }
  });

  it("a provider that just hit its limit is out of the offer: the role's next model, judged against the author again", () => {
    const answer = resolveSpawnModel({ role: "plan-critic", settings: {}, author: opus, pm: opus, catalog: catalog(true, true), hostId: "h1", avoidProvider: "codex" });
    // Sol is avoided; the only candidates left are the PM's Opus, which is the author's family: kept, and said.
    expect(answer).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", source: "pm" });
    expect(answer.issues).toContain("same_family_judge");
    expect(modelFamily(answer.model)).toBe("claude");
  });
});

// ---------------------------------------------------------------- provider limits move a table pick to the other family

/** A fake usage source (the contract of provider-usage.ts): one shared resource per provider, one window each; null = the source cannot be read. */
const usageSource = (percent: Record<string, number | null>, calls: string[] = []) => {
  const resetsAt = new Date(Date.now() + 3600_000).toISOString();
  return {
    sdk: { plugins: {
      experimental_discoverRpc: async () => [{ pluginId: "usage-src" }],
      callRpc: async ({ method, input }: { method: string; input?: { resourceId: string } }) => {
        calls.push(method);
        if (method === USAGE_LIST_METHOD) return { resources: Object.keys(percent).map((id) => ({ id: `r-${id}`, providerId: id, scope: { kind: "shared" } })) };
        const used = percent[input!.resourceId.slice(2)];
        return used === null ? { usage: { status: "error" } } : { usage: { status: "ok", windows: [{ label: "weekly", usedPercent: used, resetsAt, model: null }] } };
      },
    } },
    events: { on: () => () => undefined },
    log: () => undefined,
  };
};
/** The registration the plugin makes (writer state), over a fake source; returns what a spawn wrapper gets from `spawnUsageOf`. */
const usageOf = async (percent: Record<string, number | null>, calls: string[] = [], log: string[] = []) => {
  const bb = usageSource(percent, calls) as never;
  createWriterState({ bb, log: () => undefined } as never);
  const usage = spawnUsageOf({ bb, log: (line) => log.push(line) });
  // The spawn path refreshes in the background (warmSpawnUsage returns at once); a test waits for the cache directly.
  await usage!.warm({ providerIds: ["claude-code", "codex"], hostId: "h1" });
  return usage;
};
const base = { settings: {}, pm: opus, catalog: catalog(true, true), hostId: "h1" };

describe("a provider's nearly spent limit moves the helpers to the other family", () => {
  it("Opus at 93% weekly: the analyst takes Sol, the result says why and one log line is written", async () => {
    const log: string[] = [];
    const answer = resolveSpawnModel({ role: "analyst", ...base, usage: await usageOf({ "claude-code": 93, codex: 20 }, [], log) });
    expect({ providerId: answer.providerId, model: answer.model }).toEqual(sol);
    expect(answer.issues).toEqual(["usage_moved: claude-code weekly 93% → codex/gpt-6.1-sol"]);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("claude-code weekly 93%");
    expect(consistentProvider(answer.providerId, answer.model)).toBe(answer.providerId);
  });

  it("the same peers for the small models: Haiku -> Luna, Sonnet -> Terra, and Sol -> Opus the other way", async () => {
    const usage = await usageOf({ "claude-code": 95, codex: 10 });
    expect(resolveSpawnModel({ role: "memory", ...base, usage })).toMatchObject({ providerId: "codex", model: "gpt-6-luna" });
    expect(resolveSpawnModel({ role: "errand", ...base, usage })).toMatchObject({ providerId: "codex", model: "gpt-6.1-terra" });
    const gpt = await usageOf({ "claude-code": 10, codex: 95 });
    expect(resolveSpawnModel({ role: "council", ...base, usage: gpt })).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", issues: ["usage_moved: codex weekly 95% → claude-code/claude-opus-5-5"] });
  });

  it("both families spent: the table's pick stays, no issue", async () => {
    const answer = resolveSpawnModel({ role: "analyst", ...base, usage: await usageOf({ "claude-code": 93, codex: 96 }) });
    expect({ providerId: answer.providerId, model: answer.model }).toEqual(opus);
    expect(answer.issues).toEqual([]);
  });

  it("room left (below the threshold) moves nothing; the owner's threshold applies, and 0 turns the check off", async () => {
    const usage = await usageOf({ "claude-code": 93, codex: 20 });
    expect(resolveSpawnModel({ role: "analyst", ...base, usage, settings: { "usage.skip_percent": 95 } })).toMatchObject({ ...opus, issues: [] });
    expect(resolveSpawnModel({ role: "analyst", ...base, usage, settings: { "usage.skip_percent": 0 } })).toMatchObject({ ...opus, issues: [] });
    expect(resolveSpawnModel({ role: "analyst", ...base, usage, settings: { "usage.skip_percent": 90 } })).toMatchObject({ ...sol });
  });

  it("the machine does not offer the peer: the pick stays", async () => {
    const answer = resolveSpawnModel({ role: "analyst", ...base, catalog: catalog(false, true), usage: await usageOf({ "claude-code": 93, codex: 20 }) });
    expect({ providerId: answer.providerId, model: answer.model }).toEqual(opus);
    expect(answer.issues).not.toContain(expect.stringContaining("usage_moved"));
  });

  it("a judge that the limit puts into its author's family stays allowed and records same_family_judge_by_limit", async () => {
    const answer = resolveSpawnModel({ role: "plan-critic", ...base, author: opus, usage: await usageOf({ "claude-code": 20, codex: 95 }) });
    expect({ providerId: answer.providerId, model: answer.model }).toEqual(opus);
    expect(answer.issues).toEqual(["same_family_judge_by_limit", "usage_moved: codex weekly 95% → claude-code/claude-opus-5-5"]);
  });

  it("the cross-family rule comes first: the author on Sol puts the critic on Opus, and Opus spent moves it back to Sol with the issue", async () => {
    const settings = { [roleModelKey("planner")]: { model: "gpt-6.1-sol" } };
    const answer = resolveSpawnModel({ role: "plan-critic", ...base, settings, author: sol, usage: await usageOf({ "claude-code": 94, codex: 10 }) });
    expect({ providerId: answer.providerId, model: answer.model }).toEqual(sol);
    expect(answer.issues).toEqual(expect.arrayContaining(["crossed_family", "same_family_judge_by_limit"]));
  });

  it("a judge whose limit moves it away from its author's family stops being flagged as not independent", async () => {
    // Sol is gone from the machine, so the judge would stay on the author's Opus; Opus is spent but Sol is not on offer: it stays and says so.
    const answer = resolveSpawnModel({ role: "plan-critic", ...base, catalog: catalog(false, true), author: opus, usage: await usageOf({ "claude-code": 95, codex: 10 }) });
    expect(answer.issues).toContain("same_family_judge");
    expect(answer.issues).not.toContain("same_family_judge_by_limit");
  });

  it("the deliberate exceptions are not moved: a pinned run keeps its pair; the writer and the seats never come through the resolver", async () => {
    const usage = await usageOf({ "claude-code": 99, codex: 10 });
    const pinned = resolveSpawnModel({ role: "specialist:mine", ...base, pinned: opus, usage });
    expect(pinned).toMatchObject({ source: "pinned" });
    expect(pinned.issues).toEqual([]);
    const pins = resolveSpawnModel({ role: "repairer", ...base, pinned: { provider: "claude-code", model: "claude-opus-5-5" }, usage });
    expect({ providerId: pins.providerId, model: pins.model }).toEqual(opus);
    for (const [file, wrapper] of Object.entries(WRAPPERS)) if (wrapper.via === "exception") expect(read(file), file).not.toMatch(/spawnUsageOf|resolveSpawnModel/);
  });

  it("unknown usage moves nothing: no usage source, a source that cannot be read, a cold cache", async () => {
    expect(resolveSpawnModel({ role: "analyst", ...base })).toMatchObject({ ...opus, issues: [] });
    expect(resolveSpawnModel({ role: "analyst", ...base, usage: await usageOf({ "claude-code": null, codex: 10 }) })).toMatchObject({ ...opus, issues: [] });
    // Nothing warmed: the first decision does not wait for the source, and does not guess.
    const bb = usageSource({ "claude-code": 99, codex: 1 }) as never;
    createWriterState({ bb, log: () => undefined } as never);
    expect(resolveSpawnModel({ role: "analyst", ...base, usage: spawnUsageOf({ bb }) })).toMatchObject({ ...opus, issues: [] });
    expect(spawnUsageOf({ bb: {} })).toBeUndefined();
  });

  it("a specialist and the workflow architect stay on Claude Code with Claude spent: their profile needs it (409 otherwise, live 2026-10-27)", async () => {
    const usage = await usageOf({ "claude-code": 97, codex: 20 });
    for (const role of ["specialist", "workflow-architect"]) {
      const got = resolveSpawnModel({ role, ...base, usage });
      expect(got.providerId, role).toBe("claude-code");
      expect(got.issues.some((issue) => issue.startsWith("usage_moved")), role).toBe(false);
    }
    expect(resolveSpawnModel({ role: "analyst", ...base, usage }).providerId).toBe("codex");
  });

  it("a spawn never waits for the usage source: warmSpawnUsage returns at once", async () => {
    const bb = { events: { on: () => () => undefined }, sdk: { plugins: { experimental_discoverRpc: () => new Promise(() => undefined), callRpc: async () => ({}) } } } as never;
    createWriterState({ bb, log: () => undefined } as never);
    const usage = spawnUsageOf({ bb });
    const started = Date.now();
    await warmSpawnUsage(usage, "h1");
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("a slow source never holds a decision", async () => {
    const bb = { events: { on: () => () => undefined }, sdk: { plugins: { experimental_discoverRpc: () => new Promise(() => undefined), callRpc: async () => ({}) } } } as never;
    createWriterState({ bb, log: () => undefined } as never);
    const usage = spawnUsageOf({ bb });
    vi.useFakeTimers();
    try {
      const warmed = warmSpawnUsage(usage, "h1");
      await vi.advanceTimersByTimeAsync(13_000);
      await warmed;
    } finally { vi.useRealTimers(); }
    expect(resolveSpawnModel({ role: "analyst", ...base, usage })).toMatchObject({ ...opus, issues: [] });
  });

  it("the cache is respected: decisions inside the time to live read the source no more", async () => {
    const calls: string[] = [];
    const usage = await usageOf({ "claude-code": 93, codex: 20 }, calls);
    const asked = calls.length;
    expect(asked).toBeGreaterThan(0);
    for (let n = 0; n < 5; n += 1) resolveSpawnModel({ role: "analyst", ...base, usage });
    await usage!.warm({ providerIds: ["claude-code", "codex"], hostId: "h1" });
    expect(calls).toHaveLength(asked);
    expect(calls.filter((method) => method === USAGE_LIST_METHOD)).toHaveLength(1);
    expect(calls.filter((method) => method === USAGE_FETCH_METHOD)).toHaveLength(2);
  });

  it("a provider that just hit its limit: the author row goes to its peer, from either family; with no peer on offer the pair is flagged", async () => {
    const fromClaude = resolveSpawnModel({ role: "analyst", ...base, avoidProvider: "claude-code" });
    expect({ providerId: fromClaude.providerId, model: fromClaude.model }).toEqual(sol);
    expect(fromClaude.issues[0]).toMatch(/^usage_moved: claude-code provider limit 100% → codex\/gpt-6.1-sol/);
    const fromCodex = resolveSpawnModel({ role: "council", ...base, avoidProvider: "codex" });
    expect({ providerId: fromCodex.providerId, model: fromCodex.model }).toEqual(opus);
    const alone = resolveSpawnModel({ role: "analyst", ...base, catalog: catalog(false, true), avoidProvider: "claude-code" });
    expect(alone.providerId).toBe("claude-code");
    expect(alone.issues).toContain("model_unavailable_here");
  });
});

// ---------------------------------------------------------------- the generic helper, driven to its real spawn

vi.mock("../src/rooms/core/server", async (original) => ({
  ...(await original<typeof import("../src/rooms/core/server")>()),
  fullAccessSpawn: vi.fn(async (_bb: unknown, args: unknown) => { throw Object.assign(new Error("SPAWNED"), { args }); }),
  findThreadsByMetadata: vi.fn(async () => null),
}));
vi.mock("../src/rooms/runs/server", async (original) => ({
  ...(await original<typeof import("../src/rooms/runs/server")>()),
  requireHelperSpawn: () => ({ mode: "optional", policy: null }),
  helperChildPlacement: async () => ({ projectId: "p" }),
  requiredPolicyField: () => ({}),
}));

describe("the generic helper spawns what the resolver answers", { timeout: 60_000 }, () => {
  const spawnedBy = async (role: string, settings: Record<string, unknown>) => {
    const { createWorkflowAgents } = await import("../src/rooms/workflow/server/workflow-agent");
    const rt = {
      pmThreadId: "pm", projectId: "p", runId: "run1",
      ctx: {
        db: { prepare: () => ({ get: () => undefined }) }, host: {}, log: () => undefined, isDisposed: () => false,
        effectiveProjectSettings: async () => ({ values: settings }), ownedAgents: async () => ({}),
        bb: {
          storage: { kv: { get: async () => null, set: async () => undefined } },
          sdk: { threads: { get: async () => ({ environmentId: "env" }), defaultExecutionOptions: async () => opus }, environments: { get: async () => ({ path: "", hostId: "" }) }, hosts: { list: async () => [] } },
        },
      },
      services: {},
    };
    try {
      await createWorkflowAgents().run({ rt, workflowRunId: "wf1", stepKey: "s", nodeId: "n", spawnKey: `k-${role}`, title: "t", prompt: "x", fields: [], role } as never);
    } catch (cause) {
      const args = (cause as { args?: Record<string, unknown> }).args;
      if (!args) throw cause;
      return { providerId: args.providerId, model: args.model, reasoningLevel: args.reasoningLevel };
    }
    throw new Error("the helper did not reach its spawn");
  };

  const roles = ROLE_TABLE.map((row) => row.id).filter((id) => !["workflow-architect", "rules-analyzer", "repairer", "docs-maintainer"].includes(id));
  it.each(roles)("%s", async (role) => {
    const planner = role === "plan-critic" || role === "specialist-reviewer" ? { author: opus } : {};
    const expected = resolveSpawnModel({ role, settings: {}, pm: opus, ...planner });
    expect(await spawnedBy(role, {})).toEqual({ providerId: expected.providerId, model: expected.model, reasoningLevel: expected.reasoningEffort });
  });

  it("the owner's row of the table is what spawns, as a consistent pair", async () => {
    const settings = { [roleModelKey("memory")]: { model: "gpt-6.1-terra", reasoning_effort: "low" }, [roleModelKey("analyst")]: { model: "claude-sonnet-5-5" } };
    expect(await spawnedBy("memory", settings)).toEqual({ providerId: "codex", model: "gpt-6.1-terra", reasoningLevel: "low" });
    expect(await spawnedBy("analyst", settings)).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5" });
  });
});
