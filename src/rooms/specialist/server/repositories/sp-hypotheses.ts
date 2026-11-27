import { randomUUID } from "node:crypto";
import { type HypothesisStateSp, isHypothesisStateSp, type OutcomeVerdict } from "@lane-pilot/contracts";
import type { LanePilotDatabase } from "../../../storage";
import type { ActionOrder } from "../../models/action-order";
import type { IntentOutcomeRow } from "./sp-outcomes";
import { getCharter } from "./sp-store";

const SNAPSHOT_MAX = 30;
const UP_DIRECTIONS = new Set(["up", "higher", "higher_is_better", "increase", "maximize", "above", "+"]);
const DOWN_DIRECTIONS = new Set(["down", "lower", "lower_is_better", "decrease", "minimize", "below", "-"]);

export interface SpHypothesisLogger {
  debug?: (message: string) => void;
  info?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface SpHypothesisRow {
  id: string;
  project_id: string;
  domain: string;
  parent_id: string | null;
  title: string;
  lever: string | null;
  state: HypothesisStateSp;
  evidence_json: string;
  created_at: number;
  updated_at: number;
}

export interface UpsertHypothesisInput {
  id?: string;
  projectId: string;
  domain: string;
  parentId?: string | null;
  title: string;
  lever?: string | null;
  state?: HypothesisStateSp;
  evidence?: unknown[];
  nowMs?: number;
}

export interface LinkIntentResult {
  ok: boolean;
  reason?: string;
  hypothesisId?: string;
  state?: HypothesisStateSp;
}

export interface SettledHypothesisTransition {
  id: string;
  from: HypothesisStateSp;
  to: HypothesisStateSp;
}

export interface SettleHypothesesResult {
  settled: SettledHypothesisTransition[];
  workedCount: number;
  refutedCount: number;
}

export interface HypothesisTreeEntry {
  id: string;
  parent_id: string | null;
  title: string;
  lever: string | null;
  state: HypothesisStateSp;
  last_verdict: OutcomeVerdict | null;
}

type MetricDirection = "up" | "down";

function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (typeof val !== "string" || !val.trim()) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

function normalizeDirectionToken(val: unknown): MetricDirection | null {
  if (typeof val !== "string") return null;
  const tok = val.trim().toLowerCase();
  if (UP_DIRECTIONS.has(tok)) return "up";
  if (DOWN_DIRECTIONS.has(tok)) return "down";
  return null;
}

function resolveCharterNorthStar(charterObj: Record<string, unknown>): { metricId: string | null; direction: MetricDirection | null } {
  const rawNs =
    (charterObj.north_star && typeof charterObj.north_star === "object"
      ? (charterObj.north_star as Record<string, unknown>)
      : charterObj.northStar && typeof charterObj.northStar === "object"
        ? (charterObj.northStar as Record<string, unknown>)
        : null) ?? null;

  const metricId =
    rawNs && typeof rawNs.metric_id === "string" && rawNs.metric_id.trim()
      ? rawNs.metric_id.trim()
      : rawNs && typeof rawNs.metricId === "string" && rawNs.metricId.trim()
        ? rawNs.metricId.trim()
        : null;

  const explicit =
    normalizeDirectionToken(rawNs?.direction) ??
    normalizeDirectionToken(rawNs?.desired_direction) ??
    normalizeDirectionToken(charterObj.direction);
  if (explicit) return { metricId, direction: explicit };

  if (rawNs && typeof rawNs.baseline === "number" && Number.isFinite(rawNs.baseline) && typeof rawNs.target === "number" && Number.isFinite(rawNs.target)) {
    if (rawNs.target > rawNs.baseline) return { metricId, direction: "up" };
    if (rawNs.target < rawNs.baseline) return { metricId, direction: "down" };
  }

  return { metricId, direction: null };
}

function resolveOutcomeDirection(
  northStar: { metricId: string | null; direction: MetricDirection | null },
  outcome: Pick<IntentOutcomeRow, "metric" | "baseline" | "expected_point">,
): MetricDirection {
  const matchesNsMetric = Boolean(northStar.metricId && outcome.metric === northStar.metricId);
  if (northStar.direction && (!northStar.metricId || matchesNsMetric || outcome.baseline === null)) {
    return northStar.direction;
  }
  if (outcome.baseline !== null && Number.isFinite(outcome.baseline) && outcome.expected_point !== outcome.baseline) {
    return outcome.expected_point > outcome.baseline ? "up" : "down";
  }
  return northStar.direction ?? "up";
}

export type OutcomePolarity = "favourable" | "unfavourable" | "neutral";

function classifyOutcome(
  verdict: OutcomeVerdict,
  direction: MetricDirection,
): OutcomePolarity {
  if (verdict === "within") return "favourable";
  if (verdict === "above") return direction === "up" ? "favourable" : "unfavourable";
  if (verdict === "below") return direction === "down" ? "favourable" : "unfavourable";
  return "neutral";
}

/** Classifies an intent outcome against its project/domain charter North Star direction. */
export function classifyProjectOutcome(
  db: LanePilotDatabase,
  projectId: string,
  domain: string,
  outcome: Pick<IntentOutcomeRow, "metric" | "baseline" | "expected_point" | "verdict">,
): OutcomePolarity {
  const charterRow = getCharter(db, projectId, domain);
  const charterObj = parseJsonSafe<Record<string, unknown>>(charterRow?.charter_json, {});
  const northStar = resolveCharterNorthStar(charterObj);
  return classifyOutcome(outcome.verdict, resolveOutcomeDirection(northStar, outcome));
}

/** Creates or updates a hypothesis in the specialist's hypothesis tree. */
export function upsertHypothesis(
  db: LanePilotDatabase,
  input: UpsertHypothesisInput,
  log?: SpHypothesisLogger,
): SpHypothesisRow {
  const now = input.nowMs ?? Date.now();
  const title = input.title.trim();
  if (!title) throw new Error("hypothesis title is required");
  if (input.state !== undefined && !isHypothesisStateSp(input.state)) {
    throw new Error(`invalid hypothesis state: ${String(input.state)}`);
  }

  const trimmedId = input.id?.trim();
  const existing = trimmedId
    ? (db.prepare("SELECT * FROM lane_pilot_sp_hypothesis WHERE id = ?").get(trimmedId) as SpHypothesisRow | undefined)
    : undefined;

  if (existing) {
    if (existing.project_id !== input.projectId || existing.domain !== input.domain) {
      throw new Error(`hypothesis ${existing.id} belongs to another project/domain`);
    }
    const nextState: HypothesisStateSp = input.state ?? existing.state;
    const nextParent = input.parentId !== undefined ? input.parentId?.trim() || null : existing.parent_id;
    const nextLever = input.lever !== undefined ? input.lever?.trim() || null : existing.lever;
    const nextEvidence = input.evidence !== undefined ? JSON.stringify(input.evidence) : existing.evidence_json;

    db.prepare(
      `UPDATE lane_pilot_sp_hypothesis
       SET parent_id = ?, title = ?, lever = ?, state = ?, evidence_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(nextParent, title, nextLever, nextState, nextEvidence, now, existing.id);

    if (nextState !== existing.state) {
      log?.info?.(`sp hypothesis id=${existing.id} state=${existing.state}→${nextState}`);
    }
    return db.prepare("SELECT * FROM lane_pilot_sp_hypothesis WHERE id = ?").get(existing.id) as SpHypothesisRow;
  }

  const id = trimmedId || `hyp_${randomUUID()}`;
  const state: HypothesisStateSp = input.state ?? "open";
  const parentId = input.parentId?.trim() || null;
  const lever = input.lever?.trim() || null;
  const evidenceJson = JSON.stringify(input.evidence ?? []);

  db.prepare(
    `INSERT INTO lane_pilot_sp_hypothesis
      (id, project_id, domain, parent_id, title, lever, state, evidence_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.projectId, input.domain, parentId, title, lever, state, evidenceJson, now, now);

  log?.debug?.(`sp hypothesis id=${id} state=new→${state}`);
  return db.prepare("SELECT * FROM lane_pilot_sp_hypothesis WHERE id = ?").get(id) as SpHypothesisRow;
}

/** Links a staged intent outcome to a hypothesis and transitions `open` hypotheses to `testing`. */
export function linkIntent(
  db: LanePilotDatabase,
  intentId: string,
  hypothesisId: string,
  log?: SpHypothesisLogger,
): LinkIntentResult {
  const cleanIntentId = typeof intentId === "string" ? intentId.trim() : "";
  const cleanHypId = typeof hypothesisId === "string" ? hypothesisId.trim() : "";
  if (!cleanIntentId) {
    log?.warn?.(`sp hypothesis link refused intent=<missing>: missing intent_id`);
    return { ok: false, reason: "missing_intent_id" };
  }
  if (!cleanHypId) {
    log?.warn?.(`sp hypothesis link refused intent=${cleanIntentId}: missing hypothesis_id`);
    return { ok: false, reason: "missing_hypothesis_id" };
  }

  const tx = db.transaction((): LinkIntentResult => {
    const hyp = db
      .prepare("SELECT * FROM lane_pilot_sp_hypothesis WHERE id = ?")
      .get(cleanHypId) as SpHypothesisRow | undefined;
    if (!hyp) {
      log?.warn?.(`sp hypothesis link refused intent=${cleanIntentId}: unknown hypothesis ${cleanHypId}`);
      return { ok: false, reason: "unknown_hypothesis" };
    }
    if (hyp.state === "refuted" || hyp.state === "dropped") {
      log?.warn?.(`sp hypothesis link refused intent=${cleanIntentId}: hypothesis ${cleanHypId} is ${hyp.state}`);
      return { ok: false, reason: `hypothesis_${hyp.state}` };
    }

    const outcome = db
      .prepare("SELECT * FROM lane_pilot_sp_intent_outcome WHERE intent_id = ?")
      .get(cleanIntentId) as IntentOutcomeRow | undefined;
    if (!outcome) {
      log?.warn?.(`sp hypothesis link refused intent=${cleanIntentId}: unknown outcome`);
      return { ok: false, reason: "unknown_outcome" };
    }
    if (outcome.project_id !== hyp.project_id || outcome.domain !== hyp.domain) {
      log?.warn?.(`sp hypothesis link refused intent=${cleanIntentId}: project/domain mismatch`);
      return { ok: false, reason: "scope_mismatch" };
    }
    if (outcome.hypothesis_id && outcome.hypothesis_id !== cleanHypId) {
      log?.warn?.(`sp hypothesis link refused intent=${cleanIntentId}: already linked to ${outcome.hypothesis_id}`);
      return { ok: false, reason: "already_linked" };
    }

    if (outcome.hypothesis_id !== cleanHypId) {
      db.prepare("UPDATE lane_pilot_sp_intent_outcome SET hypothesis_id = ? WHERE intent_id = ?").run(
        cleanHypId,
        cleanIntentId,
      );
    }

    let finalState = hyp.state;
    if (hyp.state === "open") {
      finalState = "testing";
      db.prepare("UPDATE lane_pilot_sp_hypothesis SET state = 'testing', updated_at = ? WHERE id = ?").run(
        Date.now(),
        hyp.id,
      );
      log?.info?.(`sp hypothesis id=${hyp.id} state=open→testing`);
    }

    return { ok: true, hypothesisId: hyp.id, state: finalState };
  });

  return tx();
}

/**
 * Settles `testing` hypotheses for `(projectId, domain)` from their linked outcome verdicts:
 * - `worked`: >= 1 favourable (`within` or desired North Star direction) and 0 unfavourable
 * - `refuted`: >= 2 unfavourable
 * - `inconclusive` / `pending` outcomes do not move the hypothesis
 */
export function settleHypotheses(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; nowMs?: number },
  log?: SpHypothesisLogger,
): SettleHypothesesResult {
  const now = input.nowMs ?? Date.now();
  const charterRow = getCharter(db, input.projectId, input.domain);
  const charterObj = parseJsonSafe<Record<string, unknown>>(charterRow?.charter_json, {});
  const northStar = resolveCharterNorthStar(charterObj);

  const tx = db.transaction((): SettleHypothesesResult => {
    const testing = db
      .prepare(
        `SELECT * FROM lane_pilot_sp_hypothesis
         WHERE project_id = ? AND domain = ? AND state = 'testing'
         ORDER BY created_at ASC, id ASC`,
      )
      .all(input.projectId, input.domain) as SpHypothesisRow[];

    const settled: SettledHypothesisTransition[] = [];
    let workedCount = 0;
    let refutedCount = 0;

    for (const hyp of testing) {
      const outcomes = db
        .prepare(
          `SELECT * FROM lane_pilot_sp_intent_outcome
           WHERE hypothesis_id = ? AND project_id = ? AND domain = ?
           ORDER BY check_at ASC, intent_id ASC`,
        )
        .all(hyp.id, input.projectId, input.domain) as IntentOutcomeRow[];

      let favourable = 0;
      let unfavourable = 0;
      for (const out of outcomes) {
        const dir = resolveOutcomeDirection(northStar, out);
        const cls = classifyOutcome(out.verdict, dir);
        if (cls === "favourable") favourable += 1;
        else if (cls === "unfavourable") unfavourable += 1;
      }

      let nextState: HypothesisStateSp | null = null;
      if (unfavourable >= 2) nextState = "refuted";
      else if (favourable >= 1 && unfavourable === 0) nextState = "worked";

      if (!nextState) continue;

      const existingEvidence = parseJsonSafe<Array<Record<string, unknown>>>(hyp.evidence_json, []);
      const seenIntents = new Set(
        existingEvidence
          .map((e) => (e && typeof e.intent_id === "string" ? e.intent_id : null))
          .filter((x): x is string => x !== null),
      );
      const nextEvidence = [...existingEvidence];
      for (const out of outcomes) {
        if (out.verdict === "pending" || seenIntents.has(out.intent_id)) continue;
        seenIntents.add(out.intent_id);
        nextEvidence.push({
          intent_id: out.intent_id,
          metric: out.metric,
          verdict: out.verdict,
          measured: out.measured,
        });
      }

      db.prepare(
        `UPDATE lane_pilot_sp_hypothesis
         SET state = ?, evidence_json = ?, updated_at = ?
         WHERE id = ?`,
      ).run(nextState, JSON.stringify(nextEvidence), now, hyp.id);

      log?.info?.(`sp hypothesis id=${hyp.id} state=testing→${nextState}`);
      settled.push({ id: hyp.id, from: "testing", to: nextState });
      if (nextState === "worked") workedCount += 1;
      else refutedCount += 1;
    }

    return { settled, workedCount, refutedCount };
  });

  return tx();
}

/** Returns titles of `refuted` and `dropped` hypotheses (capped at 30) so the shift avoids repeating them. */
export function triedAlready(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; limit?: number },
): string[] {
  const limit = Math.max(1, Math.min(SNAPSHOT_MAX, input.limit ?? SNAPSHOT_MAX));
  const rows = db
    .prepare(
      `SELECT title FROM lane_pilot_sp_hypothesis
       WHERE project_id = ? AND domain = ? AND state IN ('refuted', 'dropped')
       ORDER BY updated_at DESC, id ASC
       LIMIT ?`,
    )
    .all(input.projectId, input.domain, limit) as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

/** Returns up to 30 `open` and `testing` hypotheses with their latest linked outcome verdict for shift snapshots. */
export function hypothesisTreeSnapshot(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; limit?: number },
): HypothesisTreeEntry[] {
  const limit = Math.max(1, Math.min(SNAPSHOT_MAX, input.limit ?? SNAPSHOT_MAX));
  const rows = db
    .prepare(
      `SELECT * FROM lane_pilot_sp_hypothesis
       WHERE project_id = ? AND domain = ? AND state IN ('open', 'testing')
       ORDER BY updated_at DESC, created_at DESC, id ASC
       LIMIT ?`,
    )
    .all(input.projectId, input.domain, limit) as SpHypothesisRow[];

  if (rows.length === 0) return [];

  const placeholders = rows.map(() => "?").join(",");
  const outcomes = db
    .prepare(
      `SELECT hypothesis_id, verdict
       FROM lane_pilot_sp_intent_outcome
       WHERE hypothesis_id IN (${placeholders})
       ORDER BY CASE WHEN verdict != 'pending' THEN 0 ELSE 1 END ASC,
                COALESCE(measured_at, check_at) DESC,
                intent_id DESC`,
    )
    .all(...rows.map((r) => r.id)) as Array<{ hypothesis_id: string; verdict: OutcomeVerdict }>;

  const lastVerdictByHyp = new Map<string, OutcomeVerdict>();
  for (const out of outcomes) {
    if (!lastVerdictByHyp.has(out.hypothesis_id)) {
      lastVerdictByHyp.set(out.hypothesis_id, out.verdict);
    }
  }

  return rows.map((r) => ({
    id: r.id,
    parent_id: r.parent_id,
    title: r.title,
    lever: r.lever,
    state: r.state,
    last_verdict: lastVerdictByHyp.get(r.id) ?? null,
  }));
}

/** Resolves an order's `new_hypothesis` (creating an `open` row) or existing `hypothesis_id`. */
export function resolveOrderHypothesis(
  db: LanePilotDatabase,
  input: { projectId: string; domain: string; order: Pick<ActionOrder, "hypothesis_id" | "new_hypothesis">; nowMs?: number },
  log?: SpHypothesisLogger,
): string | null {
  if (input.order.new_hypothesis) {
    const created = upsertHypothesis(
      db,
      {
        projectId: input.projectId,
        domain: input.domain,
        title: input.order.new_hypothesis.title,
        parentId: input.order.new_hypothesis.parent_id ?? null,
        lever: input.order.new_hypothesis.lever ?? null,
        state: "open",
        ...(input.nowMs !== undefined ? { nowMs: input.nowMs } : {}),
      },
      log,
    );
    return created.id;
  }
  return input.order.hypothesis_id?.trim() || null;
}
