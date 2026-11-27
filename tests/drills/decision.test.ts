import { afterEach, describe, expect, it } from "vitest";
import { callReason, closeOwnerItem, listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import { saveProjectSetting } from "../../src/rooms/plugin-db";
import { composeReviewDesk } from "../../src/rooms/reports/server";
import {
  decideHeldIntent,
  dueOutcomes,
  linkIntent,
  proposeLocalRule,
  recordMeasurement,
  settleHypotheses,
  specialistScorecard,
  upsertCharter,
} from "../../src/rooms/specialist/server";
import { setupLiveSpecialistEnv } from "../specialist/live-e2e-harness";

const DAY_MS = 86_400_000;

function createStepTracker(drillName: string) {
  let current = "init";
  return async <T>(label: string, fn: () => T | Promise<T>): Promise<T> => {
    current = label;
    try {
      return await fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`[drill:${drillName} step="${current}"] ${msg}`, { cause: err });
    }
  };
}

let cleanup: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

describe("Control Drill 3: Decision", () => {
  it("sp-specialist-tick with burned-out creative -> typed intent -> propose-only owner item -> approve -> measurement closes -> rule recorded with attribution -> scorecard counts it", async () => {
    const step = createStepTracker("decision");
    const t0 = Date.now();
    const hypothesisTitle = "Refreshing burned-out creative restores CTR to 3.2-4.5%";

    const t = await setupLiveSpecialistEnv({
      plan_mkt: {
        summary: "Creative burned out: CTR dropped from 4.0% to 1.8% across 5,200 impressions (above 1,000 min volume); rotate creative.",
        bottleneck: "creative_fatigue",
        lever: "core",
        self_doubt: "Verified tracking freshness and 200 OK landing status; impressions 5,200 exceed charter minimum 1,000.",
        missing_data_note: "",
        orders: [
          {
            kind: "direct_api",
            title: "Rotate burned-out ad creative on campaign C1",
            domain: "marketing",
            reason_code: "change_creative",
            action_class: "change_creative",
            server: "mcp-yandex-direct",
            tool: "update_ad_creative",
            entity_id: "camp_1",
            target_scope: { scope_type: "campaign", scope_value: "camp_1" },
            tariff_known: true,
            estimated_cost_usd: 0.25,
            requires_owner_go: false,
            forecast: {
              metric: "ctr",
              horizon_days: 5,
              baseline: 0.018,
              lo80: 0.032,
              point: 0.038,
              hi80: 0.045,
              unit: "ratio",
            },
            new_hypothesis: {
              title: hypothesisTitle,
              lever: "core",
            },
          },
        ],
        owner_questions: [],
        new_shadow_questions: [],
        forecast: {
          metric: "ctr",
          horizon_days: 5,
          baseline: 0.018,
          lo80: 0.032,
          point: 0.038,
          hi80: 0.045,
          unit: "ratio",
        },
        needs_owner_go: false,
      },
      audit: { status: "pass", findings: [], reasons: "" },
    });
    cleanup = t.dispose;

    await step("seed charter and propose-only employee loop mode", () => {
      upsertCharter(t.db, {
        projectId: t.projectId,
        domain: "marketing",
        charter: {
          north_star: { metric_id: "ctr", direction: "up", baseline: 0.018, target: 0.04 },
          min_volume: 1000,
          budgets: { daily_cap_usd: 25, cell_cap_usd: 5 },
        },
        approvedBy: "owner",
        nowMs: t0 - DAY_MS,
      });
      saveProjectSetting(t.db, t.projectId, "loops.mode", { employee: "report" });
    });

    const tickResult = await step("run sp-specialist-tick with creative burnout signal", async () => {
      const res = await t.runWorkflowLive("sp-specialist-tick", {
        domain: "marketing",
        mode: "daily_sweep",
        scope_id: "default",
        emergency: false,
      });
      expect(res.summary.status).toBe("succeeded");
      return res;
    });

    const { intentId, hypothesisId } = await step("verify typed change_creative intent, tier/cost brakes, and propose-only owner item", () => {
      const intents = t.db
        .prepare("SELECT intent_id, reason_code, status, drop_reason, estimated_cost_usd, order_json FROM lane_pilot_sp_intent WHERE project_id = ?")
        .all(t.projectId) as Array<{
          intent_id: string;
          reason_code: string;
          status: string;
          drop_reason: string | null;
          estimated_cost_usd: number;
          order_json: string;
        }>;
      expect(intents).toHaveLength(1);
      const intent = intents[0]!;
      expect(intent.reason_code).toBe("change_creative");
      expect(intent.status).toBe("held");
      expect(intent.drop_reason).toBe("owner_go_required");
      expect(intent.estimated_cost_usd).toBe(0.25);

      const parsedOrder = JSON.parse(intent.order_json) as Record<string, unknown>;
      expect(parsedOrder._tier).toBe("L");
      expect(parsedOrder.forecast).toMatchObject({ metric: "ctr", lo80: 0.032, point: 0.038, hi80: 0.045 });

      const ownerItems = listOpenOwnerItems(t.db, { projectId: t.projectId, source: "specialist" });
      const item = ownerItems.find((entry) => entry.key === `sp:intent:${intent.intent_id}`);
      expect(item).toBeDefined();
      expect(callReason(item!.kind)).toBe("decision");

      const hyp = t.db
        .prepare("SELECT id, state FROM lane_pilot_sp_hypothesis WHERE project_id = ? AND title = ?")
        .get(t.projectId, hypothesisTitle) as { id: string; state: string } | undefined;
      expect(hyp).toMatchObject({ state: "open" });

      return { intentId: intent.intent_id, hypothesisId: hyp!.id, tickRunId: tickResult.runId };
    });

    await step("owner approves held intent", () => {
      const approved = decideHeldIntent(t.db, { intentId, decision: "approve", nowMs: t0 + 1000 }, t.ctx.bb.log);
      expect(approved).toEqual({ ok: true, status: "staged" });
      expect(closeOwnerItem(t.db, `sp:intent:${intentId}`, "owner:approved", t0 + 1000)).toBe(true);
      expect(listOpenOwnerItems(t.db, { projectId: t.projectId, source: "specialist" }).some((i) => i.key === `sp:intent:${intentId}`)).toBe(false);

      const linked = linkIntent(t.db, intentId, hypothesisId, t.ctx.bb.log);
      expect(linked).toEqual({ ok: true, hypothesisId, state: "testing" });
    });

    const afterCheckAt = t0 + 6 * DAY_MS;

    await step("after check date, measurement closes decision and settles hypothesis as worked", () => {
      const due = dueOutcomes(t.db, { projectId: t.projectId, domain: "marketing", now: afterCheckAt });
      expect(due.map((row) => row.intent_id)).toContain(intentId);

      const measured = recordMeasurement(
        t.db,
        { intentId, measured: 0.039, source: "product_alerts.py", now: afterCheckAt },
        t.ctx.bb.log,
      );
      expect(measured).toEqual({ ok: true, verdict: "within" });

      const settled = settleHypotheses(t.db, { projectId: t.projectId, domain: "marketing", nowMs: afterCheckAt }, t.ctx.bb.log);
      expect(settled.workedCount).toBe(1);
    });

    await step("learned-rule candidate recorded with attribution and counted on weekly scorecard", () => {
      const ruleRes = proposeLocalRule(
        t.db,
        { projectId: t.projectId, domain: "marketing", hypothesisId, nowMs: afterCheckAt },
        t.ctx.bb.log,
      );
      expect(ruleRes.ok).toBe(true);
      if (!ruleRes.ok) throw new Error(`expected rule ok, got ${ruleRes.reason}`);
      expect(ruleRes.scope).toBe("local");
      expect(ruleRes.state).toBe("active");

      const evidence = JSON.parse(ruleRes.rule.evidence_json) as Array<{ intent_id: string; verdict: string; measured: number }>;
      expect(evidence).toHaveLength(1);
      expect(evidence[0]).toMatchObject({ intent_id: intentId, verdict: "within", measured: 0.039 });

      const win = JSON.parse(ruleRes.rule.window_json) as { comparison: string; measurement_days: number };
      expect(win.measurement_days).toBeGreaterThanOrEqual(5);
      expect(ruleRes.rule.uncertainty).toContain("0.039");

      const cards = specialistScorecard(t.db, { now: afterCheckAt }, t.ctx.bb.log);
      const card = cards.find((entry) => entry.caseId === `${t.projectId}:marketing`);
      expect(card).toBeDefined();
      expect(card?.line).toContain("решений 1, проверено 1, сработало 1");
      expect(card?.conclusiveShare8w).toBe(1);

      const desk = composeReviewDesk(t.db, {}, { now: afterCheckAt });
      expect(desk.items.some((item) => item.id === `scorecard:${t.projectId}:marketing`)).toBe(true);
    });
  });
});
