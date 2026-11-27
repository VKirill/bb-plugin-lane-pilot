import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { EVOLVE_THRESHOLDS, LP_EVENTS } from "@lane-pilot/contracts";
import { GLOBAL_SETTINGS_PROJECT_ID, PATHS_BRANCH_DRAFT_REPEATS_KEY } from "@lane-pilot/settings-catalog";
import {
  WorkflowEngine,
  definitionSha256,
  loadWorkflow,
  parseWorkflow,
  validateWorkflow,
  type StoredWorkflow,
  type Workflow,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { EVOLVE_ENABLED_KEY, EVOLVE_GRAPHS_KEY } from "../../src/rooms/evolve";
import {
  addCase,
  listHypotheses,
  queueHypothesis,
  registerEvolveActions,
  setHypothesisState,
  splitForRunId,
  workingCases,
} from "../../src/rooms/evolve/server";
import { addRoad, getRoad, listRoad } from "../../src/rooms/lead/server";
import { createRun, openDatabase, saveProjectSetting, setRunThread } from "../../src/rooms/plugin-db";
import type { Services } from "../../src/rooms/services";
import { INTERNAL_UPKEEP_WORKFLOWS, isInternalUpkeep } from "../../src/rooms/workflow";
import {
  createDedupeGate,
  createRunFinished,
  getRunVerdict,
  listRouteMisses,
  listRunVerdicts,
  recordRouteMiss,
  setRunVerdict,
} from "../../src/rooms/workflow/server";
import {
  createWorkflowTriggers,
  desiredSchedules,
} from "../../src/rooms/workflow/server/services/workflow-triggers";

const PROJECT = "proj_evolve";
const PM = "pm_evolve";
const RUN = "lprun_evolve";

function loadEvolveWorkflow(): Workflow {
  const raw = readFileSync(join(process.cwd(), "workflows/lp.evolve.json"), "utf8");
  return parseWorkflow(raw);
}

function makeInvoiceWorkflow(): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id: "invoice-send",
    version: 1,
    status: "published",
    name: { en: "Invoice Send", ru: "Счёт" },
    description: { en: "Send an invoice", ru: "Отправить счёт" },
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [
      {
        id: "create",
        type: "agent",
        role: "errand",
        provider: "claude-code",
        model: "claude-opus-5-5",
        verify: "create.out != ''",
        prompt: "Create invoice {{input.query}}",
        out: [{ name: "out", type: "string" }],
      },
      { id: "done", type: "action", action: "emit", map: { result: "create.out" } },
    ],
    edges: [
      { from: "start", to: "create" },
      { from: "create", to: "done" },
    ],
  });
}

function makeErrandWorkflow(): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id: "errand",
    version: 1,
    status: "published",
    name: { en: "Errand", ru: "Поручение" },
    description: { en: "Run an errand", ru: "Поручение" },
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [{ id: "done", type: "action", action: "emit", map: { result: "'ok'" } }],
    edges: [{ from: "start", to: "done" }],
  });
}

function makeOtherWorkflow(): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id: "other-graph",
    version: 1,
    status: "published",
    name: { en: "Other Graph", ru: "Другой граф" },
    description: { en: "Another workflow", ru: "Другой граф" },
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [{ id: "done", type: "action", action: "emit", map: { result: "'ok'" } }],
    edges: [{ from: "start", to: "done" }],
  });
}

function stored(wf: Workflow, origin: StoredWorkflow["origin"] = "builtin"): StoredWorkflow {
  return { workflow: wf, origin, source: `${wf.id}.json`, sha256: definitionSha256(wf), warnings: [] };
}

function storeOf(...items: StoredWorkflow[]): WorkflowStore {
  return {
    list: () => items,
    get: (id) => items.find((i) => i.workflow.id === id) ?? null,
    resolve: (id, version) => {
      const found = items.find((i) => i.workflow.id === id)?.workflow ?? null;
      return found && (version === undefined || found.version === version) ? found : null;
    },
    problems: [],
  };
}

function setupWorld(extraItems: StoredWorkflow[] = [], deps: Parameters<typeof registerEvolveActions>[2] = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    threadId === PM ? { role: "pm" } : { role: "pm", architectProjectId: PROJECT },
  );
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "cli");
  setRunThread(db, RUN, PM);

  const evolveWf = loadEvolveWorkflow();
  const invoiceWf = makeInvoiceWorkflow();
  const errandWf = makeErrandWorkflow();
  const otherWf = makeOtherWorkflow();
  const items = [stored(evolveWf), stored(invoiceWf), stored(errandWf), stored(otherWf), ...extraItems];

  const logs: string[] = [];
  const ctx = {
    bb,
    db,
    isDisposed: () => false,
    effectiveProjectSettings: async () => ({ values: {} }),
    log: (m: string) => logs.push(m),
  } as unknown as ServerCore;

  let onRunEvent: (runId: string) => Promise<void> = async () => undefined;
  const engine = new WorkflowEngine({
    db,
    harnessVersion: "test-1",
    resolveWorkflow: (id, version) => storeOf(...items).resolve(id, version),
    onEvent: (runId) => {
      void onRunEvent(runId);
    },
  });
  engine.register("agent", {
    reentrant: true,
    run: async () => ({ output: { out: "ok", handoff: "ok" } }),
  });

  const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
    loadStore: async () => ({ store: storeOf(...items), project: "ok" }),
  });
  onRunEvent = createRunFinished(ctx, { triggers, subscribers: [] });

  registerEvolveActions(engine, ctx, {
    workflowTriggers: triggers,
    loadWorkflow: async (id) => storeOf(...items).get(id)?.workflow ?? null,
    resolveWorkflow: (id, version) => storeOf(...items).resolve(id, version),
    leadRoad: { addRoad, getRoad, listRoad, doneRoad: () => true },
    listRouteMisses: (filter) => listRouteMisses(db, filter),
    getRunVerdict: (runId) => getRunVerdict(db, runId),
    listRunVerdicts: (filter) => listRunVerdicts(db, filter),
    checkNearTwin: async (input) => !(await createDedupeGate({ db, loadLibraryWorkflows: () => items.map((i) => i.workflow) }).check(input)).ok,
    ...deps,
  });

  return { bb, db, ctx, engine, triggers, harness, logs, evolveWf, invoiceWf, errandWf, otherWf, items };
}

function makeRunIds(prefix: string, heldOutNeed: number, workingNeed: number) {
  const heldOut: string[] = [];
  const working: string[] = [];
  for (let i = 0; heldOut.length < heldOutNeed || working.length < workingNeed; i += 1) {
    const id = `${prefix}-${i}`;
    if (splitForRunId(id) === "held_out") {
      if (heldOut.length < heldOutNeed) heldOut.push(id);
    } else if (working.length < workingNeed) {
      working.push(id);
    }
  }
  return { heldOut, working };
}

describe("Task 34: lp.evolve graph, triggers, and event handlers", () => {
  it("loads and validates workflows/lp.evolve.json with event triggers and no schedule row", () => {
    expect(LP_EVENTS.MODEL_CATALOG_CHANGED).toBe("lp.models.catalog-changed");
    expect(LP_EVENTS.EVOLVE_THRESHOLD_CROSSED).toBe("lp.evolve.threshold-crossed");
    expect(INTERNAL_UPKEEP_WORKFLOWS).toContain("lp.evolve");
    expect(isInternalUpkeep("lp.evolve")).toBe(true);

    const raw = readFileSync(join(process.cwd(), "workflows/lp.evolve.json"), "utf8");
    const loaded = loadWorkflow(raw);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) throw new Error("expected lp.evolve.json to load");

    const errors = validateWorkflow(loaded.workflow, { shipped: true }).filter((p) => p.level === "error");
    expect(errors).toEqual([]);
    expect(loaded.workflow.status).toBe("published");
    expect(loaded.workflow.triggers.map((t) => t.event)).toEqual([
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
      LP_EVENTS.EVOLVE_THRESHOLD_CROSSED,
      LP_EVENTS.MODEL_CATALOG_CHANGED,
    ]);
    expect(loaded.workflow.triggers.some((t) => t.type === "schedule")).toBe(false);
    expect(desiredSchedules([stored(loaded.workflow, "global")], PROJECT)).toEqual([]);
  });

  it("ingests invoice-send run-finished once, ignores non-allow-listed graphs, and does not trigger itself", async () => {
    const { db, engine, triggers, invoiceWf, otherWf } = setupWorld();

    // Run invoice-send and record owner accept verdict.
    const h1 = engine.start({ workflow: invoiceWf, inputs: { query: "acme" }, link: { projectId: PROJECT, runId: RUN } });
    const s1 = await h1.done;
    await engine.idle();

    // Verify lp.evolve ran for invoice-send (first ingest before verdict -> no case yet).
    const firstEvolveRuns = db.prepare("SELECT id FROM lane_pilot_wf_run WHERE workflow_id = 'lp.evolve'").all();
    expect(firstEvolveRuns).toHaveLength(1);
    const ingestRows1 = db.prepare("SELECT run_id, workflow_id FROM lane_pilot_evolve_ingest WHERE run_id = ?").all(s1.runId);
    expect(ingestRows1).toHaveLength(1);

    // Re-emitting the same run-finished event is a duplicate / idempotent no-op.
    const dupEmit = await triggers.emitEvent(
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
      { runId: s1.runId, workflowId: "invoice-send", status: "succeeded", graphVersion: 1, projectId: PROJECT },
      { id: `manual-dup:${s1.runId}`, key: "invoice-send", projectId: PROJECT },
    );
    expect(dupEmit.started).toHaveLength(1);
    await engine.idle();
    expect(db.prepare("SELECT run_id FROM lane_pilot_evolve_ingest WHERE run_id = ?").all(s1.runId)).toHaveLength(1);

    // Run invoice-send a second time with a pre-recorded verdict -> adds case once.
    const { working } = makeRunIds("inv-accept", 0, 1);
    const run2Id = working[0]!;
    setRunVerdict(db, { runId: run2Id, workflowId: "invoice-send", graphVersion: 1, verdict: "accept", source: "owner", decidedAt: 10_000 });
    await triggers.emitEvent(
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
      { runId: run2Id, workflowId: "invoice-send", status: "succeeded", graphVersion: 1, projectId: PROJECT },
      { id: `wf-finished:${run2Id}:1`, key: "invoice-send", projectId: PROJECT },
    );
    await engine.idle();
    expect(workingCases(db, "invoice-send")).toHaveLength(1);

    // Non-allow-listed graph is ignored.
    const hOther = engine.start({ workflow: otherWf, inputs: { query: "x" }, link: { projectId: PROJECT, runId: RUN } });
    const sOther = await hOther.done;
    await engine.idle();
    expect(db.prepare("SELECT run_id FROM lane_pilot_evolve_ingest WHERE run_id = ?").all(sOther.runId)).toHaveLength(0);

    // lp.evolve never emits lp.workflow.run-finished for itself (no self-trigger loop).
    const selfInbox = db.prepare("SELECT id FROM lane_pilot_wf_inbox WHERE name = ? AND key = 'lp.evolve'").all(LP_EVENTS.WORKFLOW_RUN_FINISHED);
    expect(selfInbox).toHaveLength(0);
  });

  it("emits lp.evolve.threshold-crossed once when held-out/working cases reach 20/10", async () => {
    const { db, engine, triggers } = setupWorld();
    const { heldOut, working } = makeRunIds("thresh", EVOLVE_THRESHOLDS.heldOutMin, EVOLVE_THRESHOLDS.workingMin);

    // Seed 19 held-out and 10 working cases first.
    for (const id of [...heldOut.slice(0, EVOLVE_THRESHOLDS.heldOutMin - 1), ...working]) {
      addCase(db, { workflowId: "invoice-send", runId: id, verdict: "accept", graphVersion: 1, now: 1_000 });
    }

    // The 20th held-out run arrives with a verdict -> crosses 20/10 and emits EVOLVE_THRESHOLD_CROSSED once.
    const crossingRunId = heldOut[EVOLVE_THRESHOLDS.heldOutMin - 1]!;
    setRunVerdict(db, { runId: crossingRunId, workflowId: "invoice-send", graphVersion: 1, verdict: "accept", source: "owner", decidedAt: 2_000 });
    await triggers.emitEvent(
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
      { runId: crossingRunId, workflowId: "invoice-send", status: "succeeded", graphVersion: 1, projectId: PROJECT },
      { id: `wf-finished:${crossingRunId}:1`, key: "invoice-send", projectId: PROJECT },
    );
    await engine.idle();

    const thresholdEvents1 = db.prepare("SELECT id, payload_json FROM lane_pilot_wf_inbox WHERE name = ?").all(LP_EVENTS.EVOLVE_THRESHOLD_CROSSED) as Array<{ id: string; payload_json: string }>;
    expect(thresholdEvents1).toHaveLength(1);
    expect(JSON.parse(thresholdEvents1[0]!.payload_json)).toMatchObject({
      workflowId: "invoice-send",
      reason: "cases_threshold",
      heldOut: 20,
      working: 10,
    });

    // A 21st case does NOT emit the threshold event again.
    const extraId = makeRunIds("thresh-extra", 1, 0).heldOut[0]!;
    setRunVerdict(db, { runId: extraId, workflowId: "invoice-send", graphVersion: 1, verdict: "accept", source: "owner", decidedAt: 3_000 });
    await triggers.emitEvent(
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
      { runId: extraId, workflowId: "invoice-send", status: "succeeded", graphVersion: 1, projectId: PROJECT },
      { id: `wf-finished:${extraId}:1`, key: "invoice-send", projectId: PROJECT },
    );
    await engine.idle();

    const thresholdEvents2 = db.prepare("SELECT id FROM lane_pilot_wf_inbox WHERE name = ?").all(LP_EVENTS.EVOLVE_THRESHOLD_CROSSED);
    expect(thresholdEvents2).toHaveLength(1);
  });

  it("returns { skipped: 'disabled' } from every handler when evolve.enabled is false", async () => {
    const { db, engine, triggers, evolveWf } = setupWorld();
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, EVOLVE_ENABLED_KEY, false);

    // Verify graph run skips cleanly via ingest -> done.
    const res = await triggers.emitEvent(
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
      { runId: "run_disabled_1", workflowId: "invoice-send", status: "succeeded", graphVersion: 1, projectId: PROJECT },
      { id: "wf-finished:run_disabled_1:1", key: "invoice-send", projectId: PROJECT },
    );
    expect(res.started).toHaveLength(1);
    await engine.idle();
    expect(db.prepare("SELECT run_id FROM lane_pilot_evolve_ingest").all()).toHaveLength(0);

    // Verify each individual handler returns { skipped: "disabled" } when invoked.
    for (const uses of ["lp.evolve_ingest", "lp.evolve_propose", "lp.evolve_replay", "lp.evolve_decide", "lp.evolve_reprove"] as const) {
      const single = parseWorkflow({
        schemaVersion: 1,
        id: `test-single-${uses.replace(/[^a-z0-9]/g, "-")}`,
        version: 1,
        status: "published",
        name: { en: "Single", ru: "Один" },
        description: { en: "Single handler check", ru: "Проверка шага" },
        nodes: [
          {
            id: "step",
            type: "action",
            uses,
            out: [{ name: "skipped", type: "string", required: false }],
          },
          { id: "done", type: "action", action: "emit", map: { skipped: "step.skipped" } },
        ],
        outputs: [{ name: "skipped", type: "string", required: false }],
        edges: [
          { from: "start", to: "step" },
          { from: "step", to: "done" },
        ],
      });
      const h = engine.start({ workflow: single, inputs: { workflowId: "invoice-send", runId: "r1" } });
      const summary = await h.done;
      expect(summary.status).toBe("succeeded");
      expect(summary.output).toEqual({ skipped: "disabled" });
    }
    expect(evolveWf.id).toBe("lp.evolve");
  });

  it("writes a lead_road process row on repeated errand catalog misses when no near-twin exists", async () => {
    const { db, engine, triggers } = setupWorld();
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, PATHS_BRANCH_DRAFT_REPEATS_KEY, 3);
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, EVOLVE_GRAPHS_KEY, ["invoice-send"]);

    const now = Date.now();
    for (let i = 1; i <= 3; i += 1) {
      recordRouteMiss(db, {
        projectId: PROJECT,
        source: "errand_route",
        kind: "weak_match",
        brief: `Prepare weekly SEO audit summary variant ${i}`,
        category: "seo",
        confidence: 45,
        now: now - i * 1_000,
      });
    }

    await triggers.emitEvent(
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
      { runId: "errand-run-1", workflowId: "errand", status: "succeeded", graphVersion: 1, projectId: PROJECT },
      { id: "wf-finished:errand-run-1:1", key: "errand", projectId: PROJECT },
    );
    await engine.idle();

    const rows = listRoad(db, { kind: "option" }).filter((r) => r.class === "process" && r.source === "lead");
    expect(rows).toHaveLength(1);
    const payload = JSON.parse(rows[0]!.payload_json!) as { category: string; missIds: string[] };
    expect(payload.category).toBe("seo");
    expect(payload.missIds).toHaveLength(3);
  });

  it("re-proves promoted model/plan variants on MODEL_CATALOG_CHANGED and queues a demotion hypothesis on failure", async () => {
    const proveCalls: Array<{ workflowId: string; provider: string; model: string }> = [];
    const { db, engine, triggers } = setupWorld([], {
      proveWorkflow: async (input) => {
        proveCalls.push({ workflowId: input.workflowId, provider: input.provider, model: input.model });
        return {
          ok: false,
          casesN: 2,
          passedN: 1,
          failures: [{ caseId: "case-1", reason: "output mismatch" }],
        };
      },
    });

    const queued = queueHypothesis(db, {
      workflowId: "invoice-send",
      nodeId: "create",
      armKind: "model",
      variant: { provider: "claude-code", model: "claude-haiku-5-5" },
      graphVersion: 1,
      source: "census",
    });
    expect(queued.ok).toBe(true);
    if (!queued.ok) throw new Error("queue failed");
    setHypothesisState(db, { id: queued.hypothesis.id, state: "promoted", now: 5_000 });

    await triggers.emitEvent(
      LP_EVENTS.MODEL_CATALOG_CHANGED,
      { prevSha: "sha_a", nextSha: "sha_b" },
      { id: "catalog:sha_b", key: "sha_b" },
    );
    await engine.idle();

    expect(proveCalls).toEqual([{ workflowId: "invoice-send", provider: "claude-code", model: "claude-haiku-5-5" }]);
    const demotions = listHypotheses(db, { workflowId: "invoice-send", state: "queued" });
    expect(demotions).toHaveLength(1);
    expect(demotions[0]!.source).toBe("catalog_change");
    expect(demotions[0]!.nodeId).toBe("create");
  });
});
