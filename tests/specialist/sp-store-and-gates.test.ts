import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { snapshotLessonProblem } from "../../src/rooms/critique/server";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  type ActionOrder,
  checkRuSeasonality,
  classifyToolTier,
  estimateActionOrderCost,
  evaluateAutonomyGate,
  wilsonLowerBound,
} from "../../src/rooms/specialist";
import {
  acquireLock,
  acquireTick,
  advanceCursor,
  applyMutationsBatch,
  checkCohortMaturity,
  checkLockCollisions,
  checkStrategyGuard,
  completeTick,
  consumeApprovalNonce,
  getBudgetRemainingUsd,
  getCharter,
  listCursors,
  loadMergedQuestions,
  loadQuestionBank,
  mintApprovalNonce,
  recordQuestionAnswer,
  reserveBudget,
  settleBudget,
  spSweep,
  stageIntent,
  triageQuestions,
  upsertCharter,
  upsertCohort,
} from "../../src/rooms/specialist/server";
import { roleSpec } from "../../src/rooms/workflow/server/workflow-agent";

function freshDb() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return openDatabase(bb);
}

describe("Specialist OS SQLite store, safety gates, and role protections", () => {
  it("migrates all 17 lane_pilot_sp_* tables and manages versioned charters", () => {
    const db = freshDb();
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lane_pilot_sp_%' ORDER BY name ASC")
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(tables).toHaveLength(17);

    const v1 = upsertCharter(db, {
      projectId: "p1",
      domain: "marketing",
      charter: { goal: "paid_growth", budgets: { daily_cap_usd: 120, cell_cap_usd: 30, rolling_24h_auto_cap_usd: 25, max_active_cells: 2 } },
      approvedBy: "owner",
    });
    expect(v1.version).toBe(1);

    const same = upsertCharter(db, {
      projectId: "p1",
      domain: "marketing",
      charter: { budgets: { cell_cap_usd: 30, daily_cap_usd: 120, max_active_cells: 2, rolling_24h_auto_cap_usd: 25 }, goal: "paid_growth" },
      approvedBy: "owner",
    });
    expect(same.version).toBe(1); // canonicalJson sha256 identical -> idempotent version

    const v2 = upsertCharter(db, {
      projectId: "p1",
      domain: "marketing",
      charter: { goal: "paid_growth_q4", budgets: { daily_cap_usd: 150, cell_cap_usd: 40, rolling_24h_auto_cap_usd: 30, max_active_cells: 2 } },
      approvedBy: "owner",
    });
    expect(v2.version).toBe(2);
    expect(getCharter(db, "p1", "marketing")?.daily_cap_usd).toBe(150);
  });

  it("enforces G-11 single-flight tick lease, completed slot dedupe, and TTL expiry", () => {
    const db = freshDb();
    const t0 = 1_760_000_000_000;
    const first = acquireTick(db, {
      projectId: "p1",
      domain: "marketing",
      slotKey: "daily:2026-11-12",
      holderRunId: "run_1",
      leaseTtlMs: 60_000,
      nowMs: t0,
    });
    expect(first.ok).toBe(true);

    const overlap = acquireTick(db, {
      projectId: "p1",
      domain: "marketing",
      slotKey: "daily:2026-11-12",
      holderRunId: "run_2",
      nowMs: t0 + 10_000,
    });
    expect(overlap).toMatchObject({ ok: false, reason: "active_lease" });

    // After TTL expiry without completion, a new runner can take over
    const takeover = acquireTick(db, {
      projectId: "p1",
      domain: "marketing",
      slotKey: "daily:2026-11-12",
      holderRunId: "run_2",
      nowMs: t0 + 65_000,
    });
    expect(takeover.ok).toBe(true);

    completeTick(db, {
      projectId: "p1",
      domain: "marketing",
      tickId: takeover.tickId,
      markSlotCompleted: true,
      nowMs: t0 + 70_000,
    });

    const replaySameSlot = acquireTick(db, {
      projectId: "p1",
      domain: "marketing",
      slotKey: "daily:2026-11-12",
      holderRunId: "run_3",
      nowMs: t0 + 80_000,
    });
    expect(replaySameSlot).toMatchObject({ ok: false, reason: "slot_already_completed" });
  });

  it("enforces G-12 atomic 3-aggregate budget reservations (daily, cell, 24h auto, max concurrent cells) and CAS cursors", () => {
    const db = freshDb();
    const now = Date.parse("2026-11-12T10:00:00Z");
    upsertCharter(db, {
      projectId: "p1",
      domain: "marketing",
      charter: { budgets: { daily_cap_usd: 50, cell_cap_usd: 25, rolling_24h_auto_cap_usd: 20, max_active_cells: 2 } },
      nowMs: now,
    });

    const r1 = reserveBudget(db, { projectId: "p1", domain: "marketing", cellKey: "cell_a", amountUsd: 15, isAuto: true, nowMs: now });
    expect(r1.ok).toBe(true);

    // Exceeds rolling 24h auto cap (15 + 10 > 20)
    const autoBlocked = reserveBudget(db, { projectId: "p1", domain: "marketing", cellKey: "cell_b", amountUsd: 10, isAuto: true, nowMs: now });
    expect(autoBlocked).toMatchObject({ ok: false, reason: "rolling_24h_auto_cap_exceeded" });

    // Non-auto cell_b succeeds (15 + 20 <= 50, cell_b 20 <= 25)
    const r2 = reserveBudget(db, { projectId: "p1", domain: "marketing", cellKey: "cell_b", amountUsd: 20, isAuto: false, nowMs: now });
    expect(r2.ok).toBe(true);

    // 3rd distinct reserved cell blocked by max_active_cells = 2
    const maxCellsBlocked = reserveBudget(db, { projectId: "p1", domain: "marketing", cellKey: "cell_c", amountUsd: 5, isAuto: false, nowMs: now });
    expect(maxCellsBlocked).toMatchObject({ ok: false, reason: "max_concurrent_cells_exceeded" });

    // Cell cap exceeded on cell_a (15 + 12 > 25)
    const cellCapBlocked = reserveBudget(db, { projectId: "p1", domain: "marketing", cellKey: "cell_a", amountUsd: 12, isAuto: false, nowMs: now });
    expect(cellCapBlocked).toMatchObject({ ok: false, reason: "cell_cap_exceeded" });

    // Settling r1 frees concurrent reserved slot for cell_c; then daily cap blocks excess
    settleBudget(db, r1.ledgerId!, "settled", 15, now);
    const dailyCapBlocked = reserveBudget(db, { projectId: "p1", domain: "marketing", cellKey: "cell_c", amountUsd: 20, isAuto: false, nowMs: now });
    expect(dailyCapBlocked).toMatchObject({ ok: false, reason: "daily_cap_exceeded" });
    expect(getBudgetRemainingUsd(db, "p1", "marketing", now)).toBe(15);

    // CAS cursor optimistic concurrency
    expect(advanceCursor(db, { projectId: "p1", domain: "marketing", streamKey: "metrika", nextCursor: { offset: 10 }, expectedVersion: 0 })).toEqual({
      ok: true,
      version: 1,
    });
    expect(advanceCursor(db, { projectId: "p1", domain: "marketing", streamKey: "metrika", nextCursor: { offset: 20 }, expectedVersion: 0 })).toEqual({
      ok: false,
      version: 1,
    });
    expect(listCursors(db, "p1", "marketing")).toMatchObject({ metrika: { offset: 10, _version: 1 } });
  });

  it("enforces G-04 URL prefix locks, G-09 21-45d SEO indexation locks, G-08 cohort maturity, and G-01/G-13 stageIntent", () => {
    const db = freshDb();
    const now = 1_760_000_000_000;

    // G-09: seo_indexation clamps short TTL up to 21 days minimum
    const seoLk = acquireLock(db, {
      projectId: "p1",
      domain: "seo",
      scopeType: "seo_indexation",
      scopeValue: "https://example.ru/catalog/coffee",
      ownerGraph: "seo-release",
      ownerRunId: "run_seo_1",
      reasonCode: "seo_indexation_lock",
      ttlMs: 60_000,
      nowMs: now,
    });
    expect(seoLk.ok).toBe(true);
    const active = checkLockCollisions(db, { projectId: "p1", scopeType: "url_prefix", scopeValue: "https://example.ru/catalog", nowMs: now });
    expect(active).toHaveLength(1);
    expect(active[0]!.expires_at - now).toBe(21 * 86_400_000);

    // G-08: immature cohort (cdf_pay < 0.6) drops stop/kill orders
    upsertCohort(db, {
      projectId: "p1",
      domain: "marketing",
      cohortKey: "tg_cell_01",
      channel: "tg_ads",
      cohortDate: "2026-11-10",
      cdfPay: 0.35,
      nowMs: now,
    });
    expect(checkCohortMaturity(db, "p1", "marketing", "tg_cell_01")).toEqual({
      mature: false,
      cdfPay: 0.35,
      reasonCode: "immature_cohort",
    });

    const killOrder: ActionOrder = {
      kind: "direct_api",
      title: "Kill TG cell 01",
      domain: "marketing",
      reason_code: "cpa_spike",
      action_class: "live_pause",
      server: "mcp-telegram-ads",
      tool: "change_ad_status",
      is_stop_or_kill: true,
      cohort_key: "tg_cell_01",
      requires_owner_go: false,
      tariff_known: true,
      estimated_cost_usd: 0.1,
    };
    const droppedImmature = stageIntent(db, { projectId: "p1", domain: "marketing", sourceGraph: "mkt-pulse-monitor", order: killOrder, nowMs: now });
    expect(droppedImmature).toMatchObject({ status: "dropped", dropReason: "immature_cohort" });

    // G-13: unknown paid API tariff refuses cost estimation & drops intent
    const unknownTariffOrder: ActionOrder = {
      kind: "sub_graph",
      title: "Paid crawl with unknown tariff",
      domain: "seo",
      reason_code: "ai_citation_gap",
      action_class: "analysis_propose",
      workflow_id: "seo-ai-visibility",
      is_stop_or_kill: false,
      requires_owner_go: false,
      tariff_known: false,
    };
    expect(estimateActionOrderCost(unknownTariffOrder).ok).toBe(false);
    expect(stageIntent(db, { projectId: "p1", domain: "seo", sourceGraph: "seo-monitor", order: unknownTariffOrder, nowMs: now })).toMatchObject({
      status: "dropped",
      dropReason: "unknown_tariff_upper_bound",
    });

    // Valid order stages once, then dedupes on idem_key and semantic_key
    const cleanOrder: ActionOrder = {
      kind: "code_task",
      title: "Fix broken canonical on /blog",
      domain: "seo",
      reason_code: "seo_tech_blocker",
      action_class: "code_fix",
      is_stop_or_kill: false,
      requires_owner_go: false,
      tariff_known: true,
    };
    const s1 = stageIntent(db, { projectId: "p1", domain: "seo", sourceGraph: "seo-tech-audit", slotScope: "s1", order: cleanOrder, nowMs: now });
    expect(s1.status).toBe("staged");
    const dupIdem = stageIntent(db, { projectId: "p1", domain: "seo", sourceGraph: "seo-tech-audit", slotScope: "s1", order: cleanOrder, nowMs: now });
    expect(dupIdem).toMatchObject({ status: "dropped", dropReason: "duplicate_idem_key" });
    const dupSem = stageIntent(db, { projectId: "p1", domain: "seo", sourceGraph: "seo-tech-audit", slotScope: "s2", order: cleanOrder, nowMs: now });
    expect(dupSem).toMatchObject({ status: "dropped", dropReason: "duplicate_semantic_key" });
  });

  it("enforces G-02 single-use HMAC nonces, G-03 tool tiers (R/D/L/S), and strategy guard (<=15% / 120h)", () => {
    const db = freshDb();
    const now = 1_760_000_000_000;

    expect(classifyToolTier("mcp-yandex-seo-ro", "webmaster_get_queries")).toBe("R");
    expect(classifyToolTier("mcp-yandex-direct", "create_draft_campaign")).toBe("D");
    expect(classifyToolTier("mcp-yandex-direct", "update_campaign_budget")).toBe("L");
    expect(classifyToolTier("mcp-yandex-direct", "delete_campaign")).toBe("S");

    // Tier S refused without charter emergency authorisation
    const sBlocked = applyMutationsBatch(db, {
      projectId: "p1",
      domain: "marketing",
      tier: "S",
      items: [{ entity_id: "camp_1", mutation_kind: "delete_campaign" }],
      nowMs: now,
    });
    expect(sBlocked.applied).toBe(0);
    expect(sBlocked.errors).toContain("tier_S_forbidden_without_emergency_charter");

    // Tier L requires valid single-use HMAC nonce bound to exact payload
    const items = [{ entity_id: "camp_1", mutation_kind: "budget_edit", current_value: 100, next_value: 112 }];
    const nonce = mintApprovalNonce(db, { projectId: "p1", actionId: "mkt-direct:push_live", payload: items, nowMs: now });

    // Tampered payload rejected without burning the valid nonce
    const mismatch = consumeApprovalNonce(db, {
      projectId: "p1",
      actionId: "mkt-direct:push_live",
      payload: [{ entity_id: "camp_1", mutation_kind: "budget_edit", current_value: 100, next_value: 150 }],
      token: nonce.token,
      nowMs: now + 1_000,
    });
    expect(mismatch).toEqual({ ok: false, reason: "payload_mismatch" });

    // Honest staging without external adapter (`G-02` / `G-25`): records simulated + staged_manual without claiming live applied
    const stagedNonce = mintApprovalNonce(db, { projectId: "p1", actionId: "mkt-direct:stage_only", payload: items, nowMs: now });
    const stagedOnly = applyMutationsBatch(db, {
      projectId: "p1",
      domain: "marketing",
      tier: "L",
      items: [{ entity_id: "camp_stage", mutation_kind: "goal_upsert" }],
      actionId: "mkt-direct:stage_only",
      nonceToken: mintApprovalNonce(db, {
        projectId: "p1",
        actionId: "mkt-direct:stage_only",
        payload: [{ entity_id: "camp_stage", mutation_kind: "goal_upsert" }],
        nowMs: now,
      }).token,
      nowMs: now + 1_500,
    });
    expect(stagedNonce.token.length).toBeGreaterThan(10);
    expect(stagedOnly.applied).toBe(0);
    expect(stagedOnly.staged).toBe(1);
    expect(stagedOnly.mode).toBe("staged_manual");

    // Valid apply succeeds (+12% <= 15%) when external mutation adapter executes
    const okApply = applyMutationsBatch(db, {
      projectId: "p1",
      domain: "marketing",
      tier: "L",
      items,
      actionId: "mkt-direct:push_live",
      nonceToken: nonce.token,
      executeMutation: () => ({ ok: true, externalReceipt: { adapter: "test_direct_api" } }),
      nowMs: now + 2_000,
    });
    expect(okApply.applied).toBe(1);
    expect(okApply.mode).toBe("live");

    // Replay with the same nonce fails immediately
    const replay = applyMutationsBatch(db, {
      projectId: "p1",
      domain: "marketing",
      tier: "L",
      items,
      actionId: "mkt-direct:push_live",
      nonceToken: nonce.token,
      nowMs: now + 3_000,
    });
    expect(replay.applied).toBe(0);
    expect(replay.errors).toContain("nonce_nonce_already_consumed");

    // Second budget edit within 120h or >15% step is blocked by checkStrategyGuard
    const sg = checkStrategyGuard(db, {
      projectId: "p1",
      entityId: "camp_1",
      mutationKind: "budget_edit",
      currentValue: 112,
      nextValue: 140,
      nowMs: now + 3_600_000,
    });
    expect(sg.allowed).toBe(false);
    expect(sg.reasons.some((r) => r.startsWith("budget_step_"))).toBe(true);
    expect(sg.reasons.some((r) => r.startsWith("cooldown_active_"))).toBe(true);

    // Sweep cleans expired locks & old unconsumed nonces
    mintApprovalNonce(db, { projectId: "p1", actionId: "old", payload: {}, ttlMs: 1_000, nowMs: now - 100_000_000 });
    expect(spSweep(db, now).purgedNonces).toBe(1);
  });

  it("loads the 480-question native bank, merges shadow questions.ext.json, triages with cooldowns, and checks Wilson/RU calendar/E-07/E-11", () => {
    const db = freshDb();
    const bank = loadQuestionBank();
    expect(bank.questions.length).toBe(480);

    const tmp = mkdtempSync(join(tmpdir(), "sp-q-"));
    mkdirSync(join(tmp, ".agents", "marketing"), { recursive: true });
    writeFileSync(
      join(tmp, ".agents", "marketing", "questions.ext.json"),
      JSON.stringify({
        questions: [
          {
            question_id: "SHD-MKT-001",
            domain: "marketing",
            target_graphs: ["mkt-project-intake"],
            trigger_situation: "bot payment webhook attribution",
            contour: "intake_cold_start",
            question_ru: "Передаёт ли бот start_param в платёжный вебхук?",
            options_ru: ["Да", "Нет"],
            safe_default: "Нет",
            impact_weight: 0.92,
            ttl_days: 30,
            periodic_reverify_query: "webhook_check",
            auto_resolvable_via_mcp: false,
            source_citation: "osipenkov-2026",
          },
        ],
      }),
    );

    const merged = loadMergedQuestions(tmp, "marketing");
    expect(merged.length).toBe(481);

    const triaged = triageQuestions(db, {
      projectId: "p1",
      domain: "marketing",
      mode: "intake",
      checkoutPath: tmp,
      top: 5,
      nowMs: 1_760_000_000_000,
    });
    expect(triaged.due_count).toBeGreaterThan(5);
    expect(triaged.selected_count).toBeLessThanOrEqual(5);

    recordQuestionAnswer(db, {
      projectId: "p1",
      questionId: "SHD-MKT-001",
      domain: "marketing",
      answerText: "Да",
      ttlDays: 10,
      nowMs: 1_760_000_000_000,
    });

    // Wilson lower bound + autonomy promotion gate
    expect(wilsonLowerBound(29, 30)).toBeGreaterThan(0.8);
    expect(evaluateAutonomyGate({ actionClass: "analysis_propose", samplesN: 30, successesK: 29, cohenKappa: 0.75 }).allowedClass).toBe("bounded_auto");
    expect(evaluateAutonomyGate({ actionClass: "live_budget", samplesN: 30, successesK: 30, cohenKappa: 0.9, highRisk: true }).allowedClass).toBe("propose");

    // RU calendar seasonality check (New Year holidays)
    expect(checkRuSeasonality("2026-01-04").holidayId).not.toBeNull();

    // E-07: snapshotLessonProblem rejects dated KPI snapshots, accepts timeless rules
    expect(snapshotLessonProblem("2026-11-10 CPA = 450₽ и CTR 3.2% в кампании Поиск")).not.toBeNull();
    expect(snapshotLessonProblem("При росте автотаргетинга в ЕПК проверять долю широких синонимов через поисковые запросы.")).toBeNull();

    // E-11: roleSpec blocks direct helper edits to engine-owned Specialist OS files
    const gmSpec = roleSpec("specialist:growth-marketer");
    expect(gmSpec.editable(".agents/marketing/charter.json")).toBe(false);
    expect(gmSpec.editable(".agents/seo/memory/ledger.json")).toBe(false);
    expect(gmSpec.editable(".agents/marketing/questions.ext.json")).toBe(false);
    expect(gmSpec.editable(".agents/marketing/intake/brief.md")).toBe(true);
  });
});
