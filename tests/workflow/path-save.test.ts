import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadWorkflow, parseWorkflow, type Workflow } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { type Services } from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { recordTrajectoryDelta } from "../../src/rooms/errands/server";
import { listPathCandidates } from "../../src/rooms/lead/server";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import { registerCli } from "../../src/rooms/tools/server";
import {
  createWorkflowArchitect,
  saveBranch,
  savePath,
  setRunVerdict,
  type ArchitectDeps,
} from "../../src/rooms/workflow/server";
import { workflow } from "./fixtures";

let dispose: (() => Promise<void> | void) | null = null;

afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function insertWfRun(
  db: ReturnType<typeof openDatabase>,
  patch: Partial<{
    id: string;
    workflow_id: string;
    workflow_version: number;
    project_id: string | null;
    parent_run_id: string | null;
    status: string;
    definition_json: string;
    inputs_json: string;
    output_json: string | null;
    created_at: number;
    updated_at: number;
  }> = {},
): string {
  const id = patch.id ?? `wfrun_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, parent_run_id, status, inputs_json, output_json, created_at, updated_at)
     VALUES (?, ?, ?, 'sha', ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    patch.workflow_id ?? "errand",
    patch.workflow_version ?? 1,
    patch.definition_json ?? "{}",
    patch.project_id === undefined ? "proj-1" : patch.project_id,
    patch.parent_run_id ?? null,
    patch.status ?? "succeeded",
    patch.inputs_json ?? "{}",
    patch.output_json ?? null,
    patch.created_at ?? 1000,
    patch.updated_at ?? 2000,
  );
  return id;
}

function insertWfStep(
  db: ReturnType<typeof openDatabase>,
  input: {
    runId: string;
    nodeId: string;
    state?: string;
    output?: unknown;
    receipt?: unknown;
    startedAt?: number;
  },
) {
  db.prepare(
    `INSERT INTO lane_pilot_wf_step
      (run_id, step_key, origin, node_id, visit, state, output_json, receipt_json, started_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    `${input.nodeId}#1`,
    `origin:${input.nodeId}#1`,
    input.nodeId,
    input.state ?? "succeeded",
    input.output === undefined ? null : JSON.stringify(input.output),
    input.receipt === undefined ? null : JSON.stringify(input.receipt),
    input.startedAt ?? 1100,
    (input.startedAt ?? 1100) + 1,
  );
}

function insertEpisode(
  db: ReturnType<typeof openDatabase>,
  input: {
    runId: string;
    projectId?: string | null;
    workflowId?: string;
    trace: string[];
    createdAt?: number;
  },
) {
  const ts = input.createdAt ?? 2000;
  db.prepare(
    `INSERT INTO lane_pilot_errand_episode
      (run_id, extractor_version, project_id, workflow_id, status, outcome, trace_json, created_at, updated_at)
     VALUES (?, 1, ?, ?, 'succeeded', 'done', ?, ?, ?)`,
  ).run(
    input.runId,
    input.projectId === undefined ? "proj-1" : input.projectId,
    input.workflowId ?? "errand",
    JSON.stringify(input.trace),
    ts,
    ts,
  );
}

function setupWorld(library: Workflow[] = []) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const deps: ArchitectDeps = {
    globalDir: () => "/tmp/lp-path-save-global",
    projectPlace: async () => null,
    writeProjectFile: async () => ({ status: "applied", path: "/tmp/x.json", afterSha256: "abc", reason: null }),
    capabilityPorts: () => ({} as ReturnType<ArchitectDeps["capabilityPorts"]>),
    hasExecutor: () => true,
    loadLibraryWorkflows: async () => library,
  };
  const architect = createWorkflowArchitect(ctx, { workflowEngine: { hasExecutor: () => true } } as never, deps);
  return { bb, harness, db, ctx, architect };
}

describe("savePath (Task 15)", () => {
  it("opens a draft from a one-run errand with status=draft, sourceRunIds, brief fields (no values), and no repeat threshold", async () => {
    const { harness, db, ctx, architect } = setupWorld();
    const runId = insertWfRun(db, {
      id: "err_run_1",
      workflow_id: "errand",
      project_id: "proj-1",
      status: "succeeded",
      inputs_json: JSON.stringify({ title: "Collect weekly invoice PDF", task: "Download invoice and save summary" }),
      created_at: 10_000,
      updated_at: 12_000,
    });
    insertWfStep(db, {
      runId,
      nodeId: "errand",
      output: { state: "done", invoice_path: "SECRET_OUTPUT_VALUE_DO_NOT_LEAK", total_cents: 4200 },
      startedAt: 10_500,
    });
    insertEpisode(db, {
      runId,
      projectId: "proj-1",
      workflowId: "errand",
      trace: ["agent:researcher", "action:invoice:fetch", "action:emit"],
      createdAt: 12_000,
    });
    recordTrajectoryDelta(db, {
      projectId: "proj-1",
      threadId: "thr_pm_1",
      workflowId: "errand",
      stageArchetype: "invoice_filter",
      interventionKind: "rule_added",
      rawSummary: "Skip zero-amount credit memos",
      now: 11_000,
    });
    setRunVerdict(db, {
      runId,
      workflowId: "errand",
      graphVersion: 1,
      verdict: "accept",
      source: "owner",
      note: "Worked cleanly",
      decidedAt: 12_500,
    });

    const res = await savePath(
      ctx,
      { architect },
      { runId, note: "Parameterize vendor name", projectId: "proj-1", threadId: "thr_pm_1" },
    );
    expect(res).toEqual({ ok: true, draftId: expect.any(String) });
    if (!res.ok) throw new Error("expected ok");

    const loaded = architect.get({ projectId: "proj-1", draftId: res.draftId });
    if (!("draft" in loaded)) throw new Error("expected draft detail");
    expect(loaded.draft.status).toBe("draft");
    expect(loaded.metadata).toMatchObject({
      source: "path-capture",
      sourceRunIds: [runId],
    });
    const brief = String(loaded.metadata?.brief ?? "");
    expect(brief.length).toBeLessThanOrEqual(4000);
    expect(brief).toContain("Collect weekly invoice PDF");
    expect(brief).toContain("agent:researcher");
    expect(brief).toContain("invoice_path");
    expect(brief).toContain("total_cents");
    expect(brief).not.toContain("SECRET_OUTPUT_VALUE_DO_NOT_LEAK");
    expect(brief).toContain("the owner changed invoice-filter (rule_added): Skip zero-amount credit memos");
    expect(brief).toContain("Owner verdict: accept");
    expect(brief).toContain("Parameterize vendor name");
    expect(brief).toContain("turn this into a graph of contracted steps: typed inputs/outputs, effect per step, a code verify wherever the output is checkable; keep values as inputs, not constants");

    const infoLogs = harness.logEntries.filter((e) => e.level === "info").map((e) => e.message);
    expect(infoLogs.some((m) => m.includes(`path save run=${runId} draft=${res.draftId}`))).toBe(true);
  });

  it("refuses unfinished runs, child runs, missing traces, and missing architect", async () => {
    const { harness, db, ctx, architect } = setupWorld();
    const runningId = insertWfRun(db, { id: "run_live", status: "running" });
    const parentId = insertWfRun(db, { id: "run_parent", status: "succeeded" });
    const childId = insertWfRun(db, { id: "run_child", parent_run_id: parentId, status: "succeeded" });
    const emptyErrandId = insertWfRun(db, { id: "err_empty", workflow_id: "errand", status: "succeeded" });

    expect(await savePath(ctx, { architect }, { runId: runningId, projectId: "proj-1" })).toEqual({
      ok: false,
      reason: "run_not_finished",
    });
    expect(await savePath(ctx, { architect }, { runId: childId, projectId: "proj-1" })).toEqual({
      ok: false,
      reason: "run_not_finished",
    });
    expect(await savePath(ctx, { architect }, { runId: emptyErrandId, projectId: "proj-1" })).toEqual({
      ok: false,
      reason: "no_trace",
    });
    expect(await savePath(ctx, { architect }, { runId: "nonexistent", projectId: "proj-1" })).toEqual({
      ok: false,
      reason: "no_trace",
    });

    const wfRunId = insertWfRun(db, {
      id: "wf_steps_only",
      workflow_id: "custom-flow",
      status: "succeeded",
      definition_json: JSON.stringify({
        nodes: [{ id: "fetch", type: "agent", role: "analyst", effect: "R" }],
      }),
      inputs_json: JSON.stringify({ brief: "Analyze metrics" }),
    });
    insertWfStep(db, {
      runId: wfRunId,
      nodeId: "fetch",
      output: { metric_count: 7, summary: "PRIVATE_STEP_TEXT" },
    });

    expect(await savePath(ctx, { architect: null }, { runId: wfRunId, projectId: "proj-1" })).toEqual({
      ok: false,
      reason: "architect_unavailable",
    });

    // Non-errand without episode row falls back to run's own step list without leaking output values.
    const saved = await savePath(ctx, { architect }, { runId: wfRunId, projectId: "proj-1" });
    expect(saved).toEqual({ ok: true, draftId: expect.any(String) });
    if (saved.ok) {
      const detail = architect.get({ projectId: "proj-1", draftId: saved.draftId });
      if (!("draft" in detail)) throw new Error("expected draft detail");
      const brief = String(detail.metadata?.brief ?? "");
      expect(brief).toContain("fetch [agent:analyst]");
      expect(brief).toContain("metric_count");
      expect(brief).not.toContain("PRIVATE_STEP_TEXT");
    }

    const warnLogs = harness.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
    expect(warnLogs.some((m) => m.includes(`path save refused run=${runningId}: run_not_finished`))).toBe(true);
  });

  it("refuses near-twin of a published graph with reason=near_twin, workflowId, and suggestion=branch", async () => {
    const published = parseWorkflow(
      workflow({
        id: "existing-report-flow",
        nodes: [
          { id: "search", type: "agent", role: "researcher", prompt: "Search", out: [{ name: "items", type: "array" }] },
          { id: "write", type: "agent", role: "writer", prompt: "Write", out: [{ name: "text", type: "string" }] },
          { id: "done", type: "action", action: "emit", map: { result: "write.text" } },
        ],
        edges: [
          { from: "start", to: "search" },
          { from: "search", to: "write" },
          { from: "write", to: "done" },
        ],
      }),
    );

    const { db, ctx, architect } = setupWorld([published]);
    const runId = insertWfRun(db, {
      id: "err_twin",
      workflow_id: "errand",
      project_id: "proj-1",
      status: "succeeded",
      inputs_json: JSON.stringify({ task: "Research and write report" }),
    });
    insertEpisode(db, {
      runId,
      trace: ["agent:researcher", "agent:writer", "action:emit"],
    });

    const res = await savePath(ctx, { architect }, { runId, projectId: "proj-1" });
    expect(res).toEqual({
      ok: false,
      reason: "near_twin",
      workflowId: "existing-report-flow",
      suggestion: "branch",
    });
    expect(architect.get({ projectId: "proj-1" }).drafts).toHaveLength(0);
  });

  it("automatically includes the source run in the draft's test cases when sourceRunIds is set", async () => {
    const { db, ctx, architect } = setupWorld();
    const runId = insertWfRun(db, {
      id: "err_source_1",
      workflow_id: "errand",
      project_id: "proj-1",
      status: "succeeded",
      inputs_json: JSON.stringify({ task: "Summarize release notes" }),
    });
    insertWfStep(db, {
      runId,
      nodeId: "errand",
      output: { summary: "v1.2 ready" },
    });
    insertEpisode(db, {
      runId,
      trace: ["agent:analyst", "action:emit"],
    });

    const saved = await savePath(ctx, { architect }, { runId, projectId: "proj-1" });
    expect(saved.ok).toBe(true);
    if (!saved.ok) throw new Error("expected draft");

    const patched = architect.patch({
      projectId: "proj-1",
      draftId: saved.draftId,
      ops: [
        { op: "set_meta", set: { inputs: [{ name: "task", type: "string" }], outputs: [{ name: "summary", type: "string" }] } },
        {
          op: "add_node",
          node: {
            id: "summarize",
            type: "agent",
            role: "analyst",
            effect: "R",
            prompt: "Summarize",
            out: [{ name: "summary", type: "string" }],
          },
        },
        { op: "add_node", node: { id: "done", type: "action", action: "emit", map: { summary: "summarize.summary" } } },
        { op: "add_edge", edge: { from: "start", to: "summarize" } },
        { op: "add_edge", edge: { from: "summarize", to: "done" } },
      ],
    });
    expect(patched.ok).toBe(true);

    const tested = await architect.test({ projectId: "proj-1", draftId: saved.draftId });
    expect(tested.ran).toBe(true);
    expect(tested.green).toBe(true);
    if (!("cases" in tested)) throw new Error("expected cases");
    expect(tested.cases.map((c) => c.caseId)).toContain(`replay:${runId}`);
  });

  it("registers lane_pilot_path_save PM tool and bb lane-pilot path save CLI command", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();

    const tool = harness.registrations.agentTools.find((t) => t.name === "lane_pilot_path_save");
    expect(tool).toBeDefined();

    const db = bb.storage.database();
    const run1 = insertWfRun(db, {
      id: "err_tool_1",
      workflow_id: "errand",
      project_id: "proj-pm",
      status: "succeeded",
      inputs_json: JSON.stringify({ task: "Fetch daily KPIs" }),
    });
    insertEpisode(db, { runId: run1, projectId: "proj-pm", trace: ["agent:analyst", "action:kpi:read"] });

    const toolRes = JSON.parse(
      String(
        await harness.behavior.callAgentTool(
          "lane_pilot_path_save",
          { runId: run1, note: "From PM chat" },
          { threadId: "pm_thr_1", projectId: "proj-pm" },
        ),
      ),
    ) as { ok: boolean; draftId?: string };
    expect(toolRes).toEqual({ ok: true, draftId: expect.any(String) });

    const run2 = insertWfRun(db, {
      id: "err_cli_1",
      workflow_id: "errand",
      project_id: "proj-cli",
      status: "succeeded",
      inputs_json: JSON.stringify({ task: "Sync partner leads" }),
    });
    insertEpisode(db, { runId: run2, projectId: "proj-cli", trace: ["agent:errand", "action:crm:sync"] });

    const cliOk = await harness.behavior.runCli(["path", "save", run2, "--note", "Via CLI"]);
    expect(cliOk.exitCode).toBe(0);
    const parsedCli = JSON.parse(cliOk.stdout ?? "{}") as { ok: boolean; draftId?: string };
    expect(parsedCli).toEqual({ ok: true, draftId: expect.any(String) });

    const cliBad = await harness.behavior.runCli(["path", "save", "missing_run"]);
    expect(cliBad.exitCode).toBe(1);
    expect(cliBad.stderr).toContain("no_trace");

    // Minimal registerCli without workflowEngine returns architect_unavailable cleanly.
    const { bb: minBb, harness: minHarness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const minDb = openDatabase(minBb);
    registerCli(createCore(minBb, minDb), {} as Services, migrations);
    const runMin = insertWfRun(minDb, { id: "err_min_1", workflow_id: "errand", project_id: "proj-min", status: "succeeded" });
    insertEpisode(minDb, { runId: runMin, projectId: "proj-min", trace: ["agent:analyst"] });
    const minCli = await minHarness.behavior.runCli(["path", "save", runMin]);
    expect(minCli.exitCode).toBe(1);
    expect(minCli.stderr).toContain("architect_unavailable");
    await minHarness.lifecycle.dispose();
  });
});

function buildDecisionGraph(whenEdgeCount: number) {
  const routes = Array.from({ length: whenEdgeCount }, (_, i) => `route_${i + 1}`);
  const nodes = [
    {
      id: "classify",
      type: "agent",
      role: "analyst",
      effect: "R",
      prompt: "Pick route",
      out: [{ name: "kind", type: "enum", values: routes }],
    },
    { id: "route_gate", type: "decision", reads_node: "classify" },
    ...routes.map((route) => ({
      id: `emit_${route}`,
      type: "action",
      action: "emit",
      map: { result: `classify.kind` },
    })),
    {
      id: "emit_fallback",
      type: "action",
      action: "emit",
      map: { result: `"fallback"` },
    },
  ];
  const edges = [
    { from: "start", to: "classify" },
    { from: "classify", to: "route_gate" },
    ...routes.map((route) => ({
      from: "route_gate",
      to: `emit_${route}`,
      when: `classify.kind == '${route}'`,
    })),
    { from: "route_gate", to: "emit_fallback" },
  ];
  return workflow({
    id: `decision-branches-${whenEdgeCount}`,
    inputs: [{ name: "text", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    nodes,
    edges,
  });
}

describe("saveBranch & branches_into_data (Task 18)", () => {
  it("opens a branch draft seeded with the graph from a ready candidate, exempt from dedup, and runs replay over source + past runs", async () => {
    const baseGraph = parseWorkflow(
      workflow({
        id: "deploy-branch-flow",
        scope: { level: "project", projectId: "proj-1" },
        inputs: [{ name: "target", type: "string" }],
        outputs: [{ name: "status", type: "string" }],
        nodes: [
          {
            id: "check",
            type: "agent",
            role: "analyst",
            effect: "R",
            prompt: "Inspect target",
            out: [{ name: "verdict", type: "enum", values: ["ok", "hotfix"] }],
          },
          {
            id: "done",
            type: "action",
            action: "emit",
            map: { status: "check.verdict" },
          },
        ],
        edges: [
          { from: "start", to: "check" },
          { from: "check", to: "done" },
        ],
      }),
    );

    const { harness, db, ctx, architect } = setupWorld([baseGraph]);
    const now = Date.now();
    const defJson = JSON.stringify(baseGraph);

    // 3 accepted deviations (ready candidate across threads thr_b1..b3)
    const devRuns = ["run_dev_1", "run_dev_2", "run_dev_3"];
    for (let i = 0; i < devRuns.length; i += 1) {
      const threadId = `thr_b${i + 1}`;
      const runId = devRuns[i]!;
      insertWfRun(db, {
        id: runId,
        workflow_id: baseGraph.id,
        project_id: "proj-1",
        status: "succeeded",
        definition_json: defJson,
        inputs_json: JSON.stringify({ target: `app-${i + 1}`, threadId }),
        created_at: now - (5 - i) * 3600_000,
        updated_at: now - (5 - i) * 3600_000 + 500,
      });
      insertWfStep(db, {
        runId,
        nodeId: "check",
        output: { verdict: "ok", handoff: `ok ${i + 1}` },
      });
      recordTrajectoryDelta(db, {
        id: `td_branch_${i + 1}`,
        projectId: "proj-1",
        threadId,
        workflowId: baseGraph.id,
        stageArchetype: "check",
        interventionKind: "rule_added",
        rawSummary: i === 1 ? "  hotfix   skip smoke test " : "Hotfix skip smoke test!",
        now: now - (3 - i) * 86_400_000,
      });
    }

    // Earlier past run of the same graph (no delta on its thread)
    insertWfRun(db, {
      id: "run_past_1",
      workflow_id: baseGraph.id,
      project_id: "proj-1",
      status: "succeeded",
      definition_json: defJson,
      inputs_json: JSON.stringify({ target: "prod", threadId: "thr_past_1" }),
      created_at: now - 10 * 86_400_000,
      updated_at: now - 10 * 86_400_000 + 500,
    });
    insertWfStep(db, {
      runId: "run_past_1",
      nodeId: "check",
      output: { verdict: "ok", handoff: "past ok" },
    });

    const { branch } = listPathCandidates(db, { now, windowDays: 30, repeats: 3, projectId: "proj-1" });
    expect(branch).toHaveLength(1);
    expect(branch[0]!.ready).toBe(true);
    const candidateKey = branch[0]!.key;

    const loadWorkflowFn = (id: string) => (id === baseGraph.id ? baseGraph : null);

    // Below repeat threshold refuses cleanly
    const notReady = await saveBranch(
      ctx,
      { architect, loadWorkflow: loadWorkflowFn, repeats: 4 },
      { graphId: baseGraph.id, candidateKey, projectId: "proj-1", now },
    );
    expect(notReady).toEqual({ ok: false, reason: "not_ready" });

    // Ready candidate opens draft seeded with the graph and exempt from same-graph dedup
    const saved = await saveBranch(
      ctx,
      { architect, loadWorkflow: loadWorkflowFn },
      { graphId: baseGraph.id, candidateKey, projectId: "proj-1", now },
    );
    expect(saved).toEqual({ ok: true, draftId: expect.any(String) });
    if (!saved.ok) throw new Error("expected branch draft");

    const detail = architect.get({ projectId: "proj-1", draftId: saved.draftId });
    if (!("draft" in detail)) throw new Error("expected draft detail");
    expect(detail.draft.status).toBe("draft");
    expect(detail.draft.workflowId).toBe(baseGraph.id);
    expect(detail.metadata).toMatchObject({
      source: "branch-capture",
      branchOf: baseGraph.id,
      candidateKey,
      sourceRunIds: expect.arrayContaining(devRuns),
    });
    const brief = String(detail.metadata?.brief ?? "");
    expect(brief).toContain("rule_added");
    expect(brief).toContain("Hotfix skip smoke test");
    expect(brief).toContain("run_dev_1");
    expect(brief).toContain("add one `decision` branch for this condition; keep every existing path unchanged; add a test case per source run");
    expect((detail.definition.nodes as Array<{ id: string }>).map((n) => n.id)).toEqual(["check", "done"]);

    const infoLogs = harness.logEntries.filter((e) => e.level === "info").map((e) => e.message);
    expect(infoLogs.some((m) => m.includes(`branch draft graph=${baseGraph.id} draft=${saved.draftId} runs=3`))).toBe(true);

    // Replay gate runs source runs AND past runs of the graph
    const tested = await architect.test({ projectId: "proj-1", draftId: saved.draftId });
    expect(tested.ran).toBe(true);
    expect(tested.green).toBe(true);
    if (!("cases" in tested)) throw new Error("expected cases");
    const caseIds = tested.cases.map((c) => c.caseId);
    expect(caseIds).toContain("replay:run_dev_1");
    expect(caseIds).toContain("replay:run_dev_2");
    expect(caseIds).toContain("replay:run_dev_3");
    expect(caseIds).toContain("replay:run_past_1");

    // A regression that breaks a past run turns the draft test red
    const broken = architect.patch({
      projectId: "proj-1",
      draftId: saved.draftId,
      ops: [
        { op: "remove_edge", edge: { from: "check", to: "done" } },
        { op: "add_edge", edge: { from: "check", to: "done", when: "check.verdict == 'hotfix'" } },
      ],
    });
    expect(broken.ok).toBe(true);
    const brokenTest = await architect.test({ projectId: "proj-1", draftId: saved.draftId });
    expect(brokenTest.ran).toBe(true);
    expect(brokenTest.green).toBe(false);
    if (!("cases" in brokenTest)) throw new Error("expected cases");
    const pastCase = brokenTest.cases.find((c) => c.caseId === "replay:run_past_1");
    expect(pastCase?.green).toBe(false);

    // Refusals for missing graph / candidate / architect
    expect(
      await saveBranch(ctx, { architect, loadWorkflow: loadWorkflowFn }, { graphId: "missing-graph", candidateKey }),
    ).toEqual({ ok: false, reason: "unknown_graph" });
    expect(
      await saveBranch(ctx, { architect, loadWorkflow: loadWorkflowFn }, { graphId: baseGraph.id, candidateKey: "branch:missing" }),
    ).toEqual({ ok: false, reason: "candidate_not_found" });
    expect(
      await saveBranch(ctx, { architect: null, loadWorkflow: loadWorkflowFn }, { graphId: baseGraph.id, candidateKey }),
    ).toEqual({ ok: false, reason: "architect_unavailable" });

    const warnLogs = harness.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
    expect(warnLogs.some((m) => m.includes("branch draft refused graph=missing-graph: unknown_graph"))).toBe(true);
    expect(warnLogs.some((m) => m.includes(`branch draft refused graph=${baseGraph.id}: not_ready`))).toBe(true);
  });

  it("supports lane_pilot_path_save { branch } tool and bb lane-pilot path branch CLI", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    dispose = () => harness.lifecycle.dispose();

    const db = bb.storage.database();
    const graphId = "analyze-code";
    const now = Date.now();
    for (let i = 0; i < 3; i += 1) {
      const threadId = `thr_cli_b${i + 1}`;
      insertWfRun(db, {
        id: `run_ac_${i + 1}`,
        workflow_id: graphId,
        project_id: "proj-pm",
        status: "succeeded",
        inputs_json: JSON.stringify({ threadId }),
        created_at: now - 10_000 + i * 100,
        updated_at: now - 9_000 + i * 100,
      });
      recordTrajectoryDelta(db, {
        id: `td_ac_${i + 1}`,
        projectId: "proj-pm",
        threadId,
        workflowId: graphId,
        stageArchetype: "analyze",
        interventionKind: "rule_added",
        rawSummary: "Check migration files too",
        now: now - 5_000 + i * 100,
      });
    }

    const { branch } = listPathCandidates(db, { now, windowDays: 30, repeats: 3, projectId: "proj-pm" });
    expect(branch).toHaveLength(1);
    const candidateKey = branch[0]!.key;

    const toolRes = JSON.parse(
      String(
        await harness.behavior.callAgentTool(
          "lane_pilot_path_save",
          { branch: { graphId, candidateKey } },
          { threadId: "pm_thr_1", projectId: "proj-pm" },
        ),
      ),
    ) as { ok: boolean; draftId?: string };
    expect(toolRes).toEqual({ ok: true, draftId: expect.any(String) });

    const cliOk = await harness.behavior.runCli(["path", "branch", graphId, candidateKey, "--project", "proj-pm"]);
    expect(cliOk.exitCode).toBe(0);
    const parsedCli = JSON.parse(cliOk.stdout ?? "{}") as { ok: boolean; draftId?: string };
    expect(parsedCli).toEqual({ ok: true, draftId: expect.any(String) });

    const cliBad = await harness.behavior.runCli(["path", "branch", graphId, "branch:nope"]);
    expect(cliBad.exitCode).toBe(1);
    expect(cliBad.stderr).toContain("candidate_not_found");
  });

  it("warns branches_into_data for a 7-branch decision graph and stays quiet for a 6-branch graph", () => {
    const six = loadWorkflow(buildDecisionGraph(6));
    expect(six.ok).toBe(true);
    if (!six.ok) throw new Error("expected 6-branch graph to load");
    expect(six.warnings.filter((w) => w.code === "branches_into_data")).toEqual([]);

    const seven = loadWorkflow(buildDecisionGraph(7));
    expect(seven.ok).toBe(true);
    if (!seven.ok) throw new Error("expected 7-branch graph to load");
    const branchWarnings = seven.warnings.filter((w) => w.code === "branches_into_data");
    expect(branchWarnings).toEqual([
      {
        level: "warning",
        code: "branches_into_data",
        message: "move these conditions into a rule table or a card (research R4)",
      },
    ]);
  });
});
