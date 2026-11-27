import type { LoopHealthEntry } from "@lane-pilot/contracts";
import type { SpecialistDetailOutput } from "../../../contracts";
import type { ScheduleService } from "../../../schedule/server";
import type { LanePilotDatabase } from "../../../storage";
import { listAutonomyRows } from "../repositories/sp-autonomy";
import { getCharter, type CharterRow } from "../repositories/sp-store";
import { buildSpecialistShifts, type WfRunMetaReader } from "./sp-detail-shifts";

const DAY_MS = 86_400_000;
const MONETARY_ONLY_SQL = "AND COALESCE(reason, '') NOT LIKE 'api_units:%'";

export interface SpecialistDetailLogger {
  warn?: (message: string) => void;
  debug?: (message: string) => void;
}

export interface SpecialistDetailInput {
  projectId: string;
  domain: string;
}

export interface SpecialistDetailDeps {
  db: LanePilotDatabase;
  kv?: { get: (key: string) => Promise<unknown> };
  schedules?: Pick<ScheduleService, "list" | "runs">;
  wfRunMeta?: WfRunMetaReader;
  loopHealth?: (
    db: LanePilotDatabase,
    options?: { now?: number; projectId?: string | null; domain?: string },
  ) => LoopHealthEntry[];
  now?: () => number;
  log?: SpecialistDetailLogger;
}

export function charterDraftKey(projectId: string, domain: string): string {
  return `specialist.charter_draft:${projectId}:${domain}`;
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNum(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return asRecord(JSON.parse(raw)) ?? {};
  } catch {
    return {};
  }
}

function runPart<T>(name: string, fallback: T, log: SpecialistDetailLogger | undefined, fn: () => T): T {
  try {
    return fn();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log?.warn?.(`[console] specialist_detail part=${name} failed: ${message}`);
    return fallback;
  }
}

async function runPartAsync<T>(
  name: string,
  fallback: T,
  log: SpecialistDetailLogger | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log?.warn?.(`[console] specialist_detail part=${name} failed: ${message}`);
    return fallback;
  }
}

function extractNorthStarMetric(body: Record<string, unknown>): string | null {
  const ns = asRecord(body.north_star) ?? asRecord(body.northStar);
  return (
    asText(body.metric) ??
    asText(ns?.metric_id) ??
    asText(ns?.metricId) ??
    asText(ns?.metric) ??
    asText(body.goal)
  );
}

function readPendingDraft(raw: unknown): { draftId: string; body: Record<string, unknown> } | null {
  const rec = asRecord(raw);
  if (!rec) return null;
  const draftId = asText(rec.draftId);
  const body = asRecord(rec.body) ?? asRecord(rec.charter);
  if (!draftId || !body) return null;
  return { draftId, body };
}

function buildNorthStar(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  charterBody: Record<string, unknown>,
): SpecialistDetailOutput["northStar"] {
  const charterMetric = extractNorthStarMetric(charterBody);
  const rows = (
    charterMetric
      ? db
          .prepare(
            `SELECT metric, measured, COALESCE(measured_at, check_at) AS at
             FROM lane_pilot_sp_intent_outcome
             WHERE project_id = ? AND domain = ? AND metric = ? AND measured IS NOT NULL
             ORDER BY COALESCE(measured_at, check_at) ASC, intent_id ASC`,
          )
          .all(projectId, domain, charterMetric)
      : db
          .prepare(
            `SELECT metric, measured, COALESCE(measured_at, check_at) AS at
             FROM lane_pilot_sp_intent_outcome
             WHERE project_id = ? AND domain = ? AND measured IS NOT NULL
             ORDER BY COALESCE(measured_at, check_at) ASC, intent_id ASC`,
          )
          .all(projectId, domain)
  ) as Array<{ metric: string; measured: number; at: number }>;

  const metric = charterMetric ?? rows[rows.length - 1]?.metric ?? null;
  if (!metric) return null;

  const series = rows
    .filter((row) => row.metric === metric && Number.isFinite(row.measured))
    .map((row) => ({ at: row.at, value: row.measured }));
  const freshAt = series.length > 0 ? series[series.length - 1]!.at : null;
  return { metric, series, freshAt };
}

function buildCaps(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  charterRow: CharterRow | null,
  charterBody: Record<string, unknown>,
  nowMs: number,
): SpecialistDetailOutput["caps"] {
  const ledgerCount = (
    db
      .prepare("SELECT COUNT(*) AS cnt FROM lane_pilot_sp_ledger WHERE project_id = ? AND domain = ?")
      .get(projectId, domain) as { cnt: number }
  ).cnt;
  if (!charterRow && ledgerCount === 0) return [];

  const dayUtc = new Date(nowMs).toISOString().slice(0, 10);
  const monthUtc = dayUtc.slice(0, 7);
  const since24h = nowMs - DAY_MS;
  const budgets = asRecord(charterBody.budgets) ?? {};

  const dayUsed = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_usd), 0) AS s FROM lane_pilot_sp_ledger
         WHERE project_id = ? AND domain = ? AND day_utc = ? AND mode IN ('reserved','settled') ${MONETARY_ONLY_SQL}`,
      )
      .get(projectId, domain, dayUtc) as { s: number }
  ).s;

  const monthUsed = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_usd), 0) AS s FROM lane_pilot_sp_ledger
         WHERE project_id = ? AND domain = ? AND substr(day_utc, 1, 7) = ? AND mode IN ('reserved','settled') ${MONETARY_ONLY_SQL}`,
      )
      .get(projectId, domain, monthUtc) as { s: number }
  ).s;

  const testUsed = (
    db
      .prepare(
        `SELECT COALESCE(SUM(amount_usd), 0) AS s FROM lane_pilot_sp_ledger
         WHERE project_id = ? AND domain = ? AND is_auto = 1 AND (day_utc = ? OR created_at >= ?) AND mode IN ('reserved','settled') ${MONETARY_ONLY_SQL}`,
      )
      .get(projectId, domain, dayUtc, since24h) as { s: number }
  ).s;

  return [
    {
      period: "day",
      capUsd: charterRow ? charterRow.daily_cap_usd : asNum(budgets.daily_cap_usd) ?? asNum(budgets.daily),
      usedUsd: Number((dayUsed ?? 0).toFixed(4)),
    },
    {
      period: "month",
      capUsd:
        asNum(budgets.monthly_cap_usd) ??
        asNum(budgets.monthly_media_cap) ??
        asNum(budgets.monthly_usd) ??
        asNum(budgets.monthly),
      usedUsd: Number((monthUsed ?? 0).toFixed(4)),
    },
    {
      period: "test",
      capUsd: charterRow ? charterRow.cell_cap_usd : asNum(budgets.cell_cap_usd) ?? asNum(budgets.auto_test_cell_cap),
      usedUsd: Number((testUsed ?? 0).toFixed(4)),
    },
  ];
}

export function buildAutonomy(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  nowMs: number,
): SpecialistDetailOutput["autonomy"] {
  const rows = listAutonomyRows(db, projectId, domain);
  const grants = db
    .prepare(
      `SELECT action_class, granted_at, revoked_at
       FROM lane_pilot_sp_autonomy_grant
       WHERE project_id = ? AND domain = ?
       ORDER BY action_class ASC, granted_at DESC`,
    )
    .all(projectId, domain) as Array<{ action_class: string; granted_at: number; revoked_at: number | null }>;

  const activeGrants = new Set<string>();
  const seenGrantClasses = new Set<string>();
  for (const grant of grants) {
    seenGrantClasses.add(grant.action_class);
    if (grant.revoked_at === null) activeGrants.add(grant.action_class);
  }

  const byClass = new Map<string, SpecialistDetailOutput["autonomy"][number]>();
  for (const row of rows) {
    const frozen = row.frozen_until !== null && row.frozen_until > nowMs;
    const level =
      row.autonomy_class === "bounded_auto" && (frozen || row.high_risk === 1) ? "propose" : row.autonomy_class;
    byClass.set(row.action_class, {
      actionClass: row.action_class,
      level,
      sample: Math.max(0, Math.floor(row.samples_n)),
      confidence: row.samples_n > 0 || row.wilson_lb > 0 ? row.wilson_lb : null,
      frozen,
    });
  }

  for (const actionClass of seenGrantClasses) {
    if (byClass.has(actionClass)) continue;
    byClass.set(actionClass, {
      actionClass,
      level: activeGrants.has(actionClass) ? "bounded_auto" : "propose",
      sample: 0,
      confidence: null,
      frozen: false,
    });
  }

  return [...byClass.values()].sort((a, b) => a.actionClass.localeCompare(b.actionClass));
}

function buildLoopHealth(
  deps: SpecialistDetailDeps,
  projectId: string,
  domain: string,
  nowMs: number,
  hasSpecialistState: boolean,
): SpecialistDetailOutput["loopHealth"] {
  if (!deps.loopHealth) return null;
  const entries = deps.loopHealth(deps.db, { projectId, domain, now: nowMs });
  const employee = entries.find((entry) => entry.loop === "employee");
  if (!employee) return null;

  const caseId = `${projectId}:${domain}`;
  const cases = Array.isArray(employee.evidence?.cases)
    ? (employee.evidence.cases as Array<{
        caseId?: string;
        conclusiveCount8w?: number;
        totalVerdicts8w?: number;
        conclusiveShare8w?: number;
      }>)
    : [];
  const caseStats = cases.find((item) => item.caseId === caseId);
  if (!hasSpecialistState && !employee.failing && !caseStats && employee.metric === null) {
    return null;
  }

  const status = employee.failing ? "failing" : employee.mode === "off" ? "off" : "ok";
  let note: string | null = null;
  if (employee.failing) {
    note = asText(employee.evidence?.reason) ?? "low_conclusive_share_8w";
  } else if (caseStats && typeof caseStats.totalVerdicts8w === "number" && caseStats.totalVerdicts8w > 0) {
    note = `${caseStats.conclusiveCount8w ?? 0}/${caseStats.totalVerdicts8w} conclusive (8w)`;
  } else if (typeof employee.metric === "number" && Number.isFinite(employee.metric)) {
    note = `${Math.round(employee.metric * 100)}% conclusive (8w)`;
  }
  return { status, note };
}

/**
 * Aggregates the full staff-page view (`specialist_detail`) for one `(projectId, domain)` specialist:
 * charter + pending draft, recent & next shifts, North Star series, budget caps, autonomy, and loop health.
 * Each section is isolated so one failing room degrades only its own field and logs a warning.
 */
export async function specialistDetail(
  deps: SpecialistDetailDeps,
  input: SpecialistDetailInput,
): Promise<SpecialistDetailOutput> {
  const nowMs = deps.now ? deps.now() : Date.now();
  const { projectId, domain } = input;

  const charterRow = runPart<CharterRow | null>("charter", null, deps.log, () => getCharter(deps.db, projectId, domain));
  const charterBody = parseJsonObject(charterRow?.charter_json);

  const pendingDraft = deps.kv
    ? await runPartAsync<{ draftId: string; body: Record<string, unknown> } | null>("charter_draft", null, deps.log, async () =>
        readPendingDraft(await deps.kv!.get(charterDraftKey(projectId, domain))),
      )
    : null;

  const charter: SpecialistDetailOutput["charter"] = charterRow
    ? {
        version: charterRow.version,
        approvedBy: charterRow.approved_by,
        approvedAt: charterRow.approved_by
          ? (asNum(charterBody.approved_at) ?? asNum(charterBody.approvedAt) ?? charterRow.updated_at)
          : null,
        body: charterBody,
        pendingDraft,
      }
    : pendingDraft
      ? {
          version: 0,
          approvedBy: null,
          approvedAt: null,
          body: {},
          pendingDraft,
        }
      : null;

  const shifts = runPart<SpecialistDetailOutput["shifts"]>(
    "shifts",
    { last: null, next: null, recent: [] },
    deps.log,
    () => buildSpecialistShifts(deps.db, projectId, domain, nowMs, deps.schedules, deps.wfRunMeta),
  );

  const northStar = runPart<SpecialistDetailOutput["northStar"]>("northStar", null, deps.log, () =>
    buildNorthStar(deps.db, projectId, domain, charterBody),
  );

  const caps = runPart<SpecialistDetailOutput["caps"]>("caps", [], deps.log, () =>
    buildCaps(deps.db, projectId, domain, charterRow, charterBody, nowMs),
  );

  const autonomy = runPart<SpecialistDetailOutput["autonomy"]>("autonomy", [], deps.log, () =>
    buildAutonomy(deps.db, projectId, domain, nowMs),
  );

  const hasSpecialistState = Boolean(
    charter || shifts.recent.length > 0 || shifts.next || northStar || caps.length > 0 || autonomy.length > 0,
  );
  const loopHealth = runPart<SpecialistDetailOutput["loopHealth"]>("loopHealth", null, deps.log, () =>
    buildLoopHealth(deps, projectId, domain, nowMs, hasSpecialistState),
  );

  deps.log?.debug?.(
    `[console] specialist_detail project=${projectId} domain=${domain} charter=${charter ? charter.version : "none"} shifts=${shifts.recent.length} autonomy=${autonomy.length}`,
  );

  return {
    charter,
    shifts,
    northStar,
    caps,
    autonomy,
    loopHealth,
  };
}
