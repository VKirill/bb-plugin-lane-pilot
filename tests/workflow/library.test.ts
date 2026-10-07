import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseLpSignal } from "../../src/realtime-channel";
import { createWorkflowLibrary, clipJson } from "../../src/server/workflow-library";
import type { ServerCore } from "../../src/server/core";
import type { Services } from "../../src/server/services";
import { parseWorkflow } from "../../src/workflow/validate";
import { conditionText, roleTone, workflowView } from "../../src/workflow/view";
import { engineOn, journalDb, ok, wf } from "./engine-helpers";
import { workflow } from "./fixtures";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

/** A review loop: a decision with labelled, conditional edges and a loop bounded by maxVisits. */
const reviewFix = (id = "review-fix", extra: Record<string, unknown> = {}) => workflow({
  id, name: "Review and fix", status: "published",
  nodes: [
    { id: "build", type: "agent", role: "builder", prompt: "Build the thing   described\nin the task.", maxVisits: 3, output: [{ name: "done", type: "boolean" }] },
    { id: "review", type: "agent", role: "reviewer", prompt: "Review the build.", output: [{ name: "verdict", type: "enum", values: ["pass", "rework"] }] },
    { id: "ship", type: "action", action: "ship", output: [{ name: "text", type: "string" }] },
  ],
  edges: [
    { from: "start", to: "build" },
    { from: "build", to: "review", pass: "read-prior-session" },
    { from: "review", to: "build", when: { field: "verdict", op: "eq", value: "rework" }, label: "again" },
    { from: "review", to: "ship", when: "review.verdict == 'pass'" },
    { from: "ship", to: "end", with: { result: "ship.text" } },
  ],
  ...extra,
});

async function library(options: { files?: Array<{ path: string; content: string }> | Error; globalFiles?: Record<string, string> } = {}) {
  const db = journalDb();
  const globalDir = await mkdtemp(join(tmpdir(), "lp-wf-global-"));
  dirs.push(globalDir);
  for (const [name, text] of Object.entries(options.globalFiles ?? {})) await writeFile(join(globalDir, name), text);
  const hostCalls: unknown[] = [];
  const ctx = {
    db, log: () => undefined,
    host: { call: async (method: string, input: unknown) => {
      hostCalls.push({ method, input });
      if (options.files instanceof Error) throw options.files;
      return { hostId: "host_1", files: options.files ?? [] };
    } },
  } as unknown as ServerCore;
  const engine = engineOn(db, { "agent": ok(() => ({ handoff: "done", verdict: "pass", done: true })), ship: ok(() => ({ text: "shipped" })) }, { resolveWorkflow: () => null });
  const services = { workflowEngine: engine, docsPlaces: async () => [{ hostId: "host_1", path: "/work/proj", scopes: [], name: "Proj" }] } as unknown as Services;
  return { db, engine, hostCalls, lib: createWorkflowLibrary(ctx, services, { globalDir }) };
}

describe("workflow view model", () => {
  it("writes a condition the way an owner reads it", () => {
    expect(conditionText({ field: "verdict", op: "eq", value: "rework" })).toBe("verdict == 'rework'");
    expect(conditionText({ all: [{ field: "items.length", op: "lt", value: 5 }, { any: [{ field: "a", op: "exists" }, { not: { field: "b", op: "in", value: ["x"] } }] }] }))
      .toBe("items.length < 5 && (a exists || !(b in [\"x\"]))");
    expect(conditionText("  build.status ==\n 'done' ")).toBe("build.status == 'done'");
    expect(conditionText(undefined)).toBeNull();
  });

  it("colours an agent by what its role does", () => {
    expect([roleTone("pm-reader"), roleTone("builder"), roleTone("qa-browser"), roleTone("plan-critic"), roleTone("specialist"), roleTone(null)])
      .toEqual(["plan", "build", "qa", "review", "agent", "agent"]);
  });

  it("draws the lowered graph: entry and exit nodes, labelled edges, passing modes, excerpts", () => {
    const view = workflowView(parseWorkflow(reviewFix()));
    expect(view.nodes.map((node) => node.id)).toEqual(["$start", "build", "review", "ship", "$end"]);
    const build = view.nodes.find((node) => node.id === "build")!;
    expect(build).toMatchObject({ kind: "agent", tone: "build", role: "builder", excerpt: "Build the thing described in the task.", maxVisits: 3 });
    expect(view.edges.find((edge) => edge.from === "build")).toMatchObject({ to: "review", pass: "read-prior-session" });
    expect(view.edges.find((edge) => edge.label === "again")).toMatchObject({ from: "review", to: "build", when: "verdict == 'rework'" });
    expect(view.edges.find((edge) => edge.to === "ship")!.when).toBe("review.verdict == 'pass'");
    expect(view.edges.find((edge) => edge.to === "$end")!.carries).toEqual(["result"]);
  });

  it("shows a subworkflow node with the workflow it calls", () => {
    const child = parseWorkflow(workflow({ id: "child", internal: true }));
    const parent = parseWorkflow(workflow({
      id: "parent",
      nodes: [{ id: "call", type: "subworkflow", workflow: "child", inputs: { query: "input.query" }, output: [{ name: "result", type: "string" }] }],
      edges: [{ from: "start", to: "call", with: { query: "input.query" } }, { from: "call", to: "end", with: { result: "call.result" } }],
    }), );
    void child;
    expect(workflowView(parent).nodes.find((node) => node.id === "call")).toMatchObject({ kind: "subworkflow", tone: "sub", calls: { id: "child", version: null } });
  });
});

describe("workflow library", () => {
  it("lists built-in, global and project workflows with scope, status and stats, and reports a broken file", async () => {
    const { lib, db, hostCalls } = await library({
      globalFiles: { "review-fix.json": JSON.stringify(reviewFix()), "broken.json": "{ not json" },
      files: [{ path: "x-digest.json", content: JSON.stringify(workflow({ id: "x-digest", name: "X digest", status: "tested" })) }],
    });
    const result = await lib.list({ projectId: "proj_1" });
    expect(hostCalls).toEqual([{ method: "listWorkflowFiles", input: { requestedHostId: "host_1", projectCwd: "/work/proj" } }]);
    expect(result.project).toBe("ok");
    const byId = Object.fromEntries(result.workflows.map((row) => [row.id, row]));
    expect(byId["analyze-plan-execute"]).toMatchObject({ scope: "builtin" });
    expect(byId["review-fix"]).toMatchObject({ scope: "global", status: "published", nodes: 3 });
    expect(byId["x-digest"]).toMatchObject({ scope: "project", status: "tested" });
    expect(result.problems.map((row) => [row.origin, row.source.endsWith("broken.json")])).toEqual([["global", true]]);

    // Stats come from the journal and follow the project filter.
    const def = JSON.stringify(parseWorkflow(reviewFix()));
    const insert = (id: string, status: string, project: string | null, at: number) => db.prepare(`INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(id, "review-fix", 1, "x", def, project, status, at, at);
    insert("r1", "succeeded", "proj_1", 10); insert("r2", "failed", "proj_1", 20); insert("r3", "succeeded", "proj_2", 30); insert("r4", "running", "proj_1", 40); insert("r5", "canceled", "proj_1", 50);
    const scoped = (await lib.list({ projectId: "proj_1" })).workflows.find((row) => row.id === "review-fix")!.stats;
    expect(scoped).toEqual({ runs: 4, succeeded: 1, failed: 1, active: 1, successRate: 0.5, lastRunAt: 50, lastStatus: "canceled", lastRunId: "r5" });
    const everywhere = (await lib.list({})).workflows.find((row) => row.id === "review-fix")!.stats;
    expect(everywhere).toMatchObject({ runs: 5, succeeded: 2, failed: 1, successRate: 2 / 3 });
    expect((await lib.list({})).project).toBe("not_requested");
  });

  it("says so when the project's machine cannot be read, and still lists the rest", async () => {
    const { lib } = await library({ files: new Error("machine offline") });
    const result = await lib.list({ projectId: "proj_1" });
    expect(result.project).toBe("unavailable");
    expect(result.workflows.map((row) => row.id)).toContain("analyze-plan-execute");
  });

  it("answers one workflow with its graph, fields and recent runs, and null for an unknown id", async () => {
    const { lib } = await library({ globalFiles: { "review-fix.json": JSON.stringify(reviewFix()) } });
    const { workflow: detail } = await lib.get({ id: "review-fix" });
    expect(detail).toMatchObject({ id: "review-fix", scope: "global", outputs: [{ name: "result", type: "string", required: true }], runs: [] });
    expect(detail!.graph.nodes).toHaveLength(5);
    expect(detail!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await lib.get({ id: "nope" })).workflow).toBeNull();
    const builtin = (await lib.get({ id: "lp-task-pipeline" })).workflow!;
    expect(builtin.graph.nodes.some((node) => node.kind === "lp-task" && node.stages.length > 0)).toBe(true);
  });
});

describe("workflow run snapshot", () => {
  it("returns the pinned graph, each step with its state, thread and handoff, and the event tail", async () => {
    const { lib, engine } = await library();
    const definition = wf(JSON.parse(JSON.stringify(reviewFix("snap"))) as never);
    const started = engine.start({ workflow: definition, inputs: { query: "q" }, link: { projectId: "proj_1" } });
    await started.done;
    const { snapshot } = lib.runSnapshot({ runId: started.runId });
    expect(snapshot!.run).toMatchObject({ id: started.runId, workflowId: "snap", status: "succeeded", projectId: "proj_1" });
    expect(snapshot!.graph.nodes.map((node) => node.id)).toContain("review");
    const review = snapshot!.steps.find((step) => step.nodeId === "review")!;
    expect(review).toMatchObject({ state: "succeeded", handoff: "done", output: { verdict: "pass" }, threadId: null });
    expect(snapshot!.steps.every((step) => step.state === "succeeded")).toBe(true);
    expect(snapshot!.events.length).toBeGreaterThan(3);
    expect(lib.runSnapshot({ runId: "missing" }).snapshot).toBeNull();
  });

  it("clips a large output to a preview", () => {
    expect(clipJson({ a: 1 })).toEqual({ a: 1 });
    const big = clipJson({ text: "x".repeat(10_000) }) as { truncated: boolean; preview: string };
    expect(big.truncated).toBe(true);
    expect(big.preview.length).toBeLessThan(2_000);
  });
});

describe("workflow signals", () => {
  const executors = () => ({ agent: ok(() => ({ handoff: "h", verdict: "pass", done: true })), ship: ok(() => ({ text: "t" })) });

  it("tells a watcher after every journal event, and the signal carries the run", async () => {
    const db = journalDb();
    const seen: string[] = [];
    const engine = engineOn(db, executors(), { onEvent: (runId) => { seen.push(runId); } });
    const started = engine.start({ workflow: wf(JSON.parse(JSON.stringify(reviewFix("sig"))) as never), inputs: { query: "q" } });
    await started.done;
    expect(seen.length).toBeGreaterThan(3);
    expect(new Set(seen)).toEqual(new Set([started.runId]));
    expect(parseLpSignal({ kind: "workflow", runId: "wfrun_1" })).toEqual({ kind: "workflow", runId: "wfrun_1" });
  });

  it("a failing listener never fails the run", async () => {
    const db = journalDb();
    const engine = engineOn(db, executors(), { onEvent: () => { throw new Error("boom"); } });
    const started = engine.start({ workflow: wf(JSON.parse(JSON.stringify(reviewFix("sig2"))) as never), inputs: { query: "q" } });
    expect((await started.done).status).toBe("succeeded");
  });
});
