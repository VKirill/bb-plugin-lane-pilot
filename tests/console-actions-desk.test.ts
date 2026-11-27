import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import { addRoad, leadDecisions, proposeRoad } from "../src/rooms/lead/server";
import { savePushConfig } from "../src/rooms/owner-waiting/server";
import { openDatabase } from "../src/rooms/plugin-db";
import { composeReviewDesk, deskRpc, nextDeskDefaultAt } from "../src/rooms/reports/server";
import { actionsLog, grantAutonomy, room as specialistRoom } from "../src/rooms/specialist/server";
import { autonomousEffects } from "../src/rooms/workflow/server";

let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function seedWfRunAndEffect(
  db: ReturnType<typeof openDatabase>,
  input: {
    effectId: string;
    runId: string;
    workflowId: string;
    projectId: string | null;
    kind: string;
    effectKey: string;
    state: "intended" | "done" | "failed" | "unknown";
    intentJson?: string | null;
    resultJson?: string | null;
    updatedAt: number;
  },
) {
  db.prepare(
    `INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, created_at, updated_at)
     VALUES (?, ?, 1, 'sha', '{}', ?, 'succeeded', '{}', ?, ?)`,
  ).run(input.runId, input.workflowId, input.projectId, input.updatedAt - 1_000, input.updatedAt);
  db.prepare(
    `INSERT INTO lane_pilot_wf_effect
      (id, run_id, step_key, effect_key, kind, state, intent_json, result_json, created_at, updated_at)
     VALUES (?, ?, 'step_1', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.effectId,
    input.runId,
    input.effectKey,
    input.kind,
    input.state,
    input.intentJson ?? null,
    input.resultJson ?? null,
    input.updatedAt - 500,
    input.updatedAt,
  );
}

describe("actionsLog & actions_log", () => {
  it("merges bounded_auto specialist mutations, workflow effects, and autonomous lead decisions newest first with safe undo rules", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    const t0 = Date.parse("2026-11-27T10:00:00Z");

    // Grant bounded_auto for seo / bid_adjust so the mutation log row qualifies.
    grantAutonomy(db, {
      projectId: "proj-1",
      domain: "seo",
      actionClass: "bid_adjust",
      by: "owner",
      now: t0 - 10_000,
    });

    // 1) Qualified bounded_auto specialist mutation with a previous value but NO real revert RPC (specialist_autonomy_set must NOT be used as undo).
    db.prepare(
      `INSERT INTO lane_pilot_sp_mutation_log
        (mutation_id, project_id, domain, entity_id, mutation_kind, tier, delta_ratio, nonce_id, status, detail_json, applied_at)
       VALUES (?, ?, ?, ?, ?, 'D', 0.1, 'nonce-1', 'applied', ?, ?)`,
    ).run(
      "mut-auto-1",
      "proj-1",
      "seo",
      "kw:123",
      "bid_adjust",
      JSON.stringify({
        summary: "Lowered bid by 10%",
        previousValue: 1.5,
        undo: { method: "specialist_autonomy_set", input: { projectId: "proj-1" } },
      }),
      t0 + 1_000,
    );

    // 2) Qualified bounded_auto specialist mutation whose own revert executor IS a registered reverse RPC (schedule_pause).
    db.prepare(
      `INSERT INTO lane_pilot_sp_mutation_log
        (mutation_id, project_id, domain, entity_id, mutation_kind, tier, delta_ratio, nonce_id, status, detail_json, applied_at)
       VALUES (?, ?, ?, ?, ?, 'D', NULL, 'nonce-2', 'applied', ?, ?)`,
    ).run(
      "mut-auto-undoable",
      "proj-1",
      "marketing",
      "sched-9",
      "schedule_create",
      JSON.stringify({
        autonomy_class: "bounded_auto",
        revert: { method: "schedule_pause", input: { id: "sched-9" } },
      }),
      t0 + 3_000,
    );

    // 3) Non-autonomous (propose) mutation must be excluded.
    db.prepare(
      `INSERT INTO lane_pilot_sp_mutation_log
        (mutation_id, project_id, domain, entity_id, mutation_kind, tier, delta_ratio, nonce_id, status, detail_json, applied_at)
       VALUES (?, ?, ?, ?, ?, 'L', NULL, 'nonce-3', 'applied', ?, ?)`,
    ).run(
      "mut-propose-excluded",
      "proj-1",
      "seo",
      "kw:999",
      "keyword_pause",
      JSON.stringify({ autonomy_class: "propose" }),
      t0 + 4_000,
    );

    // 4) Workflow effects: one done schedule effect (undoable via schedule_pause) and one failed maintenance effect.
    seedWfRunAndEffect(db, {
      effectId: "eff-sched",
      runId: "wf-run-1",
      workflowId: "custom-growth",
      projectId: "proj-1",
      kind: "schedule",
      effectKey: "schedule.create",
      state: "done",
      intentJson: JSON.stringify({ name: "Morning check" }),
      resultJson: JSON.stringify({ scheduleId: "sched-42" }),
      updatedAt: t0 + 2_000,
    });
    seedWfRunAndEffect(db, {
      effectId: "eff-maint-fail",
      runId: "wf-run-2",
      workflowId: "lp.worktree-cleanup",
      projectId: "proj-1",
      kind: "cleanup",
      effectKey: "prune",
      state: "failed",
      updatedAt: t0 + 5_000,
    });

    // 5) Autonomous lead decision (answered_by = 'lead') and owner decision (must be excluded).
    db.prepare(
      `INSERT INTO lane_pilot_decision
        (id, project_id, run_id, surface, class, situation_json, options_json, answer_json, answered_at, answered_by, split, created_at)
       VALUES (?, ?, ?, ?, ?, '{}', '[]', ?, ?, ?, 'exam', ?)`,
    ).run(
      "dec-lead-1",
      "proj-1",
      "run-7",
      "task_word",
      "accept",
      JSON.stringify({ choice: "yes" }),
      t0 + 2_500,
      "lead",
      t0,
    );
    db.prepare(
      `INSERT INTO lane_pilot_decision
        (id, project_id, run_id, surface, class, situation_json, options_json, answer_json, answered_at, answered_by, split, created_at)
       VALUES (?, ?, ?, ?, ?, '{}', '[]', ?, ?, ?, 'exam', ?)`,
    ).run(
      "dec-owner-excluded",
      "proj-1",
      "run-8",
      "task_word",
      "accept",
      JSON.stringify({ choice: "no" }),
      t0 + 6_000,
      "owner",
      t0,
    );

    const warnings: string[] = [];
    const out = actionsLog(
      db,
      { projectId: "proj-1", since: t0, limit: 20 },
      {
        autonomousEffects,
        leadDecisions,
        log: { warn: (m) => warnings.push(m) },
      },
    );

    expect(warnings).toEqual([]);
    expect(out.rows.map((r) => r.id)).toEqual([
      "wf_eff:eff-maint-fail",
      "sp_mut:mut-auto-undoable",
      "lead_dec:dec-lead-1",
      "wf_eff:eff-sched",
      "sp_mut:mut-auto-1",
    ]);

    expect(out.rows[0]).toMatchObject({
      actor: "workflow:lp.worktree-cleanup",
      authority: "maintenance",
      result: "failed",
      undo: null,
    });
    expect(out.rows[1]).toMatchObject({
      actor: "specialist:marketing",
      authority: "bounded_auto",
      result: "done",
      undo: { method: "schedule_pause", input: { id: "sched-9" } },
    });
    expect(out.rows[2]).toMatchObject({
      actor: "lead",
      authority: "bounded_auto",
      result: "done",
      undo: null,
    });
    expect(out.rows[3]).toMatchObject({
      actor: "workflow:custom-growth",
      authority: "repo_rule",
      result: "done",
      undo: { method: "schedule_pause", input: { id: "sched-42" } },
    });
    expect(out.rows[4]).toMatchObject({
      actor: "specialist:seo",
      authority: "bounded_auto",
      result: "done",
      undo: null,
    });

    // Source failure isolation: failing leadDecisions logs warning naming source and preserves other sources.
    const ctx = createCore(bb, db);
    const rpc = specialistRoom.rpc!(ctx, {
      autonomousEffects,
      leadDecisions: () => {
        throw new Error("lead table offline");
      },
    }) as { actions_log: (i: { projectId?: string }) => Promise<typeof out> };
    const degraded = await rpc.actions_log({ projectId: "proj-1" });
    expect(degraded.rows.map((r) => r.id)).toEqual([
      "wf_eff:eff-maint-fail",
      "sp_mut:mut-auto-undoable",
      "wf_eff:eff-sched",
      "sp_mut:mut-auto-1",
    ]);
  });
});

describe("deskRpc desk_get", () => {
  it("returns the same item ids as composeReviewDesk for the seeded week with next Monday 10:00 defaultAt in owner tz", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);

    // Friday 2026-11-27T15:00:00Z -> next Monday 10:00 in Europe/Moscow (UTC+3) is 2026-11-30T07:00:00Z.
    const nowMs = Date.parse("2026-11-27T15:00:00Z");
    savePushConfig(db, { timezone: "Europe/Moscow" });

    const dir = addRoad(
      db,
      { id: "dir:proj-1", projectId: "proj-1", title: "Directions", kind: "direction", source: "lead", why: "Seed root direction for test" },
      nowMs - 10_000,
    );
    const branch = addRoad(
      db,
      {
        id: "road-cand-1",
        parentId: dir.id,
        projectId: "proj-1",
        title: "Automate weekly SEO digest",
        kind: "option",
        source: "lead",
        why: "Repeated 4 times this week",
        class: "process",
        payload: { key: "cand:seo-digest", count: 4 },
      },
      nowMs - 5_000,
    );
    proposeRoad(db, branch.id, "dec-road-1", nowMs - 4_000);

    const ctx = createCore(bb, db);
    const direct = composeReviewDesk(db, { timezone: "Europe/Moscow" }, { now: nowMs });
    const handlers = deskRpc(ctx, { now: () => nowMs });
    const view = await handlers.desk_get({});

    expect(view.week).toBe(direct.week);
    expect(view.items.map((item) => item.id)).toEqual(direct.items.map((item) => item.id));
    expect(view.items.find((item) => item.id === "road:road-cand-1")).toMatchObject({
      id: "road:road-cand-1",
      section: "candidates",
      question: "process: Automate weekly SEO digest",
      evidence: "cand:seo-digest",
      answered: null,
      defaultAt: Date.parse("2026-11-30T07:00:00Z"),
      options: [
        { id: "save as draft", label: "save as draft", isDefault: false },
        { id: "later", label: "later", isDefault: true },
        { id: "reject", label: "reject", isDefault: false },
      ],
    });
    expect(nextDeskDefaultAt(nowMs, "Europe/Moscow")).toBe(Date.parse("2026-11-30T07:00:00Z"));

    const otherWeek = await handlers.desk_get({ week: "2026-W01" });
    expect(otherWeek).toEqual({ week: "2026-W01", items: [] });
  });
});
