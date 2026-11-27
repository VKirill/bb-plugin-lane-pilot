import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { OUTCOME_VERDICTS } from "@lane-pilot/contracts";
import type { StepContext, Workflow } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import { createCore } from "../../src/rooms/core/server/core";
import {
  type ActionOrder,
  actionOrderSchema,
  computeIdemKey,
  intervalForecastSchema,
} from "../../src/rooms/specialist";
import {
  dueOutcomes,
  expireOutcomes,
  recordMeasurement,
  registerSpExecutors,
  stageIntent,
  writePendingOutcome,
} from "../../src/rooms/specialist/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";

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

function makeOrder(overrides: Partial<ActionOrder> = {}): ActionOrder {
  return actionOrderSchema.parse({
    kind: "sub_graph",
    title: "Improve checkout conversion",
    domain: "marketing",
    reason_code: "cro_friction_fix",
    action_class: "analysis_propose",
    workflow_id: "mkt-landing-cro-audit",
    is_stop_or_kill: false,
    requires_owner_go: false,
    tariff_known: true,
    estimated_cost_usd: 0.2,
    forecast: {
      metric: "checkout_cr",
      horizon_days: 7,
      baseline: 0.12,
      lo80: 0.14,
      point: 0.16,
      hi80: 0.19,
      unit: "ratio",
    },
    ...overrides,
  });
}

describe("Specialist intent outcome log (Task 35)", () => {
  it("exports OUTCOME_VERDICTS and extends intervalForecastSchema without changing computeIdemKey", () => {
    expect(OUTCOME_VERDICTS).toEqual(["pending", "within", "above", "below", "inconclusive"]);

    const parsed = intervalForecastSchema.parse({
      metric: "ctr",
      horizon_days: 10,
      lo80: 0.03,
      point: 0.04,
      hi80: 0.05,
      unit: "ratio",
      baseline: 0.025,
      check_at: "2026-11-20T00:00:00Z",
    });
    expect(parsed.baseline).toBe(0.025);
    expect(parsed.check_at).toBe("2026-11-20T00:00:00Z");

    const baseOrder = makeOrder({
      forecast: { metric: "checkout_cr", horizon_days: 7, lo80: 0.14, point: 0.16, hi80: 0.19, unit: "ratio" },
    });
    const extendedOrder = makeOrder({
      forecast: {
        metric: "checkout_cr",
        horizon_days: 14,
        baseline: 0.11,
        check_at: "2026-12-01T00:00:00Z",
        lo80: 0.15,
        point: 0.18,
        hi80: 0.22,
        unit: "percent",
      },
    });
    const noForecastOrder = makeOrder({ forecast: undefined });

    const k1 = computeIdemKey("p1", "marketing", baseOrder, "slot_1");
    const k2 = computeIdemKey("p1", "marketing", extendedOrder, "slot_1");
    const k3 = computeIdemKey("p1", "marketing", noForecastOrder, "slot_1");
    expect(k1).toBe(k2);
    expect(k1).toBe(k3);
  });

  it("writes a pending outcome on stageIntent with forecast, computes default check_at, and queries dueOutcomes", () => {
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.parse("2026-11-01T10:00:00Z");

    const staged = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder(),
      log: ctx.bb.log,
      nowMs: t0,
    });
    expect(staged.status).toBe("staged");

    const row = db
      .prepare("SELECT * FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?")
      .get(staged.intentId) as Record<string, unknown> | undefined;
    expect(row).toMatchObject({
      intent_id: staged.intentId,
      project_id: "p1",
      domain: "marketing",
      metric: "checkout_cr",
      unit: "ratio",
      baseline: 0.12,
      expected_lo: 0.14,
      expected_point: 0.16,
      expected_hi: 0.19,
      check_at: t0 + 7 * DAY_MS,
      measured: null,
      verdict: "pending",
    });
    expect(logs.some((l) => l.level === "debug" && l.message.includes(`intent outcome pending intent=${staged.intentId}`))).toBe(true);

    // Not due yet before check_at
    expect(dueOutcomes(db, { projectId: "p1", domain: "marketing", now: t0 + 6 * DAY_MS })).toHaveLength(0);
    // Due once check_at arrives
    const due = dueOutcomes(db, { projectId: "p1", domain: "marketing", now: t0 + 7 * DAY_MS });
    expect(due).toHaveLength(1);
    expect(due[0]!.intent_id).toBe(staged.intentId);

    // Explicit check_at overrides horizon_days
    const explicitCheck = "2026-11-05T12:00:00Z";
    const stagedExplicit = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({
        workflow_id: "mkt-tracking-setup",
        forecast: {
          metric: "unattributed_paid_share",
          horizon_days: 30,
          lo80: 0.02,
          point: 0.04,
          hi80: 0.06,
          unit: "ratio",
          check_at: explicitCheck,
        },
      }),
      nowMs: t0,
    });
    const explicitRow = db
      .prepare("SELECT check_at FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?")
      .get(stagedExplicit.intentId) as { check_at: number };
    expect(explicitRow.check_at).toBe(Date.parse(explicitCheck));
  });

  it("assigns within / above / below verdicts and refuses duplicate, unknown, and non-numeric measurements", () => {
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    const sWithin = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf-a" }),
      nowMs: t0,
    });
    const sAbove = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf-b" }),
      nowMs: t0,
    });
    const sBelow = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf-c" }),
      nowMs: t0,
    });

    const rWithin = recordMeasurement(db, { intentId: sWithin.intentId, measured: 0.16, source: "product_alerts.py", now: t0 + 7 * DAY_MS }, ctx.bb.log);
    const rAbove = recordMeasurement(db, { intentId: sAbove.intentId, measured: 0.25, source: "product_alerts.py", now: t0 + 7 * DAY_MS }, ctx.bb.log);
    const rBelow = recordMeasurement(db, { intentId: sBelow.intentId, measured: 0.09, source: "product_alerts.py", now: t0 + 7 * DAY_MS }, ctx.bb.log);
    expect(rWithin).toEqual({ ok: true, verdict: "within" });
    expect(rAbove).toEqual({ ok: true, verdict: "above" });
    expect(rBelow).toEqual({ ok: true, verdict: "below" });

    // Second measurement refused
    const second = recordMeasurement(db, { intentId: sWithin.intentId, measured: 0.17, source: "product_alerts.py", now: t0 + 8 * DAY_MS }, ctx.bb.log);
    expect(second).toEqual({ ok: false, reason: "already_measured" });

    // Unknown intent refused
    const unknown = recordMeasurement(db, { intentId: "int_does_not_exist", measured: 0.15, source: "product_alerts.py" }, ctx.bb.log);
    expect(unknown).toEqual({ ok: false, reason: "unknown_intent" });

    // Non-numeric measurement refused
    const sPending = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf-d" }),
      nowMs: t0,
    });
    const nonNum = recordMeasurement(
      db,
      { intentId: sPending.intentId, measured: Number.NaN, source: "product_alerts.py" },
      ctx.bb.log,
    );
    expect(nonNum).toEqual({ ok: false, reason: "not_numeric" });

    expect(logs.some((l) => l.level === "info" && l.message === `intent outcome intent=${sWithin.intentId} verdict=within`)).toBe(true);
    expect(logs.some((l) => l.level === "warn" && l.message.includes(`intent measurement refused intent=${sWithin.intentId}:`))).toBe(true);
    expect(logs.some((l) => l.level === "warn" && l.message.includes("intent measurement refused intent=int_does_not_exist:"))).toBe(true);
    expect(logs.some((l) => l.level === "warn" && l.message.includes(`intent measurement refused intent=${sPending.intentId}:`))).toBe(true);
  });

  it("expires unmeasured outcomes to inconclusive 7 days after check_at", () => {
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");
    const staged = stageIntent(db, {
      projectId: "p1",
      domain: "seo",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ domain: "seo" }),
      nowMs: t0,
    });
    const checkAt = t0 + 7 * DAY_MS;

    // 6 days after check_at -> still pending
    expect(expireOutcomes(db, checkAt + 6 * DAY_MS, ctx.bb.log).expiredCount).toBe(0);

    // 7 days after check_at -> inconclusive
    const expired = expireOutcomes(db, checkAt + 7 * DAY_MS, ctx.bb.log);
    expect(expired).toEqual({ expiredCount: 1, intentIds: [staged.intentId] });

    const row = db
      .prepare("SELECT verdict, measured FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?")
      .get(staged.intentId) as { verdict: string; measured: number | null };
    expect(row).toEqual({ verdict: "inconclusive", measured: null });
    expect(logs.some((l) => l.level === "warn" && l.message === `intent outcome inconclusive intent=${staged.intentId} (no measurement)`)).toBe(true);

    // Subsequent late measurement is refused
    const late = recordMeasurement(db, { intentId: staged.intentId, measured: 0.16, source: "pulse_probe.py" }, ctx.bb.log);
    expect(late).toEqual({ ok: false, reason: "already_measured" });
  });

  it("sp.load_memory returns <= 20 due outcomes and sp.commit_memory receipt accepts script-node bindings while rejecting model text", async () => {
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.now() - 10 * DAY_MS;

    // Seed 22 due pending outcomes for marketing
    const intentIds: string[] = [];
    for (let i = 0; i < 22; i++) {
      const res = stageIntent(db, {
        projectId: "p1",
        domain: "marketing",
        sourceGraph: "sp-specialist-tick",
        order: makeOrder({
          workflow_id: `wf_${i}`,
          forecast: { metric: `m_${i}`, horizon_days: 5, lo80: 0.1, point: 0.15, hi80: 0.2, unit: "ratio" },
        }),
        nowMs: t0 + i * 1000,
      });
      intentIds.push(res.intentId);
    }
    // Also add 1 expired (> check_at + 7d) outcome directly
    const oldIntent = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_expired", forecast: undefined }),
      nowMs: t0 - 30 * DAY_MS,
    });
    writePendingOutcome(
      db,
      { intentId: oldIntent.intentId, projectId: "p1", domain: "marketing", createdAt: t0 - 30 * DAY_MS },
      { metric: "old_m", horizon_days: 7, lo80: 0.1, point: 0.15, hi80: 0.2, unit: "ratio" },
    );

    const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
    registerSpExecutors({} as never, ctx, {
      action: (key, run) => {
        actions.set(key, run);
      },
    });

    const rt = { ctx, services: {}, pmThreadId: "pm1", projectId: "p1", runId: "run_1" } as unknown as ChainRuntime;
    const loadExec = actions.get("sp.load_memory")!;
    const loaded = await loadExec(
      {
        runId: "run_1",
        stepKey: "load_state",
        nodeId: "load_state",
        node: {
          id: "load_state",
          type: "action",
          action: "sp.load_memory",
          params: { domain: "marketing" },
          out: [{ name: "due_outcomes_json", type: "string", required: true }],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: [] } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );

    const parsedDue = JSON.parse(String(loaded.due_outcomes_json)) as Array<{ intent_id: string; metric: string }>;
    expect(parsedDue).toHaveLength(20);
    // Expired outcome was swept to inconclusive before building due_outcomes_json
    const expiredRow = db
      .prepare("SELECT verdict FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?")
      .get(oldIntent.intentId) as { verdict: string };
    expect(expiredRow.verdict).toBe("inconclusive");

    const commitExec = actions.get("sp.commit_memory")!;
    const targetFromScript = intentIds[0]!;
    const targetFromAgent = intentIds[1]!;
    const targetFromLiteral = intentIds[2]!;

    const wfNodes = [
      { id: "collect_mkt", type: "action", action: "sp.run_script", params: {}, out: [] },
      { id: "plan_mkt", type: "agent", form: "agent", role: "specialist:growth-marketer", prompt: "", out: [] },
    ] as unknown as Workflow["nodes"];

    // 1. Model-text binding (type: "agent") is rejected
    await commitExec(
      {
        runId: "run_2",
        stepKey: "receipt",
        nodeId: "receipt",
        node: {
          id: "receipt",
          type: "action",
          action: "sp.commit_memory",
          params: { phase: "receipt", domain: "marketing", measurements: "{{plan_mkt.measurements}}" },
          out: [{ name: "measurements_recorded", type: "number", required: true }, { name: "measurements_refused", type: "number", required: true }],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: wfNodes } as unknown as Workflow,
        template: (v: unknown) =>
          typeof v === "object" && v !== null
            ? { ...v, measurements: [{ intent_id: targetFromAgent, measured: 0.15, source: "model" }] }
            : [{ intent_id: targetFromAgent, measured: 0.15, source: "model" }],
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );
    expect((db.prepare("SELECT verdict FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?").get(targetFromAgent) as { verdict: string }).verdict).toBe("pending");

    // 2. Literal inline array (not bound to a script node) is rejected
    await commitExec(
      {
        runId: "run_3",
        stepKey: "receipt",
        nodeId: "receipt",
        node: {
          id: "receipt",
          type: "action",
          action: "sp.commit_memory",
          params: {
            phase: "receipt",
            domain: "marketing",
            measurements: [{ intent_id: targetFromLiteral, measured: 0.15, source: "inline" }],
          },
          out: [{ name: "measurements_recorded", type: "number", required: true }, { name: "measurements_refused", type: "number", required: true }],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: wfNodes } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );
    expect((db.prepare("SELECT verdict FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?").get(targetFromLiteral) as { verdict: string }).verdict).toBe("pending");

    // 3. Script-node binding ({{collect_mkt.measurements_json}}) is accepted
    const scriptOut = await commitExec(
      {
        runId: "run_4",
        stepKey: "receipt",
        nodeId: "receipt",
        node: {
          id: "receipt",
          type: "action",
          action: "sp.commit_memory",
          params: {
            phase: "receipt",
            domain: "marketing",
            measurements: ["{{collect_mkt.measurements_json}}"],
          },
          out: [{ name: "measurements_recorded", type: "number", required: true }, { name: "measurements_refused", type: "number", required: true }],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: wfNodes } as unknown as Workflow,
        template: (v: unknown) =>
          v === "{{collect_mkt.measurements_json}}"
            ? JSON.stringify([{ intent_id: targetFromScript, measured: 0.15, source: "product_alerts.py" }])
            : v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );
    expect(scriptOut.measurements_recorded).toBe(1);
    expect(scriptOut.measurements_refused).toBe(0);
    expect((db.prepare("SELECT verdict, source FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?").get(targetFromScript) as { verdict: string; source: string })).toEqual({
      verdict: "within",
      source: "product_alerts.py",
    });
    expect(logs.some((l) => l.level === "warn" && l.message.includes("not a script node"))).toBe(true);
  });
});
