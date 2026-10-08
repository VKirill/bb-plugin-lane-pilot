import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentRequest, withResolvedModel, type HelperRequest } from "../../src/server/workflow-agent";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_REASONING, modelOverrideKey, resolveAgentModel } from "../../src/server/workflow-agent-model";
import { resolveStepExecutors, DELEGATED_ACTIONS } from "../../src/server/workflow-step-executors";
import { validateSettingValue, validateSettingsObject } from "../../src/setting-validation";
import { VISIBLE_CATALOG } from "../../src/ui-catalog";
import { BUILTIN_PRESETS, PRESET_FIELDS, PRESET_SLUGS, presetKey, presetSelection, presetSlug } from "@lane-pilot/models";
import type { StepContext } from "../../src/workflow/engine";
import type { GraphNode } from "../../src/workflow/schema";
import { loadWorkflow, parseWorkflow } from "../../src/workflow/validate";
import { workflow } from "./fixtures";

const pm = { providerId: "codex", model: "gpt-6-luna" };
const pick = (role: string, node: Record<string, string> = {}, settings: Record<string, unknown> = {}, pair: typeof pm | null = null) =>
  resolveAgentModel({ role, node, settings, pm: pair });

describe("which model a workflow agent step runs on", () => {
  it("falls back to the PM chat's model, and to the built-in default only when the PM is unknown", () => {
    expect(pick("analyst", {}, {}, pm)).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoningEffort: DEFAULT_REASONING, source: "pm", sourceKey: null, inherited: true, issues: [] });
    expect(pick("analyst")).toMatchObject({ providerId: DEFAULT_PROVIDER, model: DEFAULT_MODEL, reasoningEffort: DEFAULT_REASONING, source: "role-default" });
  });

  it("takes the generic workflow.agent selection before the PM, with its own effort", () => {
    const settings = { "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-sonnet-5-5", "workflow.agent.reasoning_effort": "medium" };
    expect(pick("worker", {}, settings, pm)).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningEffort: "medium", source: "agent", sourceKey: "workflow.agent.model" });
    // Without an effort of its own the step runs on the default effort.
    expect(pick("worker", {}, { ...settings, "workflow.agent.reasoning_effort": "" }, pm).reasoningEffort).toBe(DEFAULT_REASONING);
  });

  it("takes the role's stage selection before the generic one", () => {
    const settings = {
      "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-sonnet-5-5",
      "pm_read.provider": "acp-opencode", "pm_read.model": "zai/glm-5.3-flash", "pm_read.reasoning_effort": "high",
      "plan_critique.provider": "codex", "plan_critique.model": "gpt-6-sol",
      "code_critique.provider": "codex", "code_critique.model": "gpt-6-terra",
      "night_review.provider": "claude-code", "night_review.model": "claude-opus-5",
      "specialist.provider": "claude-code", "specialist.model": "claude-opus-4-8",
    };
    expect(pick("analyst", {}, settings, pm)).toMatchObject({ providerId: "acp-opencode", model: "zai/glm-5.3-flash", reasoningEffort: "high", source: "stage", sourceKey: "pm_read.model" });
    expect(pick("pm-reader", {}, settings).model).toBe("zai/glm-5.3-flash");
    expect(pick("planner", {}, settings)).toMatchObject({ model: "gpt-6-sol", reasoningEffort: "medium", source: "stage", sourceKey: "plan_critique.model" });
    expect(pick("auditor", {}, settings)).toMatchObject({ model: "gpt-6-terra", sourceKey: "code_critique.model" });
    // The auditor goes on to the night review when the code critique is not set.
    expect(pick("auditor", {}, { ...settings, "code_critique.model": "" }).model).toBe("claude-opus-5");
    expect(pick("specialist:seo", {}, settings).model).toBe("claude-opus-4-8");
    // A role with no stage (a worker, the errand helper) goes straight to the generic selection.
    expect(pick("worker", {}, settings)).toMatchObject({ model: "claude-sonnet-5-5", source: "agent" });
    expect(pick("errand", {}, settings)).toMatchObject({ source: "agent" });
  });

  it("gives the debugger its own selection before the specialist's", () => {
    const settings = { "specialist.provider": "claude-code", "specialist.model": "claude-opus-4-8", "workflow.debugger.provider": "codex", "workflow.debugger.model": "gpt-6-sol", "workflow.debugger.reasoning_effort": "xhigh" };
    expect(pick("debugger", {}, settings)).toMatchObject({ providerId: "codex", model: "gpt-6-sol", reasoningEffort: "xhigh", source: "stage", sourceKey: "workflow.debugger.model" });
    expect(pick("debugger", {}, { "specialist.provider": "claude-code", "specialist.model": "claude-opus-4-8" }).model).toBe("claude-opus-4-8");
  });

  it("takes the node's preset before the role's stage selection and the generic one", () => {
    const settings = { "pm_read.provider": "acp-opencode", "pm_read.model": "zai/glm-5.3-flash", "workflow.agent.provider": "codex", "workflow.agent.model": "gpt-6-sol" };
    expect(pick("analyst", { model_preset: "strong" }, settings, pm)).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", source: "preset", sourceKey: "strong", issues: [] });
  });

  it("lets the node's own fields override the level below, field by field", () => {
    const settings = { "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-sonnet-5-5", "workflow.agent.reasoning_effort": "medium" };
    expect(pick("worker", { provider: "codex", model: "gpt-6-sol", reasoning: "max" }, settings, pm)).toMatchObject({ providerId: "codex", model: "gpt-6-sol", reasoningEffort: "max", source: "node", sourceKey: null, inherited: false });
    // Only the effort is the node's: the model comes from the level below.
    expect(pick("worker", { reasoning: "low" }, settings, pm)).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningEffort: "low", source: "node" });
    expect(pick("analyst", { model_preset: "cheap-fast", reasoning: "high" }, {}, pm)).toMatchObject({ model: BUILTIN_PRESETS["cheap-fast"]!.model, reasoningEffort: "high", source: "node" });
    expect(pick("analyst", { provider: "codex" }, {}, pm).issues).toEqual(["provider_without_model"]);
  });

  it("carries the node's fast mode to the spawn and counts it as the node's own choice", () => {
    expect(pick("worker", { service_tier: "fast" }, {}, pm)).toMatchObject({ providerId: "codex", model: "gpt-6-luna", serviceTier: "fast", source: "node", inherited: false });
    expect(pick("worker", {}, {}, pm)).toMatchObject({ serviceTier: null, inherited: true });
    expect(pick("worker", { service_tier: "turbo" }, {}, pm).serviceTier).toBeNull();
  });

  it("flags a half-set selection and skips it", () => {
    expect(pick("worker", {}, { "workflow.agent.provider": "codex" }, pm)).toMatchObject({ source: "pm", issues: ["incomplete_selection"] });
    expect(pick("analyst", {}, { "pm_read.model": "x" }, pm)).toMatchObject({ source: "pm", issues: ["incomplete_selection"] });
  });
});

describe("model presets", () => {
  it("are named settings with built-in defaults; settings win, a pair first", () => {
    expect(pick("analyst", { model_preset: "cheap-fast" })).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", reasoningEffort: "low", source: "preset", sourceKey: "cheap-fast" });
    expect(pick("analyst", { model_preset: "strong" })).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "high" });
    const settings = { [presetKey("strong", "provider")]: "codex", [presetKey("strong", "model")]: "gpt-6-sol", [presetKey("strong", "reasoning_effort")]: "xhigh" };
    expect(pick("analyst", { model_preset: "strong" }, settings)).toMatchObject({ providerId: "codex", model: "gpt-6-sol", reasoningEffort: "xhigh" });
    // A model without its provider is not a pair: the built-in pair stays, only the effort is taken.
    expect(presetSelection("strong", { [presetKey("strong", "model")]: "gpt-6-sol", [presetKey("strong", "reasoning_effort")]: "low" })).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoning: "low" });
  });

  it("know the long names the Insights chain uses", () => {
    const names: Array<[string, string]> = [
      ["INS - анализ (Claude Opus 5)", "ins-analysis"], ["INS - психология (GPT-5.6 Luna)", "ins-psychology"], ["INS - проверка (Grok 4.6)", "ins-check"], ["INS - сводка (Claude Sonnet 5)", "ins-digest"],
      ["INS — анализ", "ins-analysis"], ["ins - сводка", "ins-digest"], ["cheap-fast", "cheap-fast"], ["strong", "strong"],
    ];
    for (const [name, slug] of names) expect(presetSlug(name)).toBe(slug);
    expect(pick("analyst", { model_preset: "INS - психология (GPT-5.6 Luna)" })).toMatchObject({ providerId: "codex", model: "gpt-5.6-luna", reasoningEffort: "max", sourceKey: "INS - психология (GPT-5.6 Luna)" });
  });

  it("are flagged when unknown, and the step goes on to the next level instead of a hidden default", () => {
    expect(presetSlug("fast-ish")).toBeNull();
    expect(pick("analyst", { model_preset: "fast-ish" }, {}, pm)).toMatchObject({ source: "pm", model: "gpt-6-luna", issues: ["unknown_preset"] });
    const found = loadWorkflow(workflow({
      nodes: [{ id: "a", type: "agent", role: "analyst", model_preset: "fast-ish", prompt: "x", output: [{ name: "o", type: "string" }] }],
      edges: [{ from: "start", to: "a" }, { from: "a", to: "end" }],
    }));
    const warnings = found.ok ? found.warnings : found.problems;
    expect(warnings.filter((problem) => problem.code === "unknown_preset")).toEqual([expect.objectContaining({ level: "warning", node: "a" })]);
  });

  it("are all known to the shipped chains: no chain names a preset that does not exist", () => {
    const dir = new URL("../../workflows/", import.meta.url);
    const named: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") {
          const row = value as Record<string, unknown>;
          if (typeof row.model_preset === "string") named.push(`${file}:${row.model_preset}`);
          Object.values(row).forEach(walk);
        }
      };
      walk(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
    }
    expect(named.length).toBeGreaterThan(8);
    expect(named.filter((entry) => !presetSlug(entry.slice(entry.indexOf(":") + 1)))).toEqual([]);
  });

  it("have a settings row for each field, with the built-in default shown", () => {
    for (const slug of PRESET_SLUGS) {
      for (const field of PRESET_FIELDS) {
        const row = VISIBLE_CATALOG.find((item) => item.storageKey === presetKey(slug, field));
        expect(row, presetKey(slug, field)).toMatchObject({ uiStatus: "editable" });
      }
      const builtin = BUILTIN_PRESETS[slug]!;
      expect(VISIBLE_CATALOG.find((item) => item.storageKey === presetKey(slug, "model"))!.defaultValue).toBe(builtin.model);
    }
    for (const prefix of ["workflow.agent", "workflow.debugger"]) for (const field of PRESET_FIELDS) expect(VISIBLE_CATALOG.some((item) => item.storageKey === `${prefix}.${field}`)).toBe(true);
  });
});

describe("validating the workflow model settings", () => {
  it("accepts the efforts a node may name and nothing else", () => {
    for (const key of ["workflow.agent.reasoning_effort", "workflow.debugger.reasoning_effort", presetKey("strong", "reasoning_effort"), presetKey("ins-check", "reasoning_effort")]) {
      for (const value of ["low", "medium", "high", "xhigh", "max", ""]) expect(validateSettingValue(key, value)).toBeNull();
      expect(validateSettingValue(key, "ultra")).toMatchObject({ code: "invalid_choice", key });
      expect(validateSettingsObject({ [key]: "turbo" })).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------- resolver == executor

const rtFor = (settings: Record<string, unknown>, pair: typeof pm | null) => ({
  pmThreadId: "pm-thread", projectId: "p", runId: "r",
  ctx: {
    db: { prepare: () => ({ get: () => undefined }) },
    effectiveProjectSettings: async () => ({ values: settings }),
    bb: { sdk: { threads: { defaultExecutionOptions: async () => (pair ? { providerId: pair.providerId, model: pair.model } : {}) } } },
  },
  services: {},
});

const requestFor = (flow: ReturnType<typeof parseWorkflow>, node: Extract<GraphNode, { type: "agent" }>, rt: ReturnType<typeof rtFor>): HelperRequest => {
  const ctx = {
    runtime: rt, workflow: flow, node, nodeId: node.id, runId: "wfrun", stepKey: `${node.id}#1`, spawnKey: "k", mode: "standard", signal: new AbortController().signal,
    input: { with: {}, via: { mode: "artifact", fromStep: null } }, goals: [], reground: false, render: (text: string) => text, template: (value: unknown) => value,
  } as unknown as StepContext<never>;
  return agentRequest(ctx as never, node);
};

const SETTINGS: Array<[string, Record<string, unknown>]> = [
  ["empty", {}],
  ["generic", { "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-sonnet-5-5", "workflow.agent.reasoning_effort": "medium" }],
  ["stages", { "pm_read.provider": "acp-opencode", "pm_read.model": "zai/glm-5.3-flash", "plan_critique.provider": "codex", "plan_critique.model": "gpt-6-sol", "code_critique.provider": "codex", "code_critique.model": "gpt-6-terra", "workflow.debugger.provider": "codex", "workflow.debugger.model": "gpt-6-sol" }],
  ["presets", { [presetKey("strong", "provider")]: "codex", [presetKey("strong", "model")]: "gpt-6-sol", [presetKey("cheap-fast", "reasoning_effort")]: "medium", [presetKey("ins-check", "provider")]: "claude-code", [presetKey("ins-check", "model")]: "claude-opus-5" }],
];

describe("the Models view says what the executor spawns", () => {
  const dir = new URL("../../workflows/", import.meta.url);
  const flows = readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((file) => {
    try { return [{ file, flow: parseWorkflow(JSON.parse(readFileSync(new URL(file, dir), "utf8"))) }]; } catch { return []; }
  });

  it("reads the shipped chains", () => {
    expect(flows.length).toBeGreaterThan(30);
  });

  it("for every agent step and every errand action of every shipped chain, under every kind of settings and with the PM known or not", async () => {
    let compared = 0;
    for (const { file, flow } of flows) {
      const steps: Array<{ node: Record<string, unknown>; id: string }> = [];
      for (const node of flow.nodes) {
        steps.push({ node: node as Record<string, unknown>, id: node.id });
        const child = (node as { child?: Record<string, unknown> }).child;
        if (node.type === "parallel" && child) steps.push({ node: child, id: `${node.id}:child` });
      }
      for (const [label, settings] of SETTINGS) {
        for (const pair of [pm, null]) {
          const rt = rtFor(settings, pair);
          for (const step of steps) {
            const node = step.node as Record<string, unknown>;
            const key = String(node.uses ?? node.action ?? "");
            let request: HelperRequest | null = null;
            if (node.type === "agent" && !String(node.uses ?? "").startsWith("lp.")) request = requestFor(flow, node as unknown as Extract<GraphNode, { type: "agent" }>, rt);
            else if (node.type === "action" && (DELEGATED_ACTIONS as readonly string[]).includes(key)) {
              request = { rt, workflowRunId: "r", stepKey: "s", nodeId: step.id, spawnKey: "k", role: "errand", title: "t", prompt: "", fields: [], ...(node.model_preset ? { preset: String(node.model_preset) } : {}) } as unknown as HelperRequest;
            }
            if (!request) continue;
            const spawned = await withResolvedModel(request);
            const shown = resolveStepExecutors({ nodes: [{ ...node, id: "x" }], settings, pm: pair })[0]!;
            expect({ file, label, node: step.id, provider: shown.providerId, model: shown.model, effort: shown.reasoningEffort })
              .toEqual({ file, label, node: step.id, provider: spawned.provider, model: spawned.model, effort: spawned.reasoning });
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(100);
  });
});

describe("the owner's model override of one step", () => {
  const at = { workflowId: "lp.plan", nodeId: "plan" };
  const key = modelOverrideKey("lp.plan", "plan");
  const overrideRow = { provider: "codex", model: "gpt-6-sol", reasoning_effort: "low", service_tier: "fast" };
  const pickAt = (node: Record<string, string>, settings: Record<string, unknown>, where: typeof at | null = at) =>
    resolveAgentModel({ role: "planner", node, settings, pm, ...(where ? { at: where } : {}) });

  it("beats the node's fields, its preset, the role's stage, the generic selection and the PM, and names its key", () => {
    const settings = { [key]: overrideRow, "plan_critique.provider": "acp-opencode", "plan_critique.model": "zai/glm-5.3-flash", "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-sonnet-5-5" };
    expect(pickAt({ provider: "claude-code", model: "claude-opus-5", model_preset: "strong" }, settings)).toMatchObject({
      providerId: "codex", model: "gpt-6-sol", reasoningEffort: "low", serviceTier: "fast", source: "override", sourceKey: key, inherited: false, issues: [],
    });
  });

  it("applies only to its own workflow and node, and only when it is a complete pair", () => {
    const settings = { [key]: overrideRow };
    expect(pickAt({}, settings, { workflowId: "lp.plan", nodeId: "other" }).source).toBe("pm");
    expect(pickAt({}, settings, { workflowId: "other", nodeId: "plan" }).source).toBe("pm");
    expect(pickAt({}, settings, null).source).toBe("pm");
    expect(pickAt({}, { [key]: { provider: "codex" } }).source).toBe("pm");
    expect(pickAt({}, { [key]: "codex" }).source).toBe("pm");
  });

  it("keeps the level below's effort when the override names none, and the default tier otherwise", () => {
    const settings = { [key]: { provider: "codex", model: "gpt-6-sol" }, "plan_critique.provider": "codex", "plan_critique.model": "gpt-6-luna", "plan_critique.reasoning_effort": "high" };
    expect(pickAt({}, settings)).toMatchObject({ model: "gpt-6-sol", reasoningEffort: "high", serviceTier: null, source: "override" });
  });

  it("is what the executor spawns and what the Models view shows, for every shipped agent step and errand action", async () => {
    const dir = new URL("../../workflows/", import.meta.url);
    let compared = 0;
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      let flow: ReturnType<typeof parseWorkflow>;
      try { flow = parseWorkflow(JSON.parse(readFileSync(new URL(file, dir), "utf8"))); } catch { continue; }
      const settings: Record<string, unknown> = {};
      for (const node of flow.nodes) {
        settings[modelOverrideKey(flow.id, node.id)] = { provider: "codex", model: "gpt-6-sol", reasoning_effort: "medium", service_tier: "fast" };
        const child = (node as { child?: unknown }).child;
        if (node.type === "parallel" && child) settings[modelOverrideKey(flow.id, `${node.id}:child`)] = { provider: "codex", model: "gpt-6-sol", reasoning_effort: "medium", service_tier: "fast" };
      }
      const rt = rtFor(settings, pm);
      const shown = new Map(resolveStepExecutors({ nodes: flow.nodes, settings, pm, workflowId: flow.id, ownKeys: new Set() }).map((row) => [row.nodeId, row]));
      for (const node of flow.nodes) {
        const key = String((node as { uses?: string }).uses ?? (node as { action?: string }).action ?? "");
        let request: HelperRequest | null = null;
        if (node.type === "agent" && !String((node as { uses?: string }).uses ?? "").startsWith("lp.")) request = requestFor(flow, node as Extract<GraphNode, { type: "agent" }>, rt);
        else if (node.type === "action" && (DELEGATED_ACTIONS as readonly string[]).includes(key)) {
          request = { rt, workflowRunId: "r", workflowId: flow.id, stepKey: "s", nodeId: node.id, spawnKey: "k", role: "errand", title: "t", prompt: "", fields: [] } as unknown as HelperRequest;
        }
        if (!request) continue;
        const spawned = await withResolvedModel(request);
        const row = shown.get(node.id)!;
        expect({ file, node: node.id, provider: row.providerId, model: row.model, effort: row.reasoningEffort, tier: row.serviceTier, scope: row.overrideScope })
          .toEqual({ file, node: node.id, provider: spawned.provider, model: spawned.model, effort: spawned.reasoning, tier: spawned.serviceTier ?? null, scope: "global" });
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(40);
  });

  it("is told apart in the view: the project's own row is «project», one inherited from all projects is «global»", () => {
    const settings = { [key]: overrideRow };
    const nodes = [{ id: "plan", type: "agent", role: "planner" }, { id: "lint", type: "action", action: "lp.lint" }];
    const view = (ownKeys: string[]) => resolveStepExecutors({ nodes, settings, pm, workflowId: "lp.plan", ownKeys: new Set(ownKeys) });
    expect(view([key])[0]).toMatchObject({ source: "override", sourceKey: key, canOverride: true, overrideScope: "project" });
    expect(view([])[0]).toMatchObject({ source: "override", overrideScope: "global" });
    // Without a workflow id (a draft of a new workflow) nothing applies; a step with no model cannot be overridden.
    expect(resolveStepExecutors({ nodes, settings, pm })[0]).toMatchObject({ source: "pm", canOverride: false, overrideScope: null });
    expect(view([key])[1]).toMatchObject({ mode: "none", canOverride: false });
  });

  it("is validated as a setting", () => {
    expect(validateSettingValue(key, overrideRow)).toBeNull();
    expect(validateSettingValue(key, { provider: "codex", model: "x" })).toBeNull();
    for (const bad of [{ provider: "codex" }, "codex", { provider: "codex", model: "x", reasoning_effort: "ultra" }, { provider: "codex", model: "x", service_tier: "turbo" }]) {
      expect(validateSettingValue(key, bad)).toMatchObject({ code: "invalid_choice", key });
    }
  });
});
