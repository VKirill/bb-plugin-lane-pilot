import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { HYPOTHESIS_STATES_SP } from "@lane-pilot/contracts";
import type { StepContext, Workflow } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { createCore } from "../../src/rooms/core/server/core";
import { openDatabase } from "../../src/rooms/plugin-db";
import { type ActionOrder, actionOrderSchema } from "../../src/rooms/specialist";
import {
  expireOutcomes,
  hypothesisTreeSnapshot,
  linkIntent,
  recordMeasurement,
  registerSpExecutors,
  settleHypotheses,
  stageIntent,
  triedAlready,
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
    title: "Test hypothesis order",
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

describe("Specialist hypothesis tree and tried-already snapshot (Task 36)", () => {
  it("exports HYPOTHESIS_STATES_SP and transitions open -> testing on linkIntent, refusing invalid links", () => {
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    expect(HYPOTHESIS_STATES_SP).toEqual(["open", "testing", "worked", "refuted", "dropped"]);

    const root = upsertHypothesis(
      db,
      { projectId: "p1", domain: "marketing", title: "Activation funnel lift", lever: "core", nowMs: t0 },
      ctx.bb.log,
    );
    const child = upsertHypothesis(
      db,
      { projectId: "p1", domain: "marketing", parentId: root.id, title: "Simplify onboarding step 2", lever: "adjacent", nowMs: t0 + 10 },
      ctx.bb.log,
    );
    expect(child.state).toBe("open");
    expect(child.parent_id).toBe(root.id);

    const staged = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "mkt-landing-cro-audit" }),
      nowMs: t0,
    });
    const linked = linkIntent(db, staged.intentId, child.id, ctx.bb.log);
    expect(linked).toEqual({ ok: true, hypothesisId: child.id, state: "testing" });
    expect(
      logs.some((l) => l.level === "info" && l.message === `sp hypothesis id=${child.id} state=open→testing`),
    ).toBe(true);

    const outcomeRow = db
      .prepare("SELECT hypothesis_id FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?")
      .get(staged.intentId) as { hypothesis_id: string | null };
    expect(outcomeRow.hypothesis_id).toBe(child.id);

    // Refusal cases log WARN
    expect(linkIntent(db, "int_missing", child.id, ctx.bb.log)).toMatchObject({ ok: false, reason: "unknown_outcome" });
    expect(linkIntent(db, staged.intentId, "hyp_missing", ctx.bb.log)).toMatchObject({ ok: false, reason: "unknown_hypothesis" });

    const droppedHyp = upsertHypothesis(
      db,
      { projectId: "p1", domain: "marketing", title: "Dropped idea", state: "dropped", nowMs: t0 },
      ctx.bb.log,
    );
    expect(linkIntent(db, staged.intentId, droppedHyp.id, ctx.bb.log)).toMatchObject({ ok: false, reason: "hypothesis_dropped" });

    const otherRoot = upsertHypothesis(
      db,
      { projectId: "p1", domain: "marketing", title: "Another open hyp", nowMs: t0 },
      ctx.bb.log,
    );
    expect(linkIntent(db, staged.intentId, otherRoot.id, ctx.bb.log)).toMatchObject({ ok: false, reason: "already_linked" });
    expect(logs.some((l) => l.level === "warn" && l.message.includes("sp hypothesis link refused intent="))).toBe(true);
  });

  it("refutes after two unfavourable outcomes, marks worked on one favourable, and keeps testing on inconclusive or mixed", () => {
    const { db, ctx, logs } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    // Charter North Star direction: up (baseline 400 -> target 600)
    upsertCharter(db, {
      projectId: "p1",
      domain: "marketing",
      charter: { north_star: { metric_id: "net_paid_users_30d", baseline: 400, target: 600 } },
      nowMs: t0,
    });

    // 1. Two unfavourable ("below" when direction is "up") -> refuted
    const hypRefute = upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: "Add exit popup", nowMs: t0 }, ctx.bb.log);
    for (let i = 0; i < 2; i++) {
      const s = stageIntent(db, {
        projectId: "p1",
        domain: "marketing",
        sourceGraph: "sp-specialist-tick",
        order: makeOrder({ workflow_id: `wf_ref_${i}` }),
        nowMs: t0 + i,
      });
      linkIntent(db, s.intentId, hypRefute.id, ctx.bb.log);
      recordMeasurement(db, { intentId: s.intentId, measured: 350, source: "posthog", now: t0 + 7 * DAY_MS + i }, ctx.bb.log);
    }

    // 2. One favourable ("within" or "above" when direction is "up") and none unfavourable -> worked
    const hypWork = upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: "Move pricing calculator above fold", nowMs: t0 }, ctx.bb.log);
    const sWork = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_work_1" }),
      nowMs: t0,
    });
    linkIntent(db, sWork.intentId, hypWork.id, ctx.bb.log);
    recordMeasurement(db, { intentId: sWork.intentId, measured: 520, source: "posthog", now: t0 + 7 * DAY_MS }, ctx.bb.log);

    // 3. Two inconclusive outcomes -> stays testing
    const hypInc = upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: "Dark mode landing test", nowMs: t0 }, ctx.bb.log);
    for (let i = 0; i < 2; i++) {
      const s = stageIntent(db, {
        projectId: "p1",
        domain: "marketing",
        sourceGraph: "sp-specialist-tick",
        order: makeOrder({ workflow_id: `wf_inc_${i}` }),
        nowMs: t0 + i,
      });
      linkIntent(db, s.intentId, hypInc.id, ctx.bb.log);
    }
    expireOutcomes(db, t0 + 14 * DAY_MS, ctx.bb.log);

    // 4. One favourable + one unfavourable -> stays testing (not worked because unfavourable != 0, not refuted because unfavourable < 2)
    const hypMixed = upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: "Video hero banner", nowMs: t0 }, ctx.bb.log);
    const sMix1 = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_mix_1" }),
      nowMs: t0,
    });
    const sMix2 = stageIntent(db, {
      projectId: "p1",
      domain: "marketing",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({ workflow_id: "wf_mix_2" }),
      nowMs: t0 + 1,
    });
    linkIntent(db, sMix1.intentId, hypMixed.id, ctx.bb.log);
    linkIntent(db, sMix2.intentId, hypMixed.id, ctx.bb.log);
    recordMeasurement(db, { intentId: sMix1.intentId, measured: 590, source: "posthog", now: t0 + 7 * DAY_MS }, ctx.bb.log);
    recordMeasurement(db, { intentId: sMix2.intentId, measured: 310, source: "posthog", now: t0 + 7 * DAY_MS }, ctx.bb.log);

    const res = settleHypotheses(db, { projectId: "p1", domain: "marketing", nowMs: t0 + 15 * DAY_MS }, ctx.bb.log);
    expect(res.workedCount).toBe(1);
    expect(res.refutedCount).toBe(1);

    const getState = (id: string) =>
      (db.prepare("SELECT state FROM lane_pilot_sp_hypothesis WHERE id = ?").get(id) as { state: string }).state;
    expect(getState(hypRefute.id)).toBe("refuted");
    expect(getState(hypWork.id)).toBe("worked");
    expect(getState(hypInc.id)).toBe("testing");
    expect(getState(hypMixed.id)).toBe("testing");

    expect(logs.some((l) => l.level === "info" && l.message === `sp hypothesis id=${hypRefute.id} state=testing→refuted`)).toBe(true);
    expect(logs.some((l) => l.level === "info" && l.message === `sp hypothesis id=${hypWork.id} state=testing→worked`)).toBe(true);
  });

  it("uses charter North Star downward direction so below is favourable and above is unfavourable", () => {
    const { db, ctx } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    upsertCharter(db, {
      projectId: "p1",
      domain: "seo",
      charter: { north_star: { metric_id: "cac_eur", direction: "down", baseline: 50, target: 30 } },
      nowMs: t0,
    });

    const hypGood = upsertHypothesis(db, { projectId: "p1", domain: "seo", title: "BOFU comparison pages", nowMs: t0 }, ctx.bb.log);
    const sGood = stageIntent(db, {
      projectId: "p1",
      domain: "seo",
      sourceGraph: "sp-specialist-tick",
      order: makeOrder({
        domain: "seo",
        workflow_id: "wf_seo_good",
        forecast: { metric: "cac_eur", horizon_days: 7, lo80: 32, point: 35, hi80: 38, unit: "eur" },
      }),
      nowMs: t0,
    });
    linkIntent(db, sGood.intentId, hypGood.id, ctx.bb.log);
    recordMeasurement(db, { intentId: sGood.intentId, measured: 24, source: "billing", now: t0 + 7 * DAY_MS }, ctx.bb.log);

    const hypBad = upsertHypothesis(db, { projectId: "p1", domain: "seo", title: "Generic blog glossary", nowMs: t0 }, ctx.bb.log);
    for (let i = 0; i < 2; i++) {
      const sBad = stageIntent(db, {
        projectId: "p1",
        domain: "seo",
        sourceGraph: "sp-specialist-tick",
        order: makeOrder({
          domain: "seo",
          workflow_id: `wf_seo_bad_${i}`,
          forecast: { metric: "cac_eur", horizon_days: 7, lo80: 32, point: 35, hi80: 38, unit: "eur" },
        }),
        nowMs: t0 + i,
      });
      linkIntent(db, sBad.intentId, hypBad.id, ctx.bb.log);
      recordMeasurement(db, { intentId: sBad.intentId, measured: 60, source: "billing", now: t0 + 7 * DAY_MS + i }, ctx.bb.log);
    }

    settleHypotheses(db, { projectId: "p1", domain: "seo", nowMs: t0 + 8 * DAY_MS }, ctx.bb.log);
    const getState = (id: string) =>
      (db.prepare("SELECT state FROM lane_pilot_sp_hypothesis WHERE id = ?").get(id) as { state: string }).state;
    expect(getState(hypGood.id)).toBe("worked");
    expect(getState(hypBad.id)).toBe("refuted");
  });

  it("caps triedAlready (refuted + dropped) and hypothesisTreeSnapshot (open + testing) at 30", () => {
    const { db } = freshHarness();
    const t0 = Date.parse("2026-11-01T00:00:00Z");

    for (let i = 0; i < 20; i++) {
      upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: `Refuted #${i}`, state: "refuted", nowMs: t0 + i });
    }
    for (let i = 0; i < 15; i++) {
      upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: `Dropped #${i}`, state: "dropped", nowMs: t0 + 20 + i });
    }
    for (let i = 0; i < 20; i++) {
      upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: `Open #${i}`, state: "open", nowMs: t0 + 40 + i });
    }
    for (let i = 0; i < 15; i++) {
      upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: `Testing #${i}`, state: "testing", nowMs: t0 + 60 + i });
    }
    upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: "Worked #1", state: "worked", nowMs: t0 + 99 });

    const tried = triedAlready(db, { projectId: "p1", domain: "marketing" });
    expect(tried).toHaveLength(30);
    expect(tried.every((t) => t.startsWith("Refuted #") || t.startsWith("Dropped #"))).toBe(true);

    const tree = hypothesisTreeSnapshot(db, { projectId: "p1", domain: "marketing" });
    expect(tree).toHaveLength(30);
    expect(tree.every((n) => n.state === "open" || n.state === "testing")).toBe(true);
  });

  it("wires sp.commit_memory (create/link + receipt settle) and sp.load_memory (hypothesis_tree_json + tried_already_json)", async () => {
    const { db, ctx } = freshHarness();
    const t0 = Date.now() - 8 * DAY_MS;

    upsertCharter(db, {
      projectId: "p1",
      domain: "marketing",
      charter: { north_star: { metric_id: "net_paid_users_30d", baseline: 400, target: 600 } },
      nowMs: t0,
    });
    upsertHypothesis(db, { projectId: "p1", domain: "marketing", title: "Dead end popup", state: "dropped", nowMs: t0 });

    const actions = new Map<string, (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Record<string, unknown>>>();
    registerSpExecutors({} as never, ctx, {
      action: (key, run) => {
        actions.set(key, run);
      },
    });
    const rt = { ctx, services: {}, pmThreadId: "pm1", projectId: "p1", runId: "run_h1" } as unknown as ChainRuntime;

    const commitExec = actions.get("sp.commit_memory")!;
    const wfNodes = [
      { id: "collect_mkt", type: "action", action: "sp.run_script", params: {}, out: [] },
    ] as unknown as Workflow["nodes"];

    // 1. commit_memory creates new_hypothesis and links staged intent
    await commitExec(
      {
        runId: "run_h1",
        stepKey: "commit_intents",
        nodeId: "commit_intents",
        node: {
          id: "commit_intents",
          type: "action",
          action: "sp.commit_memory",
          params: {
            phase: "intents",
            domain: "marketing",
            orders: [
              {
                kind: "sub_graph",
                title: "Test new onboarding checklist",
                reason_code: "cro_friction_fix",
                workflow_id: "mkt-landing-cro-audit",
                new_hypothesis: { title: "Checklist boosts paid activation", lever: "core" },
                forecast: { metric: "net_paid_users_30d", horizon_days: 7, lo80: 450, point: 510, hi80: 560, unit: "users" },
              },
            ],
          },
          out: [{ name: "intents", type: "number", required: true }],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: wfNodes } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );

    const hypRow = db
      .prepare("SELECT * FROM lane_pilot_sp_hypothesis WHERE project_id = ? AND title = ?")
      .get("p1", "Checklist boosts paid activation") as { id: string; state: string; lever: string };
    expect(hypRow.state).toBe("testing");
    expect(hypRow.lever).toBe("core");

    const loadExec = actions.get("sp.load_memory")!;
    const loadedBefore = await loadExec(
      {
        runId: "run_h2",
        stepKey: "load_state",
        nodeId: "load_state",
        node: {
          id: "load_state",
          type: "action",
          action: "sp.load_memory",
          params: { domain: "marketing" },
          out: [
            { name: "hypothesis_tree_json", type: "string", required: true },
            { name: "tried_already_json", type: "string", required: true },
          ],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: [] } as unknown as Workflow,
        template: (v: unknown) => v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );

    const treeBefore = JSON.parse(String(loadedBefore.hypothesis_tree_json)) as Array<{
      id: string;
      title: string;
      state: string;
      last_verdict: string | null;
    }>;
    expect(treeBefore).toEqual([
      {
        id: hypRow.id,
        parent_id: null,
        title: "Checklist boosts paid activation",
        lever: "core",
        state: "testing",
        last_verdict: "pending",
      },
    ]);
    expect(JSON.parse(String(loadedBefore.tried_already_json))).toEqual(["Dead end popup"]);

    // 2. receipt records measurement from script node and settles hypothesis to worked
    const linkedOutcome = db
      .prepare("SELECT intent_id FROM lane_pilot_sp_intent_outcome WHERE hypothesis_id = ?")
      .get(hypRow.id) as { intent_id: string };

    await commitExec(
      {
        runId: "run_h2",
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
          out: [{ name: "measurements_recorded", type: "number", required: true }],
        },
        workflow: { id: "sp-specialist-tick", version: 1, name: { en: "Tick", ru: "Tick" }, nodes: wfNodes } as unknown as Workflow,
        template: (v: unknown) =>
          v === "{{collect_mkt.measurements_json}}"
            ? JSON.stringify([{ intent_id: linkedOutcome.intent_id, measured: 525, source: "product_alerts.py" }])
            : v,
      } as unknown as StepContext<ChainRuntime>,
      rt,
    );

    const hypAfter = db
      .prepare("SELECT state FROM lane_pilot_sp_hypothesis WHERE id = ?")
      .get(hypRow.id) as { state: string };
    expect(hypAfter.state).toBe("worked");
  });
});
