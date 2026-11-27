import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  WorkflowEngine,
  loadWorkflowStore,
  parseWorkflow,
  registerPureActions,
  type NodeExecutor,
  type RunRow,
  type StoredWorkflow,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import { ERRAND_EPISODE_EXTRACTOR_VERSION, ERRAND_EPISODE_TABLE } from "../../src/rooms/contracts/server";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { createRunFinished } from "../../src/rooms/workflow/server";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/services/workflow-triggers";
import { mountErrands, writeEpisode, writePendingEpisode, type EpisodeDb } from "../../src/rooms/errands/server";
import { listErrandEpisodeTraces } from "../../src/rooms/storage";

const mockModelChoice = vi.hoisted(() => ({
  value: {
    choice: "invoice-send" as string | null,
    confidence: 95,
    pattern: "invoice",
    rejected: [] as Array<{ id: string; reason: string }>,
    questions: [] as string[],
  },
}));

vi.mock("@lane-pilot/workflow-engine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@lane-pilot/workflow-engine")>();
  return {
    ...actual,
    routeIntent: (input: Parameters<typeof actual.routeIntent>[0]) =>
      actual.routeIntent({ ...input, model: async () => mockModelChoice.value }),
  };
});

const PROJECT = "proj-ep";
const PM = "pm-ep";
const RUN = "lprun-ep";
const BRIEF_SECRET_TEXT = "Top secret brief text that must never appear in logs";

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 25));

const storeOf = (...items: StoredWorkflow[]): WorkflowStore => ({
  list: () => items,
  get: (id) => items.find((item) => item.workflow.id === id) ?? null,
  resolve: (id) => items.find((item) => item.workflow.id === id)?.workflow ?? null,
  problems: [],
});

function setupWorld(extraExecutors: Record<string, NodeExecutor> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "cli");
  setRunThread(db, RUN, PM);
  const ctx = {
    bb,
    db,
    isDisposed: () => false,
    effectiveProjectSettings: async () => ({ values: {} }),
    log: () => undefined,
  } as unknown as ServerCore;

  let onRunEvent: (runId: string) => Promise<void>;
  const engine = new WorkflowEngine({
    db,
    harnessVersion: "1.0.0",
    resolveWorkflow: (id) => builtinWorkflow(id),
    onEvent: (runId) => {
      void onRunEvent(runId);
    },
  });
  registerPureActions(engine);
  for (const [key, executor] of Object.entries(extraExecutors)) engine.register(key, executor);
  const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
    loadStore: async () => ({ store: storeOf(), project: "ok" }),
  });
  onRunEvent = createRunFinished(ctx, {
    triggers,
    subscribers: [(run) => writeEpisode(db, run, Date.now(), bb.log)],
  });
  return { bb, db, ctx, engine, harness, onRunEvent };
}

afterEach(() => {
  mockModelChoice.value = {
    choice: "invoice-send",
    confidence: 95,
    pattern: "invoice",
    rejected: [],
    questions: [],
  };
});

describe("errand episode writer", () => {
  it("writes one episode row with role:tool trace_json when an errand run finishes, and listErrandEpisodeTraces returns it", async () => {
    const { db, engine, harness } = setupWorld({
      "lp.errand_accounts": {
        reentrant: true,
        run: async () => ({ output: { ok: true, count: 0 } }),
      },
      "lp.errand": {
        reentrant: true,
        run: async () => ({
          output: {
            state: "done",
            reason: "",
            output: "Checked CRM.\nERRAND: done",
            files: [],
            thread_id: "thr_helper_1",
            verified: "done_checked",
            checks: ["CRM check → 12 leads"],
            handoff: "errand done",
          },
          threadId: "thr_helper_1",
          usage: {
            requestedProvider: "anthropic",
            requestedModel: "claude-opus-4-5",
            answeredProvider: "anthropic",
            answeredModel: "claude-opus-4-5",
            inputTokens: 10,
            outputTokens: 20,
            costUsd: 0.01,
          },
        }),
      },
    });

    const errandWf = builtinWorkflow("errand")!;
    const { runId, done } = engine.start({
      workflow: errandWf,
      inputs: {
        task: BRIEF_SECRET_TEXT,
        skills: ["browser-qa"],
      },
      link: { projectId: PROJECT, runId: RUN },
    });
    const summary = await done;
    await engine.idle();
    await flushMicrotasks();

    expect(summary.status).toBe("succeeded");

    const rows = db
      .prepare(`SELECT * FROM ${ERRAND_EPISODE_TABLE} WHERE run_id=?`)
      .all(runId) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row).toMatchObject({
      run_id: runId,
      extractor_version: ERRAND_EPISODE_EXTRACTOR_VERSION,
      project_id: PROJECT,
      workflow_id: "errand",
      status: "succeeded",
      outcome: "done",
      verified: "done_checked",
      thread_id: "thr_helper_1",
      model: "claude-opus-4-5",
      provider_id: "anthropic",
      trace_stats_json: null,
      process_key: null,
      enriched_model: null,
      enriched_at: null,
      summary_json: null,
      failure_class: null,
      process_key_proposed: null,
      enrichment_reason: null,
    });
    expect(JSON.parse(row.skills_offered_json as string)).toEqual(["browser-qa"]);
    expect(JSON.parse(row.checks_json as string)).toEqual(["CRM check → 12 leads"]);

    const expectedTrace = ["action:lp.errand_accounts", "errand:lp.errand", "action:builtin:emit"];
    expect(JSON.parse(row.trace_json as string)).toEqual(expectedTrace);

    const tracesMap = listErrandEpisodeTraces(db, [runId]);
    expect(tracesMap.get(runId)).toBe(JSON.stringify(expectedTrace));

    const debugLogs = harness.logEntries.filter((entry) => entry.level === "debug").map((entry) => entry.message);
    expect(
      debugLogs.some((msg) => msg.includes(`errand episode written run=${runId} steps=3 process_key=none`)),
    ).toBe(true);
    expect(harness.logEntries.some((entry) => entry.message.includes(BRIEF_SECRET_TEXT))).toBe(false);
  });

  it("updates instead of duplicating when a run finishes a second time", async () => {
    const { db, engine, bb } = setupWorld({
      "lp.errand_accounts": {
        reentrant: true,
        run: async () => ({ output: { ok: true, count: 0 } }),
      },
      "lp.errand": {
        reentrant: true,
        run: async () => ({
          output: {
            state: "done",
            reason: "",
            output: "Done.\nERRAND: done",
            files: [],
            thread_id: "thr_helper_2",
            verified: "done_unchecked",
            checks: [],
            handoff: "errand done",
          },
        }),
      },
    });

    const errandWf = builtinWorkflow("errand")!;
    const { runId, done } = engine.start({
      workflow: errandWf,
      inputs: { task: "Check status" },
      link: { projectId: PROJECT, runId: RUN },
    });
    await done;
    await engine.idle();
    await flushMicrotasks();

    const runRow = engine.journal.getRun(runId)!;
    const secondRunRow: RunRow = {
      ...runRow,
      status: "failed",
      reason: "rerun_failed",
      output_json: JSON.stringify({ state: "blocked", reason: "timed out", thread_id: "thr_helper_2" }),
    };
    writeEpisode(db, secondRunRow, runRow.updated_at + 5_000, bb.log);

    const rows = db
      .prepare(`SELECT * FROM ${ERRAND_EPISODE_TABLE} WHERE run_id=?`)
      .all(runId) as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      run_id: runId,
      status: "failed",
      outcome: "failed",
      updated_at: runRow.updated_at + 5_000,
    });
  });

  it("writes nothing for a non-errand graph without routeTop or pending row", async () => {
    const { db, engine } = setupWorld({
      "custom.step": {
        reentrant: true,
        run: async () => ({ output: { value: "ok" } }),
      },
    });

    const nonErrand = parseWorkflow({
      schemaVersion: 1,
      id: "plain-workflow",
      version: 1,
      name: "Plain workflow",
      description: { en: "Plain workflow", ru: "Обычный граф" },
      inputs: [{ name: "topic", type: "string" }],
      outputs: [{ name: "value", type: "string" }],
      nodes: [
        { id: "work", type: "action", uses: "custom.step", out: [{ name: "value", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { value: "work.value" } },
      ],
      edges: [
        { from: "start", to: "work" },
        { from: "work", to: "done" },
      ],
    });

    const { runId, done } = engine.start({
      workflow: nonErrand,
      inputs: { topic: "hello" },
      link: { projectId: PROJECT, runId: RUN },
    });
    const summary = await done;
    await engine.idle();
    await flushMicrotasks();

    expect(summary.status).toBe("succeeded");
    const rows = db.prepare(`SELECT * FROM ${ERRAND_EPISODE_TABLE} WHERE run_id=?`).all(runId);
    expect(rows).toHaveLength(0);
    expect(listErrandEpisodeTraces(db, [runId]).size).toBe(0);
  });

  it("creates a pending row right after routedGraph starts a matched graph and updates it on finish", async () => {
    const stubGraph = {
      schemaVersion: 1,
      id: "invoice-send",
      name: { en: "Invoice send", ru: "Отправка счёта" },
      description: { en: "Sends the invoice", ru: "Отправляет счёт" },
      status: "published",
      tags: ["invoice"],
      examples: { en: ["Send the November invoice to Acme Corp."], ru: [] },
      inputs: [{ name: "goal", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [
        { id: "work", type: "action", action: "noop", out: [{ name: "result", type: "string" }] },
        { id: "done", type: "action", action: "emit", map: { result: "work.result" } },
      ],
      edges: [
        { from: "start", to: "work", with: { goal: "input.goal" } },
        { from: "work", to: "done" },
      ],
    };

    let resolveStep!: (val: { output: Record<string, unknown> }) => void;
    const sdk = {
      providers: { list: async () => [] },
      projects: { get: async () => ({ sources: [{ hostId: "host-1", path: "/proj" }] }) },
      threads: {
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-1" }),
        getPluginMetadata: async () => ({}),
        spawn: async () => ({ id: "errand-thr-1" }),
        stop: async () => undefined,
        output: async () => ({ output: "Done.\nERRAND: done" }),
        events: { list: async () => [] },
      },
      environments: { get: async () => ({ id: "env-1", path: "/checkout", hostId: "host-1" }) },
    } as never;

    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk });
    const db = openDatabase(bb);
    createRun(db, RUN, PROJECT, "cli", "/checkout");
    setRunThread(db, RUN, PM);

    let onRunEvent: (runId: string) => Promise<void>;
    const engine = new WorkflowEngine({
      db,
      harnessVersion: "test",
      resolveWorkflow: (id) => builtinWorkflow(id),
      onEvent: (runId) => {
        void onRunEvent(runId);
      },
    });
    registerPureActions(engine);
    engine.register("noop", {
      reentrant: true,
      run: () => new Promise<{ output: Record<string, unknown> }>((resolve) => { resolveStep = resolve; }),
    } as never);

    const ctx = { bb, db, host: { call: async () => ({}) }, secrets: { check: async () => ({}), record: async () => undefined }, isDisposed: () => false, log: () => undefined } as unknown as ServerCore;
    const ready = await loadWorkflowStore({ builtin: [{ name: "invoice-send.json", value: stubGraph }] });
    const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
      loadStore: async () => ({ store: ready, project: "ok" }),
    });
    onRunEvent = createRunFinished(ctx, {
      triggers,
      subscribers: [(run) => writeEpisode(db, run, Date.now(), bb.log)],
    });
    mountErrands(ctx, { workflowEngine: engine, workflowCatalog: { store: async () => ready } } as never);

    mockModelChoice.value = { choice: "invoice-send", confidence: 95, pattern: "invoice", rejected: [], questions: [] };
    const answer = JSON.parse(
      String(await harness.behavior.callAgentTool("lane_pilot_errand", { task: "Send the November invoice to Acme Corp." }, { threadId: PM, projectId: PROJECT })),
    ) as { workflowRunId: string; workflow: string };

    expect(answer.workflow).toBe("invoice-send");
    const pendingRows = db
      .prepare(`SELECT * FROM ${ERRAND_EPISODE_TABLE} WHERE run_id=?`)
      .all(answer.workflowRunId) as Array<Record<string, unknown>>;
    expect(pendingRows).toHaveLength(1);
    expect(pendingRows[0]).toMatchObject({
      run_id: answer.workflowRunId,
      extractor_version: ERRAND_EPISODE_EXTRACTOR_VERSION,
      project_id: PROJECT,
      workflow_id: "invoice-send",
      status: "pending",
      outcome: "running",
    });

    // Complete the routed graph and verify the pending row is updated to finished with its step trace.
    resolveStep({ output: { result: "sent" } });
    await engine.idle();
    await flushMicrotasks();

    const finishedRows = db
      .prepare(`SELECT * FROM ${ERRAND_EPISODE_TABLE} WHERE run_id=?`)
      .all(answer.workflowRunId) as Array<Record<string, unknown>>;
    expect(finishedRows).toHaveLength(1);
    expect(finishedRows[0]).toMatchObject({
      run_id: answer.workflowRunId,
      status: "succeeded",
      workflow_id: "invoice-send",
    });
    expect(JSON.parse(finishedRows[0]!.trace_json as string)).toEqual(["action:noop", "action:builtin:emit"]);
  });

  it("logs a warning and swallows repository throws without failing the run", async () => {
    const warns: string[] = [];
    const failingDb: EpisodeDb = {
      prepare: () => {
        throw new Error("sqlite busy");
      },
    };
    const fakeRun = {
      id: "wfrun_err_1",
      idem_key: null,
      workflow_id: "errand",
      workflow_version: 1,
      workflow_sha256: "sha",
      definition_json: "{}",
      project_id: PROJECT,
      link_run_id: null,
      link_task_id: null,
      link_attempt_id: null,
      parent_run_id: null,
      parent_step_key: null,
      depth: 0,
      status: "succeeded",
      reason: null,
      mode: null,
      inputs_json: JSON.stringify({ task: BRIEF_SECRET_TEXT }),
      output_json: JSON.stringify({ state: "done" }),
      harness_version: null,
      steps_used: 0,
      tokens_used: 0,
      cost_micro_usd: 0,
      wait_ms: 0,
      owner_id: null,
      lease_until: 0,
      created_at: 1000,
      updated_at: 2000,
    } satisfies RunRow;

    expect(() => writeEpisode(failingDb, fakeRun, 3000, { warn: (m) => warns.push(m) })).not.toThrow();
    expect(() => writePendingEpisode(failingDb, { runId: "wfrun_err_2", threadId: null, projectId: PROJECT, processKey: null, now: 3000 }, { warn: (m) => warns.push(m) })).not.toThrow();
    expect(warns).toEqual([
      "errand episode write failed run=wfrun_err_1: sqlite busy",
      "errand episode write failed run=wfrun_err_2: sqlite busy",
    ]);

    // Also verify run completion stays green when an episode subscriber throws via createRunFinished.
    const { bb, db, engine, harness } = setupWorld();
    const failingTriggers = createWorkflowTriggers(
      { bb, db } as unknown as ServerCore,
      { workflowEngine: engine } as unknown as Services,
      { loadStore: async () => ({ store: storeOf(), project: "ok" }) },
    );
    const badOnRunEvent = createRunFinished(
      { db, log: () => undefined, bb },
      {
        triggers: failingTriggers,
        subscribers: [(run) => writeEpisode(failingDb, run, Date.now(), bb.log)],
      },
    );
    const runId = "wfrun_sub_1";
    db.prepare(
      `INSERT INTO lane_pilot_wf_run (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, created_at, updated_at)
       VALUES (?, 'errand', 1, 'sha', '{}', ?, 'succeeded', '{}', 1000, 2000)`,
    ).run(runId, PROJECT);
    await expect(badOnRunEvent(runId)).resolves.toBeUndefined();
    expect(
      harness.logEntries.some((entry) => entry.level === "warn" && entry.message.includes(`errand episode write failed run=${runId}: sqlite busy`)),
    ).toBe(true);
  });
});
