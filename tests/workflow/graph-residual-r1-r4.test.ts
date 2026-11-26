import { describe, expect, it } from "vitest";
import type { NodeExecutor, StepContext, Workflow, WorkflowStore } from "@lane-pilot/workflow-engine";
import {
  checkOutput,
  loadWorkflowStore,
  outputFields,
  parseWorkflow,
  registerReducers,
} from "@lane-pilot/workflow-engine";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { stepPacket } from "../../src/rooms/workflow/server/services/workflow-agent-packet";
import { engineOn, journalDb } from "./engine-helpers";

type Call = { with: Record<string, unknown>; packet: string };
type Calls = Record<string, Call[]>;

const storeOf = (): Promise<WorkflowStore> => loadWorkflowStore({ builtin: BUILTIN_SOURCES });

const valueFor = (field: { name: string; type: string; values?: string[] }): unknown => {
  if (field.name === "handoff") return "stub handoff";
  if (field.type === "string") return `${field.name}-value`;
  if (field.type === "number") return 1;
  if (field.type === "boolean") return true;
  if (field.type === "enum") return field.values?.[0] ?? "done";
  if (field.type === "object") return {};
  return [];
};

const child = (id: string, inputs: string[], outputs: Array<{ name: string; type: string; values?: string[] }>): Workflow => parseWorkflow({
  id,
  name: id,
  description: { en: id, ru: id },
  inputs: inputs.map((name) => ({ name, type: "any" })),
  outputs,
  nodes: [{
    id: "do",
    type: "agent",
    role: "analyst",
    prompt: "stub",
    with: Object.fromEntries(inputs.map((name) => [name, `{{$inputs.${name}}}`])),
    out: outputs,
  }],
  edges: [
    { from: "start", to: "do" },
    { from: "do", to: "end", with: Object.fromEntries(outputs.map(({ name }) => [name, "do." + name])) },
  ],
});

const issueChildren: Record<string, Workflow> = {
  "lp.plan": child("lp.plan", ["goal", "findings", "mode", "gaps", "boundary"], [
    { name: "status", type: "enum", values: ["ok", "low_confidence", "done", "partial", "blocked"] },
    { name: "tasks", type: "array" }, { name: "waves", type: "array" },
  ]),
  "lp.build": child("lp.build", ["tasks", "waves"], [
    { name: "status", type: "enum", values: ["done", "partial", "blocked"] },
    { name: "merged_commits", type: "array" }, { name: "failed_findings", type: "array" },
  ]),
  "lp.review": child("lp.review", ["range", "dimensions"], [
    { name: "status", type: "enum", values: ["pass", "rework", "block"] }, { name: "findings", type: "array" },
  ]),
};

const blueprintChildren: Record<string, Workflow> = {
  "lp.plan": child("lp.plan", ["goal", "findings", "boundary", "mode"], [
    { name: "status", type: "enum", values: ["ok", "low_confidence", "blocked"] },
    { name: "tasks", type: "array" }, { name: "waves", type: "array" },
  ]),
  "lp.build": child("lp.build", ["tasks", "waves"], [
    { name: "status", type: "enum", values: ["done", "partial", "blocked"] },
    { name: "merged_commits", type: "array" }, { name: "failed_findings", type: "array" },
  ]),
  "lp.close": child("lp.close", ["goals", "boundary", "goal", "merged_commits"], [
    { name: "status", type: "enum", values: ["closed", "unmet"] }, { name: "report_path", type: "string" },
  ]),
};

function agents(calls: Calls, special: (ctx: StepContext) => Record<string, unknown> = () => ({})): NodeExecutor {
  return {
    reentrant: true,
    run: async (ctx) => {
      const packet = stepPacket(ctx as never, ctx.node as never).packet;
      const key = `${ctx.workflow.id}.${ctx.nodeId}`;
      (calls[key] ??= []).push({ with: { ...ctx.input.with }, packet });
      const fields = outputFields(ctx.workflow, ctx.node);
      const output = fields === "unknown" ? {} : Object.fromEntries(fields.map((field) => [field.name, valueFor(field)]));
      return { output: { ...output, ...special(ctx) } };
    },
  };
}

const fsWrite: NodeExecutor = { reentrant: true, run: async (ctx) => ({ output: { report_path: String((ctx.node as { params?: { path?: unknown } }).params?.path ?? "report.md") } }) };

describe("P04-R1 graph input packets", () => {
  it("delivers parallel design digests to cross-review and resolutions to guidance", async () => {
    const store = await storeOf();
    const calls: Calls = {};
    const agent = agents(calls, (ctx) => {
      if (ctx.workflow.id !== "lp.brainstorm") return {};
      if (ctx.nodeId === "terms") return { terminology: [{ name: "term" }], non_goals: ["none"], term_count: 1 };
      if (ctx.nodeId.startsWith("shootdown:")) return { lens: "yagni", objections: [], ok: true };
      if (ctx.nodeId.startsWith("designs:")) return { role: "role", digest: { decision: "keep" }, ok: true };
      if (ctx.nodeId === "cross_review") return { conflicts: [], gaps: [], synergies: [], conflict_count: 0 };
      if (ctx.nodeId === "guidance") return { guidance: "guide", features: [], decisions: [], constraints: [], feature_count: 0, open_questions: [], alternatives: [], objections_open: 0 };
      return {};
    });
    const engine = engineOn(journalDb(), { agent });
    registerReducers(engine);
    const summary = await engine.start({ workflow: store.get("lp.brainstorm")!.workflow, inputs: { topic: "packet test", roles: ["api"] } }).done;
    expect(summary.status).toBe("succeeded");
    expect(calls["lp.brainstorm.cross_review"]?.[0]?.with).toMatchObject({ digests: [{ decision: "keep" }] });
    expect(calls["lp.brainstorm.cross_review"]?.[0]?.packet).toContain("digests");
    expect(calls["lp.brainstorm.guidance"]?.[0]?.with).toHaveProperty("resolutions", []);
    expect(calls["lp.brainstorm.guidance"]?.[0]?.packet).toContain("resolutions");
  });

  it("delivers goal audit and memory to project life, including the optional audit branch", async () => {
    const store = await storeOf();
    const calls: Calls = {};
    const agent = agents(calls, (ctx) => {
      if (ctx.workflow.id !== "lp.close") return {};
      if (ctx.nodeId === "goal_audit") return { goals: [], all_met: true, unmet_ids: [], intent_aligned: true, drift_items: [], points: [] };
      if (ctx.nodeId === "memory") return { staged: 1, candidate_ids: ["c1"], deferred: false };
      if (ctx.nodeId === "life") return { status: "updated", commit: "life-1" };
      return {};
    });
    const engine = engineOn(journalDb(), { agent, "fs.write": fsWrite });
    const summary = await engine.start({ workflow: store.get("lp.close")!.workflow, inputs: { goals: [{ id: "g", done_when: "done" }] }, mode: "standard" }).done;
    expect(summary.status).toBe("succeeded");
    expect(calls["lp.close.life"]?.[0]?.with).toEqual({});
    expect(calls["lp.close.life"]?.[0]?.packet).toContain("consumes:goal_audit");
    expect(calls["lp.close.life"]?.[0]?.packet).toContain("consumes:memory");
  });

  it("gives issue-full memory the diagnosis envelope and review evidence", async () => {
    const store = await storeOf();
    const calls: Calls = {};
    const agent = agents(calls, (ctx) => {
      if (ctx.workflow.id === "issue-full" && ctx.nodeId === "triage") return { severity: "high", clear: true };
      if (ctx.workflow.id === "issue-full" && ctx.nodeId === "root_cause") return {
        root_cause: "bad boundary", affected_files: ["src/x.ts"], impact_scope: "all", fix_direction: "guard", confidence: 90, locked: [], free: [],
      };
      if (ctx.workflow.id === "issue-full" && ctx.nodeId === "memory") return { staged: 1, deferred: false };
      if (ctx.workflow.id === "lp.plan") return { status: "ok", tasks: [], waves: [] };
      if (ctx.workflow.id === "lp.build") return { status: "done", merged_commits: ["commit-1"], failed_findings: [] };
      if (ctx.workflow.id === "lp.review") return { status: "pass", findings: [] };
      return {};
    });
    const engine = engineOn(journalDb(), { agent }, { resolveWorkflow: (id) => issueChildren[id] ?? store.resolve(id) });
    const summary = await engine.start({ workflow: store.get("issue-full")!.workflow, inputs: { title: "t", text: "x" } }).done;
    expect(summary.status).toBe("succeeded");
    const memory = calls["issue-full.memory"]?.[0];
    expect(memory?.with.review_findings).toEqual([]);
    expect(memory?.with.merged_commits).toEqual(["commit-1"]);
    expect(memory?.packet).toContain("consumes:root_cause");
  });
});

describe("P04-R4 blueprint-driven packets and output contract", () => {
  it("delivers all upstream specs to readiness and commit_spec, with Epic[] output", async () => {
    const store = await storeOf();
    const calls: Calls = {};
    let taskInput: Record<string, unknown> | undefined;
    const agent = agents(calls, (ctx) => {
      if (ctx.workflow.id !== "blueprint-driven") return {};
      switch (ctx.nodeId) {
        case "discovery": return { seed: "seed", spec_type: "service", glossary: [], glossary_count: 0, gaps: [] };
        case "brief": return { brief: "brief text", term_count: 5 };
        case "prd": return { prd: "prd text", req_count: 3, has_moscow: true };
        case "architecture": return { architecture: "architecture text", adr_count: 1 };
        case "epics": return { epics: [{ id: "EPIC-1" }], epic_count: 1, uncovered_reqs: [] };
        case "readiness": return { score: 90, completeness: 25, consistency: 25, traceability: 25, depth: 15, verdict: "pass", fix_phases: [], findings: [] };
        default: return {};
      }
    });
    const lpTask: NodeExecutor = { reentrant: true, run: async (ctx) => { taskInput = { ...ctx.input.with }; return { output: { state: "failed", merge_commit: "", files: [] } }; } };
    const engine = engineOn(journalDb(), { agent, "lp-task": lpTask }, { resolveWorkflow: store.resolve });
    registerReducers(engine);
    const workflow = store.get("blueprint-driven")!.workflow;
    const summary = await engine.start({ workflow, inputs: { goal: "Build a packet test", idea: "A packet test service" } }).done;
    expect(summary.status).toBe("succeeded");
    expect(calls["blueprint-driven.readiness"]?.[0]?.packet).toContain("consumes:brief");
    expect(calls["blueprint-driven.readiness"]?.[0]?.packet).toContain("consumes:prd");
    expect(calls["blueprint-driven.readiness"]?.[0]?.packet).toContain("consumes:architecture");
    expect(calls["blueprint-driven.readiness"]?.[0]?.packet).toContain("consumes:epics");
    expect(taskInput).toMatchObject({ brief: "brief text", prd: "prd text", architecture: "architecture text", epics: [{ id: "EPIC-1" }], readiness_score: 90, readiness_findings: [] });
    expect(workflow.outputs.find((field) => field.name === "epics")?.type).toBe("array");
    expect(() => checkOutput(workflow.outputs, summary.output)).not.toThrow();
  });

  it("renders the concrete slug in both done and partial terminal paths", async () => {
    const store = await storeOf();
    const run = async (buildStatus: "done" | "partial") => {
      const calls: Calls = {};
      const agent = agents(calls, (ctx) => {
        if (ctx.workflow.id !== "blueprint-driven") {
          if (ctx.workflow.id === "lp.plan") return { status: "ok", tasks: [], waves: [] };
          if (ctx.workflow.id === "lp.build") return { status: buildStatus, merged_commits: [], failed_findings: [] };
          if (ctx.workflow.id === "lp.close") return { status: "closed", report_path: "reports/close.md" };
          return {};
        }
        switch (ctx.nodeId) {
          case "discovery": return { seed: "seed", spec_type: "service", glossary: [], glossary_count: 0, gaps: [] };
          case "brief": return { brief: "brief text", term_count: 5 };
          case "prd": return { prd: "prd text", req_count: 3, has_moscow: true };
          case "architecture": return { architecture: "architecture text", adr_count: 1 };
          case "epics": return { epics: [{ id: "EPIC-1" }], epic_count: 1, uncovered_reqs: [] };
          case "readiness": return { score: 90, completeness: 25, consistency: 25, traceability: 25, depth: 15, verdict: "pass", fix_phases: [], findings: [] };
          default: return {};
        }
      });
      const engine = engineOn(journalDb(), {
        agent,
        "lp-task": { reentrant: true, run: async () => ({ output: { state: "accepted", merge_commit: "", files: [] } }) },
      }, { resolveWorkflow: (id) => blueprintChildren[id] ?? store.resolve(id) });
      registerReducers(engine);
      const workflow = store.get("blueprint-driven")!.workflow;
      const summary = await engine.start({ workflow, inputs: { goal: "Build a packet test", idea: "A packet test service" } }).done;
      return { summary, workflow };
    };

    const done = await run("done");
    expect(done.summary.status).toBe("succeeded");
    expect(done.summary.output).toMatchObject({ status: "done", spec_path: "docs/specs/build-a-packet-test" });
    expect(() => checkOutput(done.workflow.outputs, done.summary.output)).not.toThrow();

    const partial = await run("partial");
    expect(partial.summary.status).toBe("succeeded");
    expect(partial.summary.output).toMatchObject({ status: "partial", spec_path: "docs/specs/build-a-packet-test" });
    expect(() => checkOutput(partial.workflow.outputs, partial.summary.output)).not.toThrow();
  });
});
