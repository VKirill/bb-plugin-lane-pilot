import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { listActiveLocks, upsertCharter } from "../../src/rooms/specialist/server";
import { setupLiveSpecialistEnv } from "./live-e2e-harness";

/**
 * Live end-to-end execution of all 6 SEO shelf (`category === "seo"`) workflows
 * and both remaining Service shelf (`category === "service"`) Specialist OS workflows
 * on the real `WorkflowEngine` + real SQLite + real git checkout + real Python scripts.
 */
let cleanup: (() => Promise<void> | void) | null = null;
afterEach(async () => {
  await cleanup?.();
  cleanup = null;
});

const SEO_CODE_ORDER = {
  kind: "code_task",
  title: "Добавить llms.txt и FAQPage JSON-LD на коммерческие шаблоны",
  domain: "seo",
  reason_code: "ai_citation_gap",
  action_class: "code_fix",
  is_stop_or_kill: false,
  requires_owner_go: false,
  tariff_known: true,
  estimated_cost_usd: 0.25,
};

describe("Live E2E: SEO shelf (6/6 graphs) & Service shelf (2/2 graphs)", () => {
  it("1. seo-ai-visibility: runs ai_vis_panel, ai_vis_collect, ai_vis_score, agent_ready_audit, ai_vis_diagnose, and dispatches orders", async () => {
    const t = await setupLiveSpecialistEnv({
      panel_seed: { seed_path: ".agents/seo/ai-visibility/seed.json", seed_questions: 20 },
      plan: {
        summary: "Доля цитирования в Alice AI и Google AIO ниже конкурентов; ставим задачу на llms.txt и FAQPage.",
        orders: [SEO_CODE_ORDER],
        needs_owner_go: false,
      },
      audit: { status: "pass", findings: [], reasons: "Панель сбалансирована, стоимость API в лимите." },
    });
    cleanup = t.dispose;
    upsertCharter(t.db, { projectId: t.projectId, domain: "seo", charter: { site: "https://example.ru" } });

    const { summary } = await t.runWorkflowLive("seo-ai-visibility", {
      site_url: "https://example.ru",
      engines: "all",
      mode: "baseline",
      agent_ready: true,
      panel_size: 20,
    });

    expect(summary.status).toBe("succeeded");
    expect(summary.output).toMatchObject({
      status: "done",
      dispatched_count: 1,
    });
    expect(typeof summary.output?.citation_share).toBe("number");
    expect(typeof summary.output?.agent_ready_score).toBe("number");
    expect(existsSync(join(t.checkout, String(summary.output?.matrix_path)))).toBe(true);
  });

  it("2. seo-monitor (upgraded): runs pulse_02_backtest.py, pulse_rules.py, ai_vis_collect.py (monthly), and writes report via fs.write", async () => {
    const t = await setupLiveSpecialistEnv({
      pull: { pull_path: ".agents/seo/monitor/pull.json", urls: 120 },
      tech_watch: { watch_path: ".agents/seo/monitor/watch.json", alerts: [] },
      anomalies: { anomalies_path: ".agents/seo/monitor/anomalies.json", buckets: 3 },
      queue: { queue_path: ".agents/seo/monitor/queue.json", queued: 4 },
      links_review: { links_path: ".agents/seo/monitor/links.json", verdicts: ["clean_anchors"] },
      cadence: { cadence_path: ".agents/seo/monitor/cadence.json" },
      route: {
        status: "pass",
        signals: ["striking_distance_4_pages"],
        recommendations: ["Обновить 4 страницы на позициях 5-12"],
        drop_due: false,
        refresh_due: false,
        structure_due: false,
        tech_due: false,
        release_due: false,
        ai_visibility_due: false,
      },
    });
    cleanup = t.dispose;

    const { summary } = await t.runWorkflowLive("seo-monitor", {
      site_url: "https://example.ru",
      period: "monthly",
      link_campaign: true,
    });

    expect(summary.status).toBe("succeeded");
    expect(summary.output).toMatchObject({
      status: "done",
      queue_path: ".agents/seo/monitor/queue.json",
      recommendations: ["Обновить 4 страницы на позициях 5-12"],
    });
    expect(String(summary.output?.report_path)).toMatch(/^\.agents\/seo\/monitor\/\d{4}-\d{2}-\d{2}-wfrun_[0-9a-f]+\/$/);
    expect(existsSync(join(t.checkout, ".agents/seo/reports/seo-monitor-pulse_rules.json"))).toBe(true);
    expect(existsSync(join(t.checkout, ".agents/seo/reports/seo-monitor-ai_watch.json"))).toBe(true);
  });

  it("3. seo-tech-audit (upgraded): answers access, runs 3-way intake + agent_ready_audit.py + 12-way specialists fan-out, and dispatches code_tasks", async () => {
    const t = await setupLiveSpecialistEnv({
      "intake:child": ({ nodeId, visit }) => ({
        findings_paths: [`.agents/seo/tech/intake-${visit}.md`],
        defects: [],
        skipped: false,
        skipped_branches: [],
        handoff: `intake ${nodeId}#${visit}`,
      }),
      "specialists:child": ({ visit }) => ({
        findings_paths: [`.agents/seo/tech/spec-${visit}.md`],
        defects: [],
        skipped: false,
        skipped_branches: [],
      }),
      matrix: { matrix_path: ".agents/seo/tech/matrix.json", rows: 15 },
      backlog: {
        backlog_path: ".agents/seo/tech/backlog.json",
        tickets: 2,
        release_items: ["https://example.ru/llms.txt"],
        code_tasks: [SEO_CODE_ORDER],
      },
      critic: { status: "pass", findings: [] },
    });
    cleanup = t.dispose;

    const { summary, answeredFormsCount } = await t.runWorkflowLive("seo-tech-audit", {
      site_url: "https://example.ru",
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(1);
    expect(summary.output).toMatchObject({
      status: "done",
      matrix_path: ".agents/seo/tech/matrix.json",
      backlog_path: ".agents/seo/tech/backlog.json",
      dispatched_count: 1,
    });
    expect(typeof summary.output?.agent_ready_score).toBe("number");
  });

  it("4. seo-template-scale (upgraded bofu_programmatic): runs cannibalization_guard, offerist_similarity, cf_batch_handoff, and dispatches Content Factory canary wave", async () => {
    const t = await setupLiveSpecialistEnv({
      passports: { passports_path: ".agents/seo/scale/passports.json" },
      bofu_matrix: { matrix_path: ".agents/seo/scale/bofu-matrix.json", rows: 12 },
      critic: { status: "pass", verdict_path: ".agents/seo/scale/verdict.md", pilot_items: ["/vs/comp-a"] },
    });
    cleanup = t.dispose;

    const { summary, answeredFormsCount } = await t.runWorkflowLive("seo-template-scale", {
      mode: "bofu_programmatic",
      target: "https://example.ru",
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(1);
    expect(summary.output).toMatchObject({
      status: "done",
      passports_path: ".agents/seo/scale/passports.json",
      verdict_path: ".agents/seo/scale/verdict.md",
    });
    expect(String(summary.output?.cf_batch_id)).toMatch(/^cfb_/);

    const intents = t.db.prepare("SELECT status FROM lane_pilot_sp_intent WHERE project_id = ?").all(t.projectId) as Array<{ status: string }>;
    expect(intents.length).toBeGreaterThanOrEqual(1);
  });

  it("5. seo-release (upgraded): runs release_graph_sim.py premortem, owner approval, indexnow_push.py, and acquires 21-day seo_indexation lock", async () => {
    const t = await setupLiveSpecialistEnv({
      baseline: { change_log_path: ".agents/seo/release/changelog.json", cohort: "bofu-2026-11" },
      plan: { plan_path: ".agents/seo/release/plan.json" },
      redirects: () => {
        const p = ".agents/seo/release/redirects.json";
        t.writeCheckoutJson(p, {
          before: { "https://example.ru/old": { status: 200, canonical: "https://example.ru/old" } },
          after: {
            "https://example.ru/old": { status: 301, location: "https://example.ru/vs/comp-a" },
            "https://example.ru/vs/comp-a": { status: 200, canonical: "https://example.ru/vs/comp-a" },
          },
        });
        return { redirect_map_path: p };
      },
      staging_qa: { status: "pass", qa_path: ".agents/seo/release/staging-qa.md" },
      publish: { publish_status: "ok" },
      prod_qa: { status: "pass" },
      submit: { submit_path: ".agents/seo/release/submit.json", requested: 2 },
      index_check: { index_status_path: ".agents/seo/release/index-status.json", not_indexed: [] },
    });
    cleanup = t.dispose;

    const { summary, answeredFormsCount } = await t.runWorkflowLive("seo-release", {
      items: ["https://example.ru/vs/comp-a", "https://example.ru/vs/comp-b"],
      mode: "new_batch",
      url_changes: true,
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(1);
    expect(summary.output).toMatchObject({
      status: "done",
    });
    expect(Number(summary.output?.indexnow_pushed)).toBeGreaterThanOrEqual(1);

    const locks = listActiveLocks(t.db, t.projectId, "seo");
    expect(locks.length).toBe(2);
    expect(locks[0]?.scope_type).toBe("seo_indexation");
  });

  it("6. seo-drop-diagnosis (upgraded): runs drop_window_split.py + channel_isolation.py + 10-way layers fan-out + owner review + pilot dispatch", async () => {
    const t = await setupLiveSpecialistEnv({
      intake: {
        status: "proceed",
        freeze_due: "",
        log_path: ".agents/seo/drop/log.json",
        windows_path: ".agents/seo/drop/windows.json",
      },
      mechanism: { mechanism_path: ".agents/seo/drop/mechanism.md", labels: ["intent_shift"] },
      scope: { scope: "template", scope_path: ".agents/seo/drop/scope.md" },
      "layers:child": ({ visit }) => ({
        findings_paths: [`.agents/seo/drop/layer-${visit}.md`],
        defects: [],
        skipped: false,
        skipped_branches: [],
      }),
      contour: { contour: "template", contour_path: ".agents/seo/drop/contour.md" },
      hypotheses: {
        hypotheses_path: ".agents/seo/drop/hypotheses.md",
        pilot_path: ".agents/seo/drop/pilot.md",
        top_count: 2,
        followup_orders: [SEO_CODE_ORDER],
      },
      critic: { status: "pass", findings: [] },
    });
    cleanup = t.dispose;

    const { summary, answeredFormsCount } = await t.runWorkflowLive("seo-drop-diagnosis", {
      site_url: "https://example.ru",
      affected_urls: ["https://example.ru/catalog/crm"],
    });

    expect(summary.status).toBe("succeeded");
    expect(answeredFormsCount).toBe(1);
    expect(summary.output).toMatchObject({
      status: "done",
      hypotheses_path: ".agents/seo/drop/hypotheses.md",
      pilot_path: ".agents/seo/drop/pilot.md",
      dispatched_count: 1,
    });
  });

  it("7. sp-specialist-tick (service): runs marketing & seo shifts with G-11 tick lease + dedupes repeated slot as skipped_overlap", async () => {
    const t = await setupLiveSpecialistEnv({
      plan_mkt: {
        orders: [
          {
            kind: "sub_graph",
            title: "Проверить посадочную страницу после роста отказов",
            domain: "marketing",
            reason_code: "bounce_spike",
            action_class: "analysis_propose",
            workflow_id: "mkt-landing-cro-audit",
            is_stop_or_kill: false,
            requires_owner_go: false,
            tariff_known: true,
            estimated_cost_usd: 0.2,
          },
        ],
        owner_questions: [],
        forecast: "{}",
        new_shadow_questions: [],
        needs_owner_go: false,
      },
      plan_seo: {
        orders: [SEO_CODE_ORDER],
        owner_questions: [],
        forecast: "{}",
        new_shadow_questions: [],
        needs_owner_go: false,
      },
      audit: { status: "pass", findings: [], reasons: "Смена специалиста прошла чисто." },
    });
    cleanup = t.dispose;
    upsertCharter(t.db, { projectId: t.projectId, domain: "marketing", charter: { max_cac_eur: 35 } });
    upsertCharter(t.db, { projectId: t.projectId, domain: "seo", charter: { site: "https://example.ru" } });

    const mktShift = await t.runWorkflowLive("sp-specialist-tick", {
      domain: "marketing",
      mode: "daily_sweep",
      slot: "daily_sweep:2026-11-12",
    });
    expect(mktShift.summary.status).toBe("succeeded");
    expect(mktShift.summary.output).toMatchObject({
      status: "done",
      dispatched_count: 1,
    });

    // Re-running the exact same completed slot hits G-11 single-flight / completed-slot guard -> skipped_overlap
    const dupSlot = await t.runWorkflowLive("sp-specialist-tick", {
      domain: "marketing",
      mode: "daily_sweep",
      slot: "daily_sweep:2026-11-12",
    });
    expect(dupSlot.summary.status).toBe("succeeded");
    expect(dupSlot.summary.output).toMatchObject({ status: "skipped_overlap" });

    // SEO domain runs its own independent lease & pulse_probe.py
    const seoShift = await t.runWorkflowLive("sp-specialist-tick", {
      domain: "seo",
      mode: "daily_sweep",
      slot: "daily_sweep:2026-11-12",
    });
    expect(seoShift.summary.status).toBe("succeeded");
    expect(seoShift.summary.output).toMatchObject({
      status: "done",
      dispatched_count: 1,
    });
  });
});
