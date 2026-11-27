import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import {
  WorkflowEngine,
  createDraftStore,
  definitionSha256,
  lowerWorkflow,
  parseWorkflow,
  type StoredWorkflow,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import type { Services } from "../../server";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { openTrial, queueHypothesis, resolveCanary } from "../../src/rooms/evolve/server";
import { createRun, openDatabase, setRunThread, type LanePilotDatabase } from "../../src/rooms/plugin-db";
import { runWorkflowTool, type WorkflowToolDeps } from "../../src/rooms/workflow/server/handlers/workflow-tools";
import { createWorkflowTriggers, type ResolveCanary } from "../../src/rooms/workflow/server/services/workflow-triggers";

const PROJECT = "proj-canary";
const PM_THREAD = "pm-canary-1";
const LP_RUN = "lprun-canary-1";

function baseDefinition(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "invoice-send",
    version: 1,
    status: "published",
    name: { en: "Invoice Send", ru: "Отправка счёта" },
    description: { en: "Send an invoice", ru: "Отправить счёт" },
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    triggers: [
      { type: "manual" },
      { type: "schedule", cron: "0 9 * * *", projectId: PROJECT },
      { type: "event", event: "lp.canary.test", projectId: PROJECT },
    ],
    nodes: [
      {
        id: "work",
        type: "agent",
        role: "analyst",
        provider: "claude-code",
        model: "claude-sonnet-5-5",
        prompt: "Handle {{input.query}}",
        out: [{ name: "answer", type: "string" }],
      },
      {
        id: "done",
        type: "action",
        action: "emit",
        map: { result: "work.answer" },
      },
    ],
    edges: [
      { from: "start", to: "work" },
      { from: "work", to: "done" },
    ],
    ...extra,
  };
}

function childDefinition(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    id: "child-helper",
    version: 1,
    status: "published",
    name: { en: "Child Helper", ru: "Дочерний граф" },
    description: { en: "Child graph", ru: "Дочерний" },
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "out", type: "string" }],
    nodes: [{ id: "done", type: "action", action: "emit", map: { out: "$inputs.query" } }],
    edges: [{ from: "start", to: "done" }],
  };
}

function storedOf(definition: Record<string, unknown>, origin: StoredWorkflow["origin"] = "global"): StoredWorkflow {
  const workflow = parseWorkflow(definition);
  return {
    workflow,
    origin,
    source: `${workflow.id}.json`,
    sha256: definitionSha256(workflow),
    warnings: [],
  };
}

function storeOf(...items: StoredWorkflow[]): WorkflowStore {
  return {
    list: () => items,
    get: (id) => items.find((item) => item.workflow.id === id) ?? null,
    resolve: (id) => items.find((item) => item.workflow.id === id)?.workflow ?? null,
    problems: [],
  };
}

function setupWorld(options: {
  items?: StoredWorkflow[];
  resolveCanary?: ResolveCanary;
} = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const debugLogs: string[] = [];
  const warnLogs: string[] = [];
  const bbWithLogs = Object.assign(bb, {
    log: {
      debug: (m: string) => debugLogs.push(m),
      info: (_m: string) => undefined,
      warn: (m: string) => warnLogs.push(m),
      error: (m: string) => warnLogs.push(m),
    },
  });
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    threadId === PM_THREAD ? { role: "pm" } : { role: "pm", architectProjectId: PROJECT });
  const db: LanePilotDatabase = openDatabase(bbWithLogs);
  createRun(db, LP_RUN, PROJECT, "cli");
  setRunThread(db, LP_RUN, PM_THREAD);

  const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0" });
  engine.register("agent", {
    reentrant: true,
    run: async (stepCtx) => ({
      output: {
        answer: `${stepCtx.node.type === "agent" ? stepCtx.node.model : "unknown"}:${String(stepCtx.inputs.query ?? "")}`,
        handoff: "done",
      },
    }),
  });

  const items = options.items ?? [storedOf(baseDefinition())];
  const store = storeOf(...items);
  const ctx = { bb: bbWithLogs, db, log: (m: string) => warnLogs.push(m) } as unknown as ServerCore;
  const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
    loadStore: async () => ({ store, project: "ok" }),
    ...(options.resolveCanary ? { resolveCanary: options.resolveCanary } : {}),
  });

  const toolDeps: WorkflowToolDeps = {
    db,
    store: async () => store,
    engine: () => engine,
    runtime: ({ pmThreadId, projectId, runId }) => ({ ctx, services: {} as Services, pmThreadId, projectId, runId }),
    ...(options.resolveCanary ? { resolveCanary: options.resolveCanary } : {}),
    debug: (m) => debugLogs.push(m),
    warn: (m) => warnLogs.push(m),
  };

  return { db, engine, triggers, toolDeps, store, debugLogs, warnLogs, harness };
}

function seedCandidateTrial(db: LanePilotDatabase, share: number = EVOLVE_THRESHOLDS.canaryShare) {
  const baseline = parseWorkflow(baseDefinition());
  const drafts = createDraftStore(db);
  const draft = drafts.create({
    projectId: PROJECT,
    threadId: null,
    scope: "global",
    name: baseline.name,
    description: baseline.description,
    workflowId: baseline.id,
    definition: baseDefinition(),
    metadata: { source: "evolve" },
  });
  const patched = drafts.patch(
    draft.id,
    [{ op: "update_node", id: "work", set: { model: "claude-haiku-5-5" } }],
    { evolutionGate: true, source: "evolve" },
  );
  expect(patched.ok).toBe(true);
  if (!patched.ok) throw new Error("failed to patch candidate draft");

  const hyp = queueHypothesis(db, {
    workflowId: baseline.id,
    nodeId: "work",
    armKind: "model",
    variant: { model: "claude-haiku-5-5" },
    graphVersion: baseline.version,
    source: "census",
    draftId: draft.id,
  });
  expect(hyp.ok).toBe(true);
  if (!hyp.ok) throw new Error("failed to queue hypothesis");

  const trial = openTrial(db, {
    hypothesisId: hyp.hypothesis.id,
    workflowId: baseline.id,
    baselineVersion: baseline.version,
    candidateDraftId: draft.id,
    share,
  });
  const candidateWorkflow = parseWorkflow(patched.draft.definition);
  return {
    trial,
    draft: patched.draft,
    baselineWorkflow: baseline,
    candidateWorkflow,
    baselineSha: definitionSha256(baseline),
    candidateSha: definitionSha256(candidateWorkflow),
    loweredCandidateSha: definitionSha256(lowerWorkflow(candidateWorkflow)),
  };
}

describe("canary split of real runs", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()!();
  });

  it("splits ~20% of 200 starts to the new arm with candidate definition_json and tags arm/trial_id", async () => {
    let world!: ReturnType<typeof setupWorld>;
    world = setupWorld({
      resolveCanary: (workflowId) => resolveCanary(world.db, workflowId),
    });
    cleanups.push(async () => {
      world.engine.dispose();
      await world.harness.lifecycle.dispose();
    });

    const seeded = seedCandidateTrial(world.db, EVOLVE_THRESHOLDS.canaryShare);
    const runIds: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const res = await world.triggers.start({
        projectId: PROJECT,
        workflowId: "invoice-send",
        inputs: { query: `case-${i}` },
        source: "manual",
      });
      expect(res.ok).toBe(true);
      if (res.ok) runIds.push(res.runId);
    }
    await world.engine.idle();

    const rows = world.db
      .prepare("SELECT id, arm, trial_id, workflow_sha256, definition_json FROM lane_pilot_wf_run WHERE workflow_id = 'invoice-send'")
      .all() as Array<{ id: string; arm: string | null; trial_id: string | null; workflow_sha256: string; definition_json: string }>;
    expect(rows).toHaveLength(200);

    const newRows = rows.filter((r) => r.arm === "new");
    const oldRows = rows.filter((r) => r.arm === "old");
    expect(newRows.length + oldRows.length).toBe(200);
    // 200 Bernoulli(0.2): mean 40, sd ~5.66; wide guard prevents flaky CI while verifying ~20% split.
    expect(newRows.length).toBeGreaterThanOrEqual(15);
    expect(newRows.length).toBeLessThanOrEqual(65);

    for (const row of newRows) {
      expect(row.trial_id).toBe(seeded.trial.trialId);
      expect(row.workflow_sha256).toBe(seeded.candidateSha);
      expect(row.workflow_sha256).not.toBe(seeded.baselineSha);
      const parsedDef = JSON.parse(row.definition_json);
      expect(definitionSha256(parsedDef)).toBe(seeded.loweredCandidateSha);
      const workNode = parsedDef.nodes.find((n: { id: string }) => n.id === "work");
      expect(workNode.model).toBe("claude-haiku-5-5");
    }

    for (const row of oldRows) {
      expect(row.trial_id).toBe(seeded.trial.trialId);
      expect(row.workflow_sha256).toBe(seeded.baselineSha);
      const parsedDef = JSON.parse(row.definition_json);
      const workNode = parsedDef.nodes.find((n: { id: string }) => n.id === "work");
      expect(workNode.model).toBe("claude-sonnet-5-5");
    }

    expect(world.debugLogs.some((m) => m === `wf.start canary wf=invoice-send trial=${seeded.trial.trialId} arm=new`)).toBe(true);
    expect(world.debugLogs.some((m) => m === `wf.start canary wf=invoice-send trial=${seeded.trial.trialId} arm=old`)).toBe(true);
  });

  it("leaves baseline unchanged when no trial is open or resolveCanary is omitted", async () => {
    const world = setupWorld({
      resolveCanary: (workflowId) => resolveCanary(world.db, workflowId),
    });
    cleanups.push(async () => {
      world.engine.dispose();
      await world.harness.lifecycle.dispose();
    });

    const baselineSha = definitionSha256(parseWorkflow(baseDefinition()));
    const trigRes = await world.triggers.start({
      projectId: PROJECT,
      workflowId: "invoice-send",
      inputs: { query: "no-trial-trigger" },
      source: "manual",
    });
    expect(trigRes.ok).toBe(true);

    const toolRes = JSON.parse(
      await runWorkflowTool(world.toolDeps, { workflowId: "invoice-send", inputs: { query: "no-trial-tool" } }, { threadId: PM_THREAD, projectId: PROJECT }),
    ) as { workflowRunId: string };
    await world.engine.idle();

    for (const id of [trigRes.ok ? trigRes.runId : "", toolRes.workflowRunId]) {
      const row = world.db
        .prepare("SELECT arm, trial_id, workflow_sha256 FROM lane_pilot_wf_run WHERE id = ?")
        .get(id) as { arm: string | null; trial_id: string | null; workflow_sha256: string };
      expect(row.arm).toBeNull();
      expect(row.trial_id).toBeNull();
      expect(row.workflow_sha256).toBe(baselineSha);
    }
    expect(world.debugLogs.some((m) => m.startsWith("wf.start canary"))).toBe(false);
  });

  it("warns and starts the baseline when resolveCanary throws", async () => {
    const world = setupWorld({
      resolveCanary: () => {
        throw new Error("trial store unavailable");
      },
    });
    cleanups.push(async () => {
      world.engine.dispose();
      await world.harness.lifecycle.dispose();
    });

    const baselineSha = definitionSha256(parseWorkflow(baseDefinition()));
    const res = await world.triggers.start({
      projectId: PROJECT,
      workflowId: "invoice-send",
      inputs: { query: "port-throws" },
      source: "schedule",
    });
    expect(res.ok).toBe(true);
    await world.engine.idle();

    if (res.ok) {
      const row = world.db
        .prepare("SELECT arm, trial_id, workflow_sha256 FROM lane_pilot_wf_run WHERE id = ?")
        .get(res.runId) as { arm: string | null; trial_id: string | null; workflow_sha256: string };
      expect(row.arm).toBeNull();
      expect(row.trial_id).toBeNull();
      expect(row.workflow_sha256).toBe(baselineSha);
    }
    expect(world.warnLogs).toContain("wf.start canary port failed wf=invoice-send: trial store unavailable");

    const toolRes = JSON.parse(
      await runWorkflowTool(world.toolDeps, { workflowId: "invoice-send", inputs: { query: "tool-throws" } }, { threadId: PM_THREAD, projectId: PROJECT }),
    ) as { workflowRunId: string };
    await world.engine.idle();
    const toolRow = world.db
      .prepare("SELECT arm, trial_id, workflow_sha256 FROM lane_pilot_wf_run WHERE id = ?")
      .get(toolRes.workflowRunId) as { arm: string | null; trial_id: string | null; workflow_sha256: string };
    expect(toolRow.arm).toBeNull();
    expect(toolRow.trial_id).toBeNull();
    expect(toolRow.workflow_sha256).toBe(baselineSha);
  });

  it("covers event starts and runWorkflowTool, and child subworkflow runs inherit nothing", async () => {
    const parentDef = baseDefinition({
      id: "parent-canary",
      nodes: [
        {
          id: "work",
          type: "agent",
          role: "analyst",
          provider: "claude-code",
          model: "claude-sonnet-5-5",
          prompt: "Handle {{input.query}}",
          out: [{ name: "answer", type: "string" }],
        },
        {
          id: "sub",
          type: "subworkflow",
          workflow: "child-helper",
          with: { query: "work.answer" },
          out: [{ name: "out", type: "string" }],
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { result: "sub.out" },
        },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "sub" },
        { from: "sub", to: "done" },
      ],
    });
    const candidateDef = {
      ...parentDef,
      status: "draft",
      nodes: (parentDef.nodes as Array<Record<string, unknown>>).map((n) =>
        n.id === "work" ? { ...n, model: "claude-haiku-5-5" } : n),
    };
    const world = setupWorld({
      items: [storedOf(parentDef), storedOf(childDefinition())],
      resolveCanary: (workflowId) =>
        workflowId === "parent-canary"
          ? { trialId: "evt_full", definition: candidateDef, share: 1.0 }
          : null,
    });
    cleanups.push(async () => {
      world.engine.dispose();
      await world.harness.lifecycle.dispose();
    });

    const emitted = await world.triggers.emitEvent("lp.canary.test", { query: "from-event" }, { projectId: PROJECT });
    expect(emitted.started).toHaveLength(1);
    const eventRunId = emitted.started[0]!.runId;

    const toolRes = JSON.parse(
      await runWorkflowTool(world.toolDeps, { workflowId: "parent-canary", inputs: { query: "from-tool" } }, { threadId: PM_THREAD, projectId: PROJECT }),
    ) as { workflowRunId: string };

    await world.engine.idle();

    for (const parentRunId of [eventRunId, toolRes.workflowRunId]) {
      const parentRow = world.db
        .prepare("SELECT arm, trial_id, workflow_sha256, status, reason FROM lane_pilot_wf_run WHERE id = ?")
        .get(parentRunId) as { arm: string | null; trial_id: string | null; workflow_sha256: string; status: string; reason: string | null };
      expect(parentRow.reason).toBeNull();
      expect(parentRow.status).toBe("succeeded");
      expect(parentRow.arm).toBe("new");
      expect(parentRow.trial_id).toBe("evt_full");
      expect(parentRow.workflow_sha256).toBe(definitionSha256(parseWorkflow(candidateDef)));

      const childRow = world.db
        .prepare("SELECT arm, trial_id, workflow_id, status FROM lane_pilot_wf_run WHERE parent_run_id = ?")
        .get(parentRunId) as { arm: string | null; trial_id: string | null; workflow_id: string; status: string };
      expect(childRow.workflow_id).toBe("child-helper");
      expect(childRow.status).toBe("succeeded");
      expect(childRow.arm).toBeNull();
      expect(childRow.trial_id).toBeNull();
    }
  });
});
