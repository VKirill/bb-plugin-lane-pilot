import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { agentRequest, withResolvedModel, type HelperRequest } from "../../src/rooms/workflow/server/services/workflow-agent";
import { noteRoleSwitch, switchedFromProvider } from "../../src/rooms/workflow/server/services/workflow-role-fallback";
import { collectOwnerWaiting, countOpenOwnerItems } from "../../src/rooms/owner-waiting";
import { openDatabase } from "../../src/rooms/plugin-db";
import { roleModelKey } from "@lane-pilot/models";
import { loadWorkflow, parseWorkflow } from "@lane-pilot/workflow-engine";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import { resolveStepExecutors } from "../../src/rooms/workflow/server/services/workflow-step-executors";
import { workflow } from "./fixtures";

const agent = (id: string, role: string, extra: Record<string, unknown> = {}) => ({ id, type: "agent", role, prompt: "x", output: [{ name: "o", type: "string" }], ...extra });
const chain = (nodes: Array<Record<string, unknown>>) => workflow({
  nodes,
  edges: [{ from: "start", to: nodes[0]!.id }, ...nodes.slice(1).map((node, index) => ({ from: nodes[index]!.id, to: node.id })), { from: nodes.at(-1)!.id, to: "end", with: { result: `${nodes.at(-1)!.id}.o` } }],
});
const problemsOf = (raw: Record<string, unknown>) => { const found = loadWorkflow(raw); return found.ok ? found.warnings : found.problems; };

function runtime(settings: Record<string, unknown>, kv: Map<string, unknown> = new Map()) {
  return {
    pmThreadId: "pm-thread", projectId: "p", runId: "r",
    ctx: {
      db: { prepare: () => ({ get: () => undefined }) }, log: vi.fn(),
      effectiveProjectSettings: async () => ({ values: settings }), ownedAgents: async () => ({}),
      bb: { sdk: { threads: { defaultExecutionOptions: async () => ({}) } }, log: { warn: vi.fn() }, storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } } },
    },
    services: {},
  };
}
const requestFor = (raw: Record<string, unknown>, nodeId: string, rt: ReturnType<typeof runtime>): HelperRequest => {
  const flow = parseWorkflow(raw);
  const node = flow.nodes.find((candidate) => candidate.id === nodeId) as Extract<GraphNode, { type: "agent" }>;
  const ctx = {
    runtime: rt, workflow: flow, node, nodeId, runId: "wfrun", stepKey: `${nodeId}#1`, spawnKey: "k", mode: "standard", signal: new AbortController().signal,
    input: { with: {}, via: { mode: "artifact", fromStep: null } }, goals: [], reground: false, resolve: (text: string) => text, render: (text: string) => text, template: (value: unknown) => value,
  } as unknown as StepContext<never>;
  return agentRequest(ctx as never, node);
};

describe("model of a node: node field, then role table, then default", () => {
  const raw = chain([agent("a", "analyst", { provider: "codex", model: "gpt-6.1-terra" }), agent("b", "analyst")]);

  it("the node's own model wins over the role's row", async () => {
    const rt = runtime({ [roleModelKey("analyst")]: { model: "claude-sonnet-5-5" } });
    expect(await withResolvedModel(requestFor(raw, "a", rt))).toMatchObject({ provider: "codex", model: "gpt-6.1-terra" });
    expect(rt.ctx.log).toHaveBeenCalledWith(expect.stringContaining("wf.model node=a source=node model=codex/gpt-6.1-terra"));
  });

  it("a node without a model takes its role's row, then the built-in default", async () => {
    const owned = runtime({ [roleModelKey("analyst")]: { model: "claude-sonnet-5-5" } });
    expect(await withResolvedModel(requestFor(raw, "b", owned))).toMatchObject({ provider: "claude-code", model: "claude-sonnet-5-5" });
    expect(owned.ctx.log).toHaveBeenCalledWith(expect.stringContaining("wf.model node=b source=role"));
    const bare = runtime({});
    expect(await withResolvedModel(requestFor(raw, "b", bare))).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5" });
    expect(bare.ctx.log).toHaveBeenCalledWith(expect.stringContaining("wf.model node=b source=default"));
  });

  it("the Models view shows the node's model, the one the executor spawns", async () => {
    const settings = { [roleModelKey("analyst")]: { model: "claude-sonnet-5-5" } };
    const shown = resolveStepExecutors({ nodes: [{ ...(raw.nodes as Array<Record<string, unknown>>)[0]! }], settings, pm: null });
    expect(shown[0]).toMatchObject({ providerId: "codex", model: "gpt-6.1-terra", source: "pinned" });
    const spawned = await withResolvedModel(requestFor(raw, "a", runtime(settings)));
    expect([spawned.provider, spawned.model]).toEqual([shown[0]!.providerId, shown[0]!.model]);
  });

  it("the model_ignored warning is gone: a model on a node is not a problem", () => {
    expect(problemsOf(raw).some((problem) => problem.code === "model_ignored")).toBe(false);
    expect(loadWorkflow(raw).ok).toBe(true);
  });
});

describe("validation of a node's model", () => {
  it("an unknown provider or a model its provider does not have fails with the node id", () => {
    const badProvider = problemsOf(chain([agent("a", "analyst", { provider: "nonesuch", model: "x" })]));
    expect(badProvider).toContainEqual(expect.objectContaining({ code: "unknown_provider", level: "error", node: "a" }));
    const badModel = problemsOf(chain([agent("a", "analyst", { provider: "claude-code", model: "claude-mystery-9" })]));
    expect(badModel).toContainEqual(expect.objectContaining({ code: "unknown_model", level: "error", node: "a" }));
    const mismatch = problemsOf(chain([agent("a", "analyst", { provider: "claude-code", model: "gpt-6.1-sol" })]));
    expect(mismatch).toContainEqual(expect.objectContaining({ code: "unknown_model", node: "a" }));
    expect(problemsOf(chain([agent("a", "analyst", { model: "gpt-6.1-sol" })])).some((problem) => problem.level === "error" && /model/.test(problem.code))).toBe(false);
  });

  it("a critic may not share provider and model with the writer it judges, unless it says so and why", () => {
    const pair = { provider: "codex", model: "gpt-6.1-sol" };
    const same = chain([agent("write", "analyst", pair), agent("judge", "plan-critic", pair)]);
    expect(problemsOf(same)).toContainEqual(expect.objectContaining({ code: "judge_same_model", level: "error", node: "judge" }));
    const other = chain([agent("write", "analyst", pair), agent("judge", "plan-critic", { provider: "claude-code", model: "claude-opus-5-5" })]);
    expect(problemsOf(other).some((problem) => problem.code === "judge_same_model")).toBe(false);
    const allowed = chain([agent("write", "analyst", pair), agent("judge", "plan-critic", { ...pair, allow_same_model: true, same_model_reason: "only model this machine has" })]);
    expect(problemsOf(allowed).some((problem) => problem.level === "error" && /same_model/.test(problem.code))).toBe(false);
    const unexplained = chain([agent("write", "analyst", pair), agent("judge", "plan-critic", { ...pair, allow_same_model: true })]);
    expect(problemsOf(unexplained)).toContainEqual(expect.objectContaining({ code: "same_model_reason_missing", node: "judge" }));
  });
});

describe("a provider that ends its subscription moves the role for every graph", () => {
  const critic = chain([agent("judge", "plan-critic")]);
  const noted = (db: ReturnType<typeof openDatabase>, kv: Map<string, unknown>, role = "plan-critic") => noteRoleSwitch({
    kv: runtime({}, kv).ctx.bb.storage.kv, db, log: { warn: vi.fn() }, settings: {}, role,
    failed: { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high" }, to: { providerId: "codex", model: "gpt-6.1-sol" }, reason: "usage limit reached",
  });

  it("an auth failure switches the role to its fallback and posts exactly one owner item, however often it repeats or whichever graph sees it", async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const kv = new Map<string, unknown>();
    expect(await noted(db, kv)).toBe(true);
    expect(await noted(db, kv)).toBe(false);
    expect(await noted(db, kv, "plan-critic-light")).toBe(true);
    expect(countOpenOwnerItems(db, { source: "workflow", kind: "model_unavailable" })).toBe(2);
    const items = collectOwnerWaiting(db).items.filter((item) => item.kind === "model_unavailable");
    expect(items.filter((item) => item.key === "role-model:plan-critic")).toHaveLength(1);
    expect(items[0]!.what).toMatch(/unavailable for plan-critic.*gpt-6\.1-sol/);

    // the next step of any graph on that role runs on the other family, without a second failure
    const rt = runtime({}, kv);
    expect(await withResolvedModel(requestFor(critic, "judge", rt))).toMatchObject({ provider: "codex", model: "gpt-6.1-sol" });
    // a node that names its own model is not moved by the role's switch
    const pinned = chain([agent("judge", "plan-critic", { provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high" })]);
    expect(await withResolvedModel(requestFor(pinned, "judge", rt))).toMatchObject({ provider: "opencode2" });
  });

  it("the owner changing the role's model in Settings ends the switch", async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const kv = new Map<string, unknown>();
    await noted(db, kv);
    const store = runtime({}, kv).ctx.bb.storage.kv;
    expect(await switchedFromProvider(store, {}, "plan-critic")).toBe("opencode2");
    expect(await switchedFromProvider(store, { [roleModelKey("plan-critic")]: { model: "claude-opus-5-5" } }, "plan-critic")).toBeNull();
  });
});
