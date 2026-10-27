import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { costTier, nodeEffortsFor, roleModelKey, validateChoice, type ModelCatalog } from "@lane-pilot/models";
import { DELEGATED_ACTIONS, resolveStepExecutors, type StepExecutor } from "../../src/rooms/workflow/server/workflow-step-executors";

const pm = { providerId: "claude-code", model: "claude-opus-5-5" };
const writer = { "writer.provider": "codex", "writer.model": "gpt-6-luna", "writer.reasoning_effort": "high", "writer.service_tier": "fast" };
const run = (nodes: unknown[], settings: Record<string, unknown> = writer, extra: { pm?: typeof pm | null; catalog?: ModelCatalog | null } = {}) =>
  resolveStepExecutors({ nodes, settings, pm: extra.pm === undefined ? pm : extra.pm, catalog: extra.catalog ?? null });
const one = (node: Record<string, unknown>, settings?: Record<string, unknown>, extra?: Parameters<typeof run>[2]): StepExecutor => run([node], settings, extra)[0]!;

const catalog: ModelCatalog = {
  hosts: [{ id: "mac", name: "Mac mini", connected: true }, { id: "ovh", name: "OVH", connected: true }],
  providers: [
    { id: "codex", displayName: "Codex", logoUrl: null, family: null, supportsServiceTier: true, serviceTiers: ["default", "fast"], hostIds: ["mac", "ovh"],
      models: [{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: false, hostIds: ["mac", "ovh"] }] },
    { id: "opencode2", displayName: "OpenCode", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mac"],
      models: [{ id: "router9/ag/gemini-3.8-flash-high", model: "router9/ag/gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash", efforts: ["medium", "high"], defaultEffort: "high", isDefault: false, hostIds: ["mac"] },
        { id: "deepseek/v4", model: "deepseek/v4", displayName: "DeepSeek V4", efforts: ["high"], defaultEffort: "high", isDefault: false, hostIds: [] }] },
    { id: "router9", displayName: "router9", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: [], models: [] },
  ],
};

describe("step executors by node type", () => {
  it("an agent node runs on the model of its role's row of the table, whatever the PM chat runs", () => {
    expect(one({ id: "a", type: "agent", role: "analyst" })).toMatchObject({
      mode: "model", providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", source: "role-default", sourceKey: null, inherited: true,
      agent: { role: "analyst", helper: "analyst" }, costTier: "high", settingsKey: "role_model.analyst", issues: [],
    });
    expect(one({ id: "c", type: "agent", role: "code-critic" }, writer, { pm: null })).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "medium", source: "role-default", settingsKey: "role_model.code-critic" });
    expect(one({ id: "t", type: "agent", role: "triager" })).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", costTier: "low" });
    expect(one({ id: "u", type: "agent", role: "auditor" })).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", reasoningEffort: "high" });
  });

  it("the owner's row of the table, then a stage selection set earlier, decide; the removed levels do not", () => {
    expect(one({ id: "a", type: "agent", role: "analyst" }, { ...writer, [roleModelKey("analyst")]: { model: "gpt-6.1-terra", reasoning_effort: "low" } }))
      .toMatchObject({ providerId: "codex", model: "gpt-6.1-terra", reasoningEffort: "low", source: "table", sourceKey: "role_model.analyst", inherited: true, costTier: "medium" });
    expect(one({ id: "a", type: "agent", role: "pm-reader" }, { ...writer, "pm_read.provider": "opencode2", "pm_read.model": "router9/ag/gemini-3.8-flash-high" }))
      .toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "low", source: "stage", sourceKey: "pm_read.model", inherited: true, costTier: "low" });
    expect(one({ id: "a", type: "agent", role: "worker" }, { ...writer, "workflow.agent.provider": "codex", "workflow.agent.model": "gpt-6-luna", "workflow.model_override.demo/a": { provider: "codex", model: "gpt-6-luna" } }))
      .toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", source: "role-default" });
  });

  it("a node's own model fields and preset change nothing", () => {
    expect(one({ id: "a", type: "agent", role: "analyst", model_preset: "cheap-fast", provider: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoning: "medium", service_tier: "fast" }))
      .toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", serviceTier: null, source: "role-default", inherited: true });
  });

  it("the pipeline's stages run on the rows of their roles (pm-reader, plan-critic, specialist-reviewer), the old stage selection standing in until the owner sets the table", () => {
    const stage = { id: "p", type: "agent", role: "plan-critic", uses: "lp.plan-critique" };
    expect(one(stage, writer)).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "medium", serviceTier: "fast", source: "role-default", settingsKey: "role_model.plan-critic" });
    expect(one(stage, { ...writer, "plan_critique.provider": "claude-code", "plan_critique.model": "claude-opus-5-5", "plan_critique.reasoning_effort": "xhigh", "plan_critique.service_tier": "standard" }))
      .toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "xhigh", serviceTier: "standard", source: "stage", sourceKey: "plan_critique.model", inherited: true });
    expect(one(stage, { ...writer, [roleModelKey("plan-critic")]: { model: "claude-sonnet-5-5" } })).toMatchObject({ model: "claude-sonnet-5-5", source: "table", inherited: false });
    expect(one({ id: "r", type: "agent", uses: "lp.pm-read" }, writer)).toMatchObject({ model: "claude-haiku-5-5", reasoningEffort: "low", settingsKey: "role_model.pm-reader", agent: { label: "PM read" } });
    expect(one({ id: "s", type: "agent", uses: "lp.specialist-review" }, writer)).toMatchObject({ model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "medium", settingsKey: "role_model.specialist-reviewer" });
  });

  it("a code task is the writer's chain: writer, fallback 1, fallback 2, then the PM; its code critic is a part", () => {
    const task = one({ id: "w", type: "lp-task", stages: ["writer-agent", "verification", "code-critique"] }, writer);
    expect(task).toMatchObject({ mode: "chain", providerId: "codex", model: "gpt-6-luna", reasoningEffort: "high", serviceTier: "fast", source: "writer", settingsKey: "writer", costTier: "low" });
    expect(task.fallbacks).toEqual([
      { providerId: "opencode2", model: "zai-coding-plan/glm-5.3-flash", reasoningEffort: "high", pm: false },
      { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "medium", pm: false },
      { providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: null, pm: true },
    ]);
    expect(task.parts).toEqual([{ stage: "code-critique", providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "medium", serviceTier: "fast", source: "role-default", sourceKey: null }]);
  });

  it("the chain follows the configured fallbacks, drops an off slot and a repeat of the writer, and leaves the PM open when it is unknown", () => {
    const configured = { ...writer, "writer.fallback1.provider": "", "writer.fallback2.provider": "codex", "writer.fallback2.model": "gpt-6-luna" };
    expect(one({ id: "w", type: "lp-task" }, configured, { pm: null }).fallbacks).toEqual([{ providerId: null, model: null, reasoningEffort: null, pm: true }]);
    const own = { ...writer, "writer.fallback1.provider": "opencode2", "writer.fallback1.model": "deepseek/v4", "writer.fallback1.reasoning_effort": "high", "writer.fallback2.provider": "" };
    expect(one({ id: "w", type: "lp-task" }, own).fallbacks.map((row) => row.model)).toEqual(["deepseek/v4", "claude-opus-5-5"]);
  });

  it("the code critic is the code-critic row, and the old code_critique selection stands in for it", () => {
    expect(one({ id: "w", type: "lp-task" }, writer).parts[0]).toMatchObject({ providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "medium", source: "role-default", sourceKey: null });
    const task = one({ id: "w", type: "lp-task" }, { ...writer, "code_critique.provider": "claude-code", "code_critique.model": "claude-opus-5-5" });
    expect(task.parts[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", source: "stage", sourceKey: "code_critique.model" });
  });

  it("an action in a helper thread runs the errand helper on the errand row; other actions, decisions, questions and calls have no model", () => {
    expect(one({ id: "t", type: "action", action: "telegram.send_rich" })).toMatchObject({ mode: "helper", agent: { role: "errand", label: "telegram.send_rich" }, source: "helper", providerId: "claude-code", model: "claude-sonnet-5-5", settingsKey: "role_model.errand" });
    for (const node of [{ id: "x", type: "action", action: "items.dedupe" }, { id: "d", type: "decision" }, { id: "h", type: "human", question: "ok?" }, { id: "c", type: "subworkflow", workflow: "child" }]) {
      expect(one(node)).toMatchObject({ mode: "none", providerId: null, model: null, source: "none", costTier: "none", settingsKey: null });
    }
    expect(one({ id: "c", type: "subworkflow", workflow: "child" }).agent.label).toBe("child");
  });

  it("a parallel's body is its own step `<id>:child`; notes, joins and the container are not steps", () => {
    const steps = run([
      { id: "fan", type: "parallel", for_each: "x.items", child: { type: "agent", role: "pm-reader" } },
      { id: "j", type: "join", parallel: "fan" }, { id: "n", type: "note", text: "hi" }, { id: "bare", type: "parallel" },
    ]);
    expect(steps.map((step) => step.nodeId)).toEqual(["fan:child"]);
    expect(steps[0]).toMatchObject({ source: "role-default", model: "claude-haiku-5-5" });
  });

  it("works on a draft that is not finished (no type, no role)", () => {
    expect(run([{ id: "a" }, { nope: true }, "x", { id: "b", type: "agent" }]).map((step) => [step.nodeId, step.agent.role])).toEqual([["a", "worker"], ["b", "worker"]]);
  });

  it("reads the built-in task pipeline: three stages, the writer chain, no model on the bookkeeping", () => {
    const pipeline = builtinWorkflow("lp-task-pipeline")!;
    const steps = run(pipeline.nodes, writer);
    const by = Object.fromEntries(steps.map((step) => [step.nodeId, step]));
    expect(by["pm-read"]).toMatchObject({ settingsKey: "role_model.pm-reader", mode: "model" });
    expect(by["plan-critique"]).toMatchObject({ settingsKey: "role_model.plan-critic" });
    expect(by["specialist-review"]).toMatchObject({ settingsKey: "role_model.specialist-reviewer" });
    expect(by["writer"]).toMatchObject({ mode: "chain", model: "gpt-6-luna" });
    expect(by["writer"]!.fallbacks.length).toBe(3);
    expect(by["ownership-base"]).toMatchObject({ mode: "none" });
    expect(by["quality-mode"]).toMatchObject({ mode: "none" });
  });

  it("flags a step whose role's model no machine of the catalog lists", () => {
    const steps = run([
      { id: "ok", type: "agent", role: "triager" },
      { id: "noprov", type: "agent", role: "planner" },
      { id: "nomodel", type: "agent", role: "analyst" },
    ], { ...writer, [roleModelKey("analyst")]: { model: "gpt-6.1-terra" } }, { catalog });
    expect(steps.map((step) => step.issues)).toEqual([[], ["provider_unknown"], ["model_unknown"]]);
  });

  it("lists the same delegated actions the executors register", () => {
    const source = readFileSync(new URL("../../src/rooms/workflow/server/workflow-executors.ts", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("const DELEGATED"), source.indexOf("for (const [key, spec] of Object.entries(DELEGATED))"));
    const keys = [...block.matchAll(/^\s+"([a-z_.]+)": \{ role:/gm)].map((match) => match[1]);
    expect([...DELEGATED_ACTIONS].sort()).toEqual(keys.sort());
  });
});

describe("the model catalog", () => {
  it("accepts a combination the catalog supports", () => {
    expect(validateChoice(catalog, { providerId: "codex", model: "gpt-6-luna", effort: "high", serviceTier: "fast" })).toEqual({ ok: true });
    expect(validateChoice(catalog, { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", effort: "medium" })).toEqual({ ok: true });
  });

  it("rejects a model no machine offers, a provider with no machine, an unknown id, and an effort or tier the model lacks", () => {
    expect(validateChoice(catalog, { providerId: "opencode2", model: "deepseek/v4" })).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(validateChoice(catalog, { providerId: "router9", model: "x" })).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(validateChoice(catalog, { providerId: "nope", model: "x" })).toMatchObject({ ok: false, code: "provider_unknown" });
    expect(validateChoice(catalog, { providerId: "codex", model: "gpt-9" })).toMatchObject({ ok: false, code: "model_unknown" });
    expect(validateChoice(catalog, { providerId: "codex", model: "gpt-6-luna", effort: "max" })).toMatchObject({ ok: false, code: "effort_unsupported" });
    expect(validateChoice(catalog, { providerId: "opencode2", model: "router9/ag/gemini-3.8-flash-high", serviceTier: "fast" })).toMatchObject({ ok: false, code: "tier_unsupported" });
  });

  it("offers a node only the efforts both the model and the node schema know", () => {
    const luna = catalog.providers[0]!.models[0]!;
    expect(nodeEffortsFor(luna)).toEqual(["low", "medium", "high"]);
    expect(nodeEffortsFor({ ...luna, efforts: ["none", "ultra", "xhigh"] })).toEqual(["xhigh"]);
    expect(nodeEffortsFor(undefined)).toEqual([]);
  });

  it("puts a model in a price class from its list price, else from its name", () => {
    expect([costTier("claude-opus-5-5"), costTier("claude-sonnet-5-5"), costTier("gpt-6-luna"), costTier("zai-coding-plan/glm-5.3-flash"), costTier("router9/ag/gemini-3.8-pro"), costTier("deepseek/v4"), costTier("mystery"), costTier(null)])
      .toEqual(["high", "medium", "low", "low", "high", "medium", "unknown", "unknown"]);
  });
});

describe("a step that goes on in an earlier step's session", () => {
  const nodes = [
    { id: "gather", type: "agent", role: "pm-reader" },
    { id: "assess", type: "agent", role: "analyst" },
    { id: "again", type: "agent", role: "analyst", session: "new" },
    { id: "judge", type: "agent", role: "auditor" },
  ];
  const edges = [
    { from: "start", to: "gather", pass: "artifact" },
    { from: "gather", to: "assess", pass: "same-session" },
    { from: "assess", to: "gather", pass: "same-session" },
    { from: "assess", to: "again", pass: "same-session" },
    { from: "again", to: "judge", pass: "read-prior-session" },
  ];
  const by = (steps: StepExecutor[]) => Object.fromEntries(steps.map((step) => [step.nodeId, step]));

  it("shows the model of the session it runs in, with the step it inherits from", () => {
    const steps = by(resolveStepExecutors({ nodes, edges, settings: writer, pm, workflowId: "frag" }));
    // gather starts a session (the entry), so its own role's model stands, and the loop back into it changes nothing.
    expect(steps.gather).toMatchObject({ source: "role-default", model: "claude-haiku-5-5" });
    // assess has only a same-session edge in: the analyst's row is never used; the session is gather's.
    expect(steps.assess).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", source: "session", sourceKey: "gather", inherited: true });
    // `session: new` opens its own session even on a same-session edge; read-prior-session reads, it does not continue.
    expect(steps.again).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", source: "role-default" });
    expect(steps.judge).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", source: "role-default" });
  });

  it("follows the chain: the whole session runs on the first step's model", () => {
    const chain = [{ id: "a", type: "agent", role: "rules-analyzer" }, { id: "b", type: "agent", role: "analyst" }, { id: "c", type: "agent", role: "planner" }];
    const links = [{ from: "start", to: "a" }, { from: "a", to: "b", pass: "same-session" }, { from: "b", to: "c", pass: "same-session" }];
    const steps = by(resolveStepExecutors({ nodes: chain, edges: links, settings: writer, pm, workflowId: "frag" }));
    expect(steps.a).toMatchObject({ source: "role-default", model: "gpt-6-luna" });
    expect(steps.b).toMatchObject({ source: "session", sourceKey: "a", model: "gpt-6-luna" });
    expect(steps.c).toMatchObject({ source: "session", sourceKey: "b", model: "gpt-6-luna" });
  });

  it("an entry named by `entry` counts as a fresh start; a step whose only same-session source is not an agent keeps its own role's model", () => {
    const steps = by(resolveStepExecutors({ nodes: [{ id: "a", type: "agent", role: "triager" }, { id: "lint", type: "action", action: "lint" }, { id: "b", type: "agent", role: "analyst" }],
      edges: [{ from: "a", to: "lint" }, { from: "lint", to: "b", pass: "same-session" }], entry: "a", settings: writer, pm }));
    expect(steps.b).toMatchObject({ source: "role-default", model: "claude-opus-5-5" });
  });

  it("the built-in lp.analyze: assess runs in gather's session", () => {
    const analyze = builtinWorkflow("lp.analyze")!;
    const steps = by(resolveStepExecutors({ nodes: analyze.nodes, edges: analyze.edges, entry: analyze.entry, settings: writer, pm, workflowId: "lp.analyze" }));
    expect(steps.gather).toMatchObject({ source: "role-default" });
    expect(steps.assess).toMatchObject({ source: "session", sourceKey: "gather", model: steps.gather!.model });
    // second_opinion arrives by artifact: a session of its own.
    expect(steps.second_opinion!.source).not.toBe("session");
  });
});

describe("the steps of a called workflow", () => {
  const fragment = {
    nodes: [{ id: "gather", type: "agent", role: "analyst" }, { id: "assess", type: "agent", role: "analyst" }, { id: "done", type: "action", action: "emit" }],
    edges: [{ from: "start", to: "gather" }, { from: "gather", to: "assess", pass: "same-session" }, { from: "assess", to: "done" }],
  };
  const parent = [{ id: "plan", type: "action", action: "fs.write" }, { id: "analyze", type: "subworkflow", workflow: "lp.analyze" }];
  const fragments = new Map([["lp.analyze", fragment]]);

  it("are listed under their fragment, each on its role's model, and the parent's own steps stay as they were", () => {
    const settings = { ...writer, [roleModelKey("analyst")]: { model: "gpt-6.1-terra", reasoning_effort: "low" } };
    const steps = resolveStepExecutors({ nodes: parent, settings, pm, workflowId: "analyze-code", fragments });
    expect(steps.filter((step) => !step.fragment).map((step) => step.nodeId)).toEqual(["plan", "analyze"]);
    const inside = steps.filter((step) => step.fragment);
    expect(inside.map((step) => [step.fragment, step.nodeId])).toEqual([[{ nodeId: "analyze", workflowId: "lp.analyze" }, "gather"], [{ nodeId: "analyze", workflowId: "lp.analyze" }, "assess"], [{ nodeId: "analyze", workflowId: "lp.analyze" }, "done"]]);
    expect(inside[0]).toMatchObject({ source: "table", sourceKey: "role_model.analyst", model: "gpt-6.1-terra", reasoningEffort: "low" });
    // assess is in gather's session, so it runs on gather's model.
    expect(inside[1]).toMatchObject({ source: "session", sourceKey: "gather", model: "gpt-6.1-terra" });
  });

  it("a nested call is followed, a cycle and a missing workflow are not", () => {
    const inner = { nodes: [{ id: "deep", type: "agent", role: "analyst" }, { id: "back", type: "subworkflow", workflow: "outer" }, { id: "gone", type: "subworkflow", workflow: "nope" }], edges: [] };
    const outer = { nodes: [{ id: "mid", type: "subworkflow", workflow: "inner" }], edges: [] };
    const steps = resolveStepExecutors({ nodes: [{ id: "top", type: "subworkflow", workflow: "outer" }], settings: writer, pm, workflowId: "root", fragments: new Map<string, { nodes: unknown[]; edges: unknown[] }>([["outer", outer], ["inner", inner]]) });
    // `outer` is called from `top`, `inner` from `mid` inside it; `back` would call `outer` again (a cycle) and `nope` does not exist: neither adds steps.
    expect(steps.filter((step) => step.fragment && step.mode !== "none").map((step) => [step.fragment!.workflowId, step.nodeId])).toEqual([["inner", "deep"]]);
    expect(steps.map((step) => step.nodeId)).toEqual(["top", "mid", "deep", "back", "gone"]);
    expect(steps.find((step) => step.nodeId === "deep")!.fragment).toEqual({ nodeId: "top", workflowId: "inner" });
  });

  it("a call the library cannot find adds nothing", () => {
    const steps = resolveStepExecutors({ nodes: parent, settings: writer, pm, fragments });
    expect(steps.find((step) => step.nodeId === "gather")).toMatchObject({ source: "role-default", model: "claude-opus-5-5" });
    expect(resolveStepExecutors({ nodes: parent, settings: writer, pm }).map((step) => step.nodeId)).toEqual(["plan", "analyze"]);
  });
});
