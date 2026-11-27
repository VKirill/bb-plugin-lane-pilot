import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { KILL_CRITERIA, LOOP_NAMES } from "@lane-pilot/contracts";
import { createDraftStore } from "@lane-pilot/workflow-engine";
import { openDatabase, saveProjectSetting, type LanePilotDatabase } from "../../src/rooms/plugin-db";
import {
  closeTrial,
  openTrial,
  queueHypothesis,
  setHypothesisState,
} from "../../src/rooms/evolve/server";
import { loopHealth } from "../../src/rooms/reports/server";
import { actionOrderSchema } from "../../src/rooms/specialist";
import {
  expireOutcomes,
  recordMeasurement,
  stageIntent,
} from "../../src/rooms/specialist/server";
import { LOOPS_MODE_KEY } from "../../src/rooms/reports/settings";

const DAY_MS = 86_400_000;

function freshDb() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  return { bb, db };
}

function seedDraft(
  db: LanePilotDatabase,
  opts: {
    source: "path-capture" | "branch-capture" | "project-template";
    workflowId: string;
    at: number;
    published?: boolean;
    publishedAt?: number;
  },
) {
  const store = createDraftStore(db, () => opts.at);
  const draft = store.create({
    projectId: "proj-health",
    threadId: null,
    scope: "project",
    name: opts.workflowId,
    description: `${opts.source} ${opts.workflowId}`,
    workflowId: opts.workflowId,
    metadata: { source: opts.source },
  });
  if (opts.published) {
    const pubAt = opts.publishedAt ?? opts.at;
    const pubStore = createDraftStore(db, () => pubAt);
    pubStore.markPublished(draft.id, {
      version: draft.version,
      path: `/tmp/${opts.workflowId}.json`,
      sha256: `sha-${opts.workflowId}`,
      workflowVersion: 1,
    });
  }
  return draft;
}

function seedWfRun(
  db: LanePilotDatabase,
  opts: { id: string; workflowId: string; createdAt: number },
) {
  db.prepare(
    `INSERT INTO lane_pilot_wf_run
       (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, created_at, updated_at)
     VALUES (?, ?, 1, 'sha', '{}', 'proj-health', 'succeeded', ?, ?)`,
  ).run(opts.id, opts.workflowId, opts.createdAt, opts.createdAt);
}

function makeOrder(workflowId: string, horizonDays = 7) {
  return actionOrderSchema.parse({
    kind: "sub_graph",
    title: `Order ${workflowId}`,
    domain: "seo",
    reason_code: "seo_link_fix",
    action_class: "analysis_propose",
    workflow_id: workflowId,
    is_stop_or_kill: false,
    requires_owner_go: false,
    tariff_known: true,
    estimated_cost_usd: 0.1,
    forecast: {
      metric: "clicks",
      horizon_days: horizonDays,
      lo80: 100,
      point: 120,
      hi80: 150,
      unit: "clicks",
    },
  });
}

describe("loopHealth and KILL_CRITERIA (Task 49)", () => {
  it("exports M19 KILL_CRITERIA for all 5 loops and returns healthy on empty DB", () => {
    expect(KILL_CRITERIA.discovery.minAcceptedOfLast).toBe(1);
    expect(KILL_CRITERIA.discovery.lastDraftsWindow).toBe(3);
    expect(KILL_CRITERIA.discovery.minRunsIn30Days).toBe(3);
    expect(KILL_CRITERIA.branches.minAcceptedOfLast).toBe(1);
    expect(KILL_CRITERIA.evolve.windowWeeks).toBe(4);
    expect(KILL_CRITERIA.evolve.minProposedWithoutWin).toBe(3);
    expect(KILL_CRITERIA.evolve.minRollbacksIn30Days).toBe(2);
    expect(KILL_CRITERIA.employee.minConclusiveShare8w).toBe(0.5);
    expect(KILL_CRITERIA.templates.minAcceptedOfLast).toBe(1);

    const { db } = freshDb();
    const now = Date.parse("2026-11-26T12:00:00Z");
    const debugLogs: string[] = [];
    const rows = loopHealth(db, { now, log: (m) => debugLogs.push(m) });

    expect(rows.map((r) => r.loop)).toEqual([...LOOP_NAMES]);
    expect(rows.every((r) => !r.failing)).toBe(true);
    expect(rows.every((r) => r.mode === "on")).toBe(true);
    expect(debugLogs).toHaveLength(LOOP_NAMES.length);
    expect(debugLogs[0]).toMatch(/^loop health loop=discovery failing=false metric=/);
  });

  it("marks discovery failing when 0 of the last 3 path drafts are accepted (abandoned > 14d)", () => {
    const { db } = freshDb();
    const now = Date.parse("2026-11-26T12:00:00Z");

    // 1 older accepted draft + 3 newer abandoned (> 14d) drafts -> last 3 have 0 accepted.
    const oldPubAt = now - 50 * DAY_MS;
    seedDraft(db, { source: "path-capture", workflowId: "path-old", at: oldPubAt, published: true, publishedAt: oldPubAt });
    for (let i = 0; i < 3; i += 1) {
      seedWfRun(db, { id: `run_old_${i}`, workflowId: "path-old", createdAt: oldPubAt + (i + 1) * DAY_MS });
    }
    for (let i = 0; i < 3; i += 1) {
      seedDraft(db, { source: "path-capture", workflowId: `path-abandoned-${i}`, at: now - (20 - i) * DAY_MS });
    }

    const rows = loopHealth(db, { now });
    const discovery = rows.find((r) => r.loop === "discovery")!;
    expect(discovery.failing).toBe(true);
    expect(discovery.metric).toBe(0);
    expect(discovery.threshold).toBe(1);
    expect(discovery.evidence.reason).toBe("low_draft_acceptance");
  });

  it("marks discovery failing when a published path graph ran < 3 times in 30 days after publication", () => {
    const { db } = freshDb();
    const now = Date.parse("2026-11-26T12:00:00Z");
    const pubAt = now - 35 * DAY_MS;

    seedDraft(db, { source: "path-capture", workflowId: "path-rare", at: pubAt - DAY_MS, published: true, publishedAt: pubAt });
    seedWfRun(db, { id: "run_rare_1", workflowId: "path-rare", createdAt: pubAt + 2 * DAY_MS });
    seedWfRun(db, { id: "run_rare_2", workflowId: "path-rare", createdAt: pubAt + 10 * DAY_MS });

    const discovery = loopHealth(db, { now }).find((r) => r.loop === "discovery")!;
    expect(discovery.failing).toBe(true);
    expect(discovery.metric).toBe(2);
    expect(discovery.threshold).toBe(3);
    expect(discovery.evidence.reason).toBe("low_post_publish_runs");
  });

  it("marks branches and templates failing when 0 of last 3 drafts are accepted, ignoring pending drafts <= 14d", () => {
    const { db } = freshDb();
    const now = Date.parse("2026-11-26T12:00:00Z");

    // 3 abandoned branch drafts -> failing.
    for (let i = 0; i < 3; i += 1) {
      seedDraft(db, { source: "branch-capture", workflowId: `branch-ab-${i}`, at: now - (16 + i) * DAY_MS });
    }
    // Only 2 abandoned template drafts + 1 recent pending (5d old) -> not yet 3 settled, so NOT failing.
    seedDraft(db, { source: "project-template", workflowId: "tpl-ab-1", at: now - 16 * DAY_MS });
    seedDraft(db, { source: "project-template", workflowId: "tpl-ab-2", at: now - 17 * DAY_MS });
    seedDraft(db, { source: "project-template", workflowId: "tpl-pending", at: now - 5 * DAY_MS });

    const rows = loopHealth(db, { now });
    const branches = rows.find((r) => r.loop === "branches")!;
    const templates = rows.find((r) => r.loop === "templates")!;

    expect(branches.failing).toBe(true);
    expect(branches.metric).toBe(0);
    expect(templates.failing).toBe(false);

    // Add a 3rd abandoned template draft -> templates now fails.
    seedDraft(db, { source: "project-template", workflowId: "tpl-ab-3", at: now - 18 * DAY_MS });
    const templatesAfter = loopHealth(db, { now }).find((r) => r.loop === "templates")!;
    expect(templatesAfter.failing).toBe(true);
    expect(templatesAfter.metric).toBe(0);
  });

  it("marks evolve failing with >= 2 rollbacks in 30 days (canary + post-promotion)", () => {
    const { db } = freshDb();
    const now = Date.parse("2026-11-26T12:00:00Z");

    const h1 = queueHypothesis(db, {
      workflowId: "wf-a",
      nodeId: "n1",
      armKind: "model",
      variant: { model: "m1" },
      graphVersion: 1,
      source: "census",
      now: now - 10 * DAY_MS,
    });
    expect(h1.ok).toBe(true);
    if (!h1.ok) throw new Error("unexpected");
    const t1 = openTrial(db, {
      hypothesisId: h1.hypothesis.id,
      workflowId: "wf-a",
      baselineVersion: 1,
      candidateDraftId: "d1",
      now: now - 9 * DAY_MS,
    });
    closeTrial(db, { trialId: t1.trialId, state: "rolled_back", reason: "canary_reject", now: now - 5 * DAY_MS });

    const h2 = queueHypothesis(db, {
      workflowId: "wf-b",
      nodeId: "n2",
      armKind: "model",
      variant: { model: "m2" },
      graphVersion: 1,
      source: "census",
      now: now - 8 * DAY_MS,
    });
    expect(h2.ok).toBe(true);
    if (!h2.ok) throw new Error("unexpected");
    setHypothesisState(db, {
      id: h2.hypothesis.id,
      state: "retired",
      reason: "post_promotion_reject",
      now: now - 3 * DAY_MS,
    });

    const evolve = loopHealth(db, { now }).find((r) => r.loop === "evolve")!;
    expect(evolve.failing).toBe(true);
    expect(evolve.metric).toBe(2);
    expect(evolve.threshold).toBe(2);
    expect(evolve.evidence.reason).toBe("rollbacks_30d");
  });

  it("marks evolve failing after 4 weeks with >= 3 proposed and 0 promoted/approved", () => {
    const { db } = freshDb();
    const now = Date.parse("2026-11-26T12:00:00Z");

    for (let i = 0; i < 3; i += 1) {
      queueHypothesis(db, {
        workflowId: `wf-stag-${i}`,
        nodeId: "n1",
        armKind: "model",
        variant: { model: `m-${i}` },
        graphVersion: 1,
        source: "census",
        now: now - (20 - i) * DAY_MS,
      });
    }

    const evolve = loopHealth(db, { now }).find((r) => r.loop === "evolve")!;
    expect(evolve.failing).toBe(true);
    expect(evolve.metric).toBe(0);
    expect(evolve.threshold).toBe(1);
    expect(evolve.evidence.reason).toBe("no_promotions_4w");
  });

  it("marks employee failing when conclusiveShare8w is 40% (< 50%)", () => {
    const { db, bb } = freshDb();
    const now = Date.parse("2026-11-26T12:00:00Z");

    // 2 conclusive outcomes within 8 weeks.
    for (let i = 0; i < 2; i += 1) {
      const staged = stageIntent(db, {
        projectId: "proj-emp",
        domain: "seo",
        sourceGraph: "sp-tick",
        order: makeOrder(`wf_conc_${i}`, 3),
        nowMs: now - 15 * DAY_MS + i * 1000,
      });
      recordMeasurement(db, { intentId: staged.intentId, measured: 125, source: "gsc", now: now - 10 * DAY_MS + i * 1000 }, bb.log);
    }

    // 3 inconclusive outcomes within 8 weeks -> 2 / 5 = 0.40 (40%).
    for (let i = 0; i < 3; i += 1) {
      stageIntent(db, {
        projectId: "proj-emp",
        domain: "seo",
        sourceGraph: "sp-tick",
        order: makeOrder(`wf_inconc_${i}`, 3),
        nowMs: now - 20 * DAY_MS + i * 1000,
      });
    }
    expireOutcomes(db, now - 1 * DAY_MS, bb.log);

    const employee = loopHealth(db, { now }).find((r) => r.loop === "employee")!;
    expect(employee.failing).toBe(true);
    expect(employee.metric).toBe(0.4);
    expect(employee.threshold).toBe(0.5);
    expect(employee.evidence.reason).toBe("low_conclusive_share_8w");
  });

  it("reports no failing loop for a healthy seeded DB and respects loop modes without auto-switching", () => {
    const { db, bb } = freshDb();
    const now = Date.parse("2026-11-26T12:00:00Z");
    const pubAt = now - 35 * DAY_MS;

    // Healthy discovery: 1 of last 3 published, and ran 3 times within 30d after publication.
    seedDraft(db, { source: "path-capture", workflowId: "path-ok", at: pubAt - DAY_MS, published: true, publishedAt: pubAt });
    seedDraft(db, { source: "path-capture", workflowId: "path-skip-1", at: now - 20 * DAY_MS });
    seedDraft(db, { source: "path-capture", workflowId: "path-skip-2", at: now - 21 * DAY_MS });
    for (let i = 0; i < 3; i += 1) {
      seedWfRun(db, { id: `run_ok_${i}`, workflowId: "path-ok", createdAt: pubAt + (i + 1) * DAY_MS });
    }

    // Healthy branches & templates: 1 of last 3 published.
    seedDraft(db, { source: "branch-capture", workflowId: "branch-ok", at: now - 18 * DAY_MS, published: true });
    seedDraft(db, { source: "branch-capture", workflowId: "branch-old-1", at: now - 20 * DAY_MS });
    seedDraft(db, { source: "branch-capture", workflowId: "branch-old-2", at: now - 21 * DAY_MS });

    seedDraft(db, { source: "project-template", workflowId: "tpl-ok", at: now - 18 * DAY_MS, published: true });
    seedDraft(db, { source: "project-template", workflowId: "tpl-old-1", at: now - 20 * DAY_MS });
    seedDraft(db, { source: "project-template", workflowId: "tpl-old-2", at: now - 21 * DAY_MS });

    // Healthy evolve: 3 proposed in 4w, 1 promoted, 1 rollback (below 2).
    const hWin = queueHypothesis(db, {
      workflowId: "wf-ev-win",
      nodeId: "n1",
      armKind: "model",
      variant: { model: "m-win" },
      graphVersion: 1,
      source: "census",
      now: now - 15 * DAY_MS,
    });
    if (hWin.ok) {
      setHypothesisState(db, { id: hWin.hypothesis.id, state: "promoted", reason: "owner_approve", now: now - 10 * DAY_MS });
    }
    const hRb = queueHypothesis(db, {
      workflowId: "wf-ev-rb",
      nodeId: "n1",
      armKind: "model",
      variant: { model: "m-rb" },
      graphVersion: 1,
      source: "census",
      now: now - 12 * DAY_MS,
    });
    if (hRb.ok) {
      const t = openTrial(db, { hypothesisId: hRb.hypothesis.id, workflowId: "wf-ev-rb", baselineVersion: 1, candidateDraftId: "d-rb", now: now - 11 * DAY_MS });
      closeTrial(db, { trialId: t.trialId, state: "rolled_back", reason: "canary_reject", now: now - 9 * DAY_MS });
    }
    queueHypothesis(db, {
      workflowId: "wf-ev-open",
      nodeId: "n1",
      armKind: "model",
      variant: { model: "m-open" },
      graphVersion: 1,
      source: "census",
      now: now - 5 * DAY_MS,
    });

    // Healthy employee: 3 conclusive + 1 inconclusive = 75% (>= 50%).
    for (let i = 0; i < 3; i += 1) {
      const staged = stageIntent(db, {
        projectId: "proj-health",
        domain: "seo",
        sourceGraph: "sp-tick",
        order: makeOrder(`wf_emp_ok_${i}`, 3),
        nowMs: now - 12 * DAY_MS + i * 1000,
      });
      recordMeasurement(db, { intentId: staged.intentId, measured: 130, source: "gsc", now: now - 5 * DAY_MS + i * 1000 }, bb.log);
    }
    stageIntent(db, {
      projectId: "proj-health",
      domain: "seo",
      sourceGraph: "sp-tick",
      order: makeOrder("wf_emp_inc", 3),
      nowMs: now - 20 * DAY_MS,
    });
    expireOutcomes(db, now - 1 * DAY_MS, bb.log);

    saveProjectSetting(db, "proj-health", LOOPS_MODE_KEY, { evolve: "report" });
    const rows = loopHealth(db, { now, projectId: "proj-health" });

    expect(rows.every((r) => r.failing === false)).toBe(true);
    expect(rows.find((r) => r.loop === "evolve")?.mode).toBe("report");
    expect(rows.find((r) => r.loop === "employee")?.metric).toBe(0.75);
  });
});
