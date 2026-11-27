import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { RULE_SCOPES, RULE_STATES } from "@lane-pilot/contracts";
import type { StepContext, Workflow } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { createCore } from "../../src/rooms/core/server/core";
import { openDatabase } from "../../src/rooms/plugin-db";
import { type ActionOrder, actionOrderSchema } from "../../src/rooms/specialist";
import {
  activateSharedRule,
  activeRulesForSnapshot,
  expireOutcomes,
  linkIntent,
  listProposedSharedRules,
  proposeLocalRule,
  proposeSharedRule,
  recordMeasurement,
  registerSpExecutors,
  retireRule,
  settleHypotheses,
  stageIntent,
  upsertCharter,
  upsertHypothesis,
} from "../../src/rooms/specialist/server";

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
  return { bb, harness, db, ctx, logs };
}

function makeOrder(overrides: Partial<ActionOrder> = {}): ActionOrder {
  return actionOrderSchema.parse({
    kind: "sub_graph",
    title: "Test rule order",
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

function seedWorkedHypothesis(
  db: ReturnType<typeof openDatabase>,
  log: ReturnType<typeof createCore>["bb"]["log"],
  input: {
    projectId: string;
    domain?: "marketing" | "seo";
    title: string;
    outcomeCount?: number;
    comparison?: "pre/post" | "holdout";
    nowMs: number;
  },
) {
  const domain = input.domain ?? "marketing";
  const count = input.outcomeCount ?? 1;
  upsertCharter(db, {
    projectId: input.projectId,
    domain,
    charter: { north_star: { metric_id: "net_paid_users_30d", baseline: 400, target: 600 } },
    nowMs: input.nowMs,
  });
  const hyp = upsertHypothesis(
    db,
    { projectId: input.projectId, domain, title: input.title, lever: "core", nowMs: input.nowMs },
    log,
  );
  const intentIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const staged = stageIntent(db, {
      projectId: input.projectId,
      domain,
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({
        domain,
        comparison: input.comparison,
        workflow_id: `wf_${input.projectId}_${Math.random().toString(36).slice(2, 8)}_${i}`,
      }),
      nowMs: input.nowMs + i,
    });
    linkIntent(db, staged.intentId, hyp.id, log);
    recordMeasurement(
      db,
      { intentId: staged.intentId, measured: 520 + i * 5, source: "posthog", now: input.nowMs + 7 * DAY_MS + i },
      log,
    );
    intentIds.push(staged.intentId);
  }
  settleHypotheses(db, { projectId: input.projectId, domain, nowMs: input.nowMs + 8 * DAY_MS }, log);
  return { hypId: hyp.id, intentIds };
}

describe("Specialist learned rules with attribution (Task 37)", () => {
  it("exports RULE_SCOPES/RULE_STATES and enforces project_id NULL iff scope='shared'", async () => {
    expect(RULE_SCOPES).toEqual(["local", "shared"]);
    expect(RULE_STATES).toEqual(["proposed", "active", "retired"]);

    const { db, harness } = freshHarness();
    const now = Date.now();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lane_pilot_sp_rule
            (id, domain, project_id, scope, text, evidence_json, window_json, uncertainty, state, created_at)
           VALUES ('r_bad_shared', 'marketing', 'p1', 'shared', 'bad', '[]', '{}', 'u', 'proposed', ?)`,
        )
        .run(now),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lane_pilot_sp_rule
            (id, domain, project_id, scope, text, evidence_json, window_json, uncertainty, state, created_at)
           VALUES ('r_bad_local', 'marketing', NULL, 'local', 'bad', '[]', '{}', 'u', 'active', ?)`,
        )
        .run(now),
    ).toThrow();
    await harness.lifecycle.dispose();
  });

  it("creates an active local rule from a worked hypothesis with attribution, window, and uncertainty", async () => {
    const { db, ctx, logs, harness } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    const { hypId, intentIds } = seedWorkedHypothesis(db, ctx.bb.log, {
      projectId: "p1",
      title: "Move pricing calculator above fold",
      comparison: "holdout",
      nowMs: t0,
    });

    const res = proposeLocalRule(db, { projectId: "p1", domain: "marketing", hypothesisId: hypId, nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");

    expect(res.rule.scope).toBe("local");
    expect(res.rule.state).toBe("active");
    expect(res.rule.project_id).toBe("p1");
    expect(res.rule.text).toBe("Move pricing calculator above fold");

    const evidence = JSON.parse(res.rule.evidence_json) as Array<{ intent_id: string; verdict: string; measured: number }>;
    expect(evidence).toHaveLength(1);
    expect(evidence[0]?.intent_id).toBe(intentIds[0]);
    expect(evidence[0]?.verdict).toBe("within");
    expect(evidence[0]?.measured).toBe(520);

    const win = JSON.parse(res.rule.window_json) as { comparison: string; measurement_days: number };
    expect(win).toEqual({ comparison: "holdout", measurement_days: 7 });

    expect(res.rule.uncertainty).toContain("450");
    expect(res.rule.uncertainty).toContain("550");
    expect(res.rule.uncertainty).toContain("520");

    expect(logs.some((l) => l.level === "info" && l.message === `sp rule id=${res.id} scope=local state=active`)).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("refuses any rule without measured intent outcome evidence", async () => {
    const { db, ctx, logs, harness } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    // 1. Worked hypothesis with zero linked outcomes
    const noOutcomeHyp = upsertHypothesis(
      db,
      { projectId: "p1", domain: "marketing", title: "Speculative card note", state: "worked", nowMs: t0 },
      ctx.bb.log,
    );
    const r1 = proposeLocalRule(db, { projectId: "p1", domain: "marketing", hypothesisId: noOutcomeHyp.id }, ctx.bb.log);
    expect(r1).toEqual({ ok: false, reason: "no_measured_evidence" });

    // 2. Hypothesis with only expired inconclusive outcome (no measurement)
    const expHyp = upsertHypothesis(
      db,
      { projectId: "p1", domain: "marketing", title: "Unmeasured test", nowMs: t0 },
      ctx.bb.log,
    );
    const staged = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_unmeasured" }),
      nowMs: t0,
    });
    linkIntent(db, staged.intentId, expHyp.id, ctx.bb.log);
    expireOutcomes(db, t0 + 20 * DAY_MS, ctx.bb.log);

    const r2 = proposeLocalRule(db, { projectId: "p1", domain: "marketing", hypothesisId: expHyp.id }, ctx.bb.log);
    expect(r2).toEqual({ ok: false, reason: "no_measured_evidence" });
    expect(logs.some((l) => l.level === "warn" && l.message === "sp rule refused: no_measured_evidence")).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("requires >= 2 projects each with >= 2 favourable outcomes for shared rules, and owner approval to activate", async () => {
    const { db, ctx, logs, harness } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    // Project 1 has 2 favourable outcomes
    const s1 = seedWorkedHypothesis(db, ctx.bb.log, {
      projectId: "p1",
      title: "Show live price breakdown on checkout",
      outcomeCount: 2,
      nowMs: t0,
    });
    const rP1 = proposeLocalRule(db, { projectId: "p1", domain: "marketing", hypothesisId: s1.hypId, nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    if (!rP1.ok) throw new Error("expected rP1 ok");

    // Single project refused
    expect(proposeSharedRule(db, { domain: "marketing", ruleIds: [rP1.id] }, ctx.bb.log)).toMatchObject({
      ok: false,
      reason: "insufficient_projects",
    });

    // Project 2 with only 1 favourable outcome -> refused
    const s2One = seedWorkedHypothesis(db, ctx.bb.log, {
      projectId: "p2",
      title: "Show live price breakdown on checkout.",
      outcomeCount: 1,
      nowMs: t0,
    });
    const rP2One = proposeLocalRule(db, { projectId: "p2", domain: "marketing", hypothesisId: s2One.hypId, nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    if (!rP2One.ok) throw new Error("expected rP2One ok");

    expect(proposeSharedRule(db, { domain: "marketing", ruleIds: [rP1.id, rP2One.id] }, ctx.bb.log)).toMatchObject({
      ok: false,
      reason: "insufficient_favourable_outcomes",
    });

    // Project 3 with different normalized text -> refused
    const s3Diff = seedWorkedHypothesis(db, ctx.bb.log, {
      projectId: "p3",
      title: "Completely different lesson",
      outcomeCount: 2,
      nowMs: t0,
    });
    const rP3Diff = proposeLocalRule(db, { projectId: "p3", domain: "marketing", hypothesisId: s3Diff.hypId, nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    if (!rP3Diff.ok) throw new Error("expected rP3Diff ok");
    expect(proposeSharedRule(db, { domain: "marketing", ruleIds: [rP1.id, rP3Diff.id] }, ctx.bb.log)).toMatchObject({
      ok: false,
      reason: "text_mismatch",
    });

    // Project 4 with matching normalized text and 2 favourable outcomes -> shared rule proposed
    const s4 = seedWorkedHypothesis(db, ctx.bb.log, {
      projectId: "p4",
      title: "  show live   price breakdown on checkout ",
      outcomeCount: 2,
      nowMs: t0,
    });
    const rP4 = proposeLocalRule(db, { projectId: "p4", domain: "marketing", hypothesisId: s4.hypId, nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    if (!rP4.ok) throw new Error("expected rP4 ok");

    const shared = proposeSharedRule(db, { domain: "marketing", ruleIds: [rP1.id, rP4.id], nowMs: t0 + 9 * DAY_MS }, ctx.bb.log);
    expect(shared.ok).toBe(true);
    if (!shared.ok) throw new Error("expected shared ok");

    expect(shared.rule.scope).toBe("shared");
    expect(shared.rule.project_id).toBeNull();
    expect(shared.rule.state).toBe("proposed");
    expect(listProposedSharedRules(db, "marketing").map((r) => r.id)).toContain(shared.id);
    expect(logs.some((l) => l.level === "info" && l.message === `sp rule id=${shared.id} scope=shared state=proposed`)).toBe(true);

    // Proposed rule is NOT yet in snapshot
    expect(activeRulesForSnapshot(db, { projectId: "p99", domain: "marketing" })).toEqual([]);

    // Non-owner cannot activate shared rule
    const denied = activateSharedRule(db, shared.id, "specialist", { nowMs: t0 + 10 * DAY_MS, log: ctx.bb.log });
    expect(denied).toEqual({ ok: false, reason: "owner_required" });
    expect(logs.some((l) => l.level === "warn" && l.message === "sp rule refused: owner_required")).toBe(true);

    // Owner activates shared rule -> visible across projects in domain
    const activated = activateSharedRule(db, shared.id, "owner", { nowMs: t0 + 10 * DAY_MS, log: ctx.bb.log });
    expect(activated.ok).toBe(true);
    if (!activated.ok) throw new Error("expected activated ok");
    expect(activated.rule.state).toBe("active");
    expect(activated.rule.decided_at).toBe(t0 + 10 * DAY_MS);
    expect(logs.some((l) => l.level === "info" && l.message === `sp rule id=${shared.id} scope=shared state=active`)).toBe(true);

    const p99Rules = activeRulesForSnapshot(db, { projectId: "p99", domain: "marketing" });
    expect(p99Rules.map((r) => r.id)).toEqual([shared.id]);
    expect(activeRulesForSnapshot(db, { projectId: "p99", domain: "seo" })).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("retires an active rule only after two contradicting later outcomes", async () => {
    const { db, ctx, logs, harness } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    const { hypId } = seedWorkedHypothesis(db, ctx.bb.log, {
      projectId: "p1",
      title: "Sticky CTA bar on mobile",
      nowMs: t0,
    });
    const ruleRes = proposeLocalRule(db, { projectId: "p1", domain: "marketing", hypothesisId: hypId, nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    if (!ruleRes.ok) throw new Error("expected ruleRes ok");

    // 1st contradicting outcome -> not yet retired
    const bad1 = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_bad_1" }),
      nowMs: t0 + 9 * DAY_MS,
    });
    linkIntent(db, bad1.intentId, hypId, ctx.bb.log);
    recordMeasurement(db, { intentId: bad1.intentId, measured: 320, source: "posthog", now: t0 + 16 * DAY_MS }, ctx.bb.log);

    const firstTry = retireRule(db, { ruleId: ruleRes.id, nowMs: t0 + 16 * DAY_MS }, ctx.bb.log);
    expect(firstTry).toEqual({ ok: false, reason: "insufficient_contradictions", contradictions: 1 });
    expect(activeRulesForSnapshot(db, { projectId: "p1", domain: "marketing" }).map((r) => r.id)).toContain(ruleRes.id);

    // 2nd contradicting outcome -> retired
    const bad2 = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_bad_2" }),
      nowMs: t0 + 17 * DAY_MS,
    });
    linkIntent(db, bad2.intentId, hypId, ctx.bb.log);
    recordMeasurement(db, { intentId: bad2.intentId, measured: 310, source: "posthog", now: t0 + 24 * DAY_MS }, ctx.bb.log);

    const retired = retireRule(db, { ruleId: ruleRes.id, nowMs: t0 + 24 * DAY_MS }, ctx.bb.log);
    expect(retired.ok).toBe(true);
    if (!retired.ok) throw new Error("expected retired ok");
    expect(retired.rule.state).toBe("retired");
    expect(retired.rule.decided_at).toBe(t0 + 24 * DAY_MS);
    expect(activeRulesForSnapshot(db, { projectId: "p1", domain: "marketing" })).toEqual([]);
    expect(logs.some((l) => l.level === "info" && l.message === `sp rule id=${ruleRes.id} scope=local state=retired`)).toBe(true);
    await harness.lifecycle.dispose();
  });

  it("caps sp.load_memory rules_json at 15 newest active local + shared rules for the project/domain", async () => {
    const { db, ctx, harness } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    // 1 shared active rule (domain marketing)
    const sA = seedWorkedHypothesis(db, ctx.bb.log, { projectId: "pA", title: "Shared rule", outcomeCount: 2, nowMs: t0 });
    const sB = seedWorkedHypothesis(db, ctx.bb.log, { projectId: "pB", title: "Shared rule", outcomeCount: 2, nowMs: t0 });
    const lA = proposeLocalRule(db, { projectId: "pA", domain: "marketing", hypothesisId: sA.hypId, nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    const lB = proposeLocalRule(db, { projectId: "pB", domain: "marketing", hypothesisId: sB.hypId, nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    if (!lA.ok || !lB.ok) throw new Error("expected local rules");
    const shared = proposeSharedRule(db, { domain: "marketing", ruleIds: [lA.id, lB.id], nowMs: t0 + 9 * DAY_MS }, ctx.bb.log);
    if (!shared.ok) throw new Error("expected shared");
    activateSharedRule(db, shared.id, "owner", { nowMs: t0 + 9 * DAY_MS + 1, log: ctx.bb.log });

    // 16 local active rules on p1 (plus 1 on another project pOther, 1 on another domain seo)
    for (let i = 0; i < 16; i++) {
      const s = seedWorkedHypothesis(db, ctx.bb.log, {
        projectId: "p1",
        title: `Local marketing rule #${i}`,
        nowMs: t0 + 10 * DAY_MS + i * 1000,
      });
      proposeLocalRule(db, { projectId: "p1", domain: "marketing", hypothesisId: s.hypId, nowMs: t0 + 20 * DAY_MS + i * 1000 }, ctx.bb.log);
    }
    const otherProj = seedWorkedHypothesis(db, ctx.bb.log, { projectId: "pOther", title: "Other project rule", nowMs: t0 + 50 * DAY_MS });
    proposeLocalRule(db, { projectId: "pOther", domain: "marketing", hypothesisId: otherProj.hypId, nowMs: t0 + 60 * DAY_MS }, ctx.bb.log);
    const otherDom = seedWorkedHypothesis(db, ctx.bb.log, { projectId: "p1", domain: "seo", title: "SEO domain rule", nowMs: t0 + 50 * DAY_MS });
    proposeLocalRule(db, { projectId: "p1", domain: "seo", hypothesisId: otherDom.hypId, nowMs: t0 + 60 * DAY_MS }, ctx.bb.log);

    const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
    registerSpExecutors({} as never, ctx, {
      action: (key, run) => {
        actions.set(key, run);
      },
    });
    const loadExec = actions.get("sp.load_memory")!;
    const rt = { ctx, services: {}, pmThreadId: "pm1", projectId: "p1", runId: "run_rules_1" } as unknown as ChainRuntime;

    const loaded = await loadExec(
      {
        runId: "run_rules_1",
        stepKey: "load_state",
        nodeId: "load_state",
        node: {
          id: "load_state",
          type: "action",
          action: "sp.load_memory",
          params: { domain: "marketing" },
          out: [{ name: "rules_json", type: "string", required: true }],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: [] } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );

    const rules = JSON.parse(String(loaded.rules_json)) as Array<{ text: string; scope: string; project_id: string | null; created_at: number }>;
    expect(rules).toHaveLength(15);
    expect(rules[0]?.text).toBe("Local marketing rule #15");
    expect(rules[14]?.text).toBe("Local marketing rule #1");
    expect(rules.every((r) => r.project_id === "p1" || r.scope === "shared")).toBe(true);
    expect(rules.some((r) => r.text === "Other project rule" || r.text === "SEO domain rule")).toBe(false);
    // Ordered newest first
    for (let i = 1; i < rules.length; i++) {
      expect(rules[i - 1]!.created_at >= rules[i]!.created_at).toBe(true);
    }
    await harness.lifecycle.dispose();
  });
});
