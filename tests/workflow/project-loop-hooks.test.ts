import { describe, expect, it } from "vitest";
import { parseWorkflow, registerPureActions } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb } from "./engine-helpers";
import { parseLoopHookManifest, prepareLoopWorkflow, LoopHookRefusal } from "../../src/rooms/workflow/loop-hooks";

const child = (id: string, status: "published" | "draft" = "published") => parseWorkflow({
  id, status, name: { en: id, ru: id }, description: { en: id, ru: id }, inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }],
  nodes: [{ id: "done", type: "action", action: "emit", map: { status: "$inputs.goal" } }], edges: [{ from: "start", to: "done" }],
});
const root = parseWorkflow({
  id: "full", status: "published", name: { en: "full", ru: "full" }, description: { en: "full", ru: "full" }, inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }],
  nodes: [{ id: "plan", type: "subworkflow", workflow: "lp.plan", inputs: { goal: "$inputs.goal" } }, { id: "done", type: "action", action: "emit", map: { status: "'done'" } }],
  edges: [{ from: "start", to: "plan" }, { from: "plan", to: "done" }],
});

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
});
