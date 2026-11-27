import type { OutcomeVerdict } from "@lane-pilot/contracts";
import type { StepContext, WorkflowNode } from "@lane-pilot/workflow-engine";
import type { ChainRuntime } from "../../../contracts/server";
import type { LanePilotDatabase } from "../../../storage";
import type { IntervalForecast } from "../../models/action-order";

const DAY_MS = 86_400_000;
const OUTCOME_EXPIRY_DAYS = 7;
const DEFAULT_DUE_LIMIT = 20;

export interface SpOutcomeLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface IntentOutcomeRow {
  intent_id: string;
  project_id: string;
  domain: string;
  metric: string;
  unit: string;
  baseline: number | null;
  expected_lo: number;
  expected_point: number;
  expected_hi: number;
  check_at: number;
  measured: number | null;
  measured_at: number | null;
  source: string | null;
  verdict: OutcomeVerdict;
  hypothesis_id: string | null;
}

export interface PendingOutcomeIntent {
  intentId?: string;
  intent_id?: string;
  projectId?: string;
  project_id?: string;
  domain: string;
  createdAt?: number;
  created_at?: number;
  hypothesisId?: string | null;
  hypothesis_id?: string | null;
}

export interface OutcomeMeasurementInput {
  intent_id: string;
  measured: number;
  source: string;
}

export interface RecordMeasurementResult {
  ok: boolean;
  verdict?: OutcomeVerdict;
  reason?: string;
}

/** Resolves an interval forecast's check timestamp (explicit `check_at` or `created_at + horizon_days`). */
export function resolveOutcomeCheckAt(forecast: Pick<IntervalForecast, "horizon_days" | "check_at">, createdAtMs: number): number {
  if (typeof forecast.check_at === "string" && forecast.check_at.trim()) {
    const parsed = Date.parse(forecast.check_at);
    if (Number.isFinite(parsed)) return parsed;
  }
  const horizonDays =
    typeof forecast.horizon_days === "number" && Number.isFinite(forecast.horizon_days) && forecast.horizon_days > 0
      ? forecast.horizon_days
      : 14;
  return createdAtMs + horizonDays * DAY_MS;
}

/** Writes a pending outcome row for a forecasted specialist decision. */
export function writePendingOutcome(
  db: LanePilotDatabase,
  intent: PendingOutcomeIntent,
  forecast: IntervalForecast,
  log?: SpOutcomeLogger,
): IntentOutcomeRow | null {
  const intentId = intent.intentId ?? intent.intent_id;
  const projectId = intent.projectId ?? intent.project_id;
  if (!intentId || !projectId) return null;

  const createdAt = intent.createdAt ?? intent.created_at ?? Date.now();
  const checkAtMs = resolveOutcomeCheckAt(forecast, createdAt);
  const unit = forecast.unit ?? "ratio";
  const baseline = typeof forecast.baseline === "number" && Number.isFinite(forecast.baseline) ? forecast.baseline : null;
  const hypothesisId = intent.hypothesisId ?? intent.hypothesis_id ?? null;

  const info = db
    .prepare(
      `INSERT OR IGNORE INTO lane_pilot_sp_intent_outcome
        (intent_id, project_id, domain, metric, unit, baseline, expected_lo, expected_point, expected_hi, check_at, verdict, hypothesis_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .run(
      intentId,
      projectId,
      intent.domain,
      forecast.metric,
      unit,
      baseline,
      forecast.lo80,
      forecast.point,
      forecast.hi80,
      checkAtMs,
      hypothesisId,
    );

  if (info.changes > 0) {
    log?.debug?.(`intent outcome pending intent=${intentId} metric=${forecast.metric} check_at=${new Date(checkAtMs).toISOString()}`);
  }

  return (
    (db.prepare("SELECT * FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?").get(intentId) as IntentOutcomeRow | undefined) ?? null
  );
}

/** Lists pending outcomes whose check date has arrived (at most `limit`, default 20). */
export function dueOutcomes(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; now?: number; limit?: number },
): IntentOutcomeRow[] {
  const now = input.now ?? Date.now();
  const limit = Math.max(1, Math.min(100, input.limit ?? DEFAULT_DUE_LIMIT));
  return db
    .prepare(
      `SELECT * FROM lane_pilot_sp_intent_outcome
       WHERE project_id = ? AND domain = ? AND verdict = 'pending' AND check_at <= ?
       ORDER BY check_at ASC, intent_id ASC
       LIMIT ?`,
    )
    .all(input.projectId, input.domain, now, limit) as IntentOutcomeRow[];
}

/** Records a telemetry measurement for a pending intent outcome and assigns `within`, `above`, or `below`. */
export function recordMeasurement(
  db: LanePilotDatabase,
  input: { intentId: string; measured: number; source: string; now?: number },
  log?: SpOutcomeLogger,
): RecordMeasurementResult {
  const now = input.now ?? Date.now();
  if (typeof input.measured !== "number" || !Number.isFinite(input.measured)) {
    log?.warn?.(`intent measurement refused intent=${input.intentId}: not numeric`);
    return { ok: false, reason: "not_numeric" };
  }
  const source = typeof input.source === "string" ? input.source.trim() : "";
  if (!source) {
    log?.warn?.(`intent measurement refused intent=${input.intentId}: missing source`);
    return { ok: false, reason: "missing_source" };
  }

  const tx = db.transaction((): RecordMeasurementResult => {
    const row = db
      .prepare("SELECT * FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?")
      .get(input.intentId) as IntentOutcomeRow | undefined;
    if (!row) {
      log?.warn?.(`intent measurement refused intent=${input.intentId}: unknown intent`);
      return { ok: false, reason: "unknown_intent" };
    }
    if (row.verdict !== "pending" || row.measured !== null) {
      log?.warn?.(`intent measurement refused intent=${input.intentId}: already measured (${row.verdict})`);
      return { ok: false, reason: "already_measured" };
    }
    const verdict: OutcomeVerdict =
      input.measured < row.expected_lo ? "below" : input.measured > row.expected_hi ? "above" : "within";
    db.prepare(
      `UPDATE lane_pilot_sp_intent_outcome
       SET measured = ?, measured_at = ?, source = ?, verdict = ?
       WHERE intent_id = ? AND verdict = 'pending'`,
    ).run(input.measured, now, source, verdict, input.intentId);
    log?.info?.(`intent outcome intent=${input.intentId} verdict=${verdict}`);
    return { ok: true, verdict };
  });

  return tx();
}

/** Marks pending outcomes without a measurement 7 days after `check_at` as `inconclusive`. */
export function expireOutcomes(
  db: LanePilotDatabase,
  now = Date.now(),
  log?: SpOutcomeLogger,
): { expiredCount: number; intentIds: string[] } {
  const cutoff = now - OUTCOME_EXPIRY_DAYS * DAY_MS;
  const tx = db.transaction(() => {
    const due = db
      .prepare(
        `SELECT intent_id FROM lane_pilot_sp_intent_outcome
         WHERE verdict = 'pending' AND measured IS NULL AND check_at <= ?
         ORDER BY check_at ASC`,
      )
      .all(cutoff) as Array<{ intent_id: string }>;
    if (due.length === 0) return { expiredCount: 0, intentIds: [] as string[] };
    db.prepare(
      `UPDATE lane_pilot_sp_intent_outcome
       SET verdict = 'inconclusive'
       WHERE verdict = 'pending' AND measured IS NULL AND check_at <= ?`,
    ).run(cutoff);
    for (const row of due) {
      log?.warn?.(`intent outcome inconclusive intent=${row.intent_id} (no measurement)`);
    }
    return { expiredCount: due.length, intentIds: due.map((r) => r.intent_id) };
  });
  return tx();
}

const SCRIPT_BINDING_RE = /^\{\{\s*([a-z][a-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}$/;

function isScriptWorkflowNode(node: WorkflowNode | undefined): boolean {
  if (!node) return false;
  if (node.type === "action") return node.action === "sp.run_script";
  if (node.type === "agent") return node.form === "script" && Boolean(node.script);
  return false;
}

/** Extracts outcome measurements only from untemplated bindings to script node outputs in the workflow graph. */
export function collectScriptBoundMeasurements(
  c: StepContext<ChainRuntime>,
  rawBinding: unknown,
  log: SpOutcomeLogger,
): { items: Array<{ intent_id: unknown; measured: unknown; source: unknown }>; refused: number } {
  const entries = Array.isArray(rawBinding) ? rawBinding : [rawBinding];
  const byId = new Map(c.workflow.nodes.map((n) => [n.id, n]));
  const items: Array<{ intent_id: unknown; measured: unknown; source: unknown }> = [];
  let refused = 0;

  for (const entry of entries) {
    if (typeof entry !== "string") {
      refused += 1;
      log.warn?.("intent measurement refused intent=<unknown>: measurements must be bound to a script node output");
      continue;
    }
    const match = SCRIPT_BINDING_RE.exec(entry.trim());
    if (!match) {
      refused += 1;
      log.warn?.("intent measurement refused intent=<unknown>: measurements must be bound to a script node output");
      continue;
    }
    const sourceNodeId = match[1]!;
    if (!isScriptWorkflowNode(byId.get(sourceNodeId))) {
      refused += 1;
      log.warn?.(`intent measurement refused intent=<unknown>: source node ${sourceNodeId} is not a script node`);
      continue;
    }
    const resolved = c.template(entry);
    if (resolved === undefined || resolved === null || resolved === "") continue;
    let parsed: unknown = resolved;
    if (typeof resolved === "string" && resolved.trim()) {
      try {
        parsed = JSON.parse(resolved);
      } catch {
        parsed = resolved;
      }
    }
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === "object" ? [parsed] : null;
    if (!list) {
      refused += 1;
      log.warn?.(`intent measurement refused intent=<unknown>: script node ${sourceNodeId} returned non-array measurements`);
      continue;
    }
    for (const row of list) {
      if (!row || typeof row !== "object" || Array.isArray(row)) {
        refused += 1;
        log.warn?.("intent measurement refused intent=<unknown>: invalid measurement entry");
        continue;
      }
      const rec = row as Record<string, unknown>;
      items.push({ intent_id: rec.intent_id, measured: rec.measured, source: rec.source });
    }
  }
  return { items, refused };
}
