import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { LP_EVENTS } from "@lane-pilot/contracts";
import { EMBED_DIM, pendingVectors, storeMemoryRecords } from "@lane-pilot/memory-core";
import { WorkflowEngine, validateWorkflow, type WorkflowStore } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../src/rooms/contracts/server";
import type { Services } from "../server";
import { openDatabase } from "../src/rooms/plugin-db";
import { createWorkflowTriggers } from "../src/rooms/workflow/server/services/workflow-triggers";
import {
  MEMORY_EMBED_WORKFLOW_ID,
  memoryEmbedWorkflow,
  mountMemoryEmbeddings,
  setEmbedder,
  type Embedder,
} from "../src/rooms/memory/server";

const PROJECT = "proj_mem_evt";

function unitVector(seed: number): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  vec[seed % EMBED_DIM] = 1;
  return vec;
}

const emptyStore: WorkflowStore = {
  list: () => [],
  get: () => null,
  resolve: () => null,
  problems: [],
};

const disposers: Array<() => void> = [];

afterEach(() => {
  while (disposers.length) disposers.pop()!();
  setEmbedder(null);
});

function setup(embedder: Embedder) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const logs: Array<{ level: string; message: string }> = [];
  const schedules: string[] = [];
  (bb.log as unknown as Record<string, (m: string) => void>).info = (message) => logs.push({ level: "info", message });
  (bb.log as unknown as Record<string, (m: string) => void>).warn = (message) => logs.push({ level: "warn", message });
  (bb.log as unknown as Record<string, (m: string) => void>).error = (message) => logs.push({ level: "error", message });
  (bb.log as unknown as Record<string, (m: string) => void>).debug = (message) => logs.push({ level: "debug", message });
  (bb.background as unknown as { schedule: (id: string, ...rest: unknown[]) => void }).schedule = (id) => {
    schedules.push(id);
  };

  const db = openDatabase(bb);
  const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0" });
  const ctx = {
    bb,
    db,
    isDisposed: () => false,
    effectiveProjectSettings: async () => ({ values: {} }),
    log: (message: string) => logs.push({ level: "info", message }),
  } as unknown as ServerCore;
  const workflowTriggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
    loadStore: async () => ({ store: emptyStore, project: "ok" }),
  });
  return { bb, db, engine, ctx, workflowTriggers, logs, schedules, embedder };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("Task 16: memory embed & dedupe driven by lp.memory.record-committed", () => {
  it("defines LP_EVENTS.MEMORY_RECORD_COMMITTED and validates memoryEmbedWorkflow without errors", () => {
    expect(LP_EVENTS.MEMORY_RECORD_COMMITTED).toBe("lp.memory.record-committed");
    const wf = memoryEmbedWorkflow();
    const problems = validateWorkflow(wf).filter((p) => p.level === "error");
    expect(problems).toEqual([]);
  });

  it("embeds and dedupes on record commit via lp.memory.record-committed with no scheduleIsolated timers", async () => {
    const sharedVec = unitVector(3);
    const embedder: Embedder = async (texts) => texts.map(() => new Float32Array(sharedVec));
    const { db, engine, ctx, workflowTriggers, logs, schedules } = setup(embedder);

    const handle = mountMemoryEmbeddings(
      ctx,
      { workflowEngine: engine, workflowTriggers },
      { embedder, backfillOnReady: false },
    );
    disposers.push(handle.dispose);

    // No cron timers registered.
    expect(schedules).toEqual([]);

    // Commit first note -> triggers lp.memory.record-committed -> embeds it.
    const first = storeMemoryRecords(db, {
      projectId: PROJECT,
      audience: "subagent",
      sourceSha256: "a".repeat(64),
      coreBudget: 3072,
      noteBudget: 8192,
      indexBudget: 65536,
      now: 1_700_000_000_000,
      entries: [{ kind: "note", content: "Deploy uses pnpm build before packing the plugin artifact.", concepts: ["deploy"] }],
    });
    expect(first.insertedIds).toHaveLength(1);

    await waitFor(() => pendingVectors(db, 10).length === 0 && logs.some((l) => l.message.includes("job=memory-embed")));
    await engine.idle();

    const inboxRows = db
      .prepare("SELECT id, name, key FROM lane_pilot_wf_inbox WHERE name = ?")
      .all(LP_EVENTS.MEMORY_RECORD_COMMITTED) as Array<{ id: string; name: string; key: string }>;
    expect(inboxRows).toHaveLength(1);
    expect(inboxRows[0]!.key).toBe(PROJECT);

    const runs = db
      .prepare("SELECT id, workflow_id, status FROM lane_pilot_wf_run WHERE workflow_id = ?")
      .all(MEMORY_EMBED_WORKFLOW_ID) as Array<{ id: string; workflow_id: string; status: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");

    // Commit a second near-duplicate note (different wording, identical vector) -> dedupe merges it.
    const second = storeMemoryRecords(db, {
      projectId: PROJECT,
      audience: "subagent",
      sourceSha256: "b".repeat(64),
      coreBudget: 3072,
      noteBudget: 8192,
      indexBudget: 65536,
      now: 1_700_000_001_000,
      entries: [{ kind: "note", content: "Before packaging the plugin artifact, run pnpm build for deploy.", concepts: ["deploy"] }],
    });
    expect(second.insertedIds).toHaveLength(1);

    await waitFor(() => {
      const active = db
        .prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE project_id = ? AND status = 'active'")
        .get(PROJECT) as { n: number };
      return active.n === 1;
    });
    await engine.idle();

    const dup = db
      .prepare("SELECT status, expired_reason FROM lane_pilot_memory WHERE id = ?")
      .get(second.insertedIds[0]!) as { status: string; expired_reason: string | null };
    expect(dup).toEqual({ status: "expired", expired_reason: "duplicate" });
  });

  it("ignores duplicate lp.memory.record-committed events with a WARN log", async () => {
    const embedder: Embedder = async (texts) => texts.map((_, idx) => unitVector(idx));
    const { engine, ctx, workflowTriggers, logs } = setup(embedder);

    const handle = mountMemoryEmbeddings(
      ctx,
      { workflowEngine: engine, workflowTriggers },
      { embedder, backfillOnReady: false },
    );
    disposers.push(handle.dispose);

    const first = await workflowTriggers.emitEvent(
      LP_EVENTS.MEMORY_RECORD_COMMITTED,
      { eventId: "evt_dup_1", projectId: PROJECT },
      { id: "evt_dup_1", key: PROJECT, projectId: PROJECT },
    );
    expect(first.duplicate).toBe(false);

    const second = await workflowTriggers.emitEvent(
      LP_EVENTS.MEMORY_RECORD_COMMITTED,
      { eventId: "evt_dup_1", projectId: PROJECT },
      { id: "evt_dup_1", key: PROJECT, projectId: PROJECT },
    );
    expect(second.duplicate).toBe(true);
    expect(logs.some((l) => l.level === "warn" && l.message.includes("duplicate event id skipped"))).toBe(true);
  });

  it("runs one backfill pass on plugin ready when stale vectors exist", async () => {
    const embedder: Embedder = async (texts) => texts.map((_, idx) => unitVector(idx + 5));
    const { db, engine, ctx, workflowTriggers, logs } = setup(embedder);

    // Seed a record before mountMemoryEmbeddings (simulating stale/missing vectors from before restart).
    storeMemoryRecords(db, {
      projectId: PROJECT,
      audience: "subagent",
      sourceSha256: "c".repeat(64),
      coreBudget: 3072,
      noteBudget: 8192,
      indexBudget: 65536,
      now: 1_700_000_000_000,
      entries: [{ kind: "note", content: "Backfill note needing an embedding vector on startup.", concepts: ["backfill"] }],
    });
    expect(pendingVectors(db, 10)).toHaveLength(1);

    const handle = mountMemoryEmbeddings(
      ctx,
      { workflowEngine: engine, workflowTriggers },
      { embedder, backfillOnReady: true },
    );
    disposers.push(handle.dispose);

    await waitFor(() => pendingVectors(db, 10).length === 0);
    await engine.idle();

    expect(logs.some((l) => l.level === "info" && l.message.includes("job=memory-embed-backfill by=startup"))).toBe(true);
    const runs = db
      .prepare("SELECT status FROM lane_pilot_wf_run WHERE workflow_id = ?")
      .all(MEMORY_EMBED_WORKFLOW_ID) as Array<{ status: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("succeeded");
  });

  it("logs ERROR with runId when the embed/dedupe step fails", async () => {
    const failingEmbedder: Embedder = async () => {
      throw new Error("embedder boom");
    };
    const { db, engine, ctx, logs } = setup(failingEmbedder);

    storeMemoryRecords(db, {
      projectId: PROJECT,
      audience: "subagent",
      sourceSha256: "d".repeat(64),
      coreBudget: 3072,
      noteBudget: 8192,
      indexBudget: 65536,
      now: 1_700_000_000_000,
      entries: [{ kind: "note", content: "Note that triggers a failing embedder step.", concepts: ["fail"] }],
    });

    const handle = mountMemoryEmbeddings(
      ctx,
      { workflowEngine: engine },
      { embedder: failingEmbedder, backfillOnReady: false },
    );
    disposers.push(handle.dispose);

    const res = await handle.backfill();
    expect(res.started).toBe(true);
    expect(res.runId).toBeTruthy();
    expect(logs.some((l) => l.level === "error" && l.message.includes(`run=${res.runId}`))).toBe(true);
  });
});
