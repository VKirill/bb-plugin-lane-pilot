import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  DEFAULT_LOOP_MODES,
  evolveLoopAllows,
  LOOP_MODES,
  LOOP_NAMES,
  LP_EVENTS,
  type LoopMode,
} from "@lane-pilot/contracts";
import {
  GLOBAL_SETTINGS_PROJECT_ID,
  SETTING_LOOPS_MODE,
  SETTING_WORKFLOW_DISABLED,
} from "@lane-pilot/settings-catalog";
import {
  definitionSha256,
  parseWorkflow,
  WorkflowEngine,
  type StepContext,
  type Workflow,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ChainRuntime, ServerCore } from "../../src/rooms/contracts/server";
import { listRoad, parseLeadSettings } from "../../src/rooms/lead/server";
import { hubSnapshot } from "../../src/rooms/lead/server/services/tick-service";
import { listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import {
  createRun,
  openDatabase,
  readLoopMode,
  saveProjectSetting,
  setRunThread,
} from "../../src/rooms/plugin-db";
import { LOOPS_MODE_KEY } from "../../src/rooms/reports";
import { createBoardPause } from "../../src/rooms/schedule/server/repositories/board-pause-repository";
import type { Services } from "../../src/rooms/services";
import { validateSettingValue } from "../../src/rooms/settings";
import { upsertCharter } from "../../src/rooms/specialist/server";
import type { StoredWorkflow } from "../../src/rooms/storage";
import { WORKFLOW_DISABLED_KEY } from "../../src/rooms/workflow";
import {
  recordRouteMiss,
  workflowStartRefusal,
} from "../../src/rooms/workflow/server";
import {
  runWorkflowTool,
  type WorkflowToolDeps,
} from "../../src/rooms/workflow/server/handlers/workflow-tools";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/services/workflow-triggers";
import { setupLiveSpecialistEnv } from "../specialist/live-e2e-harness";

function memoryKv() {
  const data = new Map<string, unknown>();
  return {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (key: string) => {
      data.delete(key);
    },
    list: async (prefix = "") => [...data.keys()].filter((k) => k.startsWith(prefix)),
  };
}

function publishedWorkflow(
  id: string,
  extra: Record<string, unknown> = {},
): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id,
    version: 1,
    name: { en: id, ru: id },
    description: { en: `Test graph ${id}`, ru: `Тестовый граф ${id}` },
    status: "published",
    nodes: [
      {
        id: "echo",
        type: "action",
        action: "test.echo",
        params: { value: "ok" },
        out: [{ name: "out", type: "string" }],
      },
    ],
    edges: [
      { from: "start", to: "echo" },
      { from: "echo", to: "end" },
    ],
    ...extra,
  });
}

function storeFor(...workflows: Workflow[]): WorkflowStore {
  const items: StoredWorkflow[] = workflows.map((workflow) => ({
    workflow,
    origin: "project",
    source: `test:${workflow.id}.json`,
    sha256: definitionSha256(workflow),
    warnings: [],
  }));
  return {
    list: () => items,
    get: (id) => items.find((item) => item.workflow.id === id) ?? null,
    resolve: (id) => items.find((item) => item.workflow.id === id)?.workflow ?? null,
    problems: [],
  };
}

function setupTriggersEnv(...workflows: Workflow[]) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const pause = createBoardPause(memoryKv() as never);
  const logs: string[] = [];
  const origInfo = bb.log.info.bind(bb.log);
  bb.log.info = (message: string) => {
    logs.push(`INFO ${message}`);
    origInfo(message);
  };
  const store = storeFor(...workflows);
  const engine = new WorkflowEngine({
    db,
    harnessVersion: "1.0.0",
    resolveWorkflow: (id) => store.resolve(id),
  });
  engine.register("test.echo", {
    run: async () => ({ output: { out: "ok" } }),
  });

  const ctx = {
    bb,
    db,
    isDisposed: () => false,
    effectiveProjectSettings: async () => ({ values: {} }),
    log: (message: string) => logs.push(message),
  } as unknown as ServerCore;

  createRun(db, "pm-run-1", "proj-1");
  setRunThread(db, "pm-run-1", "pm-thread-1");

  const triggers = createWorkflowTriggers(
    ctx,
    { workflowEngine: engine } as unknown as Services,
    {
      loadStore: async () => ({ store, project: "ok" }),
      isBoardPaused: () => pause.isPaused(),
    },
  );

  const pmToolDeps = (pmLogs: string[]): WorkflowToolDeps => ({
    store: async () => store,
    engine: () => engine,
    db,
    runtime: ({ pmThreadId, projectId, runId }) => ({
      ctx,
      services: { workflowEngine: engine } as unknown as Services,
      pmThreadId,
      projectId,
      runId,
    }),
    warn: (msg) => pmLogs.push(msg),
    info: (msg) => pmLogs.push(msg),
    startRefusal: triggers.startRefusal,
  });

  return { bb, db, pause, logs, store, engine, ctx, triggers, pmToolDeps };
}

describe("Task 48 kill switches: board pause, workflow.disabled, and loops.mode", () => {
  describe("board_paused start refusal", () => {
    it("refuses event and schedule starts, leaves refused event unconsumed, and allows manual & PM starts", async () => {
      const evWf = publishedWorkflow("ev-graph", {
        triggers: [{ type: "event", event: LP_EVENTS.TASK_SETTLED }],
      });
      const schedWf = publishedWorkflow("sched-graph");
      const env = setupTriggersEnv(evWf, schedWf);

      await env.pause.set(true, "owner check");

      const eventResults = await env.triggers.emitEvent(
        LP_EVENTS.TASK_SETTLED,
        { taskId: "task_1", projectId: "proj-1" },
        { id: "ev_pause_1", projectId: "proj-1" },
      );
      expect(eventResults.started).toEqual([]);
      expect(eventResults.failed).toEqual([
        expect.objectContaining({
          workflowId: "ev-graph",
          reason: "board_paused",
        }),
      ]);

      // Refused for board_paused -> inbox row stays unconsumed (`consumed_by IS NULL`).
      const inboxAfterPause = env.db
        .prepare(`SELECT consumed_by FROM lane_pilot_wf_inbox WHERE id = ?`)
        .get("ev_pause_1") as { consumed_by: string | null };
      expect(inboxAfterPause.consumed_by).toBeNull();

      // Scheduled runs (both source="schedule" and origin="schedule") are refused.
      const schedRes = await env.triggers.start({
        projectId: "proj-1",
        workflowId: "sched-graph",
        inputs: {},
        source: "schedule",
      });
      expect(schedRes).toEqual({
        ok: false,
        reason: "board_paused",
        message: expect.any(String),
      });

      const schedOriginRes = await env.triggers.start({
        projectId: "proj-1",
        workflowId: "sched-graph",
        inputs: {},
        source: "manual",
        origin: "schedule",
      });
      expect(schedOriginRes).toEqual({
        ok: false,
        reason: "board_paused",
        message: expect.any(String),
      });

      // Manual and PM starts keep working when the board is paused.
      const manualRes = await env.triggers.start({
        projectId: "proj-1",
        workflowId: "sched-graph",
        inputs: {},
        source: "manual",
      });
      expect(manualRes.ok).toBe(true);

      const pmLogs: string[] = [];
      const pmRes = JSON.parse(
        await runWorkflowTool(
          env.pmToolDeps(pmLogs),
          { workflowId: "sched-graph", inputs: {} },
          { threadId: "pm-thread-1", projectId: "proj-1" },
        ),
      ) as { workflowRunId?: string; status: string };
      expect(pmRes.status).toBe("running");
      expect(pmRes.workflowRunId).toBeTruthy();

      expect(env.logs).toEqual(
        expect.arrayContaining([
          "INFO wf.start refused wf=ev-graph source=event reason=board_paused",
          "INFO wf.start refused wf=sched-graph source=schedule reason=board_paused",
        ]),
      );

      // Once unpaused, subsequent events start normally.
      await env.pause.set(false);
      const afterUnpause = await env.triggers.emitEvent(
        LP_EVENTS.TASK_SETTLED,
        { taskId: "task_2", projectId: "proj-1" },
        { id: "ev_pause_2", projectId: "proj-1" },
      );
      expect(afterUnpause.started).toEqual([
        expect.objectContaining({ workflowId: "ev-graph", created: true }),
      ]);
      expect(afterUnpause.failed).toEqual([]);
    });
  });

  describe("workflow.disabled kill switch", () => {
    it("refuses disabled workflows on manual, schedule, event, and PM starts and marks disabled events consumed", async () => {
      const evWf = publishedWorkflow("blocked-wf", {
        triggers: [{ type: "event", event: LP_EVENTS.TASK_SETTLED }],
      });
      const env = setupTriggersEnv(evWf);

      expect(WORKFLOW_DISABLED_KEY).toBe(SETTING_WORKFLOW_DISABLED);
      expect(validateSettingValue(WORKFLOW_DISABLED_KEY, ["blocked-wf"])).toBeNull();
      expect(validateSettingValue(WORKFLOW_DISABLED_KEY, "blocked-wf")).toBeTruthy();

      saveProjectSetting(env.db, "proj-1", WORKFLOW_DISABLED_KEY, ["blocked-wf"]);

      const manualRes = await env.triggers.start({
        projectId: "proj-1",
        workflowId: "blocked-wf",
        inputs: {},
        source: "manual",
      });
      expect(manualRes).toEqual({
        ok: false,
        reason: "workflow_disabled",
        message: expect.stringContaining("disabled"),
      });

      const schedRes = await env.triggers.start({
        projectId: "proj-1",
        workflowId: "blocked-wf",
        inputs: {},
        source: "schedule",
      });
      expect(schedRes).toEqual({
        ok: false,
        reason: "workflow_disabled",
        message: expect.stringContaining("disabled"),
      });

      const pmLogs: string[] = [];
      const pmRes = JSON.parse(
        await runWorkflowTool(
          env.pmToolDeps(pmLogs),
          { workflowId: "blocked-wf", inputs: {} },
          { threadId: "pm-thread-1", projectId: "proj-1" },
        ),
      ) as { status: string; workflow: string; reason: string };
      expect(pmRes).toMatchObject({ status: "refused", workflow: "blocked-wf" });
      expect(pmRes.reason).toContain("workflow_disabled");

      const evRes = await env.triggers.emitEvent(
        LP_EVENTS.TASK_SETTLED,
        { taskId: "task_blocked", projectId: "proj-1" },
        { id: "ev_disable_1", projectId: "proj-1" },
      );
      expect(evRes.started).toEqual([]);
      expect(evRes.failed).toEqual([
        expect.objectContaining({
          workflowId: "blocked-wf",
          reason: "workflow_disabled",
        }),
      ]);

      // Refused for workflow_disabled -> inbox row is marked consumed so it does not spin forever.
      const inboxAfterDisable = env.db
        .prepare(`SELECT consumed_by FROM lane_pilot_wf_inbox WHERE id = ?`)
        .get("ev_disable_1") as { consumed_by: string | null };
      expect(inboxAfterDisable.consumed_by).toBe("disabled:blocked-wf");

      // Global disable works across projects as well.
      saveProjectSetting(env.db, GLOBAL_SETTINGS_PROJECT_ID, WORKFLOW_DISABLED_KEY, ["global-off"]);
      expect(
        workflowStartRefusal({
          db: env.db,
          workflowId: "global-off",
          source: "manual",
          projectId: "other-project",
        }),
      ).toBe("workflow_disabled");

      expect(env.logs).toEqual(
        expect.arrayContaining([
          "INFO wf.start refused wf=blocked-wf source=manual reason=workflow_disabled",
          "INFO wf.start refused wf=blocked-wf source=schedule reason=workflow_disabled",
          "INFO wf.start refused wf=blocked-wf source=event reason=workflow_disabled",
        ]),
      );
      expect(pmLogs).toEqual(
        expect.arrayContaining([
          "wf.start refused wf=blocked-wf source=pm reason=workflow_disabled",
        ]),
      );
    });
  });

  describe("loops.mode controls across autonomous loops", () => {
    let leadDir = "";
    beforeEach(() => {
      leadDir = mkdtempSync(join(tmpdir(), "lp-kill-switch-lead-"));
      process.env.LANE_PILOT_LEAD_DIR = leadDir;
    });
    afterEach(() => {
      rmSync(leadDir, { recursive: true, force: true });
      delete process.env.LANE_PILOT_LEAD_DIR;
    });

    it("defaults every loop in LOOP_NAMES to 'on', validates loops.mode, and gates a stubbed evolve handler", async () => {
      expect(LOOPS_MODE_KEY).toBe(SETTING_LOOPS_MODE);
      expect(LOOP_NAMES).toEqual(["discovery", "branches", "evolve", "employee", "templates"]);
      expect(LOOP_MODES).toEqual(["on", "report", "off"]);
      expect(DEFAULT_LOOP_MODES).toEqual({
        discovery: "on",
        branches: "on",
        evolve: "on",
        employee: "on",
        templates: "on",
      });

      const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
      const db = openDatabase(bb);
      for (const loop of LOOP_NAMES) {
        expect(readLoopMode(db, loop, "proj-1")).toBe("on");
      }

      expect(validateSettingValue(LOOPS_MODE_KEY, { evolve: "report" })).toBeNull();
      expect(validateSettingValue(LOOPS_MODE_KEY, { bogus: "off" })).toBeTruthy();
      expect(validateSettingValue(LOOPS_MODE_KEY, { evolve: "paused" })).toBeTruthy();

      // Evolve executor gate contract using shared readLoopMode + evolveLoopAllows helper.
      let trialsOpened = 0;
      const runEvolveStub = (modeProjectId: string) => {
        const mode: LoopMode = readLoopMode(db, "evolve", modeProjectId);
        const allow = evolveLoopAllows(mode);
        if (!allow.run || !allow.openTrials) return { ok: true, mode, skipped: true };
        trialsOpened += 1;
        return { ok: true, mode, skipped: false };
      };

      expect(runEvolveStub("proj-1")).toEqual({ ok: true, mode: "on", skipped: false });
      expect(trialsOpened).toBe(1);

      saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, LOOPS_MODE_KEY, { evolve: "report" });
      expect(runEvolveStub("proj-1")).toEqual({ ok: true, mode: "report", skipped: true });
      expect(trialsOpened).toBe(1);

      saveProjectSetting(db, "proj-1", LOOPS_MODE_KEY, { evolve: "off" });
      expect(runEvolveStub("proj-1")).toEqual({ ok: true, mode: "off", skipped: true });
      expect(trialsOpened).toBe(1);
    });

    it("skips discovery candidate sync into lane_pilot_lead_road when discovery mode is 'report' or 'off'", async () => {
      const { bb } = createFakePluginHost({
        pluginId: "lane-pilot",
        sdk: { skills: { list: async () => [] } },
      });
      const db = openDatabase(bb);
      const settings = parseLeadSettings({});
      const catalogServices = {
        workflowCatalog: {
          store: async () => ({ list: () => [] }),
          builtins: () => [],
        },
      } as never;

      recordRouteMiss(db, {
        projectId: "proj-disc",
        source: "errand_route",
        kind: "no_candidate",
        brief: "Automate weekly billing summary",
        now: Date.now() - 10_000,
      });

      saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, LOOPS_MODE_KEY, { discovery: "report" });
      await hubSnapshot({ db, bb } as never, settings, { tickId: "tick_report", trigger: "manual" }, Date.now(), catalogServices);
      expect(listRoad(db, { kind: "option" })).toHaveLength(0);

      saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, LOOPS_MODE_KEY, { discovery: "off" });
      await hubSnapshot({ db, bb } as never, settings, { tickId: "tick_off", trigger: "manual" }, Date.now(), catalogServices);
      expect(listRoad(db, { kind: "option" })).toHaveLength(0);

      saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, LOOPS_MODE_KEY, { discovery: "on" });
      await hubSnapshot({ db, bb } as never, settings, { tickId: "tick_on", trigger: "manual" }, Date.now(), catalogServices);
      expect(listRoad(db, { kind: "option" })).toHaveLength(1);
    });

    it("forces employee loop into propose-only in 'report' mode across sp.commit_memory and sp.dispatch_tasks", async () => {
      const env = await setupLiveSpecialistEnv();
      try {
        upsertCharter(env.db, {
          projectId: env.projectId,
          domain: "marketing",
          charter: {
            budgets: {
              daily_cap_usd: 100,
              cell_cap_usd: 100,
              rolling_24h_auto_cap_usd: 100,
              max_active_cells: 10,
            },
          },
        });
        saveProjectSetting(env.db, env.projectId, LOOPS_MODE_KEY, { employee: "report" });

        const execs = (
          env.engine as unknown as {
            executors: Map<string, { run: (c: StepContext<ChainRuntime>) => Promise<{ output: Record<string, unknown> }> }>;
          }
        ).executors;

        // 1) sp.commit_memory in 'report' mode forces orders to 'held' instead of committing them for live execution.
        const commitExec = execs.get("sp.commit_memory")!;
        const commitParams = {
          phase: "intents",
          domain: "marketing",
          ownerAnswer: "approve",
          orders: [
            {
              kind: "schedule",
              title: "Weekly report cron",
              cron: "0 8 * * 1",
              targetWorkflowId: "mkt-weekly-review",
              estimated_cost_usd: 2,
            },
          ],
        };
        const commitRes = await commitExec.run({
          runId: "wf_emp_commit_report",
          stepId: "step_commit",
          stepKey: "wf_emp_commit_report:step_commit",
          mode: "live",
          node: {
            id: "step_commit",
            type: "action",
            action: "sp.commit_memory",
            params: commitParams,
            out: [
              { name: "held", type: "number" },
              { name: "intents", type: "number" },
            ],
          },
          workflow: { id: "mkt-weekly-review", version: 1, name: { en: "Weekly Review" }, nodes: [], edges: [] } as unknown as Workflow,
          runtime: env.rt,
          template: (v: unknown) => v,
          render: (s: string) => s,
          resolve: (v: unknown) => v,
          params: commitParams,
        } as unknown as StepContext<ChainRuntime>);
        expect(commitRes.output.held).toBe(1);
        const heldRows = env.db
          .prepare(`SELECT status FROM lane_pilot_sp_intent WHERE project_id = ? AND domain = ?`)
          .all(env.projectId, "marketing") as Array<{ status: string }>;
        expect(heldRows.length).toBeGreaterThan(0);
        expect(heldRows.every((row) => row.status === "held")).toBe(true);

        // 2) sp.dispatch_tasks in 'report' mode posts an owner proposal instead of executing or saving a schedule.
        const dispatchExec = execs.get("sp.dispatch_tasks")!;
        const dispatchParams = {
          domain: "marketing",
          orders: [
            {
              kind: "schedule",
              title: "Proposed-only cron",
              reason_code: "seo_sync",
              cron: "0 9 * * 1",
              targetWorkflowId: "seo-monitor",
              estimated_cost_usd: 2,
            },
          ],
        };
        const dispatchRes = await dispatchExec.run({
          runId: "wf_emp_dispatch_report",
          stepId: "step_dispatch",
          stepKey: "wf_emp_dispatch_report:step_dispatch",
          mode: "live",
          node: { id: "step_dispatch", type: "action", action: "sp.dispatch_tasks", params: dispatchParams, out: [] },
          workflow: { id: "mkt-weekly-review", version: 1, name: { en: "Weekly Review" }, nodes: [], edges: [] } as unknown as Workflow,
          runtime: env.rt,
          template: (v: unknown) => v,
          render: (s: string) => s,
          resolve: (v: unknown) => v,
          params: dispatchParams,
        } as unknown as StepContext<ChainRuntime>);

        expect(dispatchRes.output.executed_count).toBe(0);
        expect(dispatchRes.output.proposed_count).toBe(1);
        expect(env.savedSchedules).toHaveLength(0);
        expect(
          listOpenOwnerItems(env.db, { source: "specialist" }).some((item) => item.what.includes("Proposed-only cron")),
        ).toBe(true);

        // 3) sp.dispatch_tasks in 'off' mode skips all dispatches.
        saveProjectSetting(env.db, env.projectId, LOOPS_MODE_KEY, { employee: "off" });
        const dispatchOff = await dispatchExec.run({
          runId: "wf_emp_dispatch_off",
          stepId: "step_dispatch",
          stepKey: "wf_emp_dispatch_off:step_dispatch",
          mode: "live",
          node: { id: "step_dispatch", type: "action", action: "sp.dispatch_tasks", params: dispatchParams, out: [] },
          workflow: { id: "mkt-weekly-review", version: 1, name: { en: "Weekly Review" }, nodes: [], edges: [] } as unknown as Workflow,
          runtime: env.rt,
          template: (v: unknown) => v,
          render: (s: string) => s,
          resolve: (v: unknown) => v,
          params: dispatchParams,
        } as unknown as StepContext<ChainRuntime>);
        expect(dispatchOff.output).toMatchObject({
          dispatched_count: 0,
          executed_count: 0,
          proposed_count: 0,
          dispatched_ids: [],
        });
      } finally {
        await env.dispose();
      }
    });
  });
});
