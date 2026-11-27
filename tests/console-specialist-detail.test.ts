import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { rpcConsole } from "../src/rooms/contracts/rpc-console";
import { createCore } from "../src/rooms/core/server/core";
import { openDatabase } from "../src/rooms/plugin-db";
import { loopHealth } from "../src/rooms/reports/server";
import { createScheduleStore } from "../src/rooms/schedule";
import {
  charterDraftKey,
  grantAutonomy,
  revokeAutonomy,
  room as specialistRoom,
  specialistDetail,
  upsertCharter,
} from "../src/rooms/specialist/server";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function seedIntentAndOutcome(
  db: ReturnType<typeof openDatabase>,
  input: {
    intentId: string;
    projectId: string;
    domain: string;
    metric: string;
    measured: number;
    measuredAt: number;
    checkAt?: number;
    verdict?: "within" | "above" | "below";
  },
) {
  db.prepare(
    `INSERT INTO lane_pilot_sp_intent
      (intent_id, project_id, domain, source_graph, tick_id, idem_key, semantic_key, order_kind, reason_code, status, estimated_cost_usd, order_json, created_at, updated_at)
     VALUES (?, ?, ?, 'sp-specialist-tick', 'tick-1', ?, ?, 'sub_graph', 'seo_audit', 'dispatched', 0, '{}', ?, ?)`,
  ).run(
    input.intentId,
    input.projectId,
    input.domain,
    `idem:${input.intentId}`,
    `sem:${input.intentId}`,
    input.measuredAt - 10_000,
    input.measuredAt - 10_000,
  );
  db.prepare(
    `INSERT INTO lane_pilot_sp_intent_outcome
      (intent_id, project_id, domain, metric, unit, baseline, expected_lo, expected_point, expected_hi, check_at, measured, measured_at, source, verdict)
     VALUES (?, ?, ?, ?, 'count', 100, 100, 200, 300, ?, ?, ?, 'gsc', ?)`,
  ).run(
    input.intentId,
    input.projectId,
    input.domain,
    input.metric,
    input.checkAt ?? input.measuredAt,
    input.measured,
    input.measuredAt,
    input.verdict ?? "within",
  );
}

describe("specialist_detail", () => {
  it("returns charter v2 with pending draft, two grants, ledger caps, North Star series, loop health, and three ordered schedule runs", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    const nowMs = Date.parse("2026-11-27T12:00:00Z");
    const todayUtc = "2026-11-27";
    const earlierMonthUtc = "2026-11-05";

    // Charter v1 -> v2
    upsertCharter(db, {
      projectId: "proj-1",
      domain: "seo",
      approvedBy: "owner",
      nowMs: nowMs - 20 * 86_400_000,
      charter: {
        north_star: { metric_id: "organic_clicks", target: 1000 },
        budgets: { daily_cap_usd: 25, monthly_cap_usd: 400, cell_cap_usd: 5 },
      },
    });
    upsertCharter(db, {
      projectId: "proj-1",
      domain: "seo",
      approvedBy: "owner",
      nowMs: nowMs - 86_400_000,
      charter: {
        north_star: { metric_id: "organic_clicks", target: 1500 },
        budgets: { daily_cap_usd: 30, monthly_cap_usd: 500, cell_cap_usd: 6 },
      },
    });

    await bb.storage.kv.set(charterDraftKey("proj-1", "seo"), {
      draftId: "draft-v3",
      body: {
        north_star: { metric_id: "organic_clicks", target: 2000 },
        budgets: { daily_cap_usd: 40, monthly_cap_usd: 600, cell_cap_usd: 8 },
      },
    });

    // Two autonomy grants: one active bounded_auto with stats, one revoked & frozen
    grantAutonomy(db, {
      projectId: "proj-1",
      domain: "seo",
      actionClass: "sub_graph:seo_refresh",
      by: "owner",
      now: nowMs - 5_000,
    });
    db.prepare(
      `UPDATE lane_pilot_sp_autonomy
       SET samples_n = 24, successes_k = 22, wilson_lb = 0.82
       WHERE project_id = ? AND domain = ? AND action_class = ?`,
    ).run("proj-1", "seo", "sub_graph:seo_refresh");

    grantAutonomy(db, {
      projectId: "proj-1",
      domain: "seo",
      actionClass: "direct_api:bid_adjust",
      by: "owner",
      now: nowMs - 10_000,
    });
    revokeAutonomy(db, {
      projectId: "proj-1",
      domain: "seo",
      actionClass: "direct_api:bid_adjust",
      reason: "test_freeze",
      freezeDays: 14,
      now: nowMs - 2_000,
    });

    // Ledger rows: day auto ($2.5), day non-auto ($4), month earlier ($12), api_units (ignored), released (ignored)
    const insertLedger = db.prepare(
      `INSERT INTO lane_pilot_sp_ledger
        (id, project_id, domain, cell_key, day_utc, mode, is_auto, amount_usd, run_id, reason, created_at, updated_at)
       VALUES (?, 'proj-1', 'seo', ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
    );
    insertLedger.run("led-day-auto", "cell-1", todayUtc, "settled", 1, 2.5, "llm_usd:tick", nowMs - 3_600_000, nowMs - 3_600_000);
    insertLedger.run("led-day-manual", "cell-2", todayUtc, "reserved", 0, 4.0, "llm_usd:manual", nowMs - 1_800_000, nowMs - 1_800_000);
    insertLedger.run("led-month", "cell-3", earlierMonthUtc, "settled", 0, 12.0, "llm_usd:older", nowMs - 10 * 86_400_000, nowMs - 10 * 86_400_000);
    insertLedger.run("led-api-units", "cell-4", todayUtc, "settled", 0, 99.0, "api_units:xmlstock", nowMs - 900_000, nowMs - 900_000);
    insertLedger.run("led-released", "cell-5", todayUtc, "released", 1, 50.0, "llm_usd:refund", nowMs - 900_000, nowMs - 900_000);

    // North Star outcome series (inserted out of chronological order to verify ASC ordering)
    seedIntentAndOutcome(db, {
      intentId: "int-2",
      projectId: "proj-1",
      domain: "seo",
      metric: "organic_clicks",
      measured: 640,
      measuredAt: nowMs - 2 * 86_400_000,
      verdict: "within",
    });
    seedIntentAndOutcome(db, {
      intentId: "int-1",
      projectId: "proj-1",
      domain: "seo",
      metric: "organic_clicks",
      measured: 510,
      measuredAt: nowMs - 5 * 86_400_000,
      verdict: "within",
    });
    seedIntentAndOutcome(db, {
      intentId: "int-3",
      projectId: "proj-1",
      domain: "seo",
      metric: "organic_clicks",
      measured: 780,
      measuredAt: nowMs - 86_400_000,
      verdict: "above",
    });

    // Schedules: one matching seo, one non-matching marketing
    const store = createScheduleStore(db, () => nowMs - 3 * 86_400_000);
    const seoSchedule = store.insert(
      {
        projectId: "proj-1",
        name: "sp:seo:sp-specialist-tick",
        description: "SEO specialist shift",
        task: { kind: "workflow", workflowId: "sp-specialist-tick", inputs: { domain: "seo", mode: "daily_sweep" } },
        when: { type: "cron", cron: "0 9 * * *", timezone: "UTC" },
        missed: "run_once",
        missedLimit: 5,
        overlap: "skip",
        timeoutSec: 3600,
        maxFailures: 3,
      },
      { createdBy: "owner", state: "active" },
    );
    const mktSchedule = store.insert(
      {
        projectId: "proj-1",
        name: "sp:marketing:sp-specialist-tick",
        description: "Marketing specialist shift",
        task: { kind: "workflow", workflowId: "sp-specialist-tick", inputs: { domain: "marketing", mode: "heartbeat" } },
        when: { type: "cron", cron: "0 10 * * *", timezone: "UTC" },
        missed: "run_once",
        missedLimit: 5,
        overlap: "skip",
        timeoutSec: 3600,
        maxFailures: 3,
      },
      { createdBy: "owner", state: "active" },
    );

    // Seed wf_run for one shift to verify workflowId & depth enrichment
    db.prepare(
      `INSERT INTO lane_pilot_wf_run
        (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, created_at, updated_at)
       VALUES ('wf-shift-3', 'sp-specialist-tick', 1, 'sha', '{}', 'proj-1', 'succeeded', '{"domain":"seo","mode":"weekly_sweep"}', ?, ?)`,
    ).run(nowMs - 3_600_000, nowMs - 3_500_000);

    const r1 = store.addRun({
      scheduleId: seoSchedule.id,
      runKey: `${seoSchedule.id}:1`,
      scheduledAt: nowMs - 3 * 86_400_000,
      trigger: "tick",
      status: "queued",
    });
    store.claim(r1.run.id, nowMs - 3 * 86_400_000 + 60_000);
    store.finish(r1.run.id, "succeeded");
    db.prepare("UPDATE lane_pilot_schedule_run SET finished_at = ?, ref_kind = 'workflow_run', ref_id = 'wf-shift-1' WHERE id = ?")
      .run(nowMs - 3 * 86_400_000 + 30_000, r1.run.id);

    const r2 = store.addRun({
      scheduleId: seoSchedule.id,
      runKey: `${seoSchedule.id}:2`,
      scheduledAt: nowMs - 2 * 86_400_000,
      trigger: "tick",
      status: "queued",
    });
    store.claim(r2.run.id, nowMs - 2 * 86_400_000 + 60_000);
    store.finish(r2.run.id, "failed", { error: "timeout" });
    db.prepare("UPDATE lane_pilot_schedule_run SET finished_at = ?, ref_kind = 'workflow_run', ref_id = 'wf-shift-2' WHERE id = ?")
      .run(nowMs - 2 * 86_400_000 + 45_000, r2.run.id);

    const r3 = store.addRun({
      scheduleId: seoSchedule.id,
      runKey: `${seoSchedule.id}:3`,
      scheduledAt: nowMs - 3_600_000,
      trigger: "manual",
      status: "queued",
    });
    store.claim(r3.run.id, nowMs);
    store.finish(r3.run.id, "succeeded");
    db.prepare("UPDATE lane_pilot_schedule_run SET finished_at = ?, ref_kind = 'workflow_run', ref_id = 'wf-shift-3' WHERE id = ?")
      .run(nowMs - 3_500_000, r3.run.id);

    // Unrelated domain run (must not appear in seo shifts)
    store.addRun({
      scheduleId: mktSchedule.id,
      runKey: `${mktSchedule.id}:1`,
      scheduledAt: nowMs - 1_800_000,
      trigger: "tick",
      status: "succeeded",
    });

    const schedulesAdapter = {
      list: ({ projectId }: { projectId?: string } = {}) =>
        store.list(projectId ? { projectId } : {}).map((row) => ({
          id: row.id,
          projectId: row.project_id,
          name: row.name,
          description: row.description,
          task: JSON.parse(row.task_json),
          when: { type: "cron" as const, cron: row.cron!, timezone: row.timezone || "UTC" },
          missed: row.missed_policy,
          missedLimit: row.missed_limit,
          overlap: row.overlap,
          timeoutSec: row.timeout_sec,
          maxFailures: row.max_failures,
          state: row.state,
          pauseReason: row.pause_reason,
          consecutiveFailures: row.consecutive_failures,
          createdBy: row.created_by,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          nextFires: [Date.parse("2026-11-28T09:00:00Z")],
          machine: null,
          lastRun: null,
          active: [],
          column: "scheduled" as const,
          model: null,
          cost: null,
          where: {
            projectName: null,
            sectionId: null,
            sectionName: null,
            sectionPath: null,
            hostId: null,
            hostName: null,
            cwd: null,
          },
        })),
      runs: (id: string, limit = 50, offset = 0) =>
        store.runsOf(id, limit, offset).map((r) => ({
          id: r.id,
          scheduleId: r.schedule_id,
          scheduledAt: r.scheduled_at,
          trigger: r.trigger,
          status: r.status,
          reason: r.reason,
          queuedAt: r.queued_at,
          startedAt: r.started_at,
          finishedAt: r.finished_at,
          durationMs: null,
          refKind: r.ref_kind,
          refId: r.ref_id,
          hostId: r.host_id,
          threadId: null,
          exitCode: r.exit_code,
          output: r.output,
          error: r.error,
          truncated: false,
          providerId: null,
          model: null,
          tokens: null,
          costUsd: null,
          usageKnown: false,
          hostName: null,
        })),
    };

    const warnings: string[] = [];
    const detail = await specialistDetail(
      {
        db,
        kv: bb.storage.kv,
        schedules: schedulesAdapter,
        loopHealth,
        now: () => nowMs,
        log: { warn: (m) => warnings.push(m) },
      },
      { projectId: "proj-1", domain: "seo" },
    );

    expect(warnings).toEqual([]);
    expect(() => rpcConsole.specialist_detail.output.parse(detail)).not.toThrow();

    expect(detail.charter).toEqual({
      version: 2,
      approvedBy: "owner",
      approvedAt: nowMs - 86_400_000,
      body: {
        north_star: { metric_id: "organic_clicks", target: 1500 },
        budgets: { daily_cap_usd: 30, monthly_cap_usd: 500, cell_cap_usd: 6 },
      },
      pendingDraft: {
        draftId: "draft-v3",
        body: {
          north_star: { metric_id: "organic_clicks", target: 2000 },
          budgets: { daily_cap_usd: 40, monthly_cap_usd: 600, cell_cap_usd: 8 },
        },
      },
    });

    expect(detail.shifts.recent).toHaveLength(3);
    expect(detail.shifts.recent.map((s) => s.runId)).toEqual(["wf-shift-3", "wf-shift-2", "wf-shift-1"]);
    expect(detail.shifts.recent[0]).toEqual({
      at: nowMs - 3_500_000,
      depth: "weekly_sweep",
      outcome: "succeeded",
      workflowId: "sp-specialist-tick",
      runId: "wf-shift-3",
    });
    expect(detail.shifts.recent[1]?.outcome).toBe("failed");
    expect(detail.shifts.last).toEqual(detail.shifts.recent[0]);
    expect(detail.shifts.next).toEqual({
      at: Date.parse("2026-11-28T09:00:00Z"),
      depth: "daily_sweep",
    });

    expect(detail.northStar).toEqual({
      metric: "organic_clicks",
      series: [
        { at: nowMs - 5 * 86_400_000, value: 510 },
        { at: nowMs - 2 * 86_400_000, value: 640 },
        { at: nowMs - 86_400_000, value: 780 },
      ],
      freshAt: nowMs - 86_400_000,
    });

    expect(detail.caps).toEqual([
      { period: "day", capUsd: 30, usedUsd: 6.5 },
      { period: "month", capUsd: 500, usedUsd: 18.5 },
      { period: "test", capUsd: 6, usedUsd: 2.5 },
    ]);

    expect(detail.autonomy).toEqual([
      {
        actionClass: "direct_api:bid_adjust",
        level: "propose",
        sample: 0,
        confidence: null,
        frozen: true,
      },
      {
        actionClass: "sub_graph:seo_refresh",
        level: "bounded_auto",
        sample: 24,
        confidence: 0.82,
        frozen: false,
      },
    ]);

    expect(detail.loopHealth).toEqual({
      status: "ok",
      note: "3/3 conclusive (8w)",
    });

    // Also verify room RPC registration end-to-end
    const ctx = createCore(bb, db);
    const rpc = specialistRoom.rpc!(ctx, {
      schedules: schedulesAdapter as never,
      loopHealth,
    }) as { specialist_detail: (input: { projectId: string; domain: string }) => Promise<typeof detail> };
    const viaRpc = await rpc.specialist_detail({ projectId: "proj-1", domain: "seo" });
    expect(viaRpc.charter?.version).toBe(2);
    expect(viaRpc.shifts.recent).toHaveLength(3);
  });

  it("returns charter: null and empty lists for unknown project or domain, and isolates part failures", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    const unknown = await specialistDetail(
      { db, kv: bb.storage.kv, loopHealth },
      { projectId: "missing-proj", domain: "seo" },
    );
    expect(unknown).toEqual({
      charter: null,
      shifts: { last: null, next: null, recent: [] },
      northStar: null,
      caps: [],
      autonomy: [],
      loopHealth: null,
    });

    upsertCharter(db, {
      projectId: "proj-2",
      domain: "marketing",
      approvedBy: "owner",
      nowMs: 1_000_000,
      charter: { north_star: { metric_id: "paid_leads" } },
    });

    const warnings: string[] = [];
    const degraded = await specialistDetail(
      {
        db,
        kv: {
          get: async () => {
            throw new Error("kv offline");
          },
        },
        schedules: {
          list: () => {
            throw new Error("schedules offline");
          },
          runs: () => [],
        },
        loopHealth: () => {
          throw new Error("reports offline");
        },
        now: () => 2_000_000,
        log: { warn: (m) => warnings.push(m) },
      },
      { projectId: "proj-2", domain: "marketing" },
    );

    expect(degraded.charter?.version).toBe(1);
    expect(degraded.charter?.pendingDraft).toBeNull();
    expect(degraded.shifts).toEqual({ last: null, next: null, recent: [] });
    expect(degraded.loopHealth).toBeNull();
    expect(warnings).toEqual([
      "[console] specialist_detail part=charter_draft failed: kv offline",
      "[console] specialist_detail part=shifts failed: schedules offline",
      "[console] specialist_detail part=loopHealth failed: reports offline",
    ]);
  });
});
