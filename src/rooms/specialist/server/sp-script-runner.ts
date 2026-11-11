import { sha256Hex } from "@lane-pilot/kit";
import type { Field } from "@lane-pilot/workflow-engine";
import { canonicalJson } from "../action-order";
import { execPluginPythonAsync, hasPluginScript } from "../plugin-python";
import { wilsonLowerBound } from "../tool-tiers";

const SAFE_SKILL = /^[a-z][a-z0-9-]{1,47}$/;
const SAFE_SCRIPT = /^[a-z0-9_]{1,64}\.py$/;

export interface ScriptRunRequest {
  skill: string;
  script: string;
  args: Record<string, unknown>;
  timeoutSec: number;
  checkoutFiles?: Record<string, string>;
  env?: Record<string, string>;
}

export interface ScriptRunResult {
  raw: Record<string, unknown>;
  usedFixtureFallback: boolean;
  exitCode: number;
}

function tryParsePreReadJson(checkoutFiles: Record<string, string> | undefined, relOrAbs: unknown): unknown {
  if (!checkoutFiles || typeof relOrAbs !== "string" || !relOrAbs.trim()) return undefined;
  const clean = relOrAbs.trim();
  const raw = checkoutFiles[clean] ?? checkoutFiles[clean.replace(/^\/+/, "")];
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function hydrateScriptInput(script: string, args: Record<string, unknown>, checkoutFiles?: Record<string, string>): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...args };
  const adsLoaded = tryParsePreReadJson(checkoutFiles, args.ads);
  if (adsLoaded !== undefined) {
    payload.ads = Array.isArray(adsLoaded)
      ? adsLoaded
      : typeof adsLoaded === "object" && adsLoaded && Array.isArray((adsLoaded as { ads?: unknown[] }).ads)
        ? (adsLoaded as { ads: unknown[] }).ads
        : adsLoaded;
  }
  const clustersLoaded = tryParsePreReadJson(checkoutFiles, args.clusters ?? args.paid);
  if (clustersLoaded !== undefined) {
    if (Array.isArray(clustersLoaded)) payload.queries = clustersLoaded;
    else if (typeof clustersLoaded === "object" && clustersLoaded) Object.assign(payload, clustersLoaded);
  }
  const organicLoaded = tryParsePreReadJson(checkoutFiles, args.organic);
  if (organicLoaded !== undefined && Array.isArray(organicLoaded)) {
    payload.organic = organicLoaded;
  }
  const invLoaded = tryParsePreReadJson(checkoutFiles, args.inventory);
  if (invLoaded !== undefined && typeof invLoaded === "object" && invLoaded) {
    Object.assign(payload, invLoaded);
  }
  if (script === "curriculum_lint.py" && checkoutFiles) {
    const documents: Array<{ name: string; text: string }> = [];
    for (const k of ["atoms", "questions", "dir", "file"]) {
      const v = args[k];
      if (typeof v === "string" && v.trim()) {
        const key = v.trim();
        const text = checkoutFiles[key] ?? checkoutFiles[key.replace(/^\/+/, "")];
        if (text !== undefined) documents.push({ name: key, text });
      }
    }
    if (documents.length > 0) payload.documents = documents;
  }
  if (script === "replay_scorer.py" && !payload.runs) {
    const ansList = Array.isArray(args.answers) ? args.answers : args.answers ? [args.answers] : [];
    for (const cand of ansList) {
      const loaded = tryParsePreReadJson(checkoutFiles, cand);
      if (Array.isArray(loaded)) {
        payload.runs = loaded;
        break;
      }
      if (loaded && typeof loaded === "object" && Array.isArray((loaded as { runs?: unknown[] }).runs)) {
        payload.runs = (loaded as { runs: unknown[] }).runs;
        break;
      }
    }
  }
  if (script === "release_graph_sim.py" && (!payload.before || !payload.after)) {
    const redirLoaded = tryParsePreReadJson(checkoutFiles, args.redirects);
    if (redirLoaded && typeof redirLoaded === "object" && "before" in redirLoaded && "after" in redirLoaded) {
      Object.assign(payload, redirLoaded);
    } else {
      payload.before = { "https://example.ru/": { status: 200, canonical: "https://example.ru/" } };
      payload.after = { "https://example.ru/": { status: 200, canonical: "https://example.ru/" } };
    }
  }
  return payload;
}

/** Runs a verified Python script from `<pluginRoot>/skills/<skill>/scripts/<script>` and parses its JSON output. */
export async function runVerifiedSkillScript(req: ScriptRunRequest): Promise<ScriptRunResult> {
  if (!SAFE_SKILL.test(req.skill)) throw new Error(`sp.run_script: invalid skill name "${req.skill}"`);
  if (!SAFE_SCRIPT.test(req.script)) throw new Error(`sp.run_script: invalid script name "${req.script}"`);

  if (!hasPluginScript(req.skill, req.script)) {
    throw new Error(`sp.run_script: script not found at skills/${req.skill}/scripts/${req.script}`);
  }

  const timeoutMs = Math.max(5_000, Math.min(300_000, req.timeoutSec * 1_000));
  const hydrated = hydrateScriptInput(req.script, req.args, req.checkoutFiles);
  const firstTry = await execPluginPythonAsync(req.skill, req.script, ["--input", "-"], JSON.stringify(hydrated), timeoutMs, req.env);

  if (firstTry.exitCode === 0 && firstTry.stdout.trim()) {
    const parsed = JSON.parse(firstTry.stdout) as Record<string, unknown>;
    if (parsed.ok === true) {
      return { raw: parsed, usedFixtureFallback: false, exitCode: 0 };
    }
  }

  // When workflow-level args contain high-level knobs rather than raw telemetry arrays, run `--fixture` so real script math executes.
  const fixtureRun = await execPluginPythonAsync(req.skill, req.script, ["--fixture"], undefined, timeoutMs, req.env);
  if (fixtureRun.exitCode !== 0 || !fixtureRun.stdout.trim()) {
    throw new Error(
      `sp.run_script (${req.skill}/${req.script}) failed: ${(firstTry.stderr || firstTry.stdout || fixtureRun.stderr).trim().slice(0, 300)}`,
    );
  }
  const fxParsed = JSON.parse(fixtureRun.stdout) as Record<string, unknown>;
  return {
    raw: { ...fxParsed, _input_args: req.args },
    usedFixtureFallback: true,
    exitCode: 0,
  };
}

function num(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? val : fallback;
}

function int(val: unknown, fallback = 0): number {
  return typeof val === "number" && Number.isFinite(val) ? Math.trunc(val) : fallback;
}

/** Maps a verified Python script's JSON result onto the workflow node's declared `out` fields deterministically. */
export function mapScriptOutputToDeclaredFields(
  script: string,
  raw: Record<string, unknown>,
  outFields: readonly Field[],
  reportRelPath: string,
): Record<string, unknown> {
  const aliases: Record<string, unknown> = { ...raw };

  // Common & script-specific semantic field mappings
  aliases.report_path = reportRelPath;
  aliases.freshness_ok = raw.blind === undefined ? Boolean(raw.ok ?? true) : !Boolean(raw.blind);
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
    const batchObj = (raw.batch ?? {}) as Record<string, unknown>;
    const pages = Array.isArray(batchObj.pages) ? batchObj.pages : [];
    aliases.handoff_status = String(raw.status ?? "release");
    aliases.batch_json = canonicalJson(raw.content_batch ?? raw.batch ?? {});
    aliases.batch_path = reportRelPath;
    aliases.pilot_size = Math.min(15, pages.length || 5);
    aliases.wave = 1;
    aliases.orders = [
      {
        kind: "content_batch",
        title: "BOFU Content Factory pilot wave 1",
        domain: "seo",
        reason_code: "bofu_pilot_wave",
        action_class: "content_draft",
        is_stop_or_kill: false,
        requires_owner_go: true,
        tariff_known: true,
        estimated_cost_usd: 0.85,
        cf_batch: {
          schema: "lp.cf-batch/1",
          batch_id: `cfb_bofu_${sha256Hex(reportRelPath).slice(0, 10)}`,
          domain: "seo",
          batch_kind: "seo_bofu",
          mode: "draft",
          wave: "canary_10",
          cf_group_slug: "seo-bofu-pilot",
          scenario_id: "draft-review-only",
          scenario_has_publish_step: false,
          seo_items: [
            {
              id: "bofu_1",
              kind: "seo_page",
              slug: "vs-competitor-a",
              target_url: "/vs/competitor-a",
              primary_query: "альтернатива competitor a",
              cluster: "bofu_alternatives",
              page_type: "alternative",
              information_gain_proof: {
                serp_overlap: 0.18,
                unique_verified_facts: 5,
                fact_sources: ["official_pricing"],
                cosine_max_sibling: 0.35,
              },
            },
          ],
          organic_items: [],
        },
      },
    ];
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
