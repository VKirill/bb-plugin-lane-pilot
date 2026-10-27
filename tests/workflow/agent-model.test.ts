import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { agentRequest, withResolvedModel, type HelperRequest } from "../../src/rooms/workflow/server/workflow-agent";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_REASONING, ROLE_LEAST_TIER, resolveAgentModel } from "../../src/rooms/workflow/server/workflow-agent-model";
import { resolveStepExecutors, DELEGATED_ACTIONS } from "../../src/rooms/workflow/server/workflow-step-executors";
import { validateSettingValue, validateSettingsObject } from "../../src/rooms/settings/setting-validation";
import { VISIBLE_CATALOG } from "@lane-pilot/settings-catalog";
import { BUILTIN_PRESETS, PRESET_FIELDS, PRESET_SLUGS, ROLE_IDS, presetKey, presetSelection, presetSlug, roleModelKey } from "@lane-pilot/models";
import type { StepContext } from "@lane-pilot/workflow-engine";
import type { GraphNode } from "@lane-pilot/workflow-engine";
import { loadWorkflow, parseWorkflow } from "@lane-pilot/workflow-engine";
import { workflow } from "./fixtures";

const pm = { providerId: "codex", model: "gpt-6-luna" };
const strongPm = { providerId: "claude-code", model: "claude-opus-5-5" };
const pick = (role: string, settings: Record<string, unknown> = {}, pair: typeof pm | null = null, extra: Partial<Parameters<typeof resolveAgentModel>[0]> = {}) =>
  resolveAgentModel({ role, settings, pm: pair, ...extra });
const row = (model: string, reasoning_effort?: string) => ({ model, ...(reasoning_effort ? { reasoning_effort } : {}) });

describe("which model a workflow agent step runs on: the role's row of one table", () => {
  it("authors run on Claude Opus 5.5 high, judges on GPT-6.1 Sol high, cheap jobs on the small models, whatever the PM chat runs", () => {
    for (const role of ["analyst", "planner", "workflow-architect", "specialist:design-lead", "specialist:seo-specialist", "specialist:my-own-agent"]) {
      expect(pick(role, {}, pm), role).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", source: "role-default", sourceKey: null, issues: [] });
    }
    for (const role of ["plan-critic", "specialist-reviewer", "code-critic", "auditor", "debugger", "council"]) {
      expect(pick(role, {}, strongPm), role).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", reasoningEffort: "high", source: "role-default" });
    }
    expect(pick("pm-reader")).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", reasoningEffort: "low" });
    expect(pick("triager")).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoningEffort: "high" });
    expect(pick("memory")).toMatchObject({ model: "claude-haiku-5-5", reasoningEffort: "medium" });
    expect(pick("project-life")).toMatchObject({ model: "claude-haiku-5-5", reasoningEffort: "medium" });
    expect(pick("errand")).toMatchObject({ model: "claude-sonnet-5-5", reasoningEffort: "medium" });
    expect(pick("browser-qa")).toMatchObject({ model: "claude-sonnet-5-5", reasoningEffort: "medium" });
  });

  it("answers for every role of the shipped graphs; an unknown role is the analyst's, the same as roleSpec reads it", () => {
    const dir = new URL("../../workflows/", import.meta.url);
    const roles = new Set<string>();
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") {
          const found = value as Record<string, unknown>;
          if (found.type === "agent" && typeof found.role === "string" && !found.role.includes("{{")) roles.add(found.role);
          Object.values(found).forEach(walk);
        }
      };
      walk(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
    }
    expect(roles.size).toBeGreaterThan(8);
    for (const role of roles) expect(pick(role).model, role).toMatch(/^(claude-(opus|sonnet|haiku)-5-5|gpt-6\.1-(sol|terra)|gpt-6-luna)$/);
    expect(pick("worker")).toEqual(pick("analyst"));
    expect(pick("something-new")).toEqual(pick("analyst"));
    expect(pick("gate-triage")).toEqual(pick("triager"));
    expect(pick("memory-maintainer")).toEqual(pick("memory"));
    expect(pick("council-seat")).toEqual(pick("council"));
    expect(ROLE_IDS).toContain("workflow-architect");
  });

  it("takes the owner's row of the table: its model, its effort, and says where it comes from", () => {
    const settings = { [roleModelKey("analyst")]: row("claude-sonnet-5-5", "medium"), [roleModelKey("code-critic")]: row("claude-opus-5-5") };
    expect(pick("analyst", settings, pm)).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningEffort: "medium", source: "table", sourceKey: "role_model.analyst", inherited: true, issues: [] });
    // No effort in the row: the role's own default effort.
    expect(pick("code-critic", settings)).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "high", source: "table" });
    // One row serves every specialist, in every graph.
    expect(pick("specialist:copy-lead", { [roleModelKey("specialist")]: row("gpt-6.1-terra", "low") })).toMatchObject({ providerId: "codex", model: "gpt-6.1-terra", reasoningEffort: "low", source: "table" });
    expect(pick("specialist:tavily", { [roleModelKey("specialist")]: row("gpt-6.1-terra", "low") }).model).toBe("gpt-6.1-terra");
  });

  it("ignores a row that is not a pick of the table: a model outside the six, a half-set value", () => {
    for (const bad of [row("zai/glm-5.3-flash"), row("claude-opus-4-8"), { model: "" }, "gpt-6.1-sol", { effort: "high" }, null]) {
      expect(pick("planner", { [roleModelKey("planner")]: bad }, pm), JSON.stringify(bad)).toMatchObject({ model: "claude-opus-5-5", source: "role-default" });
    }
    // An effort the table does not know is dropped; the model stays.
    expect(pick("analyst", { [roleModelKey("analyst")]: { model: "claude-haiku-5-5", reasoning_effort: "turbo" } })).toMatchObject({ model: "claude-haiku-5-5", reasoningEffort: "high", source: "table" });
  });

  it("maps a stage selection the owner set before the table into the role it served, and the table wins over it", () => {
    const settings = {
      "pm_read.provider": "acp-opencode", "pm_read.model": "zai/glm-5.3-flash", "pm_read.reasoning_effort": "high",
      "plan_critique.provider": "codex", "plan_critique.model": "gpt-6-sol",
      "code_critique.provider": "codex", "code_critique.model": "gpt-6.1-terra",
      "night_review.provider": "claude-code", "night_review.model": "claude-opus-5",
      "specialist.provider": "claude-code", "specialist.model": "claude-opus-4-8",
      "errand.provider": "claude-code", "errand.model": "claude-haiku-5-5",
    };
    expect(pick("pm-reader", settings)).toMatchObject({ providerId: "acp-opencode", model: "zai/glm-5.3-flash", reasoningEffort: "high", source: "stage", sourceKey: "pm_read.model" });
    expect(pick("plan-critic", settings)).toMatchObject({ model: "gpt-6-sol", reasoningEffort: "medium", source: "stage", sourceKey: "plan_critique.model" });
    expect(pick("code-critic", settings)).toMatchObject({ model: "gpt-6.1-terra", source: "stage", sourceKey: "code_critique.model" });
    expect(pick("specialist-reviewer", settings)).toMatchObject({ model: "claude-opus-4-8", source: "stage", sourceKey: "specialist.model" });
    expect(pick("specialist:seo", settings)).toMatchObject({ model: "claude-opus-4-8", source: "stage" });
    expect(pick("errand", settings)).toMatchObject({ model: "claude-haiku-5-5", source: "stage", sourceKey: "errand.model" });
    // The auditor goes on to the night review when the code critique is not set.
    expect(pick("auditor", { ...settings, "code_critique.model": "" }).model).toBe("claude-opus-5");
    // The analyst and the planner borrow no stage: a cheap model chosen to read files must not write the analysis or the plan.
    expect(pick("analyst", settings, pm)).toMatchObject({ model: "claude-opus-5-5", source: "role-default" });
    expect(pick("planner", settings, pm)).toMatchObject({ model: "claude-opus-5-5", source: "role-default" });
    // The owner's row in the table stands over the stage selection.
    expect(pick("plan-critic", { ...settings, [roleModelKey("plan-critic")]: row("claude-opus-5-5", "xhigh") })).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "xhigh", source: "table" });
    // A half-set stage selection is not a selection.
    expect(pick("pm-reader", { "pm_read.model": "x" })).toMatchObject({ model: "claude-haiku-5-5", source: "role-default" });
  });

  it("gives the debugger its own old selection before the specialist's", () => {
    const settings = { "specialist.provider": "claude-code", "specialist.model": "claude-opus-4-8", "workflow.debugger.provider": "codex", "workflow.debugger.model": "gpt-6.1-sol", "workflow.debugger.reasoning_effort": "xhigh" };
    expect(pick("debugger", settings)).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", reasoningEffort: "xhigh", source: "stage", sourceKey: "workflow.debugger.model" });
    expect(pick("debugger", { "specialist.provider": "claude-code", "specialist.model": "claude-opus-4-8" }).model).toBe("claude-opus-4-8");
  });

  it("no longer reads the removed levels: the generic workflow.agent.* selection, a per-step override, the presets", () => {
    const settings = {
      "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-sonnet-5-5", "workflow.agent.reasoning_effort": "low",
      "workflow.model_override.lp.plan/plan": { provider: "codex", model: "gpt-6-sol", reasoning_effort: "low", service_tier: "fast" },
      [presetKey("strong", "provider")]: "codex", [presetKey("strong", "model")]: "gpt-6-luna",
    };
    expect(pick("planner", settings, pm)).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "high", serviceTier: null, source: "role-default" });
    expect(pick("worker", settings, pm)).toMatchObject({ model: "claude-opus-5-5", source: "role-default" });
    // And a step cannot name its own: the resolver has no node to read.
    expect(Object.keys(pick("analyst"))).not.toContain("node");
  });
});

describe("a model the machine does not offer", () => {
  const only = (...ok: string[]) => (_provider: string, model: string) => ok.includes(model);

  it("is passed over for the role's default, then for the PM's model, and says so", () => {
    const settings = { [roleModelKey("plan-critic")]: row("claude-sonnet-5-5") };
    expect(pick("plan-critic", settings, pm, { offered: only("gpt-6.1-sol") })).toMatchObject({ model: "gpt-6.1-sol", source: "role-default", issues: ["selection_unavailable"] });
    expect(pick("plan-critic", settings, strongPm, { offered: only("claude-opus-5-5") })).toMatchObject({ model: "claude-opus-5-5", source: "pm", issues: ["selection_unavailable"] });
  });

  it("is kept and flagged when nothing known to run there is left, and a pinned model is kept at once: it is the owner's choice", () => {
    expect(pick("analyst", {}, null, { offered: () => false })).toMatchObject({ model: "claude-opus-5-5", issues: ["selection_unavailable", "model_unavailable_here"] });
    expect(pick("analyst", {}, null, { offered: () => null })).toMatchObject({ issues: [] });
    expect(pick("analyst", {}, pm, { offered: () => false, pinned: { model: "gpt-6-sol" } })).toMatchObject({ providerId: "codex", model: "gpt-6-sol", source: "pinned", issues: ["model_unavailable_here"] });
  });
});

describe("a model a run pins for itself (a scheduled agent, an agent the owner created)", () => {
  it("stands over the table for the fields it sets, and counts as the run's own choice", () => {
    expect(pick("specialist:mine", {}, pm, { pinned: { provider: "codex", model: "gpt-6-sol", reasoning: "max", service_tier: "fast" } }))
      .toMatchObject({ providerId: "codex", model: "gpt-6-sol", reasoningEffort: "max", serviceTier: "fast", source: "pinned", sourceKey: null, inherited: false });
    // A model with no provider runs on the provider that serves it (F4: a GPT model never goes to claude-code); with no effort, on the role's.
    expect(pick("analyst", {}, pm, { pinned: { model: "claude-sonnet-5-5" } })).toMatchObject({ providerId: DEFAULT_PROVIDER, model: "claude-sonnet-5-5", reasoningEffort: "high", source: "pinned" });
    // An effort alone changes the effort and keeps the table's model.
    expect(pick("analyst", {}, pm, { pinned: { reasoning: "low" } })).toMatchObject({ model: "claude-opus-5-5", reasoningEffort: "low", source: "role-default", inherited: false });
    expect(pick("analyst", {}, pm, { pinned: { service_tier: "turbo" } }).serviceTier).toBeNull();
  });

  it("is what withResolvedModel does with the scheduled agent's model and an owner-created agent's model", async () => {
    const rt = rtFor({}, strongPm);
    const base = { rt, workflowRunId: "r", stepKey: "s", nodeId: "n", spawnKey: "k", title: "t", prompt: "", fields: [] };
    const routine = await withResolvedModel({ ...base, role: "specialist:seo-specialist", model: "gpt-6-luna", reasoning: "low", serviceTier: "fast" } as unknown as HelperRequest);
    expect(routine).toMatchObject({ provider: "codex", model: "gpt-6-luna", reasoning: "low", serviceTier: "fast" });
    const plain = await withResolvedModel({ ...base, role: "specialist:seo-specialist" } as unknown as HelperRequest);
    expect(plain).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5", reasoning: "high" });
  });
});

describe("validating the table and the settings of the removed levels", () => {
  it("accepts a row of the table: one of the six models and an effort, or nothing", () => {
    for (const role of ROLE_IDS) {
      expect(validateSettingValue(roleModelKey(role), row("claude-opus-5-5", "high"))).toBeNull();
      expect(validateSettingValue(roleModelKey(role), row("gpt-6.1-sol"))).toBeNull();
      expect(validateSettingValue(roleModelKey(role), null)).toBeNull();
    }
    for (const bad of [row("zai/glm-5.3-flash"), row("claude-opus-5"), { model: "gpt-6.1-sol", reasoning_effort: "ultra" }, { model: "gpt-6.1-sol", provider: "codex" }, "gpt-6.1-sol", {}, []]) {
      expect(validateSettingValue(roleModelKey("analyst"), bad), JSON.stringify(bad)).toMatchObject({ code: "invalid_choice", key: roleModelKey("analyst") });
    }
    expect(validateSettingValue("role_model.nobody", row("gpt-6.1-sol"))).toMatchObject({ code: "invalid_choice" });
    expect(validateSettingsObject({ [roleModelKey("analyst")]: row("gpt-6.1-sol") })).toEqual([]);
  });

  it("keeps the efforts a debugger or preset selection may name, and has no row of the removed generic selection", () => {
    for (const key of ["workflow.debugger.reasoning_effort", presetKey("strong", "reasoning_effort"), presetKey("ins-check", "reasoning_effort")]) {
      for (const value of ["low", "medium", "high", "xhigh", "max", ""]) expect(validateSettingValue(key, value)).toBeNull();
      expect(validateSettingValue(key, "ultra")).toMatchObject({ code: "invalid_choice", key });
      expect(validateSettingsObject({ [key]: "turbo" })).toHaveLength(1);
    }
    for (const field of PRESET_FIELDS) {
      expect(VISIBLE_CATALOG.some((item) => item.storageKey === `workflow.agent.${field}`)).toBe(false);
      expect(VISIBLE_CATALOG.some((item) => item.storageKey === `workflow.debugger.${field}`)).toBe(true);
    }
  });
});

describe("model presets (now the scheduled errands' only)", () => {
  it("are named settings with built-in defaults; settings win, a pair first", () => {
    expect(presetSelection("cheap-fast", {})).toEqual({ providerId: "claude-code", model: "claude-haiku-5-5", reasoning: "low" });
    const settings = { [presetKey("strong", "provider")]: "codex", [presetKey("strong", "model")]: "gpt-6-sol", [presetKey("strong", "reasoning_effort")]: "xhigh" };
    expect(presetSelection("strong", settings)).toEqual({ providerId: "codex", model: "gpt-6-sol", reasoning: "xhigh" });
    expect(presetSelection("strong", { [presetKey("strong", "model")]: "gpt-6-sol", [presetKey("strong", "reasoning_effort")]: "low" })).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoning: "low" });
  });

  it("know the long names the Insights chain used", () => {
    const names: Array<[string, string]> = [
      ["INS - анализ (Claude Opus 5)", "ins-analysis"], ["INS - психология (GPT-5.6 Luna)", "ins-psychology"], ["INS - проверка (GPT-6.1 Sol)", "ins-check"], ["INS - сводка (Claude Sonnet 5)", "ins-digest"],
      ["INS — анализ", "ins-analysis"], ["ins - сводка", "ins-digest"], ["cheap-fast", "cheap-fast"], ["strong", "strong"],
    ];
    for (const [name, slug] of names) expect(presetSlug(name)).toBe(slug);
    expect(presetSlug("fast-ish")).toBeNull();
  });

  it("have a settings row for each field, with the built-in default shown", () => {
    for (const slug of PRESET_SLUGS) {
      for (const field of PRESET_FIELDS) expect(VISIBLE_CATALOG.find((item) => item.storageKey === presetKey(slug, field)), presetKey(slug, field)).toMatchObject({ uiStatus: "editable" });
      expect(VISIBLE_CATALOG.find((item) => item.storageKey === presetKey(slug, "model"))!.defaultValue).toBe(BUILTIN_PRESETS[slug]!.model);
    }
  });
});

describe("a node names no model", () => {
  const dir = new URL("../../workflows/", import.meta.url);
  const MODEL_FIELDS = ["provider", "model", "reasoning", "service_tier", "model_preset"];

  it("is true of every shipped graph: no node carries provider, model, reasoning, service_tier or model_preset", () => {
    const named: string[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".json"))) {
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === "object") {
          const found = value as Record<string, unknown>;
          if (typeof found.type === "string" && typeof found.id === "string") for (const field of MODEL_FIELDS) if (field in found) named.push(`${file}:${found.id}:${field}`);
          Object.values(found).forEach(walk);
        }
      };
      walk(JSON.parse(readFileSync(new URL(file, dir), "utf8")));
    }
    expect(named).toEqual([]);
  });

  it("is warned about when a file does name one (it loads, the field is ignored when the step runs)", () => {
    for (const field of MODEL_FIELDS) {
      const found = loadWorkflow(workflow({
        nodes: [{ id: "a", type: "agent", role: "analyst", prompt: "x", [field]: field === "reasoning" ? "high" : field === "service_tier" ? "fast" : "gpt-6.1-sol", output: [{ name: "o", type: "string" }] }],
        edges: [{ from: "start", to: "a" }, { from: "a", to: "end" }],
      }));
      const warnings = found.ok ? found.warnings : found.problems;
      expect(warnings.filter((problem) => problem.code === "model_ignored"), field).toEqual([expect.objectContaining({ level: "warning", node: "a", message: expect.stringContaining(field) })]);
    }
    const clean = loadWorkflow(workflow({
      nodes: [{ id: "a", type: "agent", role: "analyst", prompt: "x", output: [{ name: "o", type: "string" }] }],
      edges: [{ from: "start", to: "a" }, { from: "a", to: "end" }],
    }));
    expect((clean.ok ? clean.warnings : clean.problems).some((problem) => problem.code === "model_ignored")).toBe(false);
  });

  it("changes nothing in the request or in what the Models view shows", async () => {
    const flow = parseWorkflow(workflow({
      nodes: [{ id: "a", type: "agent", role: "analyst", prompt: "x", provider: "codex", model: "gpt-6-luna", reasoning: "low", service_tier: "fast", model_preset: "cheap-fast", output: [{ name: "o", type: "string" }] }],
      edges: [{ from: "start", to: "a" }, { from: "a", to: "end", with: { result: "a.o" } }],
    }));
    const rt = rtFor({}, pm);
    const node = flow.nodes.find((candidate) => candidate.id === "a") as Extract<GraphNode, { type: "agent" }>;
    const request = requestFor(flow, node, rt);
    expect(request).not.toHaveProperty("model");
    expect(request).not.toHaveProperty("preset");
    const spawned = await withResolvedModel(request);
    expect(spawned).toMatchObject({ provider: "claude-code", model: "claude-opus-5-5", reasoning: "high" });
    expect(resolveStepExecutors({ nodes: [{ ...node }], settings: {}, pm })[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", source: "role-default" });
  });
});

describe("the Models view shows the move a nearly spent provider causes", () => {
  const spent = (providerId: string) => (providerId === "claude-code" ? { percent: 93, window: "weekly" } : null);
  it("an agent node and a pipeline stage read the cached usage the executor reads; unknown usage shows the table's pick", () => {
    const nodes = [{ id: "a", type: "agent", role: "analyst" }, { id: "b", type: "agent", role: "pm-reader", uses: "lp.pm-read" }, { id: "c", type: "agent", role: "plan-critic" }];
    const shown = resolveStepExecutors({ nodes, settings: {}, pm, spent });
    expect(shown[0]).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol", issues: ["usage_moved: claude-code weekly 93% → codex/gpt-6.1-sol"] });
    expect(shown[1]).toMatchObject({ providerId: "codex", model: "gpt-6-luna", issues: ["usage_moved: claude-code weekly 93% → codex/gpt-6-luna"] });
    // The PM (the plan's author here) is a GPT model, so the critic crossed to Opus; Opus is spent, and the limit puts it back in the author's family.
    expect(shown[2]).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol" });
    expect(shown[2]!.issues).toEqual(["crossed_family", "same_family_judge_by_limit", "usage_moved: claude-code weekly 93% → codex/gpt-6.1-sol"]);
    expect(resolveStepExecutors({ nodes, settings: {}, pm })[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", issues: [] });
  });
});

// ---------------------------------------------------------------- resolver == executor

const rtFor = (settings: Record<string, unknown>, pair: typeof pm | null) => ({
  pmThreadId: "pm-thread", projectId: "p", runId: "r",
  ctx: {
    db: { prepare: () => ({ get: () => undefined }) },
    effectiveProjectSettings: async () => ({ values: settings }),
    ownedAgents: async () => ({}),
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
  ["table", { [roleModelKey("analyst")]: row("claude-sonnet-5-5", "low"), [roleModelKey("errand")]: row("gpt-6.1-terra"), [roleModelKey("specialist")]: row("gpt-6-luna", "max"), [roleModelKey("plan-critic")]: row("claude-opus-5-5") }],
  ["stages", { "pm_read.provider": "acp-opencode", "pm_read.model": "zai/glm-5.3-flash", "plan_critique.provider": "codex", "plan_critique.model": "gpt-6-sol", "code_critique.provider": "codex", "code_critique.model": "gpt-6.1-terra", "workflow.debugger.provider": "codex", "workflow.debugger.model": "gpt-6-sol", "errand.provider": "claude-code", "errand.model": "claude-sonnet-5-5" }],
  ["removed", { "workflow.agent.provider": "claude-code", "workflow.agent.model": "claude-haiku-5-5", "workflow.model_override.lp.plan/plan": { provider: "codex", model: "gpt-6-luna" }, [presetKey("strong", "model")]: "gpt-6-luna" }],
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
              request = { rt, workflowRunId: "r", stepKey: "s", nodeId: step.id, spawnKey: "k", role: "errand", title: "t", prompt: "", fields: [] } as unknown as HelperRequest;
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

describe("a deciding role", () => {
  // The hub's settings of 2026-10-25: the cheap stages are on Haiku 5.5.
  const hub = { "pm_read.provider": "claude-code", "pm_read.model": "claude-haiku-5-5", "plan_critique.provider": "claude-code", "plan_critique.model": "claude-haiku-5-5",
    "night_review.provider": "claude-code", "night_review.model": "claude-haiku-5-5", "code_critique.provider": "codex", "code_critique.model": "gpt-6-sol",
    "specialist.provider": "claude-code", "specialist.model": "claude-haiku-5-5" };

  it("never plans or audits on a light model it inherits, and the plan's critic is another model than its planner", () => {
    expect(ROLE_LEAST_TIER).toEqual({ planner: "strong", "code-critic": "standard", auditor: "standard", debugger: "standard" });
    for (const lightPm of [pm, { providerId: "claude-code", model: "claude-haiku-5-5" }]) {
      const planner = pick("planner", hub, lightPm);
      expect(planner).toMatchObject({ model: "claude-opus-5-5" });
      expect(pick("auditor", { ...hub, "code_critique.provider": "", "code_critique.model": "" }, lightPm)).toMatchObject({ model: "gpt-6.1-sol", issues: ["escalated_for_role"] });
      expect(pick("debugger", hub, lightPm).model).not.toMatch(/haiku|luna/);
      const critic = pick("plan-critic", hub, lightPm);
      expect(critic.model).not.toBe(planner.model);
    }
  });

  it("keeps a light model the owner picks in the table, and says so", () => {
    expect(pick("planner", { [roleModelKey("planner")]: row("claude-haiku-5-5") }, strongPm)).toMatchObject({ model: "claude-haiku-5-5", source: "table", issues: ["light_model_for_role"] });
    expect(pick("code-critic", { [roleModelKey("code-critic")]: row("gpt-6-luna") })).toMatchObject({ model: "gpt-6-luna", issues: ["light_model_for_role"] });
    // A role with no minimum does not mind.
    expect(pick("memory", { [roleModelKey("memory")]: row("gpt-6-luna") }).issues).toEqual([]);
  });

  it("tiers the models the team uses", async () => {
    const { modelTier } = await import("@lane-pilot/models");
    expect(["claude-haiku-5-5", "gpt-6-luna", "zai-coding-plan/glm-5.3-flash", "router9/ag/gemini-3.8-flash-low"].map(modelTier)).toEqual(["light", "light", "light", "light"]);
    expect(["claude-sonnet-5-5", "router9/ag/gemini-3.8-flash-high", "composer-2.5", "gpt-5.6-sol", "gpt-6.1-terra"].map(modelTier)).toEqual(["standard", "standard", "standard", "standard", "standard"]);
    expect(["claude-opus-5-5", "gpt-6-sol", "gpt-6.1-sol", "openlux/gemini-4-argon", "openrouter/~google/gemini-pro-latest"].map(modelTier)).toEqual(["strong", "strong", "strong", "strong", "strong"]);
  });

  it("keeps the built-in constants the provider-limit fallback runs on", () => {
    expect([DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_REASONING]).toEqual(["claude-code", "claude-opus-5-5", "high"]);
  });
});

describe("the Models view is read-only", () => {
  const nodes = [{ id: "plan", type: "agent", role: "planner" }, { id: "lint", type: "action", action: "lp.lint" }];

  it("shows the role's row for each step and names the setting that decides it; a step with no model has none", () => {
    const view = resolveStepExecutors({ nodes, settings: { [roleModelKey("planner")]: row("claude-sonnet-5-5") }, pm: strongPm });
    expect(view[0]).toMatchObject({ nodeId: "plan", model: "claude-sonnet-5-5", source: "table", sourceKey: "role_model.planner", settingsKey: "role_model.planner" });
    expect(view[0]).not.toHaveProperty("overridable");
    expect(view[0]).not.toHaveProperty("canOverride");
    expect(view[0]).not.toHaveProperty("overrideScope");
    expect(view[1]).toMatchObject({ mode: "none", model: null, settingsKey: null });
  });

  it("does not move a step on a removed per-step override setting", () => {
    const settings = { "workflow.model_override.lp.plan/plan": { provider: "codex", model: "gpt-6-sol" } };
    expect(resolveStepExecutors({ nodes, settings, pm: strongPm, workflowId: "lp.plan" })[0]).toMatchObject({ model: "claude-opus-5-5", source: "role-default" });
  });
});
