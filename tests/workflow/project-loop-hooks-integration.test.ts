import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowEngine, parseWorkflow, registerPureActions } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { createWorkflowLibrary } from "../../src/rooms/workflow/server/workflow-library";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/workflow-triggers";
import { parseLoopHookManifest, prepareLoopWorkflow } from "../../src/rooms/workflow/loop-hooks";
import { workflow } from "./fixtures";
import { engineOn, journalDb, trust } from "./engine-helpers";

const filesToRemove: string[] = [];
afterEach(async () => { await Promise.all(filesToRemove.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const hookChild = (id: string, value: string) => parseWorkflow(workflow({
  id, status: "published", inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }],
  nodes: [
    { id: "ask", type: "human", question: "Run this project check?", options: ["yes", "no"], output: [{ name: "answer", type: "string" }] },
    { id: "done", type: "action", action: "emit", map: { status: `'${value}'` } },
  ], edges: [{ from: "start", to: "ask" }, { from: "ask", to: "done" }],
}));

const rootWorkflow = (id = "lp.plan") => parseWorkflow(workflow({
  id, status: "published", inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }], triggers: [{ type: "manual" }],
  nodes: [{ id: "done", type: "action", action: "emit", map: { status: "'original-root'" } }], edges: [{ from: "start", to: "done" }],
}));

const manifestText = (workflowId = "project-check") => JSON.stringify({ schemaVersion: 1, hooks: {
  "plan:pre": [{ workflow: workflowId, inputs: { goal: "$inputs.goal" } }], "verify:post": [], "ship:post": [],
} });

describe("project loop hooks: engine integration", () => {
  it("waits for and resumes a real human-gated hook child, persists its receipt, and keeps the root output", async () => {
    const db = journalDb();
    const childV1 = hookChild("project-check", "v1");
    let catalog = childV1;
    const parsed = parseLoopHookManifest(manifestText());
    const prepared = prepareLoopWorkflow({
      workflow: rootWorkflow(), manifest: parsed.manifest, manifestSha256: parsed.sha256,
      resolve: (id) => id === "project-check" ? catalog : null,
    });
    const engine = engineOn(db);
    registerPureActions(engine);
    try {
      const root = engine.start({ workflow: prepared.workflow, resolve: prepared.resolve, inputs: { goal: "owner goal" } });
      await engine.idle();
      expect(engine.get(root.runId)).toMatchObject({ status: "waiting" });
      const childRow = db.prepare("SELECT id, definition_json FROM lane_pilot_wf_run WHERE parent_run_id=?").get(root.runId) as { id: string; definition_json: string };
      expect(childRow).toBeTruthy();
      expect(JSON.parse(childRow.definition_json).nodes.some((node: { id: string }) => node.id === "ask")).toBe(true);
      const child = engine.get(childRow.id)!;
      expect(child.waiting[0]?.await).toMatchObject({ kind: "human" });
      // The parent pinned the child definition at start. A catalog edit must not change this in-flight run.
      catalog = hookChild("project-check", "v2");
      expect(await engine.resolve(childRow.id, child.waiting[0]!.stepKey, { answer: "yes", answer_kind: "answered" })).toBe(true);
      await engine.poll();
      await engine.idle();
      expect(engine.get(root.runId)).toMatchObject({ status: "succeeded", output: { status: "original-root" } });
      expect(engine.get(childRow.id)).toMatchObject({ status: "succeeded", output: { status: "v1" } });
      const parentStep = db.prepare("SELECT state, output_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id LIKE 'hook-plan-pre-%'").get(root.runId) as { state: string; output_json: string };
      expect(parentStep.state).toBe("succeeded");
      expect(JSON.parse(parentStep.output_json)).toMatchObject({ status: "v1" });
    } finally { engine.dispose(); db.close(); }
  });
});

describe("project loop hooks: library and production trigger integration", () => {
  it("isolates project A/B, consumes the reserved manifest through the real trigger, and refuses malformed, unavailable, and host-mismatched projects", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const projectPaths: Record<string, string> = { projectA: "/work/a", projectB: "/work/b", broken: "/work/broken", offline: "/work/offline", mismatch: "/work/mismatch" };
    const projectFiles: Record<string, Array<{ path: string; content: string }>> = {
      projectA: [
        { path: "lp.plan.json", content: JSON.stringify(rootWorkflow()) },
        { path: "project-check.json", content: JSON.stringify(hookChild("project-check", "hook")) },
        { path: "loop-hooks.manifest.json", content: manifestText() },
      ],
      projectB: [{ path: "lp.plan.json", content: JSON.stringify(rootWorkflow()) }],
      broken: [{ path: "lp.plan.json", content: JSON.stringify(rootWorkflow()) }, { path: "loop-hooks.manifest.json", content: "{" }],
    };
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm" }));
    const ctx = {
      bb, db, log: () => undefined,
      host: { call: async (_method: string, input: { projectCwd: string }) => {
        if (input.projectCwd === "/work/offline") throw new Error("machine offline");
        if (input.projectCwd === "/work/mismatch") return { hostId: "host_other", files: projectFiles.projectA };
        const project = Object.entries(projectPaths).find(([, path]) => path === input.projectCwd)?.[0] ?? "projectB";
        return { hostId: "host_1", files: projectFiles[project] ?? projectFiles.projectB };
      } },
    } as unknown as ServerCore;
    const engine = new WorkflowEngine({ db, harnessVersion: "integration" });
    registerPureActions(engine);
    trust(db, rootWorkflow());
    trust(db, hookChild("project-check", "hook"));
    const services = { workflowEngine: engine, docsPlaces: async (projectId: string) => [{ hostId: "host_1", path: projectPaths[projectId] ?? projectPaths.projectB, scopes: [], name: projectId }] } as unknown as Services;
    const globalDir = await mkdtemp(join(tmpdir(), "lp-loop-hooks-global-"));
    filesToRemove.push(globalDir);
    const library = createWorkflowLibrary(ctx, services, { globalDir });
    const triggers = createWorkflowTriggers(ctx, services, { loadStore: (projectId) => library.loadStore(projectId) });
    try {
      createRun(db, "run-a", "projectA", "cli"); setRunThread(db, "run-a", "pm-a");
      createRun(db, "run-b", "projectB", "cli"); setRunThread(db, "run-b", "pm-b");
      const startedA = await triggers.start({ projectId: "projectA", workflowId: "lp.plan", inputs: { goal: "A" }, source: "manual" });
      expect(startedA, JSON.stringify(startedA)).toMatchObject({ ok: true });
      await engine.idle();
      const runA = (startedA as { runId: string }).runId;
      expect(engine.snapshot(runA)!.run.definition_json).toContain("hook-plan-pre-done-0-0");
      const startedB = await triggers.start({ projectId: "projectB", workflowId: "lp.plan", inputs: { goal: "B" }, source: "manual" });
      expect(startedB).toMatchObject({ ok: true });
      await engine.idle();
      const runB = (startedB as { runId: string }).runId;
      expect(engine.snapshot(runB)!.run.definition_json).not.toContain("hook-plan-pre-");
      expect(await triggers.start({ projectId: "broken", workflowId: "lp.plan", inputs: { goal: "x" }, source: "manual" })).toMatchObject({ ok: false, reason: "loop_hooks_invalid" });
      expect(await triggers.start({ projectId: "offline", workflowId: "lp.plan", inputs: { goal: "x" }, source: "manual" })).toMatchObject({ ok: false });
      expect(await triggers.start({ projectId: "mismatch", workflowId: "lp.plan", inputs: { goal: "x" }, source: "manual" })).toMatchObject({ ok: false });
    } finally { engine.dispose(); db.close(); }
  });
});
