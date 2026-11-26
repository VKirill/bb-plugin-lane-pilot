import { describe, expect, it } from "vitest";
import { parseWorkflow, registerPureActions, validateWorkflow } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb } from "./engine-helpers";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { parseLoopHookManifest, prepareLoopWorkflow, LoopHookRefusal } from "../../src/rooms/workflow/models/loop-hooks";
import type { LoopHookManifest } from "../../src/rooms/workflow";
import { stepPacket } from "../../src/rooms/workflow/server/services/workflow-agent-packet";

const child = (id: string, status: "published" | "draft" = "published") => parseWorkflow({
  id, status, name: { en: id, ru: id }, description: { en: id, ru: id }, inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }],
  nodes: [{ id: "done", type: "action", action: "emit", map: { status: "$inputs.goal" } }], edges: [{ from: "start", to: "done" }],
});
const root = parseWorkflow({
  id: "full", status: "published", name: { en: "full", ru: "full" }, description: { en: "full", ru: "full" }, inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }],
  nodes: [{ id: "plan", type: "subworkflow", workflow: "lp.plan", inputs: { goal: "$inputs.goal" } }, { id: "done", type: "action", action: "emit", map: { status: "'done'" } }],
  edges: [{ from: "start", to: "plan" }, { from: "plan", to: "done" }],
});

const discussionHook = (id: string) => parseWorkflow({
  id, status: "published", name: { en: id, ru: id }, description: { en: id, ru: id },
  inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }, { name: "handoff", type: "string" }],
  nodes: [
    { id: "ask", type: "human", question: "Continue?", options: ["yes"], output: [{ name: "answer", type: "string" }] },
    { id: "done", type: "action", action: "emit", map: { status: "$inputs.goal", handoff: "'hook handoff'" } },
  ], edges: [{ from: "start", to: "ask" }, { from: "ask", to: "done" }],
});

const discussionManifest = (refs = { goal: "$inputs.goal" }) => JSON.stringify({ schemaVersion: 1, hooks: {
  "discuss:pre": [{ workflow: "check-one", inputs: refs }, { workflow: "check-two", inputs: refs }],
} });

describe("project loop hook composition", () => {
  it("[sma:k_t_loop] keeps ordered hooks as literal subworkflow nodes before a nested plan", () => {
    const parsed = parseLoopHookManifest(JSON.stringify({ schemaVersion: 1, hooks: { "plan:pre": [{ workflow: "project-check", inputs: { goal: "$inputs.goal" } }, { workflow: "second-check", inputs: { goal: "$inputs.goal" } }], "verify:post": [], "ship:post": [] } }));
    const prepared = prepareLoopWorkflow({ workflow: root, manifest: parsed.manifest, manifestSha256: parsed.sha256, resolve: (id) => id === "lp.plan" ? child(id) : id === "project-check" ? child(id) : id === "second-check" ? child(id) : null, status: () => ({ status: "published" }) });
    expect(prepared.workflow.nodes.filter((node) => node.type === "subworkflow").map((node) => node.id)).toEqual(["plan"]);
    const planned = prepared.resolve("lp.plan")!;
    const ids = planned.nodes.filter((node) => node.type === "subworkflow").map((node) => node.id);
    expect(ids).toEqual(["hook-plan-pre-done-0-0", "hook-plan-pre-done-0-1"]);
    expect(planned.edges.find((edge) => edge.from === "$start")?.to).toBe("hook-plan-pre-done-0-0");
    expect(prepared.provenance.orderedHookIds.map((entry) => entry.endsWith("project-check") || entry.endsWith("second-check"))).toEqual([true, true]);
  });

  it("refuses malformed, unpublished and recursive hooks", () => {
    expect(() => parseLoopHookManifest("nope")).toThrow(LoopHookRefusal);
    const parsed = parseLoopHookManifest(JSON.stringify({ schemaVersion: 1, hooks: { "plan:pre": [{ workflow: "bad-child", inputs: {} }], "verify:post": [], "ship:post": [] } }));
    expect(() => prepareLoopWorkflow({ workflow: root, manifest: parsed.manifest, resolve: (id) => id === "lp.plan" ? child(id) : id === "bad-child" ? child(id, "draft") : null, status: (id) => ({ status: id === "bad-child" ? "draft" : "published" }) })).toThrow(/not a published/);
  });

  it("is a no-op without a manifest", () => {
    const prepared = prepareLoopWorkflow({ workflow: root, resolve: () => null });
    expect(prepared.workflow).toBe(root);
    expect(prepared.provenance.orderedHookIds).toEqual([]);
  });

  it("runs the composed hook as a durable child and keeps the root output", async () => {
    const db = journalDb();
    const target = child("lp.plan");
    const check = child("project-check");
    const parsed = parseLoopHookManifest(JSON.stringify({ schemaVersion: 1, hooks: { "plan:pre": [{ workflow: "project-check", inputs: { goal: "$inputs.goal" } }], "verify:post": [], "ship:post": [] } }));
    const prepared = prepareLoopWorkflow({ workflow: target, manifest: parsed.manifest, manifestSha256: parsed.sha256, resolve: (id) => id === "project-check" ? check : null, status: () => ({ status: "published" }) });
    const engine = engineOn(db);
    registerPureActions(engine);
    try {
      const run = engine.start({ workflow: prepared.workflow, resolve: prepared.resolve, inputs: { goal: "owner goal" }, key: "hook-test" });
      await engine.idle();
      expect(engine.get(run.runId)).toMatchObject({ status: "succeeded", output: { status: "owner goal" } });
      const children = db.prepare("SELECT workflow_id, parent_run_id FROM lane_pilot_wf_run WHERE parent_run_id=? ORDER BY rowid").all(run.runId) as Array<{ workflow_id: string; parent_run_id: string }>;
      expect(children.map((row) => row.workflow_id)).toEqual(["project-check"]);
    } finally { engine.dispose(); db.close(); }
  });

  it("[sma:k_t_loop] places verify post hooks before the terminal emit and keeps its original outcome", async () => {
    const db = journalDb();
    const target = child("lp.close");
    const check = child("project-check");
    const parsed = parseLoopHookManifest(JSON.stringify({ schemaVersion: 1, hooks: { "plan:pre": [], "verify:post": [{ workflow: "project-check", inputs: { goal: "$inputs.goal" } }], "ship:post": [] } }));
    const prepared = prepareLoopWorkflow({ workflow: target, manifest: parsed.manifest, manifestSha256: parsed.sha256, resolve: (id) => id === "project-check" ? check : null, status: () => ({ status: "published" }) });
    const emit = prepared.workflow.nodes.find((node) => node.type === "action" && node.action === "emit")!;
    const incoming = prepared.workflow.edges.find((edge) => edge.to === emit.id)!;
    expect(incoming.from).toBe("hook-verify-post-done-0-0");
    expect(prepared.workflow.edges.find((edge) => edge.from === "hook-verify-post-done-0-0" && edge.to === emit.id)).toBeTruthy();
    const engine = engineOn(db);
    registerPureActions(engine);
    try {
      const run = engine.start({ workflow: prepared.workflow, resolve: prepared.resolve, inputs: { goal: "original outcome" } });
      await engine.idle();
      expect(engine.get(run.runId)).toMatchObject({ status: "succeeded", output: { status: "original outcome" } });
    } finally { engine.dispose(); db.close(); }
  });
  it("runs discussion hooks after each gather and before assess, waiting for each child", async () => {
    const db = journalDb();
    const target = builtinWorkflow("lp.analyze")!;
    const children = [discussionHook("check-one"), discussionHook("check-two")];
    const parsed = parseLoopHookManifest(discussionManifest());
    const resolve = (id: string) => children.find((child) => child.id === id) ?? null;
    const prepared = prepareLoopWorkflow({ workflow: target, manifest: parsed.manifest, manifestSha256: parsed.sha256, resolve });
    expect(validateWorkflow(prepared.workflow, { resolve: prepared.resolve }).filter((problem) => problem.level === "error")).toEqual([]);
    let gathers = 0;
    let assessments = 0;
    const calls: string[] = [];
    const engine = engineOn(db, { agent: { reentrant: true, run: async (ctx) => {
      calls.push(ctx.nodeId);
      if (ctx.nodeId === "gather") {
        gathers++;
        return { threadId: "thr_gather", output: { anchors: [], modules: [], conventions: [], summary: `round-${gathers}`, stack: [], features: [], architecture: [], handoff: `gather handoff ${gathers}` } };
      }
      assessments++;
      expect(ctx.inputs.goal).toBe("owner goal");
      expect(ctx.resolve("gather.summary")).toBe(`round-${assessments}`);
      expect(ctx.input.via.mode).toBe("same-session");
      expect(ctx.input.via.fromThreadId).toBe("thr_gather");
      expect(ctx.input.via.handoff).toBe(`gather handoff ${assessments}`);
      expect(stepPacket(ctx as never, ctx.node as never).packet).toContain(`gather handoff ${assessments}`);
      return { threadId: "thr_gather", output: { decisions: [], risks: [], scores_min: 1, scope_verdict: "small", recommendation: "go", confidence: assessments === 1 ? 40 : 80, stalled: false, pressure_pass: true, open_questions: [], residual_risks: [], appetite: "small", no_gos: [], pitfalls: [], handoff: "assessed" } };
    } } });
    registerPureActions(engine);
    try {
      const run = engine.start({ workflow: prepared.workflow, resolve: prepared.resolve, inputs: { goal: "owner goal", depth: "standard", ask_owner: false } });
      for (const [i] of ["check-one", "check-two", "check-one", "check-two"].entries()) {
        await engine.idle();
        expect(engine.get(run.runId)?.status, JSON.stringify(db.prepare("SELECT node_id, state, error FROM lane_pilot_wf_step WHERE run_id=?").all(run.runId))).toBe("waiting");
        const rows = db.prepare("SELECT id, workflow_id, inputs_json FROM lane_pilot_wf_run WHERE parent_run_id=? ORDER BY rowid").all(run.runId) as Array<{ id: string; workflow_id: string; inputs_json: string }>;
        expect(rows.map((row) => row.workflow_id)).toEqual(["check-one", "check-two", "check-one", "check-two"].slice(0, i + 1));
        expect(JSON.parse(rows[i]!.inputs_json)).toMatchObject({ goal: "owner goal" });
        expect(calls).toEqual(i < 2 ? ["gather"] : ["gather", "assess", "gather"]);
        const waiting = engine.get(rows[i]!.id)!;
        expect(waiting.waiting[0]?.await).toMatchObject({ kind: "human" });
        expect(await engine.resolve(rows[i]!.id, waiting.waiting[0]!.stepKey, { answer: "yes", answer_kind: "answered" })).toBe(true);
        await engine.poll();
      }
      await engine.idle();
      expect(calls).toEqual(["gather", "assess", "gather", "assess"]);
      expect(engine.get(run.runId)).toMatchObject({ status: "succeeded", output: { summary: "round-2", confidence: 80, appetite: "small" } });
      const rows = db.prepare("SELECT workflow_id, output_json FROM lane_pilot_wf_run WHERE parent_run_id=? ORDER BY rowid").all(run.runId) as Array<{ workflow_id: string; output_json: string }>;
      expect(rows.map((row) => JSON.parse(row.output_json))).toEqual(Array(4).fill({ status: "owner goal", handoff: "hook handoff" }));
    } finally { engine.dispose(); db.close(); }
  });

  it("keeps old manifests valid and refuses missing hooks or unsupported gather mappings", () => {
    const target = builtinWorkflow("lp.analyze")!;
    const legacy: LoopHookManifest = { schemaVersion: 1, hooks: { "plan:pre": [], "verify:post": [], "ship:post": [] } };
    expect(prepareLoopWorkflow({ workflow: target, manifest: legacy, resolve: () => null }).workflow).toBe(target);
    const old = parseLoopHookManifest(JSON.stringify(legacy));
    expect(old.manifest!.hooks["discuss:pre"]).toEqual([]);
    expect(prepareLoopWorkflow({ workflow: target, manifest: old.manifest, resolve: () => null }).workflow).toBe(target);
    const parsed = parseLoopHookManifest(discussionManifest());
    expect(() => prepareLoopWorkflow({ workflow: target, manifest: parsed.manifest, resolve: () => null })).toThrow(/discuss:pre hook workflow "check-one" is missing/);
    expect(() => parseLoopHookManifest(discussionManifest({ goal: "gather.summary" }))).toThrow(/unsupported input mapping/);
    const renamed = child("lp.analyze");
    expect(() => prepareLoopWorkflow({ workflow: renamed, manifest: parsed.manifest, resolve: () => discussionHook("check-one") })).toThrow(/requires an unconditional gather-to-assess boundary/);
    const other = child("another-workflow");
    expect(prepareLoopWorkflow({ workflow: other, manifest: parsed.manifest, resolve: () => null }).workflow.nodes).toEqual(other.nodes);
    const conditional = { ...target, edges: target.edges.map((edge) => edge.from === "gather" && edge.to === "assess" ? { ...edge, when: "$inputs.ask_owner" } : edge) };
    expect(() => prepareLoopWorkflow({ workflow: conditional, manifest: parsed.manifest, resolve: () => discussionHook("check-one") })).toThrow(/requires an unconditional gather-to-assess boundary/);
  });

});
