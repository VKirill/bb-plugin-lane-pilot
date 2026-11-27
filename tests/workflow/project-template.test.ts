import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  WorkflowEngine,
  createDraftStore,
  loadWorkflow,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { addRoad, getRoad, listRoad } from "../../src/rooms/lead/server";
import { openDatabase } from "../../src/rooms/plugin-db";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import {
  createProjectTemplateRunner,
  createRunFinished,
  createWorkflowArchitect,
  extractProjectTemplateFromRun,
  registerRunVerdictPort,
  setRunVerdict,
  type ArchitectDeps,
} from "../../src/rooms/workflow/server";
import type { Services } from "../../server";

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
    parent_step_key: string | null;
    depth: number;
    status: string;
    definition_json: string;
    inputs_json: string;
    goals_json: string | null;
    created_at: number;
    updated_at: number;
  }> = {},
): string {
  const id = patch.id ?? `wfrun_${Math.random().toString(36).slice(2, 10)}`;
  db.prepare(
    `INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, parent_run_id, parent_step_key, depth, status, inputs_json, goals_json, created_at, updated_at)
     VALUES (?, ?, ?, 'sha', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    patch.workflow_id ?? "full-lifecycle",
    patch.workflow_version ?? 1,
    patch.definition_json ?? JSON.stringify(builtinWorkflow("full-lifecycle") ?? { id: "full-lifecycle", kind: "project", nodes: [] }),
    patch.project_id === undefined ? "proj-1" : patch.project_id,
    patch.parent_run_id ?? null,
    patch.parent_step_key ?? null,
    patch.depth ?? (patch.parent_run_id ? 1 : 0),
    patch.status ?? "succeeded",
    patch.inputs_json ?? "{}",
    patch.goals_json ?? null,
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
    stepKey?: string;
    state?: string;
    awaitJson?: unknown;
    output?: unknown;
    startedAt?: number;
  },
) {
  const stepKey = input.stepKey ?? `${input.nodeId}#1`;
  const startedAt = input.startedAt ?? 1100;
  db.prepare(
    `INSERT INTO lane_pilot_wf_step
      (run_id, step_key, origin, node_id, visit, state, await_json, output_json, started_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    stepKey,
    `origin:${stepKey}`,
    input.nodeId,
    input.state ?? "succeeded",
    input.awaitJson === undefined ? null : JSON.stringify(input.awaitJson),
    input.output === undefined ? null : JSON.stringify(input.output),
    startedAt,
    startedAt + 1,
  );
}

function insertGoalAuditEvent(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  verdict: "pass" | "gaps" | "not_verified",
) {
  db.prepare(
    `INSERT INTO lane_pilot_wf_event (run_id, step_key, kind, from_state, to_state, detail, at)
     VALUES (?, NULL, 'goal_audit', NULL, ?, ?, ?)`,
  ).run(
    runId,
    verdict,
    JSON.stringify({
      sha: "goals-sha",
      outputSha: "out-sha",
      verdict,
      met: verdict === "pass" ? ["g1"] : [],
      unmet: verdict === "pass" ? [] : [{ id: "g1", why: "missing evidence" }],
    }),
    2000,
  );
}

function setupWorld(library: Workflow[] = []) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const deps: ArchitectDeps = {
    globalDir: () => "/tmp/lp-project-template-global",
    projectPlace: async () => null,
    writeProjectFile: async () => ({ status: "applied", path: "/tmp/x.json", afterSha256: "abc", reason: null }),
    capabilityPorts: () => ({} as ReturnType<ArchitectDeps["capabilityPorts"]>),
    hasExecutor: () => true,
    loadLibraryWorkflows: async () => library,
  };
  const resolveWorkflow = (id: string, version?: number) => builtinWorkflow(id, version, db);
  const engine = new WorkflowEngine({
    db,
    harnessVersion: "1.0.0",
    resolveWorkflow,
  });
  const architect = createWorkflowArchitect(ctx, { workflowEngine: engine } as never, deps);
  const leadRoad = { addRoad, getRoad, listRoad };
  return { bb, harness, db, ctx, engine, architect, leadRoad };
}

function seedFullLifecycleRun(
  db: ReturnType<typeof openDatabase>,
  opts: {
    runId: string;
    projectId?: string;
    audit?: "pass" | "gaps" | "none";
    verdict?: "accept" | "reject" | "none";
    withHuman?: boolean;
    withChildren?: boolean;
    inputs?: Record<string, unknown>;
    goals?: Array<{ id: string; done_when: string; evidence: string; request?: string }>;
  },
) {
  const baseDef = builtinWorkflow("full-lifecycle")!;
  const customHumanNode = {
    id: "pick_design",
    type: "human",
    role: "owner",
    title: { en: "Pick design", ru: "Выбор дизайна" },
    question: "choose 1 of 3 designs",
    options: ["minimal", "editorial", "bold"],
    onTimeout: "stop",
    out: [
      { name: "answer_kind", type: "enum", values: ["minimal", "editorial", "bold", "timeout"], required: true },
      { name: "answer", type: "string", required: false },
    ],
  };
  const defWithHuman = opts.withHuman
    ? { ...baseDef, nodes: [...baseDef.nodes, customHumanNode] }
    : baseDef;

  const runId = insertWfRun(db, {
    id: opts.runId,
    workflow_id: "full-lifecycle",
    workflow_version: 1,
    project_id: opts.projectId ?? "proj-1",
    status: "succeeded",
    definition_json: JSON.stringify(defWithHuman),
    inputs_json: JSON.stringify(
      opts.inputs ?? {
        goal: "SECRET_PROJECT_GOAL_ACME",
        scope: "apps/acme-portal",
        priority: 2,
      },
    ),
    goals_json: JSON.stringify(
      opts.goals ?? [
        {
          id: "g1",
          done_when: "SECRET_GOAL_TEXT_FOR_ACME",
          evidence: "SECRET_EVIDENCE_FOR_ACME",
          request: "SECRET_REQUEST_FOR_ACME",
        },
      ],
    ),
    created_at: 1000,
    updated_at: 5000,
  });

  if (opts.withChildren !== false) {
    insertWfStep(db, { runId, nodeId: "plan", stepKey: "plan#1", startedAt: 1100 });
    insertWfRun(db, {
      id: `${runId}_child_plan`,
      workflow_id: "lp.plan",
      workflow_version: 1,
      project_id: opts.projectId ?? "proj-1",
      parent_run_id: runId,
      parent_step_key: "plan#1",
      inputs_json: JSON.stringify({ goal: "SECRET_PROJECT_GOAL_ACME", mode: "fresh" }),
      created_at: 1100,
    });

    if (opts.withHuman) {
      insertWfStep(db, {
        runId,
        nodeId: "pick_design",
        stepKey: "pick_design#1",
        state: "succeeded",
        awaitJson: { kind: "human", detail: { question: "choose 1 of 3 designs", options: ["minimal", "editorial", "bold"] } },
        output: { answer_kind: "editorial", answer: "SECRET_OWNER_ANSWER_ACME" },
        startedAt: 1200,
      });
    }

    insertWfStep(db, { runId, nodeId: "build", stepKey: "build#1", startedAt: 1300 });
    insertWfRun(db, {
      id: `${runId}_child_build`,
      workflow_id: "lp.build",
      workflow_version: 2,
      project_id: opts.projectId ?? "proj-1",
      parent_run_id: runId,
      parent_step_key: "build#1",
      inputs_json: JSON.stringify({ tasks: [{ id: "T1", title: "SECRET_TASK_ACME" }], waves: [["T1"]] }),
      created_at: 1300,
    });

    insertWfStep(db, { runId, nodeId: "review", stepKey: "review#1", startedAt: 1400 });
    insertWfRun(db, {
      id: `${runId}_child_review`,
      workflow_id: "lp.review",
      workflow_version: 1,
      project_id: opts.projectId ?? "proj-1",
      parent_run_id: runId,
      parent_step_key: "review#1",
      inputs_json: JSON.stringify({ range: ["deadbeef1234"], dimensions: ["correctness", "security"] }),
      created_at: 1400,
    });
  }

  if (opts.audit && opts.audit !== "none") {
    insertGoalAuditEvent(db, runId, opts.audit);
  }
  if (opts.verdict && opts.verdict !== "none") {
    setRunVerdict(db, {
      runId,
      workflowId: "full-lifecycle",
      graphVersion: 1,
      verdict: opts.verdict,
      source: "owner",
      decidedAt: 5100,
    });
  }

  return runId;
}

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 25));

describe("project templates from finished projects (Task 42)", () => {
  it("builds a draft with three pinned subworkflow nodes and the owner's human node, stripping all values", async () => {
    const { harness, db, ctx, architect, leadRoad } = setupWorld();
    const runId = seedFullLifecycleRun(db, {
      runId: "fl_run_1",
      audit: "pass",
      verdict: "accept",
      withHuman: true,
    });

    const run = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id = ?").get(runId) as never;
    const res = await extractProjectTemplateFromRun(ctx, { architect, leadRoad }, run);
    expect(res).toMatchObject({ status: "created", stages: 3 });
    if (res.status !== "created") throw new Error("expected created draft");

    const draft = createDraftStore(db).get(res.draftId);
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe("draft");
    expect(draft!.metadata).toMatchObject({
      source: "project-template",
      sourceRunIds: [runId],
    });

    const def = draft!.definition as Record<string, unknown>;
    expect(def.kind).toBe("project");
    expect(def.status).toBe("draft");

    // Inputs keep keys/types without any concrete run values.
    const inputs = def.inputs as Array<{ name: string; type: string; default?: unknown }>;
    expect(inputs.map((f) => [f.name, f.type])).toEqual(
      expect.arrayContaining([
        ["goal", "string"],
        ["scope", "string"],
        ["priority", "number"],
        ["goals", "array"],
      ]),
    );
    for (const field of inputs) {
      expect(field.default).toBeUndefined();
    }

    // Three pinned subworkflow nodes and the owner's human node at the stage boundary between plan and build.
    const nodes = def.nodes as Array<Record<string, unknown>>;
    expect(nodes.map((n) => n.id)).toEqual(["plan", "pick_design", "build", "review", "done"]);
    expect(nodes[0]).toMatchObject({ id: "plan", type: "subworkflow", workflow: "lp.plan", version: 1 });
    expect(nodes[1]).toMatchObject({
      id: "pick_design",
      type: "human",
      question: "choose 1 of 3 designs",
      options: ["minimal", "editorial", "bold"],
    });
    expect(nodes[2]).toMatchObject({ id: "build", type: "subworkflow", workflow: "lp.build", version: 2 });
    expect(nodes[3]).toMatchObject({ id: "review", type: "subworkflow", workflow: "lp.review", version: 1 });

    // Edges connect the stage boundary in exact order.
    expect(def.edges).toEqual([
      { from: "start", to: "plan", pass: "artifact" },
      { from: "plan", to: "pick_design", pass: "artifact" },
      { from: "pick_design", to: "build", pass: "artifact" },
      { from: "build", to: "review", pass: "artifact" },
      { from: "review", to: "done", pass: "artifact" },
    ]);

    // Definition parses cleanly through loadWorkflow without project-specific values leaking anywhere.
    const loaded = loadWorkflow(def);
    expect(loaded.ok).toBe(true);

    const serialized = JSON.stringify({ definition: def, metadata: draft!.metadata });
    for (const secretValue of [
      "SECRET_PROJECT_GOAL_ACME",
      "apps/acme-portal",
      "SECRET_GOAL_TEXT_FOR_ACME",
      "SECRET_EVIDENCE_FOR_ACME",
      "SECRET_REQUEST_FOR_ACME",
      "SECRET_OWNER_ANSWER_ACME",
      "SECRET_TASK_ACME",
      "deadbeef1234",
    ]) {
      expect(serialized).not.toContain(secretValue);
    }

    const infoLogs = harness.logEntries.filter((e) => e.level === "info").map((e) => e.message);
    expect(infoLogs.some((m) => m.includes(`project template run=${runId} stages=3 draft=${res.draftId}`))).toBe(true);
  });

  it("skips unaudited runs and runs without verdict or children with a warning", async () => {
    const { harness, db, ctx, architect, leadRoad } = setupWorld();

    const unauditedId = seedFullLifecycleRun(db, {
      runId: "fl_unaudited",
      audit: "none",
      verdict: "accept",
    });
    const gapsId = seedFullLifecycleRun(db, {
      runId: "fl_gaps",
      audit: "gaps",
      verdict: "accept",
    });
    const noVerdictId = seedFullLifecycleRun(db, {
      runId: "fl_no_verdict",
      audit: "pass",
      verdict: "none",
    });
    const noChildrenId = seedFullLifecycleRun(db, {
      runId: "fl_no_children",
      audit: "pass",
      verdict: "accept",
      withChildren: false,
    });

    const getRow = (id: string) => db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id = ?").get(id) as never;

    expect(await extractProjectTemplateFromRun(ctx, { architect, leadRoad }, getRow(unauditedId))).toEqual({
      status: "skipped",
      reason: "not audited",
    });
    expect(await extractProjectTemplateFromRun(ctx, { architect, leadRoad }, getRow(gapsId))).toEqual({
      status: "skipped",
      reason: "not audited",
    });
    expect(await extractProjectTemplateFromRun(ctx, { architect, leadRoad }, getRow(noVerdictId))).toEqual({
      status: "skipped",
      reason: "no verdict",
    });
    expect(await extractProjectTemplateFromRun(ctx, { architect, leadRoad }, getRow(noChildrenId))).toEqual({
      status: "skipped",
      reason: "no children",
    });

    expect(createDraftStore(db).list("proj-1")).toHaveLength(0);

    const warnLogs = harness.logEntries.filter((e) => e.level === "warn").map((e) => e.message);
    expect(warnLogs.some((m) => m.includes(`project template skipped run=${unauditedId}: not audited`))).toBe(true);
    expect(warnLogs.some((m) => m.includes(`project template skipped run=${noVerdictId}: no verdict`))).toBe(true);
    expect(warnLogs.some((m) => m.includes(`project template skipped run=${noChildrenId}: no children`))).toBe(true);
  });

  it("re-checks via the setRunVerdict port when an accept verdict arrives after run finish", async () => {
    const { db, ctx, engine, architect, leadRoad } = setupWorld();
    const runner = createProjectTemplateRunner(
      ctx,
      { workflowEngine: engine, leadRoad } as unknown as Services & { leadRoad: typeof leadRoad },
      { architect, leadRoad },
    );
    const unsub = registerRunVerdictPort(db, (verdict) => {
      if (verdict.verdict === "accept") return runner.onRunId(verdict.runId).then(() => undefined);
    });

    try {
      const runId = seedFullLifecycleRun(db, {
        runId: "fl_late_verdict",
        audit: "pass",
        verdict: "none",
      });

      const onRunFinished = createRunFinished(ctx, {
        triggers: { emitEvent: async () => ({ id: "evt_1", matched: 0, deduplicated: false }) as never },
        subscribers: [(run) => runner.onRun(run).then(() => undefined)],
      });
      await onRunFinished(runId);
      expect(createDraftStore(db).list("proj-1")).toHaveLength(0);

      setRunVerdict(db, {
        runId,
        workflowId: "full-lifecycle",
        graphVersion: 1,
        verdict: "accept",
        source: "owner",
        decidedAt: 6000,
      });
      await flushMicrotasks();

      const drafts = createDraftStore(db).list("proj-1");
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.metadata).toMatchObject({
        source: "project-template",
        sourceRunIds: [runId],
      });
    } finally {
      unsub();
    }
  });

  it("files a lead road class='branch' row instead of a duplicate draft on near_twin", async () => {
    const { harness, db, ctx, architect, leadRoad } = setupWorld();

    const firstId = seedFullLifecycleRun(db, {
      runId: "fl_twin_1",
      projectId: "proj-1",
      audit: "pass",
      verdict: "accept",
      withHuman: true,
    });
    const firstRow = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id = ?").get(firstId) as never;
    const firstRes = await extractProjectTemplateFromRun(ctx, { architect, leadRoad }, firstRow);
    expect(firstRes.status).toBe("created");
    if (firstRes.status !== "created") throw new Error("expected first draft created");

    const secondId = seedFullLifecycleRun(db, {
      runId: "fl_twin_2",
      projectId: "proj-2",
      audit: "pass",
      verdict: "accept",
      withHuman: true,
    });
    const secondRow = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE id = ?").get(secondId) as never;
    const secondRes = await extractProjectTemplateFromRun(ctx, { architect, leadRoad }, secondRow);
    expect(secondRes).toMatchObject({
      status: "near_twin",
      workflowId: firstRes.workflowId,
      stages: 3,
    });
    if (secondRes.status !== "near_twin") throw new Error("expected near_twin");
    expect(secondRes.roadId).toEqual(expect.any(String));

    // Only the first draft exists; no duplicate draft was created for proj-2.
    expect(createDraftStore(db).list("proj-1")).toHaveLength(1);
    expect(createDraftStore(db).list("proj-2")).toHaveLength(0);

    const roadRow = getRoad(db, secondRes.roadId!);
    expect(roadRow).toMatchObject({
      class: "branch",
      kind: "option",
      project_id: "proj-2",
    });
    expect(JSON.parse(roadRow!.payload_json!)).toMatchObject({
      graphId: firstRes.workflowId,
      templateId: firstRes.workflowId,
      runId: secondId,
      sourceRunIds: [secondId],
    });

    const infoLogs = harness.logEntries.filter((e) => e.level === "info").map((e) => e.message);
    expect(infoLogs.some((m) => m.includes(`project template run=${secondId} stages=3 draft=near_twin:${firstRes.workflowId}`))).toBe(true);
  });
});
