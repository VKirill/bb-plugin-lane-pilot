// Region 17 · Agent roles (subagents) — the behaviour proofs of the map nodes n1368–n1399 (docs/sma-evidence.md).
// A role of this region is a prompt plus a spawn profile. A test here checks what the role is GIVEN (its tools, skills, the data of its
// node), what it MAY WRITE (read-only, or its own folders), what form its answer must take (the output fields) and what the code does
// with that answer (the path the graph takes, the field that reaches the result) — never that a word is present in a prompt.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { buildAcceptanceCard } from "../../src/rooms/acceptance/card";
import { getBaseline } from "../../src/rooms/baseline";
import { fragmentJudgeVia, parseFragments } from "../../src/rooms/anamnesis/fragments";
import { roleProfilePolicy } from "../../src/rooms/contracts/helper-context";
import { compileMainAgentProfile } from "../../src/rooms/native-agent/agent-profile";
import { sessionOverrideAgentsJson } from "../../src/rooms/native-agent/native-agent-definition";
import { piecePlan, ANIMATOR_LAW, ANIMATOR_FREQUENT_RULE } from "../../src/rooms/phase/stages";
import { agentRequest, roleSpec } from "../../src/rooms/workflow/server/workflow-agent";
import { REDUCERS } from "../../packages/workflow-engine/src/reducers";
import { chainStore, runSim } from "../workflow/chain-harness";
import { world } from "../baseline/world";
import { out, pathOf } from "../workflow/chain-helpers";

type AgentNode = Extract<GraphNode, { type: "agent" }>;
/** The helper request the real executor builds for one agent node of a shipped graph, and the profile its role spawns with. */
async function spawnOf(workflowId: string, nodeId: string, withInput: Record<string, unknown> = {}) {
  const flow = (await chainStore()).get(workflowId)!.workflow;
  const node = flow.nodes.find((candidate) => candidate.id === nodeId) as AgentNode;
  const ctx = {
    runtime: { pmThreadId: "t", projectId: "", runId: "r", ctx: {}, services: {} }, workflow: flow, node, nodeId, runId: "wfrun", stepKey: `${nodeId}#1`, spawnKey: "k", mode: "standard",
    signal: new AbortController().signal, input: { with: withInput, via: { mode: "artifact", fromStep: null } }, goals: [], reground: false, render: (text: string) => text, template: (value: unknown) => value,
  } as unknown as StepContext<never>;
  const request = agentRequest(ctx as never, node);
  const spec = roleSpec(request.role);
  return { node, request, spec, fields: Object.fromEntries(request.fields.map((field) => [field.name, field.type])) as Record<string, string> };
}

const WRITE_TOOLS = ["Write", "Edit", "NotebookEdit", "MultiEdit"];
/** The tools a bundled session role is spawned with, as the `--agents` definition of its session carries them. */
function sessionTools(agentId: string): { tools: string[]; skills: string[] } {
  const compiled = compileMainAgentProfile(agentId);
  const json = JSON.parse(sessionOverrideAgentsJson({ agentId, edited: false, compiled })!) as Record<string, { tools?: string[]; skills?: string[] }>;
  const definition = Object.values(json)[0]!;
  return { tools: definition.tools ?? [], skills: definition.skills ?? [] };
}

describe("region 17 · specialist sessions: what the spawned role gets", () => {
  it("[sma:k_ag_selector] the selector session reads and searches but cannot write product files, and the graph's recommendation is what the run answers", async () => {
    const { tools } = sessionTools("framework-selector");
    expect(tools).toEqual(expect.arrayContaining(["Read", "Grep", "WebSearch", "WebFetch"]));
    for (const write of WRITE_TOOLS) expect(tools).not.toContain(write);
    // The same step in the ai-integration-phase graph: a read-only analyst, answering framework, options and the scores.
    const select = await spawnOf("ai-integration-phase", "select");
    expect(select.spec).toMatchObject({ helper: "analyst", readOnly: true });
    expect(select.fields).toMatchObject({ framework: "string", options: "json", scores: "json" });
    // The recommended framework is what the run reports; a blocked check does not change which framework was picked.
    const done = await runSim("ai-integration-phase", { input: { goal: "rank" }, stubs: { select: { framework: "langchain", options: [{ name: "langchain" }] }, spec: { spec_path: "x/AI-SPEC.md" }, check: { ok: true, gaps: [] } } });
    expect(out(done)).toMatchObject({ status: "done", framework: "langchain", spec_path: "x/AI-SPEC.md" });
  });

  it("[sma:k_ag_airesearcher] the research step runs as the tavily specialist with its search skill, may write only its own notes, and answers the quick reference and the implementation guidance", async () => {
    const research = await spawnOf("ai-integration-phase", "research");
    expect(research.request.role).toBe("specialist:tavily");
    expect(research.spec.helper).toBe("specialist:tavily");
    expect(research.spec.readOnly).toBe(false);
    expect(research.spec.editable(".agents/research/ai-model.md")).toBe(true);
    expect(research.spec.editable("src/rooms/app.ts")).toBe(false);
    expect(roleProfilePolicy("specialist:tavily").skills).toEqual({ mode: "allow", names: expect.arrayContaining(["tavily"]) });
    expect(research.fields).toMatchObject({ quick_reference: "string", implementation_notes: "string" });
    // Its answer reaches the spec step's artifact: the spec step is handed what the research step produced, after it.
    const spec = await spawnOf("ai-integration-phase", "spec");
    expect(spec.node.consumes?.map((use) => use.from)).toEqual(expect.arrayContaining(["research"]));
    expect(sessionTools("ai-researcher").skills).toContain("tavily");
  });

  it("[sma:k_ag_domain] the domain notes the research step answers are the field the evaluation plan is told to read, and the plan is written after them", async () => {
    const research = await spawnOf("ai-integration-phase", "research");
    expect(research.fields.domain_notes).toBe("string");
    const plan = await spawnOf("ai-integration-phase", "eval_plan");
    const named = [...plan.request.prompt.matchAll(/research\.(\w+)/g)].map((match) => match[1]!);
    expect(named).toEqual(["domain_notes"]);
    for (const field of named) expect(Object.keys(research.fields)).toContain(field);
    const run = await runSim("ai-integration-phase", { input: { goal: "rank" }, stubs: { research: { domain_notes: "expert criteria; failure modes; regulation" }, spec: { spec_path: "x/AI-SPEC.md" }, check: { ok: true, gaps: [] } } });
    expect(pathOf(run).split(" ").slice(0, 3)).toEqual(["select", "research", "eval_plan"]);
    expect(plan.node.consumes?.map((use) => use.from)).toEqual(["research"]);
  });

  it("[sma:k_ag_evalplanner] the evaluation plan is a planner's answer in one typed field, made before the spec and carried into it", async () => {
    const plan = await spawnOf("ai-integration-phase", "eval_plan");
    expect(plan.spec).toMatchObject({ helper: "planner", readOnly: true });
    expect(plan.fields.eval_plan).toBe("string");
    const spec = await spawnOf("ai-integration-phase", "spec");
    expect(spec.node.consumes?.map((use) => use.from)).toEqual(["select", "research", "eval_plan"]);
    expect(sessionTools("eval-planner").tools).not.toContain("Write");
    // A spec the checker finds gaps in is rewritten by the same spec step, not by a second evaluation plan.
    const rework = await runSim("ai-integration-phase", { input: { goal: "rank" }, stubs: { spec: { spec_path: "x" }, check: [{ ok: false, gaps: ["no guardrails"] }, { ok: true, gaps: [] }] } });
    expect(pathOf(rework)).toBe("select research eval_plan spec check spec check done");
    expect(rework.called("eval_plan")).toHaveLength(1);
  });
});
