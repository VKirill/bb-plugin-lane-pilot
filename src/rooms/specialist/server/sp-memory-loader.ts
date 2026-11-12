import type { Field } from "@lane-pilot/workflow-engine";
import type { ServerCore } from "../../contracts/server";
import { listOpenOwnerItems } from "../../owner-waiting";
import { getPassport, renderBrandcoreProjection, renderCharterDefaults } from "../../passport";
import { listActiveLocks } from "./sp-locks-intents";
import { loadQuestionBank } from "./sp-questions";
import {
  acquireTick,
  getBreakerState,
  getBudgetRemainingUsd,
  getCharter,
  listCursors,
  spSweep,
  upsertCharter,
} from "./sp-store";

type Row = Record<string, unknown>;

function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "object") return val as T;
  if (typeof val === "string" && val.trim()) {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

export async function loadSpecialistMemory(input: {
  ctx: ServerCore;
  projectId: string;
  runId: string;
  domain: "seo" | "marketing" | "specialist_os";
  params: Row;
  outFields: readonly Field[];
  checkout: { hostId: string; path: string } | null;
  readCheckoutFileText: (
    ctx: ServerCore,
    checkout: { hostId: string; path: string } | null,
    relOrAbs: unknown,
  ) => Promise<string | null>;
}): Promise<Row> {
  const { ctx, projectId, runId, domain, params, outFields, checkout, readCheckoutFileText } = input;
  const { db } = ctx;
  const now = Date.now();
  spSweep(db, now);

  const passportRec = getPassport(db, projectId);
  const hasPassport = Boolean(passportRec && passportRec.metrics.completeness_score > 0);
  const bcProj = hasPassport && passportRec ? renderBrandcoreProjection(passportRec.passport) : null;
  const brandcorePayload = bcProj ? { ...bcProj.json, brandcore_md: bcProj.markdown } : {};
  const charterDefaults = hasPassport && passportRec ? renderCharterDefaults(passportRec.passport) : {};

  // `G-04`: SEO charter bootstrap when SQLite charter is empty (`charter.json` on disk or default `"propose"` SEO charter).
  let charterRow = getCharter(db, projectId, domain);
  if (!charterRow && domain === "seo") {
    const diskSeoCharter = await readCheckoutFileText(ctx, checkout, ".agents/seo/charter.json");
    if (diskSeoCharter) {
      const parsedCharter = parseJsonSafe<Row>(diskSeoCharter, {});
      if (Object.keys(parsedCharter).length > 0) {
        upsertCharter(db, { projectId, domain: "seo", charter: parsedCharter, approvedBy: "disk_import", nowMs: now });
        charterRow = getCharter(db, projectId, "seo");
      }
    }
    if (!charterRow && hasPassport) {
      const seededSeoCharter: Row = {
        domain: "seo",
        mode: "propose",
        autonomy_class: "propose",
        ...charterDefaults,
      };
      upsertCharter(db, { projectId, domain: "seo", charter: seededSeoCharter, approvedBy: "passport_bootstrap", nowMs: now });
      charterRow = getCharter(db, projectId, "seo");
    }
  }

  const activeLocks = listActiveLocks(db, projectId, domain, now);
  const cursors = listCursors(db, projectId, domain);
  const budgetLeft = getBudgetRemainingUsd(db, projectId, domain, now);

  let leaseOk = true;
  let tickId = `tick_${runId.slice(0, 12)}`;
  const scopeId = typeof params.scopeId === "string" && params.scopeId ? params.scopeId : "default";
  if (params.acquireTick === true) {
    const slot = typeof params.slot === "string" && params.slot ? params.slot : new Date(now).toISOString().slice(0, 13);
    const lease = acquireTick(db, { projectId, domain, scopeId, slotKey: slot, holderRunId: runId, nowMs: now });
    leaseOk = lease.ok;
    tickId = lease.tickId;
  }

  const rightsRows = db.prepare("SELECT * FROM lane_pilot_sp_autonomy WHERE project_id = ? AND domain = ?").all(projectId, domain);
  const bankStats = loadQuestionBank().stats;

  // Real hypothesis history & duplicate_of_refuted check (never hardcoded false!).
  const recentCommits = db
    .prepare(
      "SELECT summary_json, created_at FROM lane_pilot_sp_memory_commit WHERE project_id = ? AND domain = ? ORDER BY created_at DESC LIMIT 25",
    )
    .all(projectId, domain) as Array<{ summary_json: string; created_at: number }>;

  const parsedCommits: Row[] = recentCommits.map((r) => ({
    ...parseJsonSafe<Row>(r.summary_json, {}),
    _created_at: r.created_at,
  }));

  const candidateHyp = String(params.hypothesisId ?? params.hypothesis ?? "").trim().toLowerCase();
  const duplicateOfRefuted = Boolean(
    candidateHyp &&
      parsedCommits.some((c) => {
        const dec = String(c.decision ?? "").toLowerCase();
        if (dec !== "kill" && dec !== "killed" && dec !== "refuted") return false;
        const prevId = String(c.hypothesisId ?? "").trim().toLowerCase();
        const prevText = String(c.hypothesis ?? "").trim().toLowerCase();
        return (prevId && prevId === candidateHyp) || (prevText && prevText === candidateHyp);
      }),
  );

  // Real matured forecasts count from `lane_pilot_sp_memory_commit` (`0` on empty DB — never hardcoded `20`!).
  let maturedForecasts = 0;
  for (const commit of parsedCommits) {
    const createdAt = typeof commit._created_at === "number" ? commit._created_at : now;
    const forecasts = Array.isArray(commit.forecasts)
      ? (commit.forecasts as Array<Row>)
      : commit.forecast && typeof commit.forecast === "object"
        ? [commit.forecast as Row]
        : [];
    for (const fc of forecasts) {
      const horizonDays = typeof fc.horizon_days === "number" && fc.horizon_days > 0 ? fc.horizon_days : 14;
      if (createdAt + horizonDays * 86_400_000 <= now || fc.matured === true) {
        maturedForecasts += 1;
      }
    }
  }

  // Real checkout artifacts & cross-room bridges (zero hardcoded empty strings when files/tables exist).
  const telemetryMapRaw =
    (await readCheckoutFileText(ctx, checkout, `.agents/${domain}/telemetry-map.json`)) ??
    (await readCheckoutFileText(ctx, checkout, ".agents/marketing/telemetry-map.json"));
  const sharedNegativesRaw =
    (await readCheckoutFileText(ctx, checkout, ".agents/marketing/shared-negatives.json")) ??
    (await readCheckoutFileText(ctx, checkout, `.agents/${domain}/shared-negatives.json`));
  const poolsHistoryRaw =
    (await readCheckoutFileText(ctx, checkout, ".agents/marketing/tg-ads/pools-history.json")) ??
    (await readCheckoutFileText(ctx, checkout, `.agents/${domain}/pools-history.json`));
  const ppcBridgeRaw =
    (await readCheckoutFileText(ctx, checkout, ".agents/seo/ppc-bridge-latest.json")) ??
    (await readCheckoutFileText(ctx, checkout, ".agents/marketing/reports/mkt-paid-search-audit-bridge.json"));

  const openAssumptions = listOpenOwnerItems(db, { projectId, source: "specialist" }).map((item) => ({
    key: item.key,
    kind: item.kind,
    what: item.what,
    why: item.why,
    createdAt: item.createdAt,
  }));

  const organicUnits = db
    .prepare(
      "SELECT unit_id, batch_id, channel, slug, target_url, status, created_at FROM lane_pilot_sp_organic_unit WHERE project_id = ? ORDER BY created_at DESC LIMIT 50",
    )
    .all(projectId);

  const breaker = getBreakerState(db, projectId, domain);
  const breakerOpen = Boolean(breaker && breaker.state === "open" && (breaker.cooldown_until === null || breaker.cooldown_until > now));

  const baseOut: Row = {
    has_charter: Boolean(charterRow),
    has_passport: hasPassport,
    lease_ok: leaseOk,
    over_llm_budget: budgetLeft <= 0,
    cold_start: !charterRow,
    tick_id: tickId,
    scope_id: scopeId,
    charter_json: charterRow?.charter_json ?? (hasPassport ? JSON.stringify(charterDefaults) : "{}"),
    passport_json: hasPassport && passportRec ? JSON.stringify(passportRec.passport) : "{}",
    market_rails_json: hasPassport ? JSON.stringify(charterDefaults) : "{}",
    budget_left_usd: budgetLeft,
    api_budget_left: budgetLeft,
    active_locks_json: JSON.stringify(activeLocks),
    cursors_json: JSON.stringify(cursors),
    open_assumptions_json: JSON.stringify(openAssumptions),
    recent_hypotheses_json: JSON.stringify(parsedCommits.slice(0, 10)),
    duplicate_of_refuted: duplicateOfRefuted,
    shared_negatives_json: sharedNegativesRaw ? JSON.stringify(parseJsonSafe(sharedNegativesRaw, [])) : "[]",
    ppc_bridge_json: ppcBridgeRaw ? JSON.stringify(parseJsonSafe(ppcBridgeRaw, {})) : "{}",
    brandcore_json: hasPassport ? JSON.stringify(brandcorePayload) : "{}",
    pools_history_json: poolsHistoryRaw ? JSON.stringify(parseJsonSafe(poolsHistoryRaw, [])) : "[]",
    telemetry_map_json: telemetryMapRaw ? JSON.stringify(parseJsonSafe(telemetryMapRaw, {})) : "{}",
    organic_units_json: JSON.stringify(organicUnits),
    breaker_open: breakerOpen,
    breaker_cooldown_until: breaker?.cooldown_until ?? 0,
    breaker_codes_json: breaker?.trigger_codes_json ?? "[]",
    previous_panel_path: ".agents/seo/ai-visibility/panel.json",
    bank_stats_json: JSON.stringify(bankStats),
    atoms_index_path: ".agents/marketing/curriculum/atoms-index.json",
    rights_json: JSON.stringify(rightsRows),
    matured_forecasts: maturedForecasts,
    snapshots_index_path: ".agents/marketing/snapshots/index.json",
  };

  const out: Row = {};
  for (const f of outFields) {
    out[f.name] =
      baseOut[f.name] !== undefined
        ? baseOut[f.name]
        : f.type === "boolean"
          ? false
          : f.type === "number"
            ? 0
            : f.type === "array"
              ? []
              : "";
  }
  return out;
}
