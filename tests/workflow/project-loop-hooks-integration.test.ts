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
import { createAutoStages } from "../../src/rooms/phase/server/auto-stages";
import type { Phase } from "../../src/rooms/phase/logic";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { workflow } from "./fixtures";
import { engineOn, journalDb, trust } from "./engine-helpers";

const filesToRemove: string[] = [];
afterEach(async () => { await Promise.all(filesToRemove.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const hookChild = (id: string, value: string, requires?: Record<string, unknown>) => parseWorkflow(workflow({
  id, status: "published", ...(requires ? { requires } : {}), inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }],
  nodes: [
    { id: "ask", type: "human", question: "Run this project check?", options: ["yes", "no"], output: [{ name: "answer", type: "string" }] },
    { id: "done", type: "action", action: "emit", map: { status: `'${value}'` } },
  ], edges: [{ from: "start", to: "ask" }, { from: "ask", to: "done" }],
}));

const rootWorkflow = (id = "lp.plan") => parseWorkflow(workflow({
  id, status: "published", inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }], triggers: [{ type: "manual" }],
  nodes: [{ id: "done", type: "action", action: "emit", map: { status: "'original-root'" } }], edges: [{ from: "start", to: "done" }],
}));

const nestedRootWorkflow = () => parseWorkflow(workflow({
  id: "full-lifecycle", status: "published", inputs: [{ name: "goal", type: "string" }], outputs: [{ name: "status", type: "string" }], triggers: [{ type: "manual" }],
  nodes: [
    { id: "plan", type: "subworkflow", workflow: "lp.plan", inputs: { goal: "$inputs.goal" } },
    { id: "done", type: "action", action: "emit", map: { status: "'nested-root'" } },
  ], edges: [{ from: "start", to: "plan" }, { from: "plan", to: "done" }],
}));

const manifestText = (workflowId = "project-check") => JSON.stringify({ schemaVersion: 1, hooks: {
  "plan:pre": [{ workflow: workflowId, inputs: { goal: "$inputs.goal" } }], "verify:post": [], "ship:post": [],
} });

describe("project loop hooks: engine integration", () => {
  it("does not let a shared child cache bypass a deeper transitive depth refusal", () => {
    const leaf = parseWorkflow(workflow({ id: "shared-leaf", status: "published", nodes: [{ id: "call", type: "subworkflow", workflow: "too-deep", inputs: {} }, { id: "done", type: "action", action: "emit", map: { result: "'ok'" } }], edges: [{ from: "start", to: "call" }, { from: "call", to: "done" }] }));
    const tooDeep = parseWorkflow(workflow({ id: "too-deep", status: "published" }));
    const shared = parseWorkflow(workflow({ id: "shared", status: "published", nodes: [{ id: "call", type: "subworkflow", workflow: "shared-leaf", inputs: {} }, { id: "done", type: "action", action: "emit", map: { result: "'ok'" } }], edges: [{ from: "start", to: "call" }, { from: "call", to: "done" }] }));
    const wrapper = parseWorkflow(workflow({ id: "deep-wrapper", status: "published", nodes: [{ id: "call", type: "subworkflow", workflow: "shared", inputs: {} }, { id: "done", type: "action", action: "emit", map: { result: "'ok'" } }], edges: [{ from: "start", to: "call" }, { from: "call", to: "done" }] }));
    const root = parseWorkflow(workflow({ id: "full", status: "published", nodes: [
      { id: "shallow", type: "subworkflow", workflow: "shared", inputs: {} },
      { id: "deep", type: "subworkflow", workflow: "deep-wrapper", inputs: {} },
      { id: "done", type: "action", action: "emit", map: { result: "'ok'" } },
    ], edges: [{ from: "start", to: "shallow" }, { from: "shallow", to: "deep" }, { from: "deep", to: "done" }] }));
    const check = parseWorkflow(workflow({ id: "project-check", status: "published" }));
    const all = new Map([root, shared, leaf, tooDeep, wrapper, check].map((item) => [item.id, item]));
    const parsed = parseLoopHookManifest(manifestText());
    expect(() => prepareLoopWorkflow({ workflow: root, manifest: parsed.manifest, manifestSha256: parsed.sha256, resolve: (id) => all.get(id) ?? null })).toThrow(/depth limit/);
  });

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
    const projectPaths: Record<string, string> = { projectA: "/work/a", projectB: "/work/b", nestedMissing: "/work/nested", broken: "/work/broken", offline: "/work/offline", mismatch: "/work/mismatch" };
    const projectFiles: Record<string, Array<{ path: string; content: string }>> = {
      projectA: [
        { path: "lp.plan.json", content: JSON.stringify(rootWorkflow()) },
        { path: "project-check.json", content: JSON.stringify(hookChild("project-check", "hook", { skills: ["project-check-skill"] })) },
        { path: "loop-hooks.manifest.json", content: manifestText() },
      ],
      projectB: [{ path: "lp.plan.json", content: JSON.stringify(rootWorkflow()) }],
      nestedMissing: [
        { path: "full-lifecycle.json", content: JSON.stringify(nestedRootWorkflow()) },
        { path: "lp.plan.json", content: JSON.stringify(rootWorkflow()) },
        { path: "project-check.json", content: JSON.stringify(hookChild("project-check", "hook", { skills: ["project-check-skill"] })) },
        { path: "loop-hooks.manifest.json", content: manifestText() },
      ],
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
    trust(db, hookChild("project-check", "hook", { skills: ["project-check-skill"] }));
    trust(db, nestedRootWorkflow());
    const services = { workflowEngine: engine, docsPlaces: async (projectId: string) => [{ hostId: "host_1", path: projectPaths[projectId] ?? projectPaths.projectB, scopes: [], name: projectId }] } as unknown as Services;
    const globalDir = await mkdtemp(join(tmpdir(), "lp-loop-hooks-global-"));
    filesToRemove.push(globalDir);
    const library = createWorkflowLibrary(ctx, services, { globalDir });
    const admitted: Array<{ requires: { skills: string[] } }> = [];
    const triggers = createWorkflowTriggers(ctx, services, {
      loadStore: (projectId) => library.loadStore(projectId),
      preflight: async (wf, input) => { admitted.push({ requires: wf.requires }); return input.projectId === "nestedMissing" ? { ok: false, issues: [{ level: "missing", kind: "skill", name: "project-check-skill", message: "missing project-check-skill" }], envRequests: [], checked: [] } : { ok: true, issues: [], envRequests: [], checked: [] }; },
    });
    try {
      createRun(db, "run-a", "projectA", "cli"); setRunThread(db, "run-a", "pm-a");
      createRun(db, "run-b", "projectB", "cli"); setRunThread(db, "run-b", "pm-b");
      const startedA = await triggers.start({ projectId: "projectA", workflowId: "lp.plan", inputs: { goal: "A" }, source: "manual" });
      expect(startedA, JSON.stringify(startedA)).toMatchObject({ ok: true });
      await engine.idle();
      const runA = (startedA as { runId: string }).runId;
      expect(engine.snapshot(runA)!.run.definition_json).toContain("hook-plan-pre-done-0-0");
      expect(admitted[0]!.requires.skills).toContain("project-check-skill");
      const startedB = await triggers.start({ projectId: "projectB", workflowId: "lp.plan", inputs: { goal: "B" }, source: "manual" });
      expect(startedB).toMatchObject({ ok: true });
      await engine.idle();
      const runB = (startedB as { runId: string }).runId;
      expect(engine.snapshot(runB)!.run.definition_json).not.toContain("hook-plan-pre-");
      const refusedNested = await triggers.start({ projectId: "nestedMissing", workflowId: "full-lifecycle", inputs: { goal: "nested" }, source: "manual" });
      expect(refusedNested).toMatchObject({ ok: false, reason: "requirements_missing" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM lane_pilot_wf_run WHERE project_id=?").get("nestedMissing")).toEqual({ count: 0 });
      expect(await triggers.start({ projectId: "broken", workflowId: "lp.plan", inputs: { goal: "x" }, source: "manual" })).toMatchObject({ ok: false, reason: "loop_hooks_invalid" });
      expect(await triggers.start({ projectId: "offline", workflowId: "lp.plan", inputs: { goal: "x" }, source: "manual" })).toMatchObject({ ok: false });
      expect(await triggers.start({ projectId: "mismatch", workflowId: "lp.plan", inputs: { goal: "x" }, source: "manual" })).toMatchObject({ ok: false });
    } finally { engine.dispose(); db.close(); }
  });

  it("holds an automatic phase stage on missing composed requirements before engine.start", async () => {
    const phase = { id: "ph_requirements", projectId: "projectA", pmThreadId: "pm", runId: "run", title: "requirements", goal: "goal", stage: "discussion", state: "active", record: {}, edition: 1, createdAt: 1, updatedAt: 1 } as unknown as Phase;
    let starts = 0;
    let composed = true;
    let preflightCalls = 0;
    const booked: string[] = [];
    const auto = createAutoStages({ log: () => undefined }, { workflowEngine: {
      resolveWorkflow: (id: string) => builtinWorkflow(id),
      start: () => { starts += 1; return { runId: "unexpected", created: true, done: new Promise(() => undefined) }; },
      get: () => null,
    } } as never, {
      exhausted: async () => undefined,
      api: { context: async () => phase, plan: () => phase, planCheck: async () => phase, question: () => phase, waveReview: () => phase, goalAudit: () => phase, lessons: () => phase, drawing: async () => phase, returnTo: () => phase },
      get: () => phase,
      save: () => undefined,
      book: (_phase, _section, kind) => { booked.push(kind); },
      writeDocs: async () => ({ written: [] }),
      runtime: () => ({}),
      pmIdle: async () => true,
      now: () => 1,
      prepareWorkflow: async (_phase, workflow) => ({ workflow, resolve: builtinWorkflow, composed }),
      preflight: async () => { preflightCalls += 1; return { ok: false, reason: "missing project-check-skill" }; },
    });
    expect(await auto.step(phase)).toBe(true);
    expect(starts).toBe(0);
    expect(booked).toContain("auto_waiting_requirements");
    composed = false;
    expect(await auto.step(phase)).toBe(true);
    expect(starts).toBe(1);
    expect(preflightCalls).toBe(1);
  });
});
