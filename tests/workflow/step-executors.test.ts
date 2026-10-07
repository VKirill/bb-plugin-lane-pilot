import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { builtinWorkflow } from "../../src/workflow/builtin";
import { costTier, nodeEffortsFor, validateChoice, type ModelCatalog } from "../../src/workflow/model-catalog";
import { DELEGATED_ACTIONS, resolveStepExecutors, type StepExecutor } from "../../src/server/workflow-step-executors";

const pm = { providerId: "claude-code", model: "claude-opus-5-5" };
const writer = { "writer.provider": "codex", "writer.model": "gpt-6-luna", "writer.reasoning_effort": "high", "writer.service_tier": "fast" };
const run = (nodes: unknown[], settings: Record<string, unknown> = writer, extra: { pm?: typeof pm | null; catalog?: ModelCatalog | null } = {}) =>
  resolveStepExecutors({ nodes, settings, pm: extra.pm === undefined ? pm : extra.pm, catalog: extra.catalog ?? null });
const one = (node: Record<string, unknown>, settings?: Record<string, unknown>, extra?: Parameters<typeof run>[2]): StepExecutor => run([node], settings, extra)[0]!;

const catalog: ModelCatalog = {
  hosts: [{ id: "mac", name: "Mac mini", connected: true }, { id: "ovh", name: "OVH", connected: true }],
  providers: [
    { id: "codex", displayName: "Codex", logoUrl: null, family: null, supportsServiceTier: true, serviceTiers: ["default", "fast"], hostIds: ["mac", "ovh"],
      models: [{ id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT-6 Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", hostIds: ["mac", "ovh"] }] },
    { id: "acp-opencode", displayName: "OpenCode", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mac"],
      models: [{ id: "router9/ag/gemini-3.8-flash-high", model: "router9/ag/gemini-3.8-flash-high", displayName: "Gemini 3.8 Flash", efforts: ["medium", "high"], defaultEffort: "high", hostIds: ["mac"] },
        { id: "deepseek/v4", model: "deepseek/v4", displayName: "DeepSeek V4", efforts: ["high"], defaultEffort: "high", hostIds: [] }] },
    { id: "router9", displayName: "router9", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: [], models: [] },
  ],
};

describe("step executors by node type", () => {
  it("an agent node with nothing set runs on the workflow agent's default (role default)", () => {
    expect(one({ id: "a", type: "agent", role: "analyst" })).toMatchObject({
      mode: "model", providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", source: "role-default", inherited: true, overridable: true,
      agent: { role: "analyst", helper: "analyst" }, costTier: "high", issues: [],
    });
  });

  it("node fields beat a preset, and a preset beats the default; an unknown preset is flagged and changes nothing", () => {
    expect(one({ id: "a", type: "agent", role: "analyst", model_preset: "cheap-fast" })).toMatchObject({ model: "claude-sonnet-5-5", reasoningEffort: "low", source: "preset", sourceKey: "cheap-fast", inherited: true });
    expect(one({ id: "a", type: "agent", role: "analyst", model_preset: "cheap-fast", provider: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoning: "medium" }))
      .toMatchObject({ providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "medium", source: "node", inherited: false, costTier: "low" });
    expect(one({ id: "a", type: "agent", role: "analyst", model_preset: "strong" })).toMatchObject({ model: "claude-opus-5-5", source: "role-default", issues: ["unknown_preset"] });
  });

  it("a provider with no model keeps the default model and says so; a model with no provider runs on the default provider", () => {
    expect(one({ id: "a", type: "agent", role: "analyst", provider: "codex" })).toMatchObject({ providerId: "codex", model: "claude-opus-5-5", issues: ["provider_without_model"] });
    expect(one({ id: "a", type: "agent", role: "analyst", model: "gpt-6-luna" })).toMatchObject({ providerId: "claude-code", model: "gpt-6-luna", source: "node" });
    expect(run([{ id: "a", type: "agent", role: "analyst", model: "gpt-6-luna" }], writer, { catalog })[0]!.issues).toEqual(["provider_unknown"]);
  });

  it("the pipeline's stages take their selection from Settings, then the writer's profile; the effort falls back as the stage does", () => {
    const stage = { id: "p", type: "agent", role: "plan-critic", uses: "lp.plan-critique" };
    expect(one(stage, writer)).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoningEffort: "high", serviceTier: "fast", source: "writer", sourceKey: "writer.model", overridable: false, settingsKey: "plan_critique" });
    expect(one(stage, { ...writer, "plan_critique.provider": "claude-code", "plan_critique.model": "claude-opus-5-5", "plan_critique.reasoning_effort": "xhigh", "plan_critique.service_tier": "standard" }))
      .toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "xhigh", serviceTier: "standard", source: "stage", sourceKey: "plan_critique.model", inherited: false });
    // The PM read and the specialist keep their own default effort and ignore the writer's.
    expect(one({ id: "r", type: "agent", uses: "lp.pm-read" }, writer)).toMatchObject({ reasoningEffort: "low", settingsKey: "pm_read", agent: { label: "PM read" } });
    expect(one({ id: "s", type: "agent", uses: "lp.specialist-review" }, writer)).toMatchObject({ reasoningEffort: "high", settingsKey: "specialist" });
  });

  it("a stage with no selection anywhere is flagged", () => {
    expect(one({ id: "p", type: "agent", uses: "lp.plan-critique" }, {})).toMatchObject({ providerId: null, source: "none", issues: ["no_selection"] });
  });

  it("a code task is the writer's chain: writer, fallback 1, fallback 2, then the PM; its code critic is a part", () => {
    const task = one({ id: "w", type: "lp-task", stages: ["writer-agent", "verification", "code-critique"] }, writer);
    expect(task).toMatchObject({ mode: "chain", providerId: "codex", model: "gpt-6-luna", reasoningEffort: "high", serviceTier: "fast", source: "writer", settingsKey: "writer", overridable: false, costTier: "low" });
    expect(task.fallbacks).toEqual([
      { providerId: "acp-opencode", model: "zai-coding-plan/glm-5.3-flash", reasoningEffort: "high", pm: false },
      { providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", reasoningEffort: "medium", pm: false },
      { providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: null, pm: true },
    ]);
    expect(task.parts).toEqual([{ stage: "code-critique", providerId: "codex", model: "gpt-6-luna", reasoningEffort: "high", serviceTier: "fast", source: "writer", sourceKey: "writer.model" }]);
  });

  it("the chain follows the configured fallbacks, drops an off slot and a repeat of the writer, and leaves the PM open when it is unknown", () => {
    const configured = { ...writer, "writer.fallback1.provider": "", "writer.fallback2.provider": "codex", "writer.fallback2.model": "gpt-6-luna" };
    expect(one({ id: "w", type: "lp-task" }, configured, { pm: null }).fallbacks).toEqual([{ providerId: null, model: null, reasoningEffort: null, pm: true }]);
    const own = { ...writer, "writer.fallback1.provider": "acp-opencode", "writer.fallback1.model": "deepseek/v4", "writer.fallback1.reasoning_effort": "high", "writer.fallback2.provider": "" };
    expect(one({ id: "w", type: "lp-task" }, own).fallbacks.map((row) => row.model)).toEqual(["deepseek/v4", "claude-opus-5-5"]);
  });

  it("the code critic takes its own selection", () => {
    const task = one({ id: "w", type: "lp-task" }, { ...writer, "code_critique.provider": "claude-code", "code_critique.model": "claude-opus-5-5" });
    expect(task.parts[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", source: "stage", sourceKey: "code_critique.model" });
  });

  it("an action in a helper thread runs the errand helper on the default; other actions, decisions, questions and calls have no model", () => {
    expect(one({ id: "t", type: "action", action: "telegram.send_rich" })).toMatchObject({ mode: "helper", agent: { role: "errand", label: "telegram.send_rich" }, source: "helper", providerId: "claude-code", model: "claude-opus-5-5", overridable: false });
    for (const node of [{ id: "x", type: "action", action: "items.dedupe" }, { id: "d", type: "decision" }, { id: "h", type: "human", question: "ok?" }, { id: "c", type: "subworkflow", workflow: "child" }]) {
      expect(one(node)).toMatchObject({ mode: "none", providerId: null, model: null, source: "none", costTier: "none", overridable: false });
    }
    expect(one({ id: "c", type: "subworkflow", workflow: "child" }).agent.label).toBe("child");
  });

  it("a parallel's body is its own step `<id>:child`; notes, joins and the container are not steps", () => {
    const steps = run([
      { id: "fan", type: "parallel", for_each: "x.items", child: { type: "agent", role: "analyst", model_preset: "cheap-fast" } },
      { id: "j", type: "join", parallel: "fan" }, { id: "n", type: "note", text: "hi" }, { id: "bare", type: "parallel" },
    ]);
    expect(steps.map((step) => step.nodeId)).toEqual(["fan:child"]);
    expect(steps[0]).toMatchObject({ source: "preset", model: "claude-sonnet-5-5" });
  });

  it("works on a draft that is not finished (no type, no role)", () => {
    expect(run([{ id: "a" }, { nope: true }, "x", { id: "b", type: "agent" }]).map((step) => [step.nodeId, step.agent.role])).toEqual([["a", "worker"], ["b", "worker"]]);
  });

  it("reads the built-in task pipeline: three stages, the writer chain, no model on the bookkeeping", () => {
    const pipeline = builtinWorkflow("lp-task-pipeline")!;
    const steps = run(pipeline.nodes, writer);
    const by = Object.fromEntries(steps.map((step) => [step.nodeId, step]));
    expect(by["pm-read"]).toMatchObject({ settingsKey: "pm_read", mode: "model" });
    expect(by["plan-critique"]).toMatchObject({ settingsKey: "plan_critique" });
    expect(by["specialist-review"]).toMatchObject({ settingsKey: "specialist" });
    expect(by["writer"]).toMatchObject({ mode: "chain", model: "gpt-6-luna" });
    expect(by["writer"]!.fallbacks.length).toBe(3);
    expect(by["ownership-base"]).toMatchObject({ mode: "none" });
    expect(by["quality-mode"]).toMatchObject({ mode: "none" });
  });

  it("flags a step whose provider or model no machine offers", () => {
    const steps = run([
      { id: "ok", type: "agent", role: "analyst", provider: "codex", model: "gpt-6-luna", reasoning: "medium" },
      { id: "nomodel", type: "agent", role: "analyst", provider: "acp-opencode", model: "deepseek/v4", reasoning: "high" },
      { id: "noprov", type: "agent", role: "analyst", provider: "router9", model: "x" },
      { id: "gone", type: "agent", role: "analyst", provider: "nope", model: "x" },
      { id: "effort", type: "agent", role: "analyst", provider: "codex", model: "gpt-6-luna", reasoning: "max" },
    ], writer, { catalog });
    expect(steps.map((step) => step.issues)).toEqual([[], ["model_unavailable"], ["provider_unavailable"], ["provider_unknown"], ["effort_unsupported"]]);
  });

  it("lists the same delegated actions the executors register", () => {
    const source = readFileSync(new URL("../../src/server/workflow-executors.ts", import.meta.url), "utf8");
    const block = source.slice(source.indexOf("const DELEGATED"), source.indexOf("for (const [key, spec] of Object.entries(DELEGATED))"));
    const keys = [...block.matchAll(/^\s+"([a-z_.]+)": \{ role:/gm)].map((match) => match[1]);
    expect([...DELEGATED_ACTIONS].sort()).toEqual(keys.sort());
  });
});

describe("the model catalog", () => {
  it("accepts a combination the catalog supports", () => {
    expect(validateChoice(catalog, { providerId: "codex", model: "gpt-6-luna", effort: "high", serviceTier: "fast" })).toEqual({ ok: true });
    expect(validateChoice(catalog, { providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", effort: "medium" })).toEqual({ ok: true });
  });

  it("rejects a model no machine offers, a provider with no machine, an unknown id, and an effort or tier the model lacks", () => {
    expect(validateChoice(catalog, { providerId: "acp-opencode", model: "deepseek/v4" })).toMatchObject({ ok: false, code: "model_unavailable" });
    expect(validateChoice(catalog, { providerId: "router9", model: "x" })).toMatchObject({ ok: false, code: "provider_unavailable" });
    expect(validateChoice(catalog, { providerId: "nope", model: "x" })).toMatchObject({ ok: false, code: "provider_unknown" });
    expect(validateChoice(catalog, { providerId: "codex", model: "gpt-9" })).toMatchObject({ ok: false, code: "model_unknown" });
    expect(validateChoice(catalog, { providerId: "codex", model: "gpt-6-luna", effort: "max" })).toMatchObject({ ok: false, code: "effort_unsupported" });
    expect(validateChoice(catalog, { providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", serviceTier: "fast" })).toMatchObject({ ok: false, code: "tier_unsupported" });
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
