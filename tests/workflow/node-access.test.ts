import { describe, expect, it } from "vitest";
import { coreRequiredSessionAdvertisement, requiredSessionPolicySpawnBinding, roleProfilePolicy } from "../../src/helper-context";
import { agentRequest, extraAccessOf } from "../../src/rooms/workflow/server/workflow-agent";
import type { StepContext } from "../../src/rooms/workflow/engine";
import { checkRequires, effectiveRequires } from "../../src/rooms/workflow/preflight";
import type { GraphNode } from "../../src/rooms/workflow/schema";
import { loadWorkflow, parseWorkflow } from "../../src/rooms/workflow/validate";
import { wf } from "./engine-helpers";
import { workflow } from "./fixtures";

/** Per-node plugins and MCP servers (the closed schema's two new fields) and how they reach the helper's session policy. */
const agentNode = (extra: Record<string, unknown> = {}) => ({ id: "look", type: "agent", role: "analyst", prompt: "Look at {{input.query}}", output: [{ name: "found", type: "string" }], ...extra });
const withAgent = (extra: Record<string, unknown> = {}) => workflow({
  nodes: [agentNode(extra)],
  edges: [{ from: "start", to: "look", with: { query: "input.query" } }, { from: "look", to: "end", with: { result: "look.found" } }],
});

describe("the node schema", () => {
  it("accepts plugins and mcp on an agent step (and on the child of a parallel), defaulting to none", () => {
    const parsed = parseWorkflow(withAgent({ plugins: ["browser-automation"], mcp: ["tavily"] }));
    const node = parsed.nodes[0] as Extract<GraphNode, { type: "agent" }>;
    expect(node).toMatchObject({ plugins: ["browser-automation"], mcp: ["tavily"] });
    expect((parseWorkflow(withAgent()).nodes[0] as Extract<GraphNode, { type: "agent" }>)).toMatchObject({ plugins: [], mcp: [] });
    const fan = parseWorkflow(workflow({
      inputs: [{ name: "items", type: "array" }], outputs: [{ name: "result", type: "json" }],
      nodes: [{ id: "fan", type: "parallel", for_each: "$inputs.items", child: { type: "agent", role: "analyst", prompt: "p", mcp: ["tavily"], output: [{ name: "x", type: "string" }] }, join: { policy: "all", out: [{ name: "xs", type: "array" }] } }],
      edges: [{ from: "start", to: "fan" }, { from: "fan", to: "end", with: { result: "fan.xs" } }],
    }));
    expect(((fan.nodes[0] as Extract<GraphNode, { type: "parallel" }>).child as { mcp: string[] }).mcp).toEqual(["tavily"]);
  });

  it("stays closed: a non-agent step has no plugins, an unknown key is refused, and a list is bounded", () => {
    expect(loadWorkflow(workflow({ nodes: [{ id: "a", type: "lp-task", plugins: ["p"], output: [{ name: "t", type: "string" }] }], edges: [{ from: "start", to: "a" }, { from: "a", to: "end", with: { result: "a.t" } }] })).ok).toBe(false);
    expect(loadWorkflow(withAgent({ pluginz: ["x"] })).ok).toBe(false);
    expect(loadWorkflow(withAgent({ mcp: Array.from({ length: 9 }, (_unused, index) => `s${index}`) })).ok).toBe(false);
    expect(loadWorkflow(withAgent({ plugins: [""] })).ok).toBe(false);
  });
});

describe("what the helper's session loads", () => {
  it("adds a step's plugins, MCP servers and skills to its role's profile and nothing else", () => {
    expect(extraAccessOf({})).toBeUndefined();
    expect(extraAccessOf({ skills: ["tavily"], plugins: ["browser-automation"], mcp: ["tavily"] })).toEqual({ skills: ["tavily"], bbPlugins: ["browser-automation"], mcpServers: ["tavily"] });
    const plain = roleProfilePolicy("analyst");
    const policy = roleProfilePolicy("analyst", {}, { bbPlugins: ["browser-automation"], mcpServers: ["tavily"], skills: ["tavily"] });
    expect(policy.bbPlugins).toEqual({ mode: "allow", names: [...(plain.bbPlugins as { names: string[] }).names, "browser-automation"] });
    expect(policy.mcpServers).toEqual({ mode: "allow", names: [...(plain.mcpServers as { names: string[] }).names, "tavily"] });
    expect(policy.skills).toEqual({ mode: "allow", names: [...(plain.skills as { names: string[] }).names, "tavily"] });
    // A name the role already has is not listed twice.
    const twice = roleProfilePolicy("analyst", {}, { mcpServers: (plain.mcpServers as { names: string[] }).names });
    expect(twice.mcpServers).toEqual(plain.mcpServers);
  });

  it("reaches the spawn as the required session policy of the helper", () => {
    const snapshot = { schemaVersion: 1 as const, mode: "roles" as const, settings: { mode: "roles" as const, skills: [], mcpServers: [], bbPlugins: [], nativePlugins: [] }, parentRequired: false, parentPolicy: null, policy: null };
    const bind = (extra?: Parameters<typeof requiredSessionPolicySpawnBinding>[0]["extra"]) => requiredSessionPolicySpawnBinding({ capability: "required", advertised: coreRequiredSessionAdvertisement(), snapshot, providerId: "claude-code", role: "analyst", ...(extra ? { extra } : {}) }) as unknown as { experimental_vkRequiredSessionPolicy: { policy: Record<string, { names: string[] }> } };
    expect(bind().experimental_vkRequiredSessionPolicy.policy.mcpServers!.names).not.toContain("tavily");
    const policy = bind({ mcpServers: ["tavily"], bbPlugins: ["browser-automation"] }).experimental_vkRequiredSessionPolicy.policy;
    expect(policy.mcpServers!.names).toContain("tavily");
    expect(policy.bbPlugins!.names).toContain("browser-automation");
  });

  it("is what an agent step asks for: the request carries the node's plugins and MCP servers", () => {
    const flow = parseWorkflow(withAgent({ plugins: ["browser-automation", "browser-automation"], mcp: ["tavily"], skills: ["tavily"] }));
    const node = flow.nodes[0] as Extract<GraphNode, { type: "agent" }>;
    const ctx = {
      runtime: { pmThreadId: "t", projectId: "p", runId: "r", ctx: {}, services: {} }, workflow: flow, node, nodeId: "look", runId: "wfrun_1", stepKey: "look#1", spawnKey: "k", mode: "standard", signal: new AbortController().signal,
      input: { with: { query: "cats" }, via: { mode: "artifact", fromStep: null } }, goals: [], reground: false, render: (text: string) => text.replace("{{input.query}}", "cats"),
    } as unknown as StepContext<never>;
    const request = agentRequest(ctx as never, node);
    expect(request).toMatchObject({ plugins: ["browser-automation"], mcp: ["tavily"], skills: ["tavily"] });
    expect(extraAccessOf(request)).toEqual({ skills: ["tavily"], bbPlugins: ["browser-automation"], mcpServers: ["tavily"] });
  });
});

describe("checked against what the machine has", () => {
  it("counts the plugins and servers of the steps as requirements, once", () => {
    const flow = wf({ ...withAgent({ plugins: ["browser-automation"], mcp: ["tavily"] }), requires: { plugins: ["lane-pilot", "browser-automation"], mcp: ["gitnexus"] } });
    expect(effectiveRequires(flow)).toMatchObject({ plugins: ["lane-pilot", "browser-automation"], mcp: ["gitnexus", "tavily"] });
  });

  it("names the plugin or server a step asks for that is not there, before the run", async () => {
    const flow = wf(withAgent({ plugins: ["browser-automation"], mcp: ["tavily", "jev"] }));
    const result = await checkRequires(effectiveRequires(flow), { plugins: async () => ["lane-pilot"], mcpServers: async () => ["tavily"] });
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => `${issue.kind}:${issue.name}`)).toEqual(["plugin:browser-automation", "mcp:jev"]);
  });
});
