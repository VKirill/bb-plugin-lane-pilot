import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getCharter, listActiveLocks, upsertCharter } from "../../src/rooms/specialist/server";
import { setupLiveSpecialistEnv } from "./live-e2e-harness";

/**
 * Live end-to-end execution of all 7 Marketing shelf (`category === "marketing"`) workflows
 * on the real `WorkflowEngine` + real SQLite `lane_pilot_sp_*` tables + real temporary git checkout
 * + real verified Python scripts (`python3`) + real BB owner approval interactions.
 */
let cleanup: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

const SAMPLE_CODE_ORDER = {
  kind: "code_task",
  title: "Добавить передачу start_param в webhook оплаты",
  domain: "marketing",
  reason_code: "tracking_gap",
  action_class: "code_fix",
  is_stop_or_kill: false,
  requires_owner_go: false,
  tariff_known: true,
  estimated_cost_usd: 0.25,
};

const SAMPLE_SUBGRAPH_ORDER = {
  kind: "sub_graph",
  title: "Запустить аудит конверсии посадочной страницы",
  domain: "marketing",
  reason_code: "low_message_match",
  action_class: "analysis_propose",
  workflow_id: "mkt-landing-cro-audit",
  is_stop_or_kill: false,
  requires_owner_go: false,
  tariff_known: true,
  estimated_cost_usd: 0.2,
};

describe("Live E2E: Marketing shelf workflows (7/7 graphs)", () => {
  it("1. mkt-project-intake: cold-start bot intake runs unit_economics_check.py, sets charter v1 on owner approval, and dispatches outbox", async () => {
    const t = await setupLiveSpecialistEnv({
      discover: ({ checkout }) => {
        const rel = ".agents/marketing/intake/brief.json";
        t.writeCheckoutJson(rel, { product: "Telegram SaaS Bot", arpu_eur: 29, gross_margin: 0.82 });
        return {
          brief_path: rel,
          funnel_steps: ["ad_click", "bot_start", "trial", "payment"],
          counters_found: ["metrika:991122"],
          payment_source: "yookassa_webhook",
          facts_missing: ["exact_churn_90d"],
        };
      },
      baseline: {
        baseline_path: ".agents/marketing/intake/baseline.json",
        priors_json: JSON.stringify({ cpc_eur: 0.45, cr_bot_start: 0.38 }),
      },
      charter: {
        charter_draft_json: JSON.stringify({
          goal: "150 платящих подписчиков в месяц",
          max_cac_eur: 35,
          channels: ["tg_ads", "yandex_direct"],
        }),
        tracking_ok: false,
        first_graph: "mkt-tracking-setup",
        orders: [SAMPLE_CODE_ORDER],
        owner_questions: [{ id: "Q1", text: "Подтвердите дневной лимит 30 EUR?" }],
        needs_owner_go: true,
      },
      audit: { status: "pass", findings: [], reasons: "Устав и расчёт юнит-экономики согласованы." },
    });
    cleanup = t.dispose;

    const { summary, answeredFormsCount } = await t.runWorkflowLive("mkt-project-intake", {
      project_url: "https://t.me/example_saas_bot",
      product_kind: "tg_bot",
      has_paid_traffic: false,
      analytics_stack: "metrika",
      budget_monthly_eur: 900,
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(1);
    expect(summary.output).toMatchObject({
      status: "done",
      charter_version: 1,
      first_graph: "mkt-tracking-setup",
      dispatched_count: 1,
    });

    const savedCharter = getCharter(t.db, t.projectId, "marketing");
    expect(savedCharter?.version).toBe(1);
    expect(existsSync(join(t.checkout, ".agents/marketing/charter.json"))).toBe(true);
    expect(existsSync(join(t.checkout, ".agents/marketing/reports/mkt-project-intake-unit_econ.json"))).toBe(true);
  });

  it("2. mkt-tracking-setup: runs utm_validator.py + funnel_reconcile.py, applies Tier L live mutation with HMAC nonce, and dispatches code tasks", async () => {
    const t = await setupLiveSpecialistEnv({
      inventory: {
        inventory_path: ".agents/marketing/tracking/inventory.json",
        counters: 2,
        goals_found: ["bot_start", "purchase"],
        gaps: ["missing_yookassa_client_id"],
      },
      design: {
        telemetry_map_path: ".agents/marketing/tracking/telemetry-map.json",
        code_tasks: [SAMPLE_CODE_ORDER],
        live_changes: [{ entity_id: "metrika_goal_purchase", mutation_kind: "goal_upsert" }],
        live_change_count: 1,
        needs_owner_go: true,
      },
      audit: { status: "pass", findings: [], reasons: "UTM и сверка воронки корректны." },
    });
    cleanup = t.dispose;
    upsertCharter(t.db, { projectId: t.projectId, domain: "marketing", charter: { max_cac_eur: 35 } });

    const { summary, answeredFormsCount } = await t.runWorkflowLive("mkt-tracking-setup", {
      site_url: "https://example-saas.ru",
      stack: "both",
      channel_scope: "web_and_bot",
      apply_live: true,
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(1);
    expect(summary.output).toMatchObject({
      status: "done",
      live_changes_applied: 1,
      dispatched_count: 1,
    });
    expect(typeof summary.output?.discrepancy_pct).toBe("number");

    const mutRows = t.db.prepare("SELECT * FROM lane_pilot_sp_mutation_log WHERE project_id = ?").all(t.projectId);
    expect(mutRows.length).toBe(1);
    expect(existsSync(join(t.checkout, ".agents/marketing/reports/mkt-tracking-setup-reconcile.json"))).toBe(true);
  });

  it("3. mkt-direct-search-campaign: runs preflight triage, morphology, seo_ppc_bridge, epk_combinatorics_lint, message_match, and live launch", async () => {
    const t = await setupLiveSpecialistEnv({
      semantics: () => {
        const clustersRel = ".agents/marketing/direct/clusters.json";
        t.writeCheckoutJson(clustersRel, {
          queries: ["купить crm систему цена", "внедрение crm под ключ москва", "crm для отдела продаж тарифы"],
        });
        return {
          clusters_path: clustersRel,
          organic_path: ".agents/marketing/direct/organic.json",
          clusters_count: 2,
          queries_count: 3,
        };
      },
      ads: () => {
        const adsRel = ".agents/marketing/direct/ads.json";
        t.writeCheckoutJson(adsRel, {
          ads: [
            { id: "ad_1", title: "CRM для отдела продаж", body: "Внедрение за 3 дня, тариф от 1900 ₽", url: "https://crm-example.ru" },
          ],
        });
        return { ads_path: adsRel, ad_groups: 2, combinations: 6, erid_ok: true };
      },
      plan: {
        campaign_path: ".agents/marketing/direct/campaign-plan.json",
        change_set: [{ entity_id: "direct_epk_01", mutation_kind: "budget_edit", current_value: 100, next_value: 112 }],
        orders: [SAMPLE_SUBGRAPH_ORDER],
        spend_eur: 30,
        needs_owner_go: true,
      },
      audit: { status: "pass", findings: [], reasons: "ЕПК комбинаторика, кросс-минусация и message match прошли." },
    });
    cleanup = t.dispose;
    upsertCharter(t.db, { projectId: t.projectId, domain: "marketing", charter: { daily_budget_eur: 50 } });

    const { summary, answeredFormsCount } = await t.runWorkflowLive("mkt-direct-search-campaign", {
      landing_url: "https://crm-example.ru/sales-crm",
      campaign_type: "unified_epk",
      strategy: "auto_cpa",
      launch: true,
      daily_budget_eur: 30,
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(1);
    expect(summary.output).toMatchObject({
      status: "launched",
      ad_groups: 2,
      dispatched_count: 1,
    });
    expect(existsSync(join(t.checkout, ".agents/marketing/reports/mkt-direct-search-campaign-combinatorics.json"))).toBe(true);
    expect(existsSync(join(t.checkout, ".agents/marketing/reports/mkt-direct-search-campaign-message_match.json"))).toBe(true);
  });

  it("4. mkt-tg-ads-campaign: runs preflight, tg_moderation_lint, tg_start_attribution, message_match, owner approval, and experiment lock", async () => {
    const t = await setupLiveSpecialistEnv({
      pools: { pools_path: ".agents/marketing/tg/pools.json", pools_count: 3, excluded_count: 2 },
      ads: () => {
        const adsRel = ".agents/marketing/tg/ads.json";
        t.writeCheckoutJson(adsRel, {
          ads: [
            { id: "tg1", text: "Аналитика продаж для селлеров в Telegram-боте. Попробуйте демо за 2 минуты.", start_param: "tg_pack1_ad1" },
          ],
        });
        return { ads_path: adsRel, ads_count: 3 };
      },
      plan: {
        campaign_path: ".agents/marketing/tg/campaign.json",
        launch_plan: [{ pool: "pack_1", cpm_eur: 2.1 }],
        orders: [SAMPLE_CODE_ORDER],
        spend_eur: 25,
        needs_owner_go: true,
      },
      audit: { status: "pass", findings: [], reasons: "Модерация TG Ads (0 нарушений) и start-атрибуция проверены." },
      launch: { launched_ads: 3, receipt_path: ".agents/marketing/tg/launch-receipt.json", launch_status: "ok" },
    });
    cleanup = t.dispose;
    upsertCharter(t.db, { projectId: t.projectId, domain: "marketing", charter: { daily_budget_eur: 40 } });

    const { summary, answeredFormsCount } = await t.runWorkflowLive("mkt-tg-ads-campaign", {
      offer: "Аналитика продаж для селлеров в Telegram-боте",
      objective: "bot_starts",
      pool_mode: "topic_pack",
      launch: true,
      daily_budget_eur: 25,
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(1);
    expect(summary.output).toMatchObject({
      status: "launched",
      ads_count: 3,
      dispatched_count: 1,
    });
    expect(String(summary.output?.lock_id)).toMatch(/^lock_/);
  });

  it("5. mkt-experiment-cycle: executes both design (mde_monte_carlo.py + lock creation) and evaluate (bucketing_split.py + scale decision)", async () => {
    let phaseMode: "design" | "evaluate" = "design";
    const t = await setupLiveSpecialistEnv({
      work: () =>
        phaseMode === "design"
          ? {
              decision: "running",
              hypothesis_id: "HYP-TG-014",
              lock_spec_json: JSON.stringify({ scope_type: "experiment", scope_value: "landing:/promo-bot" }),
              orders: [SAMPLE_CODE_ORDER],
              learning: "Зафиксирован MDE и бакетинг 50/50.",
              needs_owner_go: true,
            }
          : {
              decision: "scaled",
              hypothesis_id: "HYP-TG-014",
              lock_spec_json: "{}",
              orders: [],
              learning: "SRM ok, uplift подтверждён на зрелой когорте.",
              needs_owner_go: true,
            },
      audit: { status: "pass", findings: [], reasons: "Дизайн и чтение эксперимента статистически корректны." },
    });
    cleanup = t.dispose;
    upsertCharter(t.db, { projectId: t.projectId, domain: "marketing", charter: { cell_cap_eur: 250 } });

    const designRun = await t.runWorkflowLive("mkt-experiment-cycle", {
      hypothesis: "Если вынести калькулятор экономии в первый экран, CR вырастет на 20%",
      channel: "landing",
      phase: "design",
      cell_budget_eur: 35,
    });
    expect(designRun.summary.status).toBe("succeeded");
    expect(designRun.summary.output).toMatchObject({
      status: "running",
      hypothesis_id: "HYP-TG-014",
      dispatched_count: 1,
    });
    expect(Number(designRun.summary.output?.required_events)).toBeGreaterThan(0);
    expect(listActiveLocks(t.db, t.projectId, "marketing").length).toBe(1);

    phaseMode = "evaluate";
    const evalRun = await t.runWorkflowLive("mkt-experiment-cycle", {
      hypothesis: "Оценка гипотезы HYP-TG-014",
      channel: "landing",
      phase: "evaluate",
      lock_id: String(designRun.summary.output?.lock_id ?? ""),
    });
    expect(evalRun.summary.status).toBe("succeeded");
    expect(evalRun.summary.output).toMatchObject({
      status: "scaled",
      hypothesis_id: "HYP-TG-014",
    });
  });

  it("6. mkt-landing-cro-audit: runs cro_speed_signals.py + message_match.py and dispatches A/B variant task", async () => {
    const t = await setupLiveSpecialistEnv({
      capture: () => {
        const capRel = ".bb/chats/cro-screens.json";
        t.writeCheckoutJson(capRel, {
          url: "https://crm-example.ru",
          h1: "CRM для отдела продаж за 3 дня",
          title: "CRM система — тарифы от 1900 ₽",
          first_screen: "Внедрение CRM с гарантией и интеграцией телефонии",
        });
        return {
          screens_path: capRel,
          h1: "CRM для отдела продаж за 3 дня",
          offer_text: "Внедрение за 3 дня",
          price_text: "от 1900 ₽",
          cta_count: 2,
        };
      },
      analyze: {
        cro_path: ".agents/marketing/cro/audit.md",
        hypotheses: [
          { id: "CRO-1", target: "hero_cta", expected_lift: 0.14 },
          { id: "CRO-2", target: "mobile_lcp", expected_lift: 0.09 },
        ],
        orders: [SAMPLE_CODE_ORDER],
        needs_owner_go: false,
      },
      audit: { status: "pass", findings: [], reasons: "Скорость и соответствие оффера проверены." },
    });
    cleanup = t.dispose;

    const { summary } = await t.runWorkflowLive("mkt-landing-cro-audit", {
      landing_url: "https://crm-example.ru",
      traffic_source: "direct",
      device_focus: "mobile",
      build_variant: true,
    });

    expect(summary.status).toBe("succeeded");
    expect(summary.output).toMatchObject({
      status: "done",
      hypotheses: 2,
      dispatched_count: 1,
    });
    expect(typeof summary.output?.message_match_score).toBe("number");
  });

  it("7. mkt-pulse-monitor: runs product_alerts.py + metric_forecast.py + breaker + question triage + cursor advance", async () => {
    const t = await setupLiveSpecialistEnv({
      classify: {
        alert_level: "act",
        causes: [{ metric: "cpa", delta_pct: 28, channel: "tg_ads" }],
        orders: [SAMPLE_SUBGRAPH_ORDER],
        summary: "Обнаружен всплеск CPA в одном пуле каналов; запланирована диагностика.",
        needs_owner_go: false,
      },
      audit: { status: "pass", findings: [], reasons: "Алерт подтверждён вне праздничного окна." },
    });
    cleanup = t.dispose;
    upsertCharter(t.db, { projectId: t.projectId, domain: "marketing", charter: { max_cac_eur: 35 } });

    const { summary } = await t.runWorkflowLive("mkt-pulse-monitor", {
      window: "daily",
      scope: "all",
      quiet: false,
    });

    expect(summary.status).toBe("succeeded");
    expect(summary.output).toMatchObject({
      dispatched_count: 1,
    });
    const cursors = t.db.prepare("SELECT * FROM lane_pilot_sp_cursor WHERE project_id = ?").all(t.projectId);
    expect(cursors.length).toBeGreaterThanOrEqual(1);
    const receiptPath = join(t.checkout, String(summary.output?.report_path ?? ""));
    expect(existsSync(receiptPath)).toBe(true);
    const intentsCommitPath = join(t.checkout, ".agents/marketing/memory/commit-mkt-pulse-monitor-commit_intents.json");
    expect(JSON.parse(readFileSync(intentsCommitPath, "utf8")).stagedCount).toBe(1);
  });
});
