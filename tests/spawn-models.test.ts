import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ROLE_IDS, ROLE_TABLE, consistentProvider, modelFamily, roleModelKey, type ModelCatalog } from "@lane-pilot/models";
import { resolveSpawnModel } from "../src/rooms/core/server/spawn-model";

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

describe("the generic helper spawns what the resolver answers", () => {
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
