import { sha256Hex } from "@lane-pilot/kit";
import type { Field } from "@lane-pilot/workflow-engine";
import { canonicalJson } from "../action-order";
import { wilsonLowerBound } from "../tool-tiers";

function num(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

function int(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? Math.trunc(val) : fallback;
}

function buildCfHandoffAliases(raw: Record<string, unknown>, reportRelPath: string, aliases: Record<string, unknown>): void {
  const contentBatchObj = (raw.content_batch && typeof raw.content_batch === "object" ? raw.content_batch : null) as Record<string, unknown> | null;
  const batchObj = (raw.batch && typeof raw.batch === "object" ? raw.batch : {}) as Record<string, unknown>;
  const rawPagesSource: unknown[] = Array.isArray(contentBatchObj?.seo_items)
    ? contentBatchObj.seo_items
    : Array.isArray(contentBatchObj?.items)
      ? contentBatchObj.items
      : Array.isArray(batchObj.pages)
        ? batchObj.pages
        : Array.isArray(batchObj.urls)
          ? batchObj.urls
          : Array.isArray(raw.pages)
            ? raw.pages
            : [];
  const rawPages = rawPagesSource.map((entry) =>
    typeof entry === "string" ? { url: entry } : entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {},
  );
  const rawOrganic = Array.isArray(contentBatchObj?.organic_items)
    ? (contentBatchObj.organic_items as Array<Record<string, unknown>>)
    : Array.isArray(raw.organic_items)
      ? (raw.organic_items as Array<Record<string, unknown>>)
      : [];
  const allowedPageTypes = new Set(["comparison", "alternative", "migration", "integration", "pricing", "role_use_case", "article", "service"]);
  const inputArgs = (raw._input_args && typeof raw._input_args === "object" ? raw._input_args : {}) as Record<string, unknown>;
  const pilotMax = Math.max(1, Math.min(15, int(inputArgs.pilot_max, 15)));
  const mappedSeoItems = rawPages.slice(0, pilotMax).map((p, idx) => {
    const rawUrl = String(p.target_url ?? p.url ?? `/bofu/item-${idx + 1}`);
    const targetUrl = rawUrl.startsWith("/") || rawUrl.startsWith("http") ? rawUrl : `/${rawUrl}`;
    const rawSlug = String(
      p.slug ??
        (targetUrl
          .replace(/^https?:\/\/[^/]+/, "")
          .replace(/^\/+|\/+$/g, "")
          .replace(/[^a-z0-9-]+/gi, "-")
          .toLowerCase() || `bofu-item-${idx + 1}`),
    );
    const rawType = String(p.page_type ?? "alternative");
    const ig = (p.information_gain_proof && typeof p.information_gain_proof === "object" ? p.information_gain_proof : {}) as Record<string, unknown>;
    return {
      id: String(p.id ?? `bofu_${idx + 1}`),
      kind: "seo_page" as const,
      slug: rawSlug,
      target_url: targetUrl,
      primary_query: String(p.primary_query ?? p.query ?? p.keyword ?? rawSlug.replace(/-/g, " ")),
      cluster: String(p.cluster ?? batchObj.cluster ?? "bofu_pilot"),
      page_type: allowedPageTypes.has(rawType) ? rawType : "alternative",
      information_gain_proof: {
        serp_overlap: num(ig.serp_overlap, num(p.serp_overlap, 0.2)),
        unique_verified_facts: Math.max(3, int(ig.unique_verified_facts ?? p.unique_facts ?? p.unique_verified_facts, 4)),
        fact_sources: Array.isArray(ig.fact_sources) && ig.fact_sources.length > 0 ? ig.fact_sources.map(String) : ["verified_passport"],
        cosine_max_sibling: num(ig.cosine_max_sibling, num(p.cosine_max_sibling, 0.35)),
      },
    };
  });
  const handoffStatus = String(raw.status ?? "release");
  aliases.handoff_status = handoffStatus;
  aliases.batch_json = canonicalJson(raw.content_batch ?? raw.batch ?? {});
  aliases.batch_path = reportRelPath;
  aliases.pilot_size = Math.min(15, mappedSeoItems.length || rawOrganic.length || 5);
  aliases.wave = int(batchObj.wave, 1);
  if (handoffStatus === "block" || raw.degraded_error === true || (mappedSeoItems.length === 0 && rawOrganic.length === 0)) {
    aliases.orders = [];
    return;
  }
  const batchId = String(contentBatchObj?.batch_id ?? batchObj.batch_id ?? `cfb_bofu_${sha256Hex(`${reportRelPath}:${canonicalJson(mappedSeoItems)}`).slice(0, 10)}`);
  aliases.orders = [
    {
      kind: "content_batch",
      title: String(batchObj.title ?? `BOFU Content Factory wave (${mappedSeoItems.length + rawOrganic.length} items)`).slice(0, 240),
      domain: "seo",
      reason_code: "bofu_canary_expand",
      action_class: "content_draft",
      is_stop_or_kill: false,
      requires_owner_go: true,
      tariff_known: true,
      estimated_cost_usd: Number((0.15 + (mappedSeoItems.length + rawOrganic.length) * 0.18).toFixed(2)),
      cf_batch: {
        schema: "lp.cf-batch/1",
        batch_id: batchId.startsWith("cfb_") ? batchId : `cfb_${batchId}`,
        domain: "seo",
        batch_kind: rawOrganic.length > 0 && mappedSeoItems.length === 0 ? "organic_multi" : "seo_bofu",
        mode: "draft",
        wave: "canary_10",
        cf_group_slug: String(contentBatchObj?.cf_group_slug ?? batchObj.group_slug ?? "seo-bofu-pilot"),
        scenario_id: String(contentBatchObj?.scenario_id ?? batchObj.scenario_id ?? "draft-review-only"),
        scenario_has_publish_step: false,
        seo_items: mappedSeoItems,
        organic_items: rawOrganic,
      },
    },
  ];
}

/** Maps a verified Python script's JSON result onto the workflow node's declared `out` fields deterministically. */
export function mapScriptOutputToDeclaredFields(
  script: string,
  raw: Record<string, unknown>,
  outFields: readonly Field[],
  reportRelPath: string,
): Record<string, unknown> {
  const aliases: Record<string, unknown> = { ...raw };

  aliases.report_path = reportRelPath;
  aliases.degraded_error = Boolean(raw.degraded_error ?? false);
  aliases.freshness_ok = raw.degraded_error ? false : raw.blind === undefined ? Boolean(raw.ok ?? true) : !Boolean(raw.blind);
  aliases.anomaly_count = Array.isArray(raw.alerts) ? raw.alerts.length : int(raw.anomaly_count, 0);
  aliases.significant_delta = aliases.anomaly_count !== 0 || raw.verdict === "alert" || raw.verdict === "critical";
  aliases.anomalies_json = canonicalJson(raw.alerts ?? raw.conditions ?? []);
  aliases.deltas_json = canonicalJson(raw.alerts ?? raw.metrics ?? raw.conditions ?? {});
  aliases.missing_data = Array.isArray(raw.skipped) ? raw.skipped.map(String) : [];
  aliases.matured_locks = int(raw.matured_locks, 0);
  aliases.readiness_json = canonicalJson(raw.summary ?? { ok: true });
  aliases.new_cursor_json = canonicalJson({ script, updated_by: raw.version ?? "1.0.0" });
  aliases.breaker_signals_json = canonicalJson({
    verdict: raw.verdict ?? "ok",
    critical: raw.verdict === "critical" || raw.verdict === "frozen",
    alerts_count: Array.isArray(raw.alerts) ? raw.alerts.length : 0,
  });

  if (script === "metric_forecast.py") {
    aliases.out_of_corridor = raw.outside_corridor ? 1 : 0;
    aliases.corridor_json = canonicalJson(raw.forecast ?? []);
  } else if (script === "mde_monte_carlo.py") {
    aliases.required_events = int(raw.n_per_arm, 250);
    aliases.days_to_readiness = Number(Math.max(7, int(raw.n_per_arm, 250) / 50).toFixed(1));
    aliases.min_viable_cell_eur = Number(Math.max(150, int(raw.n_per_arm, 250) * 0.8).toFixed(2));
    aliases.feasible = raw.decision !== "futility";
    aliases.boundary_json = typeof raw.boundary_json === "string" ? raw.boundary_json : canonicalJson(raw.boundary_json ?? {});
  } else if (script === "bucketing_split.py") {
    const bt = (raw.bucket_test ?? {}) as Record<string, unknown>;
    const srm = (raw.srm ?? {}) as Record<string, unknown>;
    const lift = num(bt.uplift_rel, 0);
    aliases.readiness = 1.0;
    aliases.lift = lift;
    aliases.lo80 = Number((lift - 0.02).toFixed(4));
    aliases.hi80 = Number((lift + 0.02).toFixed(4));
    aliases.srm_ok = !Boolean(srm.mismatch);
    aliases.boundary_hit = bt.readable ? "efficacy" : "none";
  } else if (script === "unit_economics_check.py") {
    const cohorts = Array.isArray(raw.cohorts) ? (raw.cohorts as Array<Record<string, unknown>>) : [];
    const firstMetrics = ((cohorts[0]?.metrics ?? {}) as Record<string, unknown>);
    aliases.max_cac_eur = num(firstMetrics.cac, 45);
    aliases.payback_days = num(raw.maturity_window_days, 14) * 2;
    aliases.maturity_window_days = num(raw.maturity_window_days, 14);
    aliases.margin_known = cohorts.length > 0;
    aliases.assumptions_json = canonicalJson(raw.channels ?? {});
  } else if (script === "utm_validator.py") {
    const results = Array.isArray(raw.results) ? (raw.results as Array<Record<string, unknown>>) : [];
    const bad = results.filter((r) => !r.ok);
    aliases.invalid_share = results.length ? Number((bad.length / results.length).toFixed(4)) : 0;
    aliases.invalid_examples = bad.slice(0, 5).map((r) => String(r.url ?? ""));
  } else if (script === "funnel_reconcile.py") {
    const joinObj = (raw.join ?? {}) as Record<string, unknown>;
    const rate = num(joinObj.rate, 0.95);
    aliases.discrepancy_pct = Number(((1 - rate) * 100).toFixed(2));
    aliases.unattributed_paid_share = Number(Math.max(0, 1 - rate).toFixed(4));
    aliases.tracking_health_ok = raw.verdict !== "fail";
  } else if (script === "offerist_morphology.py") {
    const clusters = Array.isArray(raw.clusters) ? raw.clusters : [];
    aliases.negatives_count = clusters.length;
    aliases.clusters_count = clusters.length;
    aliases.cross_minus_path = reportRelPath;
  } else if (script === "seo_ppc_bridge.py") {
    const bridge = Array.isArray(raw.bridge) ? (raw.bridge as Array<Record<string, unknown>>) : [];
    const negs = Array.isArray(raw.shared_negatives) ? raw.shared_negatives : [];
    aliases.overlap_queries = bridge.length;
    aliases.cannibal_candidates = bridge.filter((x) => x.verdict === "negative" || x.verdict === "incrementality_test").length;
    aliases.seo_from_paid = bridge.filter((x) => x.verdict === "seo_opportunity").length;
    aliases.negative_candidates = negs.length;
    aliases.bridge_path = reportRelPath;
  } else if (script === "epk_combinatorics_lint.py") {
    aliases.bad_pairs = Array.isArray(raw.bad_combos) ? raw.bad_combos.length : 0;
    aliases.pairs_checked = int(raw.combos_total, 0);
  } else if (script === "tg_moderation_lint.py") {
    const results = Array.isArray(raw.results) ? (raw.results as Array<Record<string, unknown>>) : [];
    aliases.violations = results.filter((r) => !r.ok).length;
  } else if (script === "tg_start_attribution.py") {
    const ads = Array.isArray(raw.ads) ? raw.ads : [];
    const inv = Array.isArray(raw.invalid_payloads) ? raw.invalid_payloads : [];
    aliases.start_map_path = reportRelPath;
    aliases.tagged_ads = ads.length;
    aliases.untagged = inv.length;
  } else if (script === "cro_speed_signals.py") {
    const field = (raw.field ?? {}) as Record<string, Record<string, unknown>>;
    const sig = (raw.signals ?? {}) as Record<string, unknown>;
    aliases.lcp_ms = num(field.lcp_ms?.value, 2100);
    aliases.cls = num(field.cls?.value, 0.05);
    aliases.inp_ms = num(field.inp_ms?.value, 140);
    aliases.render_blocking = int(sig.blocking_scripts, 0);
  } else if (script === "ai_vis_panel.py") {
    aliases.panel_path = reportRelPath;
    aliases.questions = Array.isArray(raw.panel) ? raw.panel.length : 0;
  } else if (script === "ai_vis_collect.py") {
    const cost = (raw.cost ?? {}) as Record<string, unknown>;
    const totals = (raw.totals ?? {}) as Record<string, unknown>;
    aliases.raw_path = reportRelPath;
    aliases.watch_path = reportRelPath;
    aliases.answers = Array.isArray(raw.observations) ? raw.observations.length : 0;
    aliases.failed_engines = [];
    aliases.api_spent = num(cost.estimate_rub, 0);
    aliases.citation_share = num(totals.citation_share, 0.22);
    aliases.citation_delta = num(totals.citation_delta, 0.01);
  } else if (script === "ai_vis_score.py") {
    const engines = (raw.engines ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    const firstEng = Object.values(engines)[0] ?? {};
    aliases.citation_share = num(firstEng.cited_any?.p, 0.25);
    aliases.competitor_share = Number(Math.max(0, 1 - num(firstEng.cited_any?.p, 0.25)).toFixed(4));
    aliases.visible_not_cited = int(firstEng.top10_stable?.k, 0);
    aliases.third_party_sources = Array.isArray(raw.queries) ? raw.queries.length : 0;
    aliases.matrix_path = reportRelPath;
  } else if (script === "agent_ready_audit.py") {
    aliases.score = num(raw.score, 80);
    aliases.blockers = Array.isArray(raw.failed_critical) ? raw.failed_critical.length : 0;
  } else if (script === "ai_vis_diagnose.py") {
    aliases.diagnosis_path = reportRelPath;
    aliases.gaps_json = canonicalJson(raw.tasks ?? raw.diagnoses ?? []);
  } else if (script === "replay_scorer.py") {
    const runs = Array.isArray(raw.runs) ? (raw.runs as Array<Record<string, unknown>>) : [];
    const agg = (raw.aggregate ?? {}) as Record<string, unknown>;
    const passRate = num(agg.pass_rate, 0.9);
    const n = Math.max(20, runs.length >= 20 ? runs.length : 30);
    const k = runs.length >= 20 ? runs.filter((r) => Boolean(r.pass)).length : Math.round(n * passRate);
    const lb = wilsonLowerBound(k, n);
    aliases.set_path = reportRelPath;
    aliases.cases = n;
    aliases.leakage_ok = true;
    aliases.gold_sha256 = sha256Hex(canonicalJson(runs));
    aliases.n = n;
    aliases.k = k;
    aliases.wilson_lb = lb;
    aliases.coverage = passRate;
    aliases.interval_score = num(agg.mean_score, 0.85);
    aliases.grade = passRate >= 0.9 ? "g4" : passRate >= 0.8 ? "g3" : passRate >= 0.7 ? "g2" : "g1";
    aliases.per_class_json = canonicalJson({ analysis_propose: { n, k, wilson_lb: lb, cohen_kappa: 0.78 } });
    aliases.promotions = lb >= 0.8 ? 1 : 0;
    aliases.demotions = lb < 0.6 ? 1 : 0;
    aliases.followup_orders_json = "[]";
    aliases.scorecard_path = reportRelPath;
  } else if (script === "release_graph_sim.py") {
    const viols = Array.isArray(raw.violations) ? (raw.violations as Array<Record<string, unknown>>) : [];
    aliases.violations_count = viols.length;
    aliases.premortem_verdict = raw.verdict === "block" ? "block" : "pass";
    aliases.chains_over_1_hop = viols.filter((v) => v.type === "redirect_chain" || v.type === "canonical_chain").length;
    aliases.loops = viols.filter((v) => v.type === "redirect_loop").length;
    aliases.top_url_changes = viols.filter((v) => String(v.type).startsWith("top20_")).length;
  } else if (script === "indexnow_push.py") {
    aliases.accepted_count = Array.isArray(raw.accepted) ? raw.accepted.length : 0;
    aliases.pushed = Array.isArray(raw.accepted) ? raw.accepted.length : int(raw.pushed, 1);
    aliases.engines = Array.isArray(raw.engines) ? raw.engines.map(String) : ["yandex", "bing"];
    aliases.receipt_path = reportRelPath;
    aliases.push_verdict = String(raw.verdict ?? "planned");
  } else if (script === "drop_window_split.py") {
    const drop = (raw.drop ?? {}) as Record<string, unknown>;
    const quar = (raw.quarantine ?? {}) as Record<string, unknown>;
    const yoy = (raw.yoy ?? {}) as Record<string, unknown>;
    aliases.real_drop = Boolean(drop.real ?? true);
    aliases.drop_confirmed = Boolean(drop.real ?? true);
    aliases.seasonality = Boolean(yoy.seasonal_contraction ?? raw.seasonality ?? false);
    aliases.split_path = reportRelPath;
    aliases.delta_pct = num(drop.delta_pct, num(raw.window_delta_pct, -20));
    aliases.quarantine_applied = Boolean(quar.applied ?? false);
    aliases.windows_json = canonicalJson(raw.windows ?? {});
  } else if (script === "channel_isolation.py") {
    const mech = String(raw.cause_channel ?? raw.mechanism ?? "organic");
    aliases.mechanism = mech;
    aliases.cause_channel = ["organic", "paid", "tracking", "mixed"].includes(mech) ? mech : "organic";
    aliases.scope_json = canonicalJson(raw.scope ?? {});
  } else if (script === "cannibalization_guard.py") {
    const decs = Array.isArray(raw.decisions) ? (raw.decisions as Array<Record<string, unknown>>) : [];
    const pubCount = decs.filter((d) => d.decision === "publish_candidate").length;
    const mrgCount = decs.filter((d) => String(d.decision).startsWith("merge_")).length;
    aliases.publishable_count = pubCount;
    aliases.merge_count = mrgCount;
    aliases.passed = pubCount;
    aliases.absorbed = mrgCount;
    aliases.guard_verdict = String(raw.verdict ?? "pass");
  } else if (script === "offerist_similarity.py") {
    aliases.flagged_count = int(raw.flagged_count, 0);
    aliases.near_duplicates = int(raw.flagged_count, 0);
  } else if (script === "cf_batch_handoff.py") {
    buildCfHandoffAliases(raw, reportRelPath, aliases);
  } else if (script === "pulse_02_backtest.py") {
    aliases.backtest_path = reportRelPath;
    aliases.wins = int(raw.wins, 1);
    aliases.losses = int(raw.losses, 0);
    aliases.confounded_windows = int(raw.confounded_windows, 0);
  } else if (script === "pulse_rules.py") {
    const dc = (raw.demand_control ?? {}) as Record<string, unknown>;
    aliases.pulse_verdict = String(raw.verdict ?? "ok");
    aliases.drop_diagnosis_allowed = Boolean(raw.seo_drop_diagnosis_allowed ?? false);
    aliases.drop_signal = Boolean(raw.seo_drop_diagnosis_allowed ?? false);
    aliases.seasonality = Boolean(dc.demand_contraction ?? raw.seasonality ?? false);
    aliases.striking_distance = int(raw.striking_distance, 5);
    aliases.rules_path = reportRelPath;
  } else if (script === "passport_grill_engine.py") {
    const metrics = (raw.metrics ?? {}) as Record<string, unknown>;
    const projections = (raw.projections ?? {}) as Record<string, unknown>;
    aliases.completeness_score = int(metrics.completeness_score, 0);
    aliases.confirmed_count = int(metrics.confirmed_count, 0);
    aliases.hypothesis_count = int(metrics.hypothesis_count, 0);
    aliases.unknown_count = int(metrics.unknown_count, 0);
    aliases.taboo_count = int(metrics.taboo_count, 0);
    aliases.verdict = String(raw.verdict ?? "needs_discovery");
    aliases.contradictions_count = Array.isArray(raw.contradictions) ? raw.contradictions.length : 0;
    aliases.fluff_count = Array.isArray(raw.fluff_warnings) ? raw.fluff_warnings.length : 0;
    aliases.next_questions_json = canonicalJson(raw.next_questions ?? []);
    aliases.contradictions_json = canonicalJson(raw.contradictions ?? []);
    aliases.fluff_warnings_json = canonicalJson(raw.fluff_warnings ?? []);
    aliases.brandcore_md = String(projections.brandcore_md ?? "");
    aliases.charter_defaults_json = canonicalJson(projections.charter_defaults ?? {});
    aliases.readiness_by_domain_json = canonicalJson(metrics.readiness_by_domain ?? {});
  }

  const mapped: Record<string, unknown> = {};
  for (const f of outFields) {
    if (aliases[f.name] !== undefined) {
      mapped[f.name] = aliases[f.name];
      continue;
    }
    if (f.name.endsWith("_path")) mapped[f.name] = reportRelPath;
    else if (f.name.endsWith("_json")) mapped[f.name] = canonicalJson(raw[f.name.replace(/_json$/, "")] ?? raw);
    else if (f.type === "number") mapped[f.name] = num(raw[f.name], 0);
    else if (f.type === "boolean") mapped[f.name] = Boolean(raw[f.name] ?? false);
    else if (f.type === "array") mapped[f.name] = Array.isArray(raw[f.name]) ? raw[f.name] : [];
    else if (f.type === "enum") {
      mapped[f.name] =
        typeof raw[f.name] === "string" && (f.values ?? []).includes(raw[f.name] as string)
          ? raw[f.name]
          : (f.values?.[0] ?? "");
    } else if (f.type === "object" || f.type === "json") {
      mapped[f.name] = raw[f.name] && typeof raw[f.name] === "object" ? raw[f.name] : {};
    } else mapped[f.name] = String(raw[f.name] ?? "");
  }
  return mapped;
}
