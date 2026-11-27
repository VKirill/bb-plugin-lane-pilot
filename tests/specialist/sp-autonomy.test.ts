import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { AUTONOMY_CLASSES } from "@lane-pilot/contracts";
import type { StepContext, Workflow } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import type { Services } from "../../src/rooms/services";
import { type ActionOrder, actionOrderSchema } from "../../src/rooms/specialist";
import {
  autonomyOf,
  countRefusalsByActionClass,
  decideHeldIntent,
  grantAutonomy,
  promotionCandidates,
  recomputeAutonomy,
  recordMeasurement,
  registerSpExecutors,
  revokeAutonomy,
  stageIntent,
  upsertBreakerState,
  upsertCharter,
} from "../../src/rooms/specialist/server";
import { registerCli } from "../../src/rooms/tools/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";

const DAY_MS = 86_400_000;

function freshHarness() {
  const logs: Array<{ level: "debug" | "info" | "warn" | "error"; message: string }> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  for (const level of ["debug", "info", "warn", "error"] as const) {
    const orig = bb.log[level]?.bind(bb.log);
    bb.log[level] = (message: string) => {
      logs.push({ level, message: String(message) });
      orig?.(message);
    };
  }
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  registerCli(ctx, {} as Services, migrations);
  return { bb, harness, db, ctx, logs };
}

function makeDirectLOrder(overrides: Partial<ActionOrder> = {}): ActionOrder {
  return actionOrderSchema.parse({
    kind: "direct_api",
    title: "Adjust campaign budget",
    domain: "marketing",
    reason_code: "cpa_spike",
    action_class: "budget_edit",
    server: "mcp-yandex-direct",
    tool: "update_campaign_budget",
    tariff_known: true,
    estimated_cost_usd: 0.25,
    requires_owner_go: false,
    ...overrides,
  });
}

function makeDirectSOrder(overrides: Partial<ActionOrder> = {}): ActionOrder {
  return actionOrderSchema.parse({
    kind: "direct_api",
    title: "Delete legacy campaign",
    domain: "marketing",
    reason_code: "cpa_spike",
    action_class: "account_destructive",
    server: "mcp-yandex-direct",
    tool: "delete_campaign",
    tariff_known: true,
    estimated_cost_usd: 0,
    requires_owner_go: false,
    ...overrides,
  });
}

describe("Specialist autonomy, owner refusals, and code-forced owner gate (Task 39)", () => {
  it("exports AUTONOMY_CLASSES and forces L, S, and over-cap orders to the gate unless granted on a non-high-risk class", () => {
    expect(AUTONOMY_CLASSES).toEqual(["observe", "propose", "bounded_auto"]);
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.parse("2026-11-10T10:00:00Z");

    upsertCharter(db, {
      projectId: "p1",
      domain: "marketing",
      charter: { budgets: { cell_cap_usd: 5.0, daily_cap_usd: 50 } },
      nowMs: t0,
    });

    expect(autonomyOf(db, "p1", "marketing", "direct_api:cpa_spike", t0)).toBe("propose");

    // 1. L order with requires_owner_go=false from model is forced to the gate
    const lGated = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      slotScope: "slot_l_1",
      modelNeedsOwnerGo: false,
      order: makeDirectLOrder(),
      nowMs: t0,
    });
    expect(lGated.needsOwnerGo).toBe(true);
    expect(lGated.status).toBe("held");
    expect(lGated.dropReason).toBe("owner_go_required");

    const lRow = db.prepare("SELECT order_json FROM lane_pilot_sp_intent WHERE intent_id = ?").get(lGated.intentId) as { order_json: string };
    const lParsed = JSON.parse(lRow.order_json) as Record<string, unknown>;
    expect(lParsed.requires_owner_go).toBe(true);
    expect(lParsed.model_requires_owner_go).toBe(false);

    // 2. Cost > auto cell cap (D order costing $8 > $5 cap) is forced to the gate
    const overCap = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      slotScope: "slot_cap_1",
      modelNeedsOwnerGo: false,
      order: actionOrderSchema.parse({
        kind: "sub_graph",
        title: "Large crawl workflow",
        domain: "marketing",
        reason_code: "cro_friction_fix",
        workflow_id: "mkt-landing-cro-audit",
        tariff_known: true,
        estimated_cost_usd: 8.0,
        requires_owner_go: false,
      }),
      nowMs: t0,
    });
    expect(overCap.needsOwnerGo).toBe(true);
    expect(overCap.status).toBe("held");

    // 3. Grant bounded_auto on non-high-risk class -> L order is no longer gated
    const grantRes = grantAutonomy(
      db,
      { projectId: "p1", domain: "marketing", actionClass: "direct_api:cpa_spike", by: "owner", now: t0 },
      ctx.bb.log,
    );
    expect(grantRes).toMatchObject({ ok: true, autonomyClass: "bounded_auto" });
    expect(autonomyOf(db, "p1", "marketing", "direct_api:cpa_spike", t0)).toBe("bounded_auto");
    expect(logs.some((l) => l.level === "info" && l.message === "sp autonomy granted class=direct_api:cpa_spike by=owner")).toBe(true);

    const lAuto = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      slotScope: "slot_l_2",
      modelNeedsOwnerGo: false,
      order: makeDirectLOrder({
        entity_id: "camp_2",
        target_scope: { scope_type: "campaign", scope_value: "camp_2" },
      }),
      nowMs: t0 + 1000,
    });
    expect(lAuto.needsOwnerGo).toBe(false);
    expect(lAuto.status).toBe("staged");

    // 4. Even with the grant on direct_api:cpa_spike, an S order is ALWAYS gated & never auto-staged
    const sOrder = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      slotScope: "slot_s_1",
      modelNeedsOwnerGo: false,
      order: makeDirectSOrder(),
      nowMs: t0 + 2000,
    });
    expect(sOrder.needsOwnerGo).toBe(true);
    expect(sOrder.status).toBe("dropped");
    expect(sOrder.dropReason).toBe("tier_S_sensitive_forbidden");

    // 5. High-risk class refuses grant and stays gated
    const highRiskGrant = grantAutonomy(
      db,
      { projectId: "p1", domain: "marketing", actionClass: "direct_api:bid_strategy_switch", by: "owner", now: t0 },
      ctx.bb.log,
    );
    expect(highRiskGrant).toEqual({ ok: false, reason: "high_risk_never_auto" });

    const hrOrder = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      slotScope: "slot_hr_1",
      modelNeedsOwnerGo: false,
      order: makeDirectLOrder({ reason_code: "bid_strategy_switch", entity_id: "camp_hr" }),
      nowMs: t0 + 3000,
    });
    expect(hrOrder.needsOwnerGo).toBe(true);
    expect(hrOrder.status).toBe("held");
  });

  it("records owner_go decline reasons as '<reason>: <text>', counts refusals per class, and posts waiting cards for unapproved held L orders", async () => {
    const { db, ctx } = freshHarness();
    const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
    registerSpExecutors({} as never, ctx, {
      action: (key, run) => {
        actions.set(key, run);
      },
    });
    const commitExec = actions.get("sp.commit_memory")!;
    const rt = { ctx, services: {}, pmThreadId: "pm1", projectId: "p1", runId: "run_refusal_1" } as unknown as ChainRuntime;

    // 1. owner_go skipped (ownerAnswer="none") on an L order -> held + owner waiting card posted
    const heldRes = await commitExec(
      {
        runId: "run_refusal_1",
        stepKey: "commit_intents",
        nodeId: "commit_intents",
        node: {
          id: "commit_intents",
          type: "action",
          action: "sp.commit_memory",
          params: {
            phase: "intents",
            domain: "marketing",
            ownerAnswer: "none",
            modelNeedsOwnerGo: [false],
            orders: [makeDirectLOrder()],
          },
          out: [
            { name: "intents", type: "number", required: true },
            { name: "held", type: "number", required: true },
            { name: "dropped", type: "number", required: true },
          ],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: [] } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );
    expect(heldRes.intents).toBe(0);
    expect(heldRes.held).toBe(1);
    expect(listOpenOwnerItems(db, { projectId: "p1", source: "specialist" }).length).toBeGreaterThanOrEqual(1);

    // Held intent can also be declined via decideHeldIntent
    const heldRow = db.prepare("SELECT intent_id FROM lane_pilot_sp_intent WHERE project_id = 'p1' AND status = 'held'").get() as { intent_id: string };
    const dec = decideHeldIntent(db, {
      intentId: heldRow.intent_id,
      decision: "decline",
      reason: "bad_timing",
      text: "wait until Monday",
    });
    expect(dec).toEqual({ ok: true, status: "dropped", dropReason: "bad_timing: wait until Monday" });

    // 2. owner_go decline in sp.commit_memory stores "<reason>: <text>"
    const decRes = await commitExec(
      {
        runId: "run_refusal_2",
        stepKey: "commit_intents",
        nodeId: "commit_intents",
        node: {
          id: "commit_intents",
          type: "action",
          action: "sp.commit_memory",
          params: {
            phase: "intents",
            domain: "marketing",
            ownerAnswer: "decline",
            ownerDeclineReason: "too_costly",
            ownerAnswerText: "CPA above target",
            modelNeedsOwnerGo: [false],
            orders: [makeDirectLOrder({ entity_id: "camp_decline_2" })],
          },
          out: [
            { name: "intents", type: "number", required: true },
            { name: "held", type: "number", required: true },
            { name: "dropped", type: "number", required: true },
            { name: "dropped_json", type: "string", required: true },
          ],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: [] } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );
    expect(decRes.dropped).toBe(1);
    expect(JSON.parse(String(decRes.dropped_json))).toEqual(["too_costly: CPA above target"]);

    const refusalSummary = countRefusalsByActionClass(db, "p1", "marketing");
    expect(refusalSummary["direct_api:cpa_spike"]).toEqual({
      total: 2,
      byReason: { bad_timing: 1, too_costly: 1 },
    });
  });

  it("promotes non-high-risk classes with 20 good outcomes and kappa >= 0.6, never promotes high-risk, and revokes/freezes on critical incident", async () => {
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.parse("2026-11-01T09:00:00Z");

    const seedGoodApprovals = (reasonCode: string, count: number) => {
      for (let i = 0; i < count; i += 1) {
        const res = stageIntent(db, {
          projectId: "p1",
          domain: "marketing",
          sourceGraph: "sp-specialist-tick",
          slotScope: `slot_${reasonCode}_${i}`,
          modelNeedsOwnerGo: false,
          ownerDecision: "approve",
          order: makeDirectLOrder({
            reason_code: reasonCode,
            entity_id: `camp_${reasonCode}_${i}`,
            target_scope: { scope_type: "campaign", scope_value: `camp_${reasonCode}_${i}` },
            forecast: {
              metric: "roas",
              horizon_days: 7,
              lo80: 2.0,
              point: 2.5,
              hi80: 3.0,
              unit: "ratio",
            },
          }),
          nowMs: t0 + i * 1000,
        });
        expect(res.status).toBe("staged");
        recordMeasurement(db, { intentId: res.intentId, measured: 2.6, source: "product_alerts.py", now: t0 + 7 * DAY_MS + i });
      }
    };

    // 20 approvals with good outcomes and modelNeedsOwnerGo=false -> kappa = 1.0 >= 0.6, wilson_lb >= 0.80
    seedGoodApprovals("epk_combinatorics_fix", 20);
    // Same 20 approvals on a high-risk class -> MUST NEVER be a promotion candidate
    seedGoodApprovals("bid_strategy_switch", 20);

    // Run recomputeAutonomy via sp.commit_memory phase="receipt"
    const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
    registerSpExecutors({} as never, ctx, {
      action: (key, run) => {
        actions.set(key, run);
      },
    });
    const receiptExec = actions.get("sp.commit_memory")!;
    await receiptExec(
      {
        runId: "run_receipt_1",
        stepKey: "receipt",
        nodeId: "receipt",
        node: { id: "receipt", type: "action", action: "sp.commit_memory", params: { phase: "receipt", domain: "marketing" }, out: [] },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: [] } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      { ctx, services: {}, pmThreadId: "pm1", projectId: "p1", runId: "run_receipt_1" } as unknown as ChainRuntime,
    );

    const candidates = promotionCandidates(db, { projectId: "p1", domain: "marketing", now: t0 + 8 * DAY_MS });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      project_id: "p1",
      domain: "marketing",
      action_class: "direct_api:epk_combinatorics_fix",
      autonomy_class: "propose",
      samples_n: 20,
      successes_k: 20,
      default_action: "keep propose",
    });
    expect(candidates[0]!.wilson_lb).toBeGreaterThanOrEqual(0.8);
    expect(candidates[0]!.cohen_kappa).toBeGreaterThanOrEqual(0.6);
    expect(logs.some((l) => l.level === "info" && l.message.includes("sp autonomy class=direct_api:epk_combinatorics_fix n=20"))).toBe(true);

    // Grant bounded_auto, then trigger a critical incident (outcome 'below' on an L order)
    const grantAt = t0 + 9 * DAY_MS;
    grantAutonomy(db, { projectId: "p1", domain: "marketing", actionClass: "direct_api:epk_combinatorics_fix", by: "owner", now: grantAt }, ctx.bb.log);
    expect(autonomyOf(db, "p1", "marketing", "direct_api:epk_combinatorics_fix", grantAt)).toBe("bounded_auto");

    const badL = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      slotScope: "slot_bad_l",
      modelNeedsOwnerGo: false,
      order: makeDirectLOrder({
        reason_code: "epk_combinatorics_fix",
        entity_id: "camp_bad_l",
        target_scope: { scope_type: "campaign", scope_value: "camp_bad_l" },
        forecast: { metric: "roas", horizon_days: 7, lo80: 2.0, point: 2.5, hi80: 3.0, unit: "ratio" },
      }),
      nowMs: grantAt + 1000,
    });
    expect(badL.status).toBe("staged");

    const incidentAt = grantAt + 7 * DAY_MS;
    recordMeasurement(db, { intentId: badL.intentId, measured: 0.9, source: "product_alerts.py", now: incidentAt });
    recomputeAutonomy(db, { projectId: "p1", domain: "marketing", now: incidentAt }, ctx.bb.log);

    expect(autonomyOf(db, "p1", "marketing", "direct_api:epk_combinatorics_fix", incidentAt + 1000)).toBe("propose");
    const row = db
      .prepare("SELECT autonomy_class, frozen_until FROM lane_pilot_sp_autonomy WHERE project_id = 'p1' AND domain = 'marketing' AND action_class = 'direct_api:epk_combinatorics_fix'")
      .get() as { autonomy_class: string; frozen_until: number | null };
    expect(row.autonomy_class).toBe("propose");
    expect(row.frozen_until).toBe(incidentAt + 14 * DAY_MS);

    const grantRow = db
      .prepare("SELECT revoked_at, reason FROM lane_pilot_sp_autonomy_grant WHERE project_id = 'p1' AND domain = 'marketing' AND action_class = 'direct_api:epk_combinatorics_fix'")
      .get() as { revoked_at: number | null; reason: string | null };
    expect(grantRow.revoked_at).toBe(incidentAt);
    expect(grantRow.reason).toContain(badL.intentId);
    expect(logs.some((l) => l.level === "warn" && l.message.includes("sp autonomy revoked class=direct_api:epk_combinatorics_fix"))).toBe(true);
    expect(promotionCandidates(db, { projectId: "p1", domain: "marketing", now: incidentAt + DAY_MS })).toEqual([]);

    // Breaker trip also revokes an active bounded_auto class
    grantAutonomy(db, { projectId: "p1", domain: "seo", actionClass: "sub_graph:ai_visibility_gap", by: "owner", now: incidentAt }, ctx.bb.log);
    upsertBreakerState(db, { projectId: "p1", domain: "seo", fired: true, triggerCodes: ["critical_telemetry_trip"], nowMs: incidentAt + 1000 });
    recomputeAutonomy(db, { projectId: "p1", domain: "seo", now: incidentAt + 2000 }, ctx.bb.log);
    expect(autonomyOf(db, "p1", "seo", "sub_graph:ai_visibility_gap", incidentAt + 3000)).toBe("propose");
  });

  it("supports CLI `bb lane-pilot specialist autonomy`, `grant`, and `revoke`, and blocks agent-thread grants", async () => {
    const { harness, db, ctx } = freshHarness();

    grantAutonomy(db, { projectId: "p1", domain: "marketing", actionClass: "code_task:cro_friction_fix", by: "owner" }, ctx.bb.log);
    const listRes = await harness.behavior.runCli(["specialist", "autonomy", "p1", "marketing"]);
    expect(listRes.exitCode).toBe(0);
    expect(listRes.stdout).toContain("code_task:cro_friction_fix");
    expect(listRes.stdout).toContain("bounded_auto");

    const revokeRes = await harness.behavior.runCli([
      "specialist",
      "autonomy",
      "revoke",
      "p1",
      "marketing",
      "code_task:cro_friction_fix",
      "--reason",
      "manual_check",
    ]);
    expect(revokeRes.exitCode).toBe(0);
    expect(autonomyOf(db, "p1", "marketing", "code_task:cro_friction_fix")).toBe("propose");

    // Agent thread cannot grant autonomy
    const agentGrant = await harness.behavior.runCli(
      ["specialist", "autonomy", "grant", "p1", "marketing", "code_task:cro_friction_fix"],
      { threadId: "thr_agent_1" },
    );
    expect(agentGrant.exitCode).toBe(1);
    expect(agentGrant.stderr).toContain("refused");

    // Owner terminal can grant autonomy
    const ownerGrant = await harness.behavior.runCli(["specialist", "autonomy", "grant", "p1", "marketing", "code_task:cro_friction_fix"]);
    expect(ownerGrant.exitCode).toBe(0);
    expect(autonomyOf(db, "p1", "marketing", "code_task:cro_friction_fix")).toBe("bounded_auto");

    // Explicit revoke helper works cleanly
    revokeAutonomy(db, { projectId: "p1", domain: "marketing", actionClass: "code_task:cro_friction_fix", reason: "done" });
    expect(autonomyOf(db, "p1", "marketing", "code_task:cro_friction_fix")).toBe("propose");
  });
});
