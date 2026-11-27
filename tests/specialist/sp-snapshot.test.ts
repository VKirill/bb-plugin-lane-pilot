import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import type { StepContext, Workflow } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { createCore } from "../../src/rooms/core/server/core";
import { postOwnerItem } from "../../src/rooms/owner-waiting";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { SETTINGS_REGISTRY } from "../../src/rooms/settings-registry";
import { validateSettingValue } from "../../src/rooms/settings/models/setting-validation";
import {
  actionOrderSchema,
  DEFAULT_SPECIALIST_SNAPSHOT_BYTES,
  MAX_SPECIALIST_SNAPSHOT_BYTES,
  MIN_SPECIALIST_SNAPSHOT_BYTES,
  SPECIALIST_SNAPSHOT_BYTES_KEY,
} from "../../src/rooms/specialist";
import {
  acquireLock,
  advanceCursor,
  checkLockCollisions,
  loadSpecialistMemory,
  proposeLocalRule,
  registerSpExecutors,
  SNAPSHOT_CURSORS_LIMIT,
  SNAPSHOT_LOCKS_LIMIT,
  SNAPSHOT_OWNER_ITEMS_LIMIT,
  stageIntent,
  upsertCharter,
  upsertHypothesis,
  writePendingOutcome,
} from "../../src/rooms/specialist/server";

const DAY_MS = 86_400_000;

function freshHarness() {
  const logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string }> = [];
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  for (const level of ["debug", "info", "warn", "error"] as const) {
    const orig = bb.log[level]?.bind(bb.log);
    bb.log[level] = (message: string) => {
      logs.push({ level, message: String(message) });
      orig?.(message);
    };
  }
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  return { bb, db, ctx, logs };
}

function makeLoadStep(outNames: string[]): StepContext<ChainRuntime> {
  return {
    runId: "run_snap_1",
    stepKey: "load_state",
    nodeId: "load_state",
    node: {
      id: "load_state",
      type: "action",
      action: "sp.load_memory",
      params: { domain: "marketing" },
      out: outNames.map((name) => ({
        name,
        type: name === "snapshot_dropped" ? "array" : name === "budget_left_usd" ? "number" : name === "breaker_open" ? "boolean" : "string",
        required: true,
      })),
    },
    workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: [] } as unknown as Workflow,
    template: (v: unknown) => v,
  } as unknown as StepContext<ChainRuntime>;
}

describe("Specialist bounded shift snapshot (Task 38)", () => {
  it("registers specialist.snapshot_bytes with default 24000 and bounds 8000-96000", () => {
    expect(DEFAULT_SPECIALIST_SNAPSHOT_BYTES).toBe(24_000);
    expect(MIN_SPECIALIST_SNAPSHOT_BYTES).toBe(8_000);
    expect(MAX_SPECIALIST_SNAPSHOT_BYTES).toBe(96_000);

    const def = SETTINGS_REGISTRY.get(SPECIALIST_SNAPSHOT_BYTES_KEY);
    expect(def).toBeDefined();
    expect(def?.room).toBe("specialist");
    expect(def?.default).toBe(24_000);
    expect(def?.min).toBe(8_000);
    expect(def?.max).toBe(96_000);

    expect(validateSettingValue(SPECIALIST_SNAPSHOT_BYTES_KEY, 7_999)).not.toBeNull();
    expect(validateSettingValue(SPECIALIST_SNAPSHOT_BYTES_KEY, 96_001)).not.toBeNull();
    expect(validateSettingValue(SPECIALIST_SNAPSHOT_BYTES_KEY, 8_000)).toBeNull();
    expect(validateSettingValue(SPECIALIST_SNAPSHOT_BYTES_KEY, 24_000)).toBeNull();
    expect(validateSettingValue(SPECIALIST_SNAPSHOT_BYTES_KEY, 96_000)).toBeNull();
  });

  it("caps lock (50), cursor (50), and owner-item (20) queries while preserving full lock collision checks", async () => {
    const { db, ctx } = freshHarness();
    const t0 = Date.now();
    upsertCharter(db, { projectId: "p1", domain: "marketing", charter: { goal: "scale" }, nowMs: t0 });

    for (let i = 0; i < 500; i += 1) {
      acquireLock(db, {
        projectId: "p1",
        domain: "marketing",
        scopeType: "url",
        scopeValue: `https://example.com/p-${i}`,
        ownerGraph: "sp-specialist-tick",
        reasonCode: "experiment_launch",
        nowMs: t0 + i,
      });
    }
    for (let i = 0; i < 65; i += 1) {
      advanceCursor(db, {
        projectId: "p1",
        domain: "marketing",
        streamKey: `stream_${i}`,
        nextCursor: { offset: i },
        nowMs: t0 + i,
      });
    }
    for (let i = 0; i < 30; i += 1) {
      postOwnerItem(
        db,
        {
          key: `sp:q:test:${i}`,
          source: "specialist",
          kind: "question",
          reason: "decision",
          projectId: "p1",
          what: `Question ${i}`,
          why: `Reason ${i}`,
        },
        t0 + i,
      );
    }

    // Lock collision check still sees locks past the snapshot LIMIT 50
    expect(checkLockCollisions(db, { projectId: "p1", scopeType: "url", scopeValue: "https://example.com/p-499", nowMs: t0 + 1000 })).toHaveLength(1);

    // Raise cap so we inspect raw SQL LIMIT counts without byte-cap trimming
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, SPECIALIST_SNAPSHOT_BYTES_KEY, 96_000);
    const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
    registerSpExecutors({} as never, ctx, { action: (k, fn) => void actions.set(k, fn) });
    const loadExec = actions.get("sp.load_memory")!;
    const rt = { ctx, services: {}, pmThreadId: "pm1", projectId: "p1", runId: "run_limits" } as unknown as ChainRuntime;

    const loaded = await loadExec(
      makeLoadStep(["case_id", "snapshot_dropped", "active_locks_json", "cursors_json", "open_assumptions_json"]),
      rt,
    );

    const locks = JSON.parse(String(loaded.active_locks_json)) as unknown[];
    const cursors = JSON.parse(String(loaded.cursors_json)) as Record<string, unknown>;
    const ownerItems = JSON.parse(String(loaded.open_assumptions_json)) as unknown[];

    expect(locks.length).toBeLessThanOrEqual(SNAPSHOT_LOCKS_LIMIT);
    expect(locks).toHaveLength(50);
    expect(Object.keys(cursors).length).toBeLessThanOrEqual(SNAPSHOT_CURSORS_LIMIT);
    expect(Object.keys(cursors)).toHaveLength(50);
    expect(ownerItems.length).toBeLessThanOrEqual(SNAPSHOT_OWNER_ITEMS_LIMIT);
    expect(ownerItems).toHaveLength(20);
    expect(loaded.case_id).toBe("p1:marketing");
  });

  it("at cap 8000 drops tail fields first, preserves charter and due outcomes, lists dropped fields, and logs DEBUG", async () => {
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.now() - 10 * DAY_MS;

    upsertCharter(db, {
      projectId: "p1",
      domain: "marketing",
      charter: { goal: "paid_growth", north_star: { metric_id: "paid_users", baseline: 100, target: 200 } },
      nowMs: t0,
    });

    const intent = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: actionOrderSchema.parse({
        kind: "sub_graph",
        title: "Test checkout flow",
        domain: "marketing",
        reason_code: "cro_friction_fix",
        action_class: "analysis_propose",
        workflow_id: "mkt-landing-cro-audit",
        forecast: { metric: "paid_users", horizon_days: 7, baseline: 100, lo80: 110, point: 130, hi80: 150, unit: "users" },
      }),
      nowMs: t0,
    });
    writePendingOutcome(
      db,
      { intentId: intent.intentId, projectId: "p1", domain: "marketing", createdAt: t0 },
      { metric: "paid_users", horizon_days: 7, baseline: 100, lo80: 110, point: 130, hi80: 150, unit: "users" },
    );

    const hyp = upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: "Shorten checkout form", state: "worked", nowMs: t0 });
    db.prepare("UPDATE lane_pilot_sp_intent_outcome SET hypothesis_id = ?, measured = 135, measured_at = ?, source = 'pulse.py', verdict = 'within' WHERE intent_id = ?").run(
      hyp.id,
      t0 + 8 * DAY_MS,
      intent.intentId,
    );
    proposeLocalRule(db, { projectId: "p1", domain: "marketing", hypothesisId: hyp.id, text: "Shorter forms lift paid conversion", nowMs: t0 + 8 * DAY_MS });

    // Re-add a pending due outcome so due_outcomes_json is non-empty
    const dueIntent = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      slotScope: "slot_due_2",
      order: actionOrderSchema.parse({
        kind: "sub_graph",
        title: "Check pricing page",
        domain: "marketing",
        reason_code: "cro_friction_fix",
        action_class: "analysis_propose",
        workflow_id: "mkt-experiment-cycle",
        forecast: { metric: "pricing_cr", horizon_days: 5, baseline: 0.05, lo80: 0.06, point: 0.07, hi80: 0.09, unit: "ratio" },
      }),
      nowMs: t0,
    });
    expect(dueIntent.status).toBe("staged");

    upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: "Popups hurt retention", state: "refuted", nowMs: t0 });

    // Seed 50 large locks and 20 large owner items so snapshot comfortably exceeds 8000 bytes before trimming
    for (let i = 0; i < 50; i += 1) {
      acquireLock(db, {
        projectId: "p1",
        domain: "marketing",
        scopeType: "url",
        scopeValue: `https://example.com/campaign/long-slug-${i}-${"x".repeat(80)}`,
        ownerGraph: "sp-specialist-tick",
        reasonCode: "experiment_launch",
        meta: { note: "y".repeat(60) },
        nowMs: t0 + i,
      });
    }
    for (let i = 0; i < 20; i += 1) {
      postOwnerItem(
        db,
        {
          key: `sp:q:cap:${i}`,
          source: "specialist",
          kind: "question",
          reason: "decision",
          projectId: "p1",
          what: `Question ${i}: ${"q".repeat(120)}`,
          why: `Why ${i}: ${"w".repeat(120)}`,
        },
        t0 + i,
      );
    }

    // Mount with specialist.snapshot_bytes = 8000
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, SPECIALIST_SNAPSHOT_BYTES_KEY, 8_000);
    const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
    registerSpExecutors({} as never, ctx, { action: (k, fn) => void actions.set(k, fn) });
    const loadExec = actions.get("sp.load_memory")!;

    // Also provide large telemetry / negatives / pool history via direct loader test & verify priority order
    const snap = await loadSpecialistMemory({
      ctx,
      projectId: "p1",
      runId: "run_cap_8000",
      domain: "marketing",
      params: {},
      checkout: { hostId: "h1", path: "/tmp/checkout" },
      readCheckoutFileText: async (_c, _co, rel) => {
        if (String(rel).includes("telemetry-map")) return JSON.stringify({ events: "t".repeat(2500) });
        if (String(rel).includes("shared-negatives")) return JSON.stringify(["neg-" + "n".repeat(1500)]);
        if (String(rel).includes("pools-history")) return JSON.stringify([{ pool: "p".repeat(1500) }]);
        return null;
      },
      snapshotBytes: 8_000,
    });

    const serialized = JSON.stringify(snap);
    expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(8_000);
    expect(snap.case_id).toBe("p1:marketing");

    const dropped = snap.snapshot_dropped as string[];
    expect(dropped.length).toBeGreaterThan(0);
    // Tail fields (pool history / negatives / telemetry / owner items) dropped before locks/rules/outcomes/charter
    expect(dropped).toContain("pools_history_json");
    expect(dropped).toContain("shared_negatives_json");
    expect(dropped).toContain("telemetry_map_json");
    expect(dropped.indexOf("pools_history_json")).toBeLessThan(dropped.indexOf("telemetry_map_json"));
    expect(dropped.indexOf("telemetry_map_json")).toBeLessThan(dropped.indexOf("open_assumptions_json"));

    // Charter and due outcomes must survive
    expect(JSON.parse(String(snap.charter_json))).toMatchObject({ goal: "paid_growth" });
    const dueParsed = JSON.parse(String(snap.due_outcomes_json)) as Array<{ metric: string }>;
    expect(dueParsed.some((o) => o.metric === "pricing_cr")).toBe(true);
    expect(dropped).not.toContain("charter_json");
    expect(dropped).not.toContain("due_outcomes_json");

    // Fixed priority order in serialized keys
    const keys = Object.keys(snap);
    expect(keys.indexOf("charter_json")).toBeLessThan(keys.indexOf("due_outcomes_json"));
    expect(keys.indexOf("due_outcomes_json")).toBeLessThan(keys.indexOf("rules_json"));

    // Executor mounted with global setting 8000 also enforces cap and logs DEBUG
    const execSnap = await loadExec(
      makeLoadStep([
        "case_id",
        "snapshot_dropped",
        "charter_json",
        "budget_left_usd",
        "due_outcomes_json",
        "rules_json",
        "tried_already_json",
        "active_locks_json",
        "open_assumptions_json",
      ]),
      { ctx, services: {}, pmThreadId: "pm1", projectId: "p1", runId: "run_exec_8000" } as unknown as ChainRuntime,
    );
    expect(Buffer.byteLength(JSON.stringify(execSnap), "utf8")).toBeLessThanOrEqual(8_000);
    expect(execSnap.case_id).toBe("p1:marketing");
    expect(JSON.parse(String(execSnap.due_outcomes_json))).toHaveLength(1);
    expect(
      logs.some(
        (l) =>
          l.level === "debug" &&
          l.message.startsWith("sp snapshot case=p1:marketing bytes=") &&
          l.message.includes("dropped="),
      ),
    ).toBe(true);
  });

  it("warns and still returns charter when charter alone exceeds cap, and writes case_id in sp.commit_memory receipt", async () => {
    const { db, ctx, logs } = freshHarness();
    const bigCharter = { goal: "oversized_charter", notes: "c".repeat(9_200) };
    upsertCharter(db, { projectId: "p1", domain: "seo", charter: bigCharter });
    acquireLock(db, {
      projectId: "p1",
      domain: "seo",
      scopeType: "url",
      scopeValue: "https://example.com/a",
      ownerGraph: "sp-specialist-tick",
      reasonCode: "seo_indexation_lock",
    });

    const snap = await loadSpecialistMemory({
      ctx,
      projectId: "p1",
      runId: "run_oversized",
      domain: "seo",
      params: {},
      checkout: null,
      readCheckoutFileText: async () => null,
      snapshotBytes: 8_000,
    });

    expect(snap.case_id).toBe("p1:seo");
    expect(JSON.parse(String(snap.charter_json))).toEqual(bigCharter);
    expect(snap.active_locks_json).toBeUndefined();
    expect((snap.snapshot_dropped as string[])).toContain("active_locks_json");
    expect(
      logs.some(
        (l) =>
          l.level === "warn" &&
          l.message.includes("sp snapshot case=p1:seo") &&
          l.message.includes("charter_exceeds_cap"),
      ),
    ).toBe(true);

    // Receipt in sp.commit_memory names case_id
    const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
    registerSpExecutors({} as never, ctx, { action: (k, fn) => void actions.set(k, fn) });
    const commitExec = actions.get("sp.commit_memory")!;
    const receiptRes = await commitExec(
      {
        runId: "run_rcpt",
        stepKey: "receipt",
        nodeId: "receipt",
        node: {
          id: "receipt",
          type: "action",
          action: "sp.commit_memory",
          params: { phase: "receipt", domain: "seo", caseId: "p1:seo" },
          out: [
            { name: "case_id", type: "string", required: true },
            { name: "summary", type: "string", required: true },
          ],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: [] } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      { ctx, services: {}, pmThreadId: "pm1", projectId: "p1", runId: "run_rcpt" } as unknown as ChainRuntime,
    );
    expect(receiptRes.case_id).toBe("p1:seo");
    const commitRow = db
      .prepare("SELECT summary_json FROM lane_pilot_sp_memory_commit WHERE run_id = ?")
      .get("run_rcpt") as { summary_json: string };
    expect(JSON.parse(commitRow.summary_json)).toMatchObject({ case_id: "p1:seo" });
  });
});
