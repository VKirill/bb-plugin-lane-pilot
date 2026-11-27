import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { LP_EVENTS } from "@lane-pilot/contracts";
import {
  WorkflowEngine,
  definitionSha256,
  parseWorkflow,
  type NodeExecutor,
  type RunRow,
  type StoredWorkflow,
  type WorkflowStore,
} from "@lane-pilot/workflow-engine";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../server";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/services/workflow-triggers";
import { createRunFinished, type RunFinishedSubscriber } from "../../src/rooms/workflow/server";
import { INTERNAL_UPKEEP_WORKFLOWS, isInternalUpkeep } from "../../src/rooms/workflow";
import { workflow } from "./fixtures";
import { ok, rows } from "./engine-helpers";

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

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 20));

function setupWorld(
  items: StoredWorkflow[],
  subscribers: RunFinishedSubscriber[] = [],
  extraExecutors: Record<string, NodeExecutor> = {},
) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "cli");
  setRunThread(db, RUN, PM);
  const logs: string[] = [];
  const ctx = {
    bb,
    db,
    isDisposed: () => false,
    effectiveProjectSettings: async () => ({ values: {} }),
    log: (message: string) => logs.push(message),
  } as unknown as ServerCore;

  let onRunEvent: (runId: string) => Promise<void>;
  const engine = new WorkflowEngine({
    db,
    harnessVersion: "1.0.0",
    resolveWorkflow: (id, version) => {
      const found = items.find((item) => item.workflow.id === id)?.workflow ?? null;
      return found && (version === undefined || found.version === version) ? found : null;
    },
    onEvent: (runId) => {
      void onRunEvent(runId);
    },
  });
  for (const [key, executor] of Object.entries(extraExecutors)) engine.register(key, executor);
  const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
    loadStore: async () => ({ store: storeOf(...items), project: "ok" }),
  });
  onRunEvent = createRunFinished(ctx, { triggers, subscribers });
  return { bb, db, ctx, engine, triggers, harness, logs, onRunEvent };
}

describe("workflow run-finished event", () => {
  it("exposes LP_EVENTS.WORKFLOW_RUN_FINISHED and INTERNAL_UPKEEP_WORKFLOWS", () => {
    expect(LP_EVENTS.WORKFLOW_RUN_FINISHED).toBe("lp.workflow.run-finished");
    for (const id of ["lp.evolve", "lp.review-desk", "lp.daily-report", "lp.owner-push", "lp.worktree-cleanup", "lp.backlog-scan", "lead-tick"]) {
      expect(INTERNAL_UPKEEP_WORKFLOWS).toContain(id);
      expect(isInternalUpkeep(id)).toBe(true);
    }
    expect(isInternalUpkeep("demo")).toBe(false);
  });

  it("emits one inbox row per terminal transition of a top-level run and ignores duplicate onEvent calls", async () => {
    const seen: RunRow[] = [];
    const { db, engine, triggers, harness, onRunEvent } = setupWorld([], [(run) => { seen.push(run); }], {
      search: ok(() => ({ items: ["a"], count: 1, kind: "fresh" })),
      write: ok(() => ({ text: "ok" })),
    });

    const def = parseWorkflow(workflow({ id: "sample-flow", version: 2 }));
    const { runId, done } = engine.start({ workflow: def, inputs: { query: "q" }, link: { projectId: PROJECT, runId: RUN } });
    const summary = await done;
    await engine.idle();
    await flushMicrotasks();

    expect(summary.status).toBe("succeeded");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.id).toBe(runId);

    const inboxRows = rows<{ id: string; name: string; key: string; payload_json: string }>(
      db,
      "SELECT id, name, key, payload_json FROM lane_pilot_wf_inbox WHERE name=?",
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
    );
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]!.id).toMatch(new RegExp(`^wf-finished:${runId}:\\d+$`));
    expect(inboxRows[0]!.key).toBe("sample-flow");
    expect(JSON.parse(inboxRows[0]!.payload_json)).toEqual({
      runId,
      workflowId: "sample-flow",
      status: "succeeded",
      graphVersion: 2,
      projectId: PROJECT,
    });
    expect(harness.logEntries.some((entry) => entry.level === "debug" && entry.message.includes(`wf.finished run=${runId} wf=sample-flow status=succeeded emitted=true`))).toBe(true);

    // Second onEvent for the same transition emits nothing and does not re-fire subscribers.
    await onRunEvent(runId);
    // Even across a fresh emitter instance (simulating reload), the inbox id deduplicates cleanly.
    const fresh = createRunFinished({ db, log: () => undefined }, { triggers, subscribers: [] });
    await fresh(runId);

    const afterDup = rows(db, "SELECT id FROM lane_pilot_wf_inbox WHERE name=?", LP_EVENTS.WORKFLOW_RUN_FINISHED);
    expect(afterDup).toHaveLength(1);
    expect(seen).toHaveLength(1);
  });

  it("emits no inbox row and calls no subscribers for a child subworkflow run", async () => {
    const seen: string[] = [];
    const child = stored(workflow({
      id: "child-flow",
      inputs: [],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "child-ok" } }],
      edges: [{ from: "start", to: "done" }],
    }));
    const parent = stored(workflow({
      id: "parent-flow",
      inputs: [],
      outputs: [{ name: "result", type: "string" }],
      nodes: [
        { id: "sub", type: "subworkflow", workflow: "child-flow" },
        { id: "done", type: "action", action: "emit", map: { result: "sub.result" } },
      ],
      edges: [{ from: "start", to: "sub" }, { from: "sub", to: "done" }],
    }));

    const { db, engine } = setupWorld([child, parent], [(run) => { seen.push(`${run.workflow_id}:${run.parent_run_id ?? "root"}`); }]);
    const { runId, done } = engine.start({ workflow: parent.workflow, inputs: {}, link: { projectId: PROJECT, runId: RUN } });
    const summary = await done;
    await engine.idle();
    await flushMicrotasks();

    expect(summary.status).toBe("succeeded");
    expect(seen).toEqual(["parent-flow:root"]);
    const inboxRows = rows<{ key: string; payload_json: string }>(
      db,
      "SELECT key, payload_json FROM lane_pilot_wf_inbox WHERE name=?",
      LP_EVENTS.WORKFLOW_RUN_FINISHED,
    );
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]!.key).toBe("parent-flow");
    expect(JSON.parse(inboxRows[0]!.payload_json)).toMatchObject({ runId, workflowId: "parent-flow" });
  });

  it("does not emit inbox events for lp.daily-report but still invokes subscribers", async () => {
    const seen: string[] = [];
    const { db, engine, harness } = setupWorld([], [(run) => { seen.push(run.workflow_id); }]);
    const upkeep = parseWorkflow(workflow({
      id: "lp.daily-report",
      inputs: [],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "digest" } }],
      edges: [{ from: "start", to: "done" }],
    }));

    const { runId, done } = engine.start({ workflow: upkeep, inputs: {}, link: { projectId: PROJECT, runId: RUN } });
    const summary = await done;
    await engine.idle();
    await flushMicrotasks();

    expect(summary.status).toBe("succeeded");
    expect(seen).toEqual(["lp.daily-report"]);
    expect(rows(db, "SELECT id FROM lane_pilot_wf_inbox WHERE name=?", LP_EVENTS.WORKFLOW_RUN_FINISHED)).toHaveLength(0);
    expect(harness.logEntries.some((entry) => entry.level === "debug" && entry.message.includes(`wf.finished run=${runId} wf=lp.daily-report status=succeeded emitted=false`))).toBe(true);
  });

  it("isolates throwing and rejecting subscribers without failing the run", async () => {
    const healthy: string[] = [];
    const { db, engine, harness } = setupWorld([], [
      () => { throw new Error("sync boom"); },
      async () => { throw new Error("async boom"); },
      (run) => { healthy.push(run.id); },
    ]);
    const def = parseWorkflow(workflow({
      id: "resilient-flow",
      inputs: [],
      outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "done", type: "action", action: "emit", map: { result: "ok" } }],
      edges: [{ from: "start", to: "done" }],
    }));

    const { runId, done } = engine.start({ workflow: def, inputs: {}, link: { projectId: PROJECT, runId: RUN } });
    const summary = await done;
    await engine.idle();
    await flushMicrotasks();

    expect(summary).toMatchObject({ status: "succeeded", output: { result: "ok" } });
    expect(healthy).toEqual([runId]);
    expect(rows(db, "SELECT id FROM lane_pilot_wf_inbox WHERE name=?", LP_EVENTS.WORKFLOW_RUN_FINISHED)).toHaveLength(1);
    const warns = harness.logEntries.filter((entry) => entry.level === "warn").map((entry) => entry.message);
    expect(warns.some((msg) => msg.includes(`wf.finished subscriber failed run=${runId}: sync boom`))).toBe(true);
    expect(warns.some((msg) => msg.includes(`wf.finished subscriber failed run=${runId}: async boom`))).toBe(true);
  });
});
