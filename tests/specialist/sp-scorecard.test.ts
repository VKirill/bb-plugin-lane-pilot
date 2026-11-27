import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { openDatabase } from "../../src/rooms/plugin-db";
import { type ActionOrder, actionOrderSchema } from "../../src/rooms/specialist";
import {
  decideHeldIntent,
  expireOutcomes,
  linkIntent,
  proposeLocalRule,
  proposeSharedRule,
  recomputeAutonomy,
  recordMeasurement,
  settleHypotheses,
  specialistScorecard,
  stageIntent,
  upsertCharter,
  upsertHypothesis,
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

function makeOrder(overrides: Partial<ActionOrder> = {}): ActionOrder {
  return actionOrderSchema.parse({
    kind: "sub_graph",
    title: "Test scorecard order",
    domain: "marketing",
    reason_code: "cro_friction_fix",
    action_class: "analysis_propose",
    workflow_id: `wf_${Math.random().toString(36).slice(2, 10)}`,
    is_stop_or_kill: false,
    requires_owner_go: false,
    tariff_known: true,
    estimated_cost_usd: 0.2,
    forecast: {
      metric: "net_paid_users_30d",
      horizon_days: 7,
      lo80: 450,
      point: 500,
      hi80: 550,
      unit: "users",
    },
    ...overrides,
  });
}

describe("Specialist weekly scorecard per employee (Task 40)", () => {
  it("reports counts, active hypotheses, next check weekday, asks, and omits idle cases", () => {
    const { db, ctx, logs } = freshHarness();
    // 2026-11-16 is a Monday; next check +3d is Thursday ("чт").
    const now = Date.parse("2026-11-16T12:00:00Z");

    upsertCharter(db, {
      projectId: "proj-active",
      domain: "marketing",
      charter: { north_star: { metric_id: "net_paid_users_30d", baseline: 400, target: 600 } },
      nowMs: now - 30 * DAY_MS,
    });

    // Idle case: old charter + old decision + settled hypothesis > 7 days ago, nothing in last 7d.
    upsertCharter(db, {
      projectId: "proj-idle",
      domain: "seo",
      charter: { north_star: { metric_id: "clicks", baseline: 100, target: 200 } },
      nowMs: now - 30 * DAY_MS,
    });
    const idleIntent = stageIntent(db, {
      projectId: "proj-idle",
      domain: "seo",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ domain: "seo", workflow_id: "wf_idle_1" }),
      nowMs: now - 20 * DAY_MS,
    });
    recordMeasurement(
      db,
      { intentId: idleIntent.intentId, measured: 500, source: "gsc", now: now - 12 * DAY_MS },
      ctx.bb.log,
    );

    // Active case hypotheses: 1 open, 1 testing (will remain in work), 1 worked (used for shared rule).
    upsertHypothesis(
      db,
      { projectId: "proj-active", domain: "marketing", title: "Open onboarding idea", state: "open", nowMs: now - 3 * DAY_MS },
      ctx.bb.log,
    );
    const testingHyp = upsertHypothesis(
      db,
      { projectId: "proj-active", domain: "marketing", title: "Pricing anchor test", state: "open", nowMs: now - 2 * DAY_MS },
      ctx.bb.log,
    );

    // Decision 1 (staged 2 days ago, measured 1 day ago as worked/within).
    const d1 = stageIntent(db, {
      projectId: "proj-active",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_d1" }),
      nowMs: now - 2 * DAY_MS,
    });
    recordMeasurement(
      db,
      { intentId: d1.intentId, measured: 510, source: "posthog", now: now - 1 * DAY_MS },
      ctx.bb.log,
    );

    // Decision 2 (staged 3 days ago, measured 1 day ago as below/unfavourable).
    const d2 = stageIntent(db, {
      projectId: "proj-active",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_d2" }),
      nowMs: now - 3 * DAY_MS,
    });
    recordMeasurement(
      db,
      { intentId: d2.intentId, measured: 350, source: "posthog", now: now - 1 * DAY_MS },
      ctx.bb.log,
    );

    // Decision 3 (staged 1 day ago, pending check on Thursday = now + 3d).
    const d3 = stageIntent(db, {
      projectId: "proj-active",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({
        workflow_id: "wf_d3",
        forecast: {
          metric: "net_paid_users_30d",
          horizon_days: 4,
          lo80: 460,
          point: 520,
          hi80: 560,
          unit: "users",
        },
      }),
      nowMs: now - 1 * DAY_MS,
    });
    linkIntent(db, d3.intentId, testingHyp.id, ctx.bb.log);

    // Shared-rule proposal contributed by proj-active and partner proj-partner (older than 7d so partner stays idle).
    const ruleText = "Show social proof near primary CTA";
    const hA = upsertHypothesis(
      db,
      { projectId: "proj-active", domain: "marketing", title: ruleText, nowMs: now - 25 * DAY_MS },
      ctx.bb.log,
    );
    for (let i = 0; i < 2; i += 1) {
      const s = stageIntent(db, {
        projectId: "proj-active",
        domain: "marketing",
        sourceGraph: "sp-specialist-tick",
        order: makeOrder({ workflow_id: `wf_rule_a_${i}` }),
        nowMs: now - 25 * DAY_MS + i,
      });
      linkIntent(db, s.intentId, hA.id, ctx.bb.log);
      recordMeasurement(
        db,
        { intentId: s.intentId, measured: 515, source: "posthog", now: now - 18 * DAY_MS + i },
        ctx.bb.log,
      );
    }
    settleHypotheses(db, { projectId: "proj-active", domain: "marketing", nowMs: now - 17 * DAY_MS }, ctx.bb.log);
    const localA = proposeLocalRule(
      db,
      { projectId: "proj-active", domain: "marketing", hypothesisId: hA.id, nowMs: now - 17 * DAY_MS },
      ctx.bb.log,
    );
    expect(localA.ok).toBe(true);

    upsertCharter(db, {
      projectId: "proj-partner",
      domain: "marketing",
      charter: { north_star: { metric_id: "net_paid_users_30d", baseline: 400, target: 600 } },
      nowMs: now - 30 * DAY_MS,
    });
    const hB = upsertHypothesis(
      db,
      { projectId: "proj-partner", domain: "marketing", title: ruleText, nowMs: now - 25 * DAY_MS },
      ctx.bb.log,
    );
    for (let i = 0; i < 2; i += 1) {
      const s = stageIntent(db, {
        projectId: "proj-partner",
        domain: "marketing",
        sourceGraph: "sp-specialist-tick",
        order: makeOrder({ workflow_id: `wf_rule_b_${i}` }),
        nowMs: now - 25 * DAY_MS + i,
      });
      linkIntent(db, s.intentId, hB.id, ctx.bb.log);
      recordMeasurement(
        db,
        { intentId: s.intentId, measured: 525, source: "posthog", now: now - 18 * DAY_MS + i },
        ctx.bb.log,
      );
    }
    settleHypotheses(db, { projectId: "proj-partner", domain: "marketing", nowMs: now - 17 * DAY_MS }, ctx.bb.log);
    const localB = proposeLocalRule(
      db,
      { projectId: "proj-partner", domain: "marketing", hypothesisId: hB.id, nowMs: now - 17 * DAY_MS },
      ctx.bb.log,
    );
    expect(localB.ok).toBe(true);
    if (localA.ok && localB.ok) {
      const shared = proposeSharedRule(
        db,
        { domain: "marketing", ruleIds: [localA.id, localB.id], nowMs: now - 16 * DAY_MS },
        ctx.bb.log,
      );
      expect(shared.ok).toBe(true);
    }

    const cards = specialistScorecard(db, { now }, ctx.bb.log);
    expect(cards.map((c) => c.caseId)).toEqual(["proj-active:marketing"]);

    const card = cards[0]!;
    expect(card.line.length).toBeLessThanOrEqual(160);
    expect(card.line).toContain("Marketing/proj-active: решений 3, проверено 2, сработало 1; гипотез в работе 2; следующая проверка чт; просит: ");
    expect(card.askFor).toEqual([`rule:${ruleText}`]);
    expect(card.conclusiveShare8w).toBe(1);
    expect(logs.some((l) => l.level === "debug" && l.message === "sp scorecard cases=1")).toBe(true);
  });

  it("computes conclusiveShare8w over 8 weeks excluding older outcomes and includes promotion candidates in askFor", () => {
    const { db, ctx } = freshHarness();
    const now = Date.parse("2026-11-20T12:00:00Z");

    upsertCharter(db, {
      projectId: "proj-very-long-identifier-for-line-budget-check",
      domain: "seo",
      charter: { north_star: { metric_id: "clicks", baseline: 100, target: 200 } },
      nowMs: now - 90 * DAY_MS,
    });

    // Old inconclusive outcome > 8 weeks ago (9 weeks ago): must NOT count toward 8w share.
    const oldExpired = stageIntent(db, {
      projectId: "proj-very-long-identifier-for-line-budget-check",
      domain: "seo",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({
        domain: "seo",
        reason_code: "seo_link_fix",
        workflow_id: "wf_old_expired",
        forecast: { metric: "clicks", horizon_days: 7, lo80: 110, point: 130, hi80: 150, unit: "clicks" },
      }),
      nowMs: now - 70 * DAY_MS,
    });
    expireOutcomes(db, now - 56 * DAY_MS - 1, ctx.bb.log);
    expect(oldExpired.intentId).toBeTruthy();

    // 20 recent approved + measured decisions to qualify `sub_graph:seo_link_fix` for promotion (Task 39).
    for (let i = 0; i < 20; i += 1) {
      const staged = stageIntent(db, {
        projectId: "proj-very-long-identifier-for-line-budget-check",
        domain: "seo",
        sourceGraph: "sp-specialist-tick",
        order: makeOrder({
          domain: "seo",
          reason_code: "seo_link_fix",
          workflow_id: `wf_promo_${i}`,
          forecast: { metric: "clicks", horizon_days: i < 3 ? 7 : 22, lo80: 110, point: 130, hi80: 150, unit: "clicks" },
        }),
        forceHold: true,
        modelNeedsOwnerGo: false,
        nowMs: now - 20 * DAY_MS + i * 1000,
      });
      decideHeldIntent(db, { intentId: staged.intentId, decision: "approve", nowMs: now - 19 * DAY_MS + i * 1000 }, ctx.bb.log);
      if (i < 3) {
        // 3 measured within the 8w window (and within last 7d for activity).
        recordMeasurement(
          db,
          { intentId: staged.intentId, measured: 140, source: "gsc", now: now - 2 * DAY_MS + i * 1000 },
          ctx.bb.log,
        );
      }
    }

    // 1 recent inconclusive outcome within 8 weeks -> conclusiveShare8w = 3 / (3 + 1) = 0.75.
    stageIntent(db, {
      projectId: "proj-very-long-identifier-for-line-budget-check",
      domain: "seo",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({
        domain: "seo",
        reason_code: "seo_link_fix",
        workflow_id: "wf_recent_expired",
        forecast: { metric: "clicks", horizon_days: 7, lo80: 110, point: 130, hi80: 150, unit: "clicks" },
      }),
      nowMs: now - 20 * DAY_MS,
    });
    expireOutcomes(db, now - 1 * DAY_MS, ctx.bb.log);

    // 1 pending outcome left (from promo loop i >= 3) -> next check date is computed cleanly.
    recomputeAutonomy(
      db,
      { projectId: "proj-very-long-identifier-for-line-budget-check", domain: "seo", now },
      ctx.bb.log,
    );

    const cards = specialistScorecard(db, { now }, ctx.bb.log);
    expect(cards).toHaveLength(1);

    const card = cards[0]!;
    expect(card.caseId).toBe("proj-very-long-identifier-for-line-budget-check:seo");
    expect(card.conclusiveShare8w).toBe(0.75);
    expect(card.askFor).toContain("auto:sub_graph:seo_link_fix");
    expect(card.line.startsWith("SEO/")).toBe(true);
    expect(card.line.length).toBeLessThanOrEqual(160);
  });

  it("returns 0 conclusiveShare8w when all outcomes are pending and handles empty DB", () => {
    const { db, ctx, logs } = freshHarness();
    const now = Date.parse("2026-11-20T12:00:00Z");

    expect(specialistScorecard(db, { now }, ctx.bb.log)).toEqual([]);
    expect(logs.some((l) => l.level === "debug" && l.message === "sp scorecard cases=0")).toBe(true);

    stageIntent(db, {
      projectId: "p-pending",
      domain: "specialist_os",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({
        domain: "specialist_os",
        workflow_id: "wf_pending_only",
        forecast: { metric: "latency", horizon_days: 2, lo80: 1, point: 2, hi80: 3, unit: "s" },
      }),
      nowMs: now - 1 * DAY_MS,
    });

    const cards = specialistScorecard(db, { now }, ctx.bb.log);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.conclusiveShare8w).toBe(0);
    // 2026-11-20 (Fri) - 1d + 2d = 2026-11-21 (Sat -> "сб")
    expect(cards[0]!.line).toBe(
      "SpecialistOS/p-pending: решений 1, проверено 0, сработало 0; гипотез в работе 0; следующая проверка сб; просит: нет",
    );
    expect(cards[0]!.line.length).toBeLessThanOrEqual(160);
  });
});
