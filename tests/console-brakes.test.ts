import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  createWorkflowCatalog,
  definitionSha256,
  parseWorkflow,
  WorkflowEngine,
  type StepContext,
  type Workflow,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRAKE_IDS, type BrakesOutput, type StopAllOutput } from "../src/rooms/contracts";
import type { ChainRuntime, ServerCore } from "../src/rooms/contracts/server";
import { createCore } from "../src/rooms/core/server/core";
import { buildBrakesDeps } from "../src/rooms/core/server/rpc";
import { brakesRpc, createBrakesService } from "../src/rooms/owner-waiting/server";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, setRunThread } from "../src/rooms/plugin-db";
import { runsRpc } from "../src/rooms/runs/server";
import { createScheduleStore } from "../src/rooms/schedule";
import { createScheduleService } from "../src/rooms/schedule/server";
import { SPECIALIST_PAUSED_ALL_KEY } from "../src/rooms/specialist";
import { executeSpecialistOrder } from "../src/rooms/specialist/server/services/sp-dispatch-runner";
import type { Services } from "../src/rooms/services";
import type { StoredWorkflow } from "../src/rooms/storage";
import { WORKFLOW_DISABLED_KEY, WORKFLOW_TRIGGERS_PAUSED_KEY } from "../src/rooms/workflow";
import { BUILTIN_SOURCES } from "../src/rooms/workflow/builtin";
import { createWorkflowTriggers } from "../src/rooms/workflow/server/services/workflow-triggers";
import { validateSettingValue } from "../src/rooms/settings";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function publishedWorkflow(id: string, extra: Record<string, unknown> = {}): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id,
    version: 1,
    name: { en: id, ru: id },
    description: { en: `Test graph ${id}`, ru: `Тестовый граф ${id}` },
    status: "published",
    nodes: [{ id: "echo", type: "action", action: "test.echo", params: { value: "ok" }, out: [{ name: "out", type: "string" }] }],
    edges: [{ from: "start", to: "echo" }, { from: "echo", to: "end" }],
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

function createWiredBrakesRpc(bb: ReturnType<typeof createFakePluginHost>["bb"], db: ReturnType<typeof openDatabase>) {
  const ctx = createCore(bb, db);
  const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", resolveWorkflow: () => null });
  const workflowCatalog = createWorkflowCatalog({ builtin: BUILTIN_SOURCES, db });
  const services = {
    workflowEngine: engine,
    workflowCatalog,
    rollback: { recoverRevertIntents: async () => undefined },
  } as unknown as Services;
  Object.assign(services, createScheduleService(ctx, services as never));
  const runs = runsRpc(ctx, services);
  return brakesRpc(ctx, buildBrakesDeps(ctx, services, (runId) => runs.halt_run({ runId })));
}

function seedSchedule(
  schedStore: ReturnType<typeof createScheduleStore>,
  input: {
    name: string;
    cron: string;
    state: "active" | "paused";
    task: Parameters<ReturnType<typeof createScheduleStore>["insert"]>[0]["task"];
  },
) {
  return schedStore.insert(
    {
      projectId: "proj-1",
      name: input.name,
      description: "",
      task: input.task,
      when: { type: "cron", cron: input.cron, timezone: "UTC" },
      missed: "skip",
      missedLimit: 5,
      overlap: "skip",
      timeoutSec: 3600,
      maxFailures: 3,
    },
    { createdBy: "owner", state: input.state },
  );
}

describe("console brakes (brakes_get, brakes_set, stop_all)", () => {
  it("sets and unsets each brake independently with accurate impact and round-trip state", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const infoLogs: string[] = [];
    const origInfo = bb.log.info.bind(bb.log);
    bb.log.info = (msg: string) => {
      infoLogs.push(msg);
      origInfo(msg);
    };

    // Seed schedules: 1 active agent schedule, 1 active sp-specialist-tick workflow, 1 active regular errand, 1 already-paused specialist.
    const schedStore = createScheduleStore(db, () => 1_700_000_000_000);
    const agentSched = seedSchedule(schedStore, {
      name: "SEO agent routine",
      cron: "0 9 * * *",
      state: "active",
      task: { kind: "agent", agentId: "seo-specialist", task: "Audit organic pages every morning", authorized: false, accounts: [], historyRuns: 5 },
    });
    const tickSched = seedSchedule(schedStore, {
      name: "Marketing shift",
      cron: "0 10 * * *",
      state: "active",
      task: { kind: "workflow", workflowId: "sp-specialist-tick", inputs: { domain: "marketing" } },
    });
    const errandSched = seedSchedule(schedStore, {
      name: "Regular errand",
      cron: "0 11 * * *",
      state: "active",
      task: { kind: "errand", task: "Check daily metrics in dashboard", authorized: false, accounts: [] },
    });
    const prePausedSpec = seedSchedule(schedStore, {
      name: "Pre-paused specialist",
      cron: "0 12 * * *",
      state: "paused",
      task: { kind: "agent", agentId: "copy-lead", task: "Draft weekly headlines", authorized: false, accounts: [], historyRuns: 5 },
    });

    // Seed 2 queued writer attempts in an open run and 1 queued attempt in a closed run.
    createRun(db, "run-open", "proj-1");
    createTask(db, { id: "T1", runId: "run-open", kind: "bb", contract: { title: "T1" } });
    createTask(db, { id: "T2", runId: "run-open", kind: "bb", contract: { title: "T2" } });
    createAttempt(db, { id: "att-1", runId: "run-open", taskId: "T1" });
    createAttempt(db, { id: "att-2", runId: "run-open", taskId: "T2" });

    createRun(db, "run-closed", "proj-1");
    createTask(db, { id: "T3", runId: "run-closed", kind: "bb", contract: { title: "T3" } });
    createAttempt(db, { id: "att-3", runId: "run-closed", taskId: "T3" });
    db.prepare("UPDATE lane_pilot_run SET state='closed', closed_at=1000 WHERE id='run-closed'").run();

    const rpc = createWiredBrakesRpc(bb, db);

    const initial = (await rpc.brakes_get()) as BrakesOutput;
    expect(initial.brakes.map((b) => b.id)).toEqual([...BRAKE_IDS]);
    for (const brake of initial.brakes) {
      expect(brake.paused).toBe(false);
      expect(brake.since).toBeNull();
      expect(brake.reason).toBeNull();
    }
    expect(initial.brakes.find((b) => b.id === "schedules")?.impact.count).toBe(3);
    expect(initial.brakes.find((b) => b.id === "conveyor")?.impact.count).toBe(2);
    expect(initial.brakes.find((b) => b.id === "graphs")?.impact.count).toBeGreaterThan(0);
    expect(initial.brakes.find((b) => b.id === "staff")?.impact.count).toBe(2);

    // 1) Pause schedules only
    const afterSchedules = (await rpc.brakes_set({
      id: "schedules",
      paused: true,
      reason: "nightly check",
    })) as BrakesOutput;
    expect(afterSchedules.brakes.find((b) => b.id === "schedules")).toMatchObject({
      id: "schedules",
      paused: true,
      reason: "nightly check",
    });
    expect(typeof afterSchedules.brakes.find((b) => b.id === "schedules")?.since).toBe("number");
    expect(afterSchedules.brakes.find((b) => b.id === "conveyor")?.paused).toBe(false);
    expect(afterSchedules.brakes.find((b) => b.id === "graphs")?.paused).toBe(false);
    expect(afterSchedules.brakes.find((b) => b.id === "staff")?.paused).toBe(false);

    // 2) Pause conveyor
    const afterConveyor = (await rpc.brakes_set({
      id: "conveyor",
      paused: true,
      reason: "hold writers",
    })) as BrakesOutput;
    expect(afterConveyor.brakes.find((b) => b.id === "conveyor")).toMatchObject({
      id: "conveyor",
      paused: true,
      reason: "hold writers",
    });
    expect(typeof afterConveyor.brakes.find((b) => b.id === "conveyor")?.since).toBe("number");

    // 3) Pause graphs
    const afterGraphs = (await rpc.brakes_set({
      id: "graphs",
      paused: true,
      reason: "pause triggers",
    })) as BrakesOutput;
    expect(afterGraphs.brakes.find((b) => b.id === "graphs")).toMatchObject({
      id: "graphs",
      paused: true,
      reason: "pause triggers",
    });
    expect(typeof afterGraphs.brakes.find((b) => b.id === "graphs")?.since).toBe("number");

    // 4) Pause staff: pauses active specialist schedules, leaves errand untouched, sets KV flag
    const afterStaff = (await rpc.brakes_set({
      id: "staff",
      paused: true,
      reason: "freeze staff",
    })) as BrakesOutput;
    expect(afterStaff.brakes.find((b) => b.id === "staff")).toMatchObject({
      id: "staff",
      paused: true,
      reason: "freeze staff",
    });
    expect(schedStore.get(agentSched.id)?.state).toBe("paused");
    expect(schedStore.get(tickSched.id)?.state).toBe("paused");
    expect(schedStore.get(errandSched.id)?.state).toBe("active");
    expect(schedStore.get(prePausedSpec.id)?.state).toBe("paused");
    expect(await bb.storage.kv.get(SPECIALIST_PAUSED_ALL_KEY)).toMatchObject({ paused: true, reason: "freeze staff" });

    // Unset each brake and verify round-trip + specialist schedule restoration (pre-paused remains paused)
    await rpc.brakes_set({ id: "schedules", paused: false });
    await rpc.brakes_set({ id: "conveyor", paused: false });
    await rpc.brakes_set({ id: "graphs", paused: false });
    const afterAllUnset = (await rpc.brakes_set({ id: "staff", paused: false })) as BrakesOutput;

    for (const brake of afterAllUnset.brakes) {
      expect(brake.paused).toBe(false);
      expect(brake.since).toBeNull();
      expect(brake.reason).toBeNull();
    }
    expect(schedStore.get(agentSched.id)?.state).toBe("active");
    expect(schedStore.get(tickSched.id)?.state).toBe("active");
    expect(schedStore.get(errandSched.id)?.state).toBe("active");
    expect(schedStore.get(prePausedSpec.id)?.state).toBe("paused");
    expect(await bb.storage.kv.get(SPECIALIST_PAUSED_ALL_KEY)).toBeNull();

    expect(infoLogs).toContain("[brakes] set id=schedules paused=true by=rpc reason=nightly check");
    expect(infoLogs).toContain("[brakes] set id=staff paused=false by=rpc reason=-");
  });

  it("stop_all sets all four brakes and continues halting remaining runs when one halt_run fails", async () => {
    const makeBrake = (initPaused: boolean) => {
      let paused = initPaused;
      return {
        getState: async () => ({ paused, since: paused ? 100 : null, reason: paused ? "emergency" : null }),
        setState: async (next: boolean, reason?: string) => {
          paused = next;
          return { paused, since: paused ? 100 : null, reason: reason ?? null };
        },
      };
    };
    let conveyorOn = true;
    const infoLogs: string[] = [];
    const warnLogs: string[] = [];

    const service = createBrakesService({
      schedules: { ...makeBrake(false), activeCount: () => 2 },
      conveyor: {
        getState: async () => ({ on: conveyorOn, since: conveyorOn ? null : new Date(100).toISOString(), reason: conveyorOn ? null : "emergency" }),
        setState: async (on, reason) => {
          conveyorOn = on;
          return { on, since: on ? null : new Date(100).toISOString(), reason: reason ?? null };
        },
        queuedCount: () => 1,
      },
      graphs: { ...makeBrake(false), triggeredCount: () => 4 },
      staff: { ...makeBrake(false), activeSpecialistCount: () => 1 },
      listActiveRunIds: () => ["run-ok-1", "run-fail", "run-ok-2"],
      haltRun: async (runId) => {
        if (runId === "run-fail") throw new Error("halt exploded");
        return { ok: true };
      },
      log: { info: (m) => infoLogs.push(m), warn: (m) => warnLogs.push(m) },
    });

    const res: StopAllOutput = await service.stopAll({ reason: "emergency stop" });
    expect(res.brakes.every((b) => b.paused)).toBe(true);
    expect(res.halted).toEqual([
      { runId: "run-ok-1", ok: true },
      { runId: "run-fail", ok: false },
      { runId: "run-ok-2", ok: true },
    ]);
    expect(infoLogs).toContain("[brakes] stop_all halted=2 failed=1");
    expect(warnLogs.some((m) => m.includes("run-fail") && m.includes("halt exploded"))).toBe(true);
  });

  it("stop_all via RPC halts active runs from buildTaskBoard and sets all four brakes", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    createRun(db, "run-active-board", "proj-1");
    createTask(db, { id: "T1", runId: "run-active-board", kind: "bb", contract: { title: "T1" } });
    createAttempt(db, { id: "att-live", runId: "run-active-board", taskId: "T1" });

    const rpc = createWiredBrakesRpc(bb, db);
    const out = (await rpc.stop_all({ reason: "owner panic" })) as StopAllOutput;
    expect(out.brakes).toHaveLength(4);
    expect(out.brakes.every((b) => b.paused)).toBe(true);
    expect(out.halted).toEqual([{ runId: "run-active-board", ok: true }]);
  });

  it("returns paused=false and reason='unavailable' with warn log when a backing store is unavailable", async () => {
    const warns: string[] = [];
    const service = createBrakesService({
      schedules: null,
      conveyor: {
        getState: async () => {
          throw new Error("kv offline");
        },
        setState: async () => {
          throw new Error("kv offline");
        },
        queuedCount: () => 0,
      },
      graphs: {
        getState: async () => ({ paused: true, since: 123, reason: "manual" }),
        setState: async () => ({ paused: true, since: 123, reason: "manual" }),
        triggeredCount: () => 3,
      },
      staff: null,
      log: { warn: (m) => warns.push(m) },
    });

    const out = await service.get();
    expect(out.brakes.find((b) => b.id === "schedules")).toMatchObject({ id: "schedules", paused: false, since: null, reason: "unavailable" });
    expect(out.brakes.find((b) => b.id === "conveyor")).toMatchObject({ id: "conveyor", paused: false, since: null, reason: "unavailable" });
    expect(out.brakes.find((b) => b.id === "graphs")).toMatchObject({ id: "graphs", paused: true, since: 123, reason: "manual" });
    expect(out.brakes.find((b) => b.id === "staff")).toMatchObject({ id: "staff", paused: false, since: null, reason: "unavailable" });
    expect(warns.some((m) => m.includes("brake=schedules unavailable"))).toBe(true);
    expect(warns.some((m) => m.includes("brake=conveyor unavailable"))).toBe(true);
    expect(warns.some((m) => m.includes("brake=staff unavailable"))).toBe(true);
  });

  it("specialist dispatcher refuses while specialist.paused_all is set and resumes when cleared", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);

    const stepCtx = {
      runId: "wf_sp_1",
      stepId: "dispatch",
      stepKey: "wf_sp_1:dispatch",
      mode: "live",
      workflow: { id: "sp-specialist-tick" },
    } as unknown as StepContext<ChainRuntime>;
    const rt = { ctx, services: {} as Services, pmThreadId: null, projectId: "proj-1", runId: null } as unknown as ChainRuntime;

    await bb.storage.kv.set(SPECIALIST_PAUSED_ALL_KEY, { paused: true, since: Date.now(), reason: "staff brake" });

    const refused = await executeSpecialistOrder({
      ctx,
      deps: { backlog: { scan: vi.fn(async () => ({ ok: true })) } },
      c: stepCtx,
      rt,
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      intentRow: { intent_id: "int-1", idem_key: "idem-1", order_kind: "owner_gate", order_json: "{}" },
      orderObj: { kind: "owner_gate", title: "Need check" },
      checkout: null,
      writeCheckoutFile: async () => "",
    });
    expect(refused).toMatchObject({
      ok: false,
      disposition: "blocked",
      blockReason: "specialist_paused_all",
    });

    await bb.storage.kv.set(SPECIALIST_PAUSED_ALL_KEY, null);
    const resumed = await executeSpecialistOrder({
      ctx,
      deps: {},
      c: stepCtx,
      rt,
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      intentRow: { intent_id: "int-2", idem_key: "idem-2", order_kind: "owner_gate", order_json: "{}" },
      orderObj: { kind: "owner_gate", title: "Need check" },
      checkout: null,
      writeCheckoutFile: async () => "",
    });
    expect(resumed).toMatchObject({
      ok: true,
      disposition: "waiting_owner",
    });
  });

  it("workflow triggers refuse while workflow.triggers_paused is set before per-graph workflow.disabled check", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    expect(validateSettingValue(WORKFLOW_TRIGGERS_PAUSED_KEY, true)).toBeNull();
    expect(validateSettingValue(WORKFLOW_TRIGGERS_PAUSED_KEY, false)).toBeNull();

    const evWf = publishedWorkflow("ev-graph", {
      triggers: [{ type: "event", event: LP_EVENTS.TASK_SETTLED }],
    });
    const schedWf = publishedWorkflow("sched-graph", {
      triggers: [{ type: "schedule", cron: "0 9 * * *" }],
    });
    const store = storeFor(evWf, schedWf);
    const engine = new WorkflowEngine({
      db,
      harnessVersion: "1.0.0",
      resolveWorkflow: (id) => store.resolve(id),
    });
    engine.register("test.echo", { run: async () => ({ output: { out: "ok" } }) });

    const ctx = {
      bb,
      db,
      isDisposed: () => false,
      effectiveProjectSettings: async () => ({ values: {} }),
      log: () => undefined,
    } as unknown as ServerCore;

    createRun(db, "pm-run-1", "proj-1");
    setRunThread(db, "pm-run-1", "pm-thread-1");

    const triggers = createWorkflowTriggers(
      ctx,
      { workflowEngine: engine } as unknown as Services,
      { loadStore: async () => ({ store, project: "ok" }) },
    );

    // Put ev-graph in per-graph workflow.disabled AND set global workflow.triggers_paused=true:
    // triggers_paused must win before per-graph check.
    saveProjectSetting(db, "proj-1", WORKFLOW_DISABLED_KEY, ["ev-graph"]);
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, WORKFLOW_TRIGGERS_PAUSED_KEY, true);

    const eventRes = await triggers.emitEvent(
      LP_EVENTS.TASK_SETTLED,
      { taskId: "t1", projectId: "proj-1" },
      { id: "ev_trig_paused_1", projectId: "proj-1" },
    );
    expect(eventRes.started).toEqual([]);
    expect(eventRes.failed).toEqual([
      expect.objectContaining({ workflowId: "ev-graph", reason: "triggers_paused" }),
    ]);
    const inboxRow = db.prepare("SELECT consumed_by FROM lane_pilot_wf_inbox WHERE id = ?").get("ev_trig_paused_1") as { consumed_by: string | null };
    expect(inboxRow.consumed_by).toBeNull();

    const schedRes = await triggers.start({
      projectId: "proj-1",
      workflowId: "sched-graph",
      inputs: {},
      source: "schedule",
    });
    expect(schedRes).toMatchObject({ ok: false, reason: "triggers_paused" });

    // Manual start still works while triggers are paused.
    const manualRes = await triggers.start({
      projectId: "proj-1",
      workflowId: "sched-graph",
      inputs: {},
      source: "manual",
    });
    expect(manualRes.ok).toBe(true);

    // Clearing workflow.triggers_paused restores schedule trigger starts.
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, WORKFLOW_TRIGGERS_PAUSED_KEY, false);
    const schedAfterResume = await triggers.start({
      projectId: "proj-1",
      workflowId: "sched-graph",
      inputs: {},
      source: "schedule",
    });
    expect(schedAfterResume.ok).toBe(true);
  });
});
