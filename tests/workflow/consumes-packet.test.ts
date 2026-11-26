import { describe, expect, it } from "vitest";
import { stepPacket } from "../../src/rooms/workflow/server/services/workflow-agent-packet";

/**
 * Unit seam for the consumes-delivery contract (review590-consumes-delivery-design.md): a minimal StepContext-shaped
 * fixture cast through `unknown`. This is NOT engine/live coverage — the registered-executor RED lives in the parent's
 * chain-executors harness. Required-alias presence validation stays in the executor; these tests pin what stepPacket
 * puts in the packet.
 */
type Ctx = Parameters<typeof stepPacket>[0];
type Node = Parameters<typeof stepPacket>[1];

const producer = { status: "ok", tasks: ["t1"], nested: { deep: "DEPTH-3" } };

function fixture(over: {
  inputs?: Record<string, unknown>;
  with?: Record<string, unknown>;
  resolved?: Record<string, unknown>;
  consumes?: unknown[];
  sameSession?: boolean;
} = {}) {
  const calls: string[] = [];
  const resolved = over.resolved ?? {};
  const node = {
    id: "consumer", type: "agent", role: "planner", prompt: "Do the step.",
    consumes: over.consumes ?? [], produces: [{ kind: "report", version: 1 }],
  };
  const ctx = {
    runId: "wfrun_unit", stepKey: "s1", nodeId: "consumer", node,
    workflow: { id: "wf.unit", name: { en: "unit", ru: "unit" }, nodes: [], edges: [] },
    attempt: 1,
    input: { with: over.with ?? {}, via: { mode: over.sameSession ? "same-session" : "fresh", fromStep: null, fromThreadId: over.sameSession ? "thr_prev" : null, handoff: null } },
    runtime: undefined, mode: "standard", goals: [], reground: false,
    inputs: over.inputs ?? {},
    spawnKey: "spawn", signal: new AbortController().signal,
    resolve: (ref: string) => { calls.push(ref); return resolved[ref]; },
    render: (text: string) => text,
    value: (spec: unknown) => spec, template: (value: unknown) => value,
    effect: async (_key: string, _kind: string, fn: () => Promise<unknown>) => fn(),
  };
  return { ctx: ctx as unknown as Ctx, node: node as unknown as Node, calls };
}

describe("stepPacket consumes delivery (unit seam)", () => {
  it("explicit from delivers the producer's whole output as a consumes:<source> entry, not flattened", () => {
    const { ctx, node } = fixture({ consumes: [{ kind: "plan", version: 1, from: "plan" }], resolved: { plan: producer } });
    const plan = stepPacket(ctx, node);
    expect(plan.packet).toContain("consumes:plan");
    expect(plan.packet).toContain("DEPTH-3");
    expect(plan.packet).not.toMatch(/^- (status|tasks|nested)\b/m);
  });

  it("dedupes two consumes of the same from into one entry", () => {
    const { ctx, node } = fixture({
      consumes: [{ kind: "plan", version: 1, from: "plan" }, { kind: "analysis", version: 1, from: "plan" }], resolved: { plan: producer },
    });
    const plan = stepPacket(ctx, node);
    expect(plan.packet.split("consumes:plan").length - 1).toBe(1);
  });

  it("optional missing from contributes nothing and does not throw; the same source present later delivers", () => {
    const spec = [{ kind: "plan", version: 1, from: "plan", required: false }];
    const missing = fixture({ consumes: spec, resolved: {} });
    expect(() => stepPacket(missing.ctx, missing.node)).not.toThrow();
    expect(stepPacket(missing.ctx, missing.node).packet).not.toContain("consumes:plan");
    const present = fixture({ consumes: spec, resolved: { plan: producer } });
    expect(stepPacket(present.ctx, present.node).packet).toContain("consumes:plan");
  });

  it("an as alias keeps arrived-input precedence: with wins over workflow inputs even for falsy values", () => {
    const { ctx, node } = fixture({
      inputs: { note: "workflow-value", flag: "workflow-flag" },
      with: { note: 0, flag: false },
      consumes: [{ kind: "plan", version: 1, from: "plan", as: "note" }, { kind: "plan", version: 1, from: "plan", as: "flag" }],
      resolved: { plan: producer },
    });
    const plan = stepPacket(ctx, node);
    expect(plan.packet).toMatch(/- note[^\n]*: 0/);
    expect(plan.packet).toMatch(/- flag[^\n]*: false/);
    expect(plan.packet).not.toContain("workflow-value");
    expect(plan.packet).not.toContain("workflow-flag");
  });

  it("same-session suppresses general workflow inputs but still delivers the consumed alias", () => {
    const { ctx, node } = fixture({
      sameSession: true, inputs: { plan: "PLAN-DATA-1", noise: "NOISE-VALUE-9" },
      consumes: [{ kind: "plan", version: 1, from: "plan", as: "plan" }], resolved: { plan: producer },
    });
    const plan = stepPacket(ctx, node);
    expect(plan.packet).toContain("PLAN-DATA-1");
    expect(plan.packet).not.toContain("NOISE-VALUE-9");
  });

  it("a missing as alias is not auto-filled from the producer output", () => {
    const { ctx, node } = fixture({
      consumes: [{ kind: "plan", version: 1, from: "plan", as: "alias_absent" }],
      resolved: { plan: producer },
    });
    const plan = stepPacket(ctx, node);
    expect(plan.packet).not.toContain("alias_absent");
  });

  it("unnamed, $inputs and start sources get no lookup and no fabricated entry", () => {
    const { ctx, node, calls } = fixture({
      consumes: [
        { kind: "report", version: 1 },
        { kind: "plan", version: 1, from: "$inputs" },
        { kind: "plan", version: 1, from: "start" },
      ],
    });
    const plan = stepPacket(ctx, node);
    expect(plan.packet).not.toContain("consumes:");
    expect(calls.filter((ref) => ref === "$inputs" || ref === "start")).toEqual([]);
  });

  it("a consumes:<source> name already taken by an input refuses rather than overwrite", () => {
    const { ctx, node } = fixture({
      inputs: { "consumes:plan": "USER-DATA" },
      consumes: [{ kind: "plan", version: 1, from: "plan" }],
      resolved: { plan: producer },
    });
    expect(() => stepPacket(ctx, node)).toThrow();
  });
});
