import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { LP_EVENTS } from "@lane-pilot/contracts";
import {
  WorkflowEngine,
  definitionSha256,
  loadWorkflow,
  parseWorkflow,
  type NodeExecutor,
  type StoredWorkflow,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/services/workflow-triggers";
import { installThreadEventFeed, mountPmTurnWatch } from "../../src/rooms/stability/server";
import { workflow } from "./fixtures";
import { engineOn, journalDb, ok, rows, stepStates } from "./engine-helpers";

const PROJECT = "proj_a";
const PM = "pm_1";
const RUN = "lprun_1";

const stored = (definition: Record<string, unknown>, origin: StoredWorkflow["origin"] = "global"): StoredWorkflow => {
  const parsed = parseWorkflow(definition);
  return { workflow: parsed, origin, source: `${parsed.id}.json`, sha256: definitionSha256(parsed), warnings: [] };
};

const storeOf = (...items: StoredWorkflow[]): WorkflowStore => ({
  list: () => items,
  get: (id) => items.find((item) => item.workflow.id === id) ?? null,
  resolve: (id) => items.find((item) => item.workflow.id === id)?.workflow ?? null,
  problems: [],
});

const until = async (what: string, read: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  while (!read()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function setupWorld(items: StoredWorkflow[], extraExecutors: Record<string, NodeExecutor> = {}) {
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const logRows: Array<{ threadId: string; seq: number; type: string; createdAt: number; data: unknown }> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) =>
    (threadId === PM ? { role: "pm" } : { role: "pm", architectProjectId: PROJECT }));
  harness.sdk.stub("threads.events.list", async (query: { threadId?: string; types?: string[]; order?: string; limit?: string; afterSeq?: string; beforeSeq?: string }) => {
    let found = logRows.filter((row) => row.threadId === query.threadId && (!query.types?.length || query.types.includes(row.type)));
    if (query.afterSeq !== undefined) found = found.filter((row) => row.seq > Number(query.afterSeq));
    if (query.beforeSeq !== undefined) found = found.filter((row) => row.seq < Number(query.beforeSeq));
    found = [...found].sort((a, b) => (query.order === "desc" ? b.seq - a.seq : a.seq - b.seq));
    return found.slice(0, Number(query.limit) || 100).map((row) => ({ seq: row.seq, type: row.type, createdAt: row.createdAt, data: row.data }));
  });
  (bb as unknown as { events: { on: (name: string, handler: (payload: unknown) => unknown) => void } }).events = {
    on: (name, handler) => { handlers.set(name, handler); },
  };
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "cli");
  setRunThread(db, RUN, PM);
  const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0" });
  for (const [key, executor] of Object.entries(extraExecutors)) engine.register(key, executor);
  const logs: string[] = [];
  const ctx = {
    bb,
    db,
    isDisposed: () => false,
    effectiveProjectSettings: async () => ({ values: {} }),
    log: (message: string) => logs.push(message),
  } as unknown as ServerCore;
  const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
    loadStore: async () => ({ store: storeOf(...items), project: "ok" }),
  });
  return { bb, db, ctx, engine, triggers, harness, handlers, logRows, logs };
}

describe("event triggers and engine.wake", () => {
  it("schema accepts event triggers with match and rejects missing event or event fields on non-event triggers", () => {
    expect(LP_EVENTS.THREAD_IDLE).toBe("lp.thread.idle");
    expect(LP_EVENTS.PM_TURN_ENDED).toBe("lp.pm.turn-ended");

    const okLoaded = loadWorkflow(workflow({
      triggers: [{ type: "event", event: LP_EVENTS.THREAD_IDLE, match: { projectId: PROJECT } }],
    }));
    expect(okLoaded.ok).toBe(true);

    const missingEvent = loadWorkflow(workflow({
      triggers: [{ type: "event" }],
    }));
    expect(missingEvent.ok).toBe(false);

    const extraOnManual = loadWorkflow(workflow({
      triggers: [{ type: "manual", event: LP_EVENTS.THREAD_IDLE }],
    }));
    expect(extraOnManual.ok).toBe(false);
  });

  it("event starts a matching published graph once, ignores duplicate event ids, and logs start failures", async () => {
    const matchingWf = stored(workflow({
      id: "on-thread-idle",
      status: "published",
      inputs: [{ name: "threadId", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.threadId" } }],
      edges: [{ from: "start", to: "done" }],
      triggers: [{ type: "event", event: LP_EVENTS.THREAD_IDLE, match: { projectId: PROJECT } }],
    }));
    const otherProjectWf = stored(workflow({
      id: "on-other-project",
      status: "published",
      inputs: [{ name: "threadId", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.threadId" } }],
      edges: [{ from: "start", to: "done" }],
      triggers: [{ type: "event", event: LP_EVENTS.THREAD_IDLE, match: { projectId: "proj_other" } }],
    }));
    const draftWf = stored(workflow({
      id: "draft-on-idle",
      status: "draft",
      inputs: [{ name: "threadId", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.threadId" } }],
      edges: [{ from: "start", to: "done" }],
      triggers: [{ type: "event", event: LP_EVENTS.THREAD_IDLE }],
    }));
    const missingInputWf = stored(workflow({
      id: "needs-extra-input",
      status: "published",
      inputs: [{ name: "requiredExtra", type: "string", required: true }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.requiredExtra" } }],
      edges: [{ from: "start", to: "done" }],
      triggers: [{ type: "event", event: LP_EVENTS.THREAD_IDLE }],
    }));

    const { db, engine, triggers, harness } = setupWorld([matchingWf, otherProjectWf, draftWf, missingInputWf]);

    const first = await triggers.emitEvent(LP_EVENTS.THREAD_IDLE, {
      eventId: "evt_once_1",
      threadId: "thr_42",
      projectId: PROJECT,
    });
    expect(first.duplicate).toBe(false);
    expect(first.started).toHaveLength(1);
    expect(first.started[0]!.workflowId).toBe("on-thread-idle");
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0]!.workflowId).toBe("needs-extra-input");
    await engine.idle();

    expect(engine.get(first.started[0]!.runId)).toMatchObject({ status: "succeeded", output: { result: "thr_42" } });
    expect(harness.logEntries.some((entry) => entry.level === "debug" && entry.message.includes("wf.event emitted") && entry.message.includes(`name=${LP_EVENTS.THREAD_IDLE}`) && entry.message.includes("key=thr_42") && entry.message.includes("matched=2"))).toBe(true);
    expect(harness.logEntries.some((entry) => entry.level === "info" && entry.message.includes(`wf.event started run=${first.started[0]!.runId} graph=on-thread-idle`))).toBe(true);
    expect(harness.logEntries.some((entry) => entry.level === "error" && entry.message.includes("needs-extra-input"))).toBe(true);

    // Duplicate id is ignored and logged at WARN.
    const dup = await triggers.emitEvent(LP_EVENTS.THREAD_IDLE, {
      eventId: "evt_once_1",
      threadId: "thr_42",
      projectId: PROJECT,
    });
    expect(dup).toEqual({ eventId: "evt_once_1", key: "thr_42", duplicate: true, woken: 0, started: [], failed: [] });
    expect(harness.logEntries.some((entry) => entry.level === "warn" && entry.message.includes("duplicate event id skipped"))).toBe(true);
    expect(rows(db, "SELECT id FROM lane_pilot_wf_inbox")).toHaveLength(1);
    expect(rows(db, "SELECT id FROM lane_pilot_wf_run WHERE workflow_id='on-thread-idle'")).toHaveLength(1);
  });

  it("wake resolves a waiting step through resolve() and the run continues", async () => {
    const db = journalDb();
    const waitExec: NodeExecutor = {
      run: async (ctx) => ({
        wait: { kind: LP_EVENTS.THREAD_IDLE, eventKey: String(ctx.input.with.query) },
      }),
    };
    const write = ok((ctx) => ({ text: `got:${String(ctx.input.with.items)}` }));
    const engine = engineOn(db, { search: waitExec, write });
    const def = parseWorkflow(workflow({
      nodes: [
        { id: "search", type: "action", action: "search", out: [{ name: "items", type: "array" }] },
        { id: "write", type: "action", action: "write", out: [{ name: "text", type: "string" }] },
      ],
      edges: [
        { from: "start", to: "search", with: { query: "input.query" } },
        { from: "search", to: "write", with: { items: "search.items" } },
        { from: "write", to: "end", with: { result: "write.text" } },
      ],
    }));

    const { runId } = engine.start({ workflow: def, inputs: { query: "thr_wake_1" } });
    await until("step waiting", () => stepStates(db, runId)["search#1"] === "waiting");
    expect(engine.get(runId)?.status).toBe("waiting");

    const woken = await engine.wake(LP_EVENTS.THREAD_IDLE, "thr_wake_1", { items: ["alpha", "beta"] });
    expect(woken).toBe(1);
    await engine.idle();
    expect(engine.get(runId)).toMatchObject({ status: "succeeded", output: { result: "got:alpha,beta" } });
  });

  it("an event emitted before the step parks wakes it on park and is marked consumed", async () => {
    let releaseStep!: () => void;
    const gate = new Promise<void>((resolve) => { releaseStep = resolve; });
    const waitAfterGate: NodeExecutor = {
      run: async () => {
        await gate;
        return { wait: { kind: LP_EVENTS.PM_TURN_ENDED, eventKey: "thr_early" } };
      },
    };
    const finishExec = ok((ctx) => ({ text: `done:${String(ctx.input.with.reason)}` }));

    const { db, engine, triggers } = setupWorld([], {
      wait_step: waitAfterGate,
      finish_step: finishExec,
    });

    const def = parseWorkflow(workflow({
      id: "early-event-wait",
      nodes: [
        { id: "wait_step", type: "action", uses: "wait_step", out: [{ name: "reason", type: "string" }] },
        { id: "finish_step", type: "action", uses: "finish_step", out: [{ name: "text", type: "string" }] },
      ],
      edges: [
        { from: "start", to: "wait_step" },
        { from: "wait_step", to: "finish_step", with: { reason: "wait_step.reason" } },
        { from: "finish_step", to: "end", with: { result: "finish_step.text" } },
      ],
    }));

    const { runId, done } = engine.start({ workflow: def, inputs: { query: "q" } });
    await until("wait_step running", () => stepStates(db, runId)["wait_step#1"] === "running");

    // Event arrives BEFORE wait_step parks!
    const emitted = await triggers.emitEvent(LP_EVENTS.PM_TURN_ENDED, {
      eventId: "evt_early_1",
      eventKey: "thr_early",
      reason: "completed",
    });
    expect(emitted.woken).toBe(0);
    expect(rows<{ consumed_by: string | null }>(db, "SELECT consumed_by FROM lane_pilot_wf_inbox WHERE id='evt_early_1'")[0]!.consumed_by).toBeNull();

    // Now let wait_step return { wait } and park.
    releaseStep();
    const summary = await done;
    expect(summary).toMatchObject({ status: "succeeded", output: { result: "done:completed" } });
    expect(rows<{ consumed_by: string | null }>(db, "SELECT consumed_by FROM lane_pilot_wf_inbox WHERE id='evt_early_1'")[0]!.consumed_by).toBe(`${runId}:wait_step#1`);
  });

  it("refuses a stale event for an older attempt (both live wake and early inbox event)", async () => {
    const db = journalDb();
    const waitAttempt: NodeExecutor = {
      run: async () => ({
        wait: { kind: "lp.attempt.done", eventKey: "task_9", attemptKey: "att_2" },
      }),
    };
    const write = ok((ctx) => ({ text: String(ctx.input.with.val) }));
    const engine = engineOn(db, { wait_attempt: waitAttempt, write });
    const def = parseWorkflow(workflow({
      nodes: [
        { id: "wait_node", type: "action", uses: "wait_attempt", out: [{ name: "val", type: "string" }] },
        { id: "write", type: "action", uses: "write", out: [{ name: "text", type: "string" }] },
      ],
      edges: [
        { from: "start", to: "wait_node" },
        { from: "wait_node", to: "write", with: { val: "wait_node.val" } },
        { from: "write", to: "end", with: { result: "write.text" } },
      ],
    }));

    // Insert a stale inbox event for att_1 before att_2 parks.
    const { triggers } = setupWorld([]);
    void triggers;
    const { insertInboxEvent } = await import("@lane-pilot/workflow-engine");
    insertInboxEvent(db, {
      id: "evt_stale_inbox",
      name: "lp.attempt.done",
      key: "task_9",
      payload: { attemptKey: "att_1", val: "stale-early" },
      createdAt: Date.now(),
    });

    const { runId } = engine.start({ workflow: def, inputs: { query: "q" } });
    await until("wait_node waiting", () => stepStates(db, runId)["wait_node#1"] === "waiting");

    // Stale inbox event did not wake att_2 on park, and stays unconsumed.
    expect(rows<{ consumed_by: string | null }>(db, "SELECT consumed_by FROM lane_pilot_wf_inbox WHERE id='evt_stale_inbox'")[0]!.consumed_by).toBeNull();
    expect(engine.get(runId)?.status).toBe("waiting");

    // Live wake for att_1 is refused.
    expect(await engine.wake("lp.attempt.done", "task_9", { attemptKey: "att_1", val: "stale-live" })).toBe(0);
    // Live wake without attemptKey is refused when the step carries attemptKey.
    expect(await engine.wake("lp.attempt.done", "task_9", { val: "no-attempt" })).toBe(0);
    expect(stepStates(db, runId)["wait_node#1"]).toBe("waiting");

    // Live wake for att_2 succeeds and completes the run.
    expect(await engine.wake("lp.attempt.done", "task_9", { attemptKey: "att_2", val: "fresh-att-2" })).toBe(1);
    await engine.idle();
    expect(engine.get(runId)).toMatchObject({ status: "succeeded", output: { result: "fresh-att-2" } });
  });

  it("thread feed and PM turn watch emit lp.thread.idle and lp.pm.turn-ended", async () => {
    const onIdleWf = stored(workflow({
      id: "on-idle-source",
      status: "published",
      inputs: [{ name: "threadId", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.threadId" } }],
      edges: [{ from: "start", to: "done" }],
      triggers: [{ type: "event", event: LP_EVENTS.THREAD_IDLE }],
    }));
    const onPmTurnWf = stored(workflow({
      id: "on-pm-turn-source",
      status: "published",
      inputs: [{ name: "threadId", type: "string" }, { name: "reason", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.reason" } }],
      edges: [{ from: "start", to: "done" }],
      triggers: [{ type: "event", event: LP_EVENTS.PM_TURN_ENDED }],
    }));

    const { db, ctx, engine, triggers, handlers, logRows } = setupWorld([onIdleWf, onPmTurnWf]);
    installThreadEventFeed(ctx, { emitEvent: triggers.emitEvent });
    mountPmTurnWatch(ctx, { emitEvent: triggers.emitEvent });

    // Sub-agent nested idle does not emit lp.thread.idle.
    await handlers.get("thread.idle")!({
      thread: { id: "thr_sub", projectId: PROJECT },
      lastAssistantText: "sub",
      experimental_vkLastTurn: { isSubAgent: true, turnId: "t_sub" },
    });
    expect(rows(db, "SELECT id FROM lane_pilot_wf_run WHERE workflow_id='on-idle-source'")).toHaveLength(0);

    // Real thread.idle emits lp.thread.idle and starts on-idle-source.
    await handlers.get("thread.idle")!({
      thread: { id: PM, projectId: PROJECT },
      lastAssistantText: "done",
      experimental_vkLastTurn: { isSubAgent: false, turnId: "t_1" },
    });
    await engine.idle();
    const idleRuns = rows<{ id: string; status: string }>(db, "SELECT id, status FROM lane_pilot_wf_run WHERE workflow_id='on-idle-source'");
    expect(idleRuns).toHaveLength(1);
    expect(idleRuns[0]!.status).toBe("succeeded");

    // PM turn lifecycle emits lp.pm.turn-ended and starts on-pm-turn-source.
    const now = Date.now();
    logRows.push(
      { threadId: PM, seq: 1, type: "turn/started", createdAt: now, data: {} },
      { threadId: PM, seq: 2, type: "item/completed", createdAt: now + 1, data: { item: { type: "assistantMessage" } } },
      { threadId: PM, seq: 3, type: "turn/completed", createdAt: now + 2, data: {} },
    );
    await handlers.get("experimental_thread.events")!({ thread: { id: PM, status: "idle" }, sequence: 3 });
    await engine.idle();
    const pmRuns = rows<{ id: string; status: string }>(db, "SELECT id, status FROM lane_pilot_wf_run WHERE workflow_id='on-pm-turn-source'");
    expect(pmRuns).toHaveLength(1);
    expect(engine.get(pmRuns[0]!.id)).toMatchObject({ status: "succeeded", output: { result: "completed" } });
  });
});
