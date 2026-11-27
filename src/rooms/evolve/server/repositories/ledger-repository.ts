import { randomBytes } from "node:crypto";
import {
  ACTIVE_HYPOTHESIS_STATES,
  ARM_KINDS,
  EVOLVE_THRESHOLDS,
  EVOLVE_TRIAL_STATES,
  EVOLVE_VARIANT_KEYS,
  HYPOTHESIS_SOURCES,
  HYPOTHESIS_STATES,
  type ArmKind,
  type EvolveTrialState,
  type HypothesisSource,
  type HypothesisState,
} from "@lane-pilot/contracts";
import { canonicalJson, sha256Hex } from "@lane-pilot/kit";
import type { EvolveCaseDb, EvolveLogSink } from "./case-repository";

export type EvolveLedgerDb = EvolveCaseDb;

export type EvolveHypothesisRow = {
  id: string;
  workflowId: string;
  nodeId: string;
  armKind: ArmKind;
  variantJson: string;
  variantSignature: string;
  graphVersion: number;
  source: HypothesisSource;
  state: HypothesisState;
  draftId: string | null;
  scorecardJson: string | null;
  reason: string | null;
  createdAt: number;
  decidedAt: number | null;
};

export type QueueHypothesisInput = {
  id?: string | undefined;
  workflowId: string;
  nodeId: string;
  armKind: ArmKind;
  variant: unknown;
  graphVersion: number;
  source: HypothesisSource;
  draftId?: string | null | undefined;
  reason?: string | null | undefined;
  now?: number | undefined;
  activeCap?: number | undefined;
  bypassCap?: boolean | undefined;
};

export type QueueHypothesisResult =
  | { ok: true; hypothesis: EvolveHypothesisRow }
  | { ok: false; reason: "cap" | "negative" | "invalid_input" | "variant_key_forbidden" };

export type SetHypothesisStateInput = {
  id: string;
  state: HypothesisState;
  draftId?: string | null | undefined;
  scorecard?: unknown;
  reason?: string | null | undefined;
  now?: number | undefined;
};

export type AddNegativeInput = {
  workflowId: string;
  nodeId: string;
  graphVersion: number;
  reason: string;
  armKind?: ArmKind | undefined;
  variant?: unknown;
  variantSignature?: string | undefined;
  now?: number | undefined;
};

export type EvolveNegativeRow = {
  workflowId: string;
  nodeId: string;
  variantSignature: string;
  graphVersion: number;
  reason: string;
  at: number;
};

export type EvolveTrialRow = {
  trialId: string;
  hypothesisId: string;
  workflowId: string;
  baselineVersion: number;
  candidateDraftId: string;
  share: number;
  state: EvolveTrialState;
  openedAt: number;
  closedAt: number | null;
  reason: string | null;
};

export type OpenTrialInput = {
  trialId?: string | undefined;
  hypothesisId: string;
  workflowId: string;
  baselineVersion: number;
  candidateDraftId: string;
  share?: number | undefined;
  now?: number | undefined;
};

export type CloseTrialInput = {
  trialId: string;
  state: Exclude<EvolveTrialState, "open">;
  reason?: string | null | undefined;
  now?: number | undefined;
};

const ACTIVE_SET = new Set<string>(ACTIVE_HYPOTHESIS_STATES);
const ACTIVE_PLACEHOLDERS = ACTIVE_HYPOTHESIS_STATES.map(() => "?").join(", ");
const ALLOWED_VARIANT_KEY_SET = new Set<string>(EVOLVE_VARIANT_KEYS);

const newId = (prefix: string) => `${prefix}_${randomBytes(6).toString("hex")}`;

/** Computes the stable SHA-256 signature of a node-level variant proposal. */
export function variantSignature(nodeId: string, armKind: ArmKind, variant: unknown): string {
  return sha256Hex(canonicalJson({ node_id: nodeId, arm_kind: armKind, variant }));
}

function mapHypothesisRow(row: Record<string, unknown>): EvolveHypothesisRow {
  return {
    id: String(row.id),
    workflowId: String(row.workflow_id),
    nodeId: String(row.node_id),
    armKind: String(row.arm_kind) as ArmKind,
    variantJson: String(row.variant_json),
    variantSignature: String(row.variant_signature),
    graphVersion: Number(row.graph_version),
    source: String(row.source) as HypothesisSource,
    state: String(row.state) as HypothesisState,
    draftId: row.draft_id == null ? null : String(row.draft_id),
    scorecardJson: row.scorecard_json == null ? null : String(row.scorecard_json),
    reason: row.reason == null ? null : String(row.reason),
    createdAt: Number(row.created_at),
    decidedAt: row.decided_at == null ? null : Number(row.decided_at),
  };
}

function mapTrialRow(row: Record<string, unknown>): EvolveTrialRow {
  return {
    trialId: String(row.trial_id),
    hypothesisId: String(row.hypothesis_id),
    workflowId: String(row.workflow_id),
    baselineVersion: Number(row.baseline_version),
    candidateDraftId: String(row.candidate_draft_id),
    share: Number(row.share),
    state: String(row.state) as EvolveTrialState,
    openedAt: Number(row.opened_at),
    closedAt: row.closed_at == null ? null : Number(row.closed_at),
    reason: row.reason == null ? null : String(row.reason),
  };
}

/**
 * Records a workflow run as ingested into the evolve ledger (idempotent by `runId`).
 * Returns `true` when newly ingested and `false` if already present.
 */
export function markIngested(
  db: EvolveLedgerDb,
  runId: string,
  workflowId: string,
  nowOrOpts?: number | { now?: number | undefined; log?: EvolveLogSink | undefined },
  log?: EvolveLogSink,
): boolean {
  const cleanRunId = runId.trim();
  const cleanWorkflowId = workflowId.trim();
  if (!cleanRunId || !cleanWorkflowId) {
    throw new Error("markIngested requires non-empty runId and workflowId");
  }
  const now = typeof nowOrOpts === "number" ? nowOrOpts : (nowOrOpts?.now ?? Date.now());
  const sink = typeof nowOrOpts === "object" && nowOrOpts !== null ? (nowOrOpts.log ?? log) : log;

  const res = db.prepare(
    `INSERT OR IGNORE INTO lane_pilot_evolve_ingest (run_id, workflow_id, ingested_at)
     VALUES (?, ?, ?)`,
  ).run(cleanRunId, cleanWorkflowId, now);
  const isNew = res.changes > 0;
  sink?.debug?.(`evolve ingest run=${cleanRunId} new=${isNew}`);
  return isNew;
}

/** Counts active (`queued|replaying|report_only|canary`) hypotheses for a workflow. */
export function activeCount(db: EvolveLedgerDb, workflowId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS cnt
     FROM lane_pilot_evolve_hypothesis
     WHERE workflow_id = ? AND state IN (${ACTIVE_PLACEHOLDERS})`,
  ).get(workflowId, ...ACTIVE_HYPOTHESIS_STATES) as { cnt?: unknown } | undefined;
  return Number(row?.cnt ?? 0);
}

/** Checks whether a variant signature is already archived as negative for the same graph version. */
export function hasNegative(
  db: EvolveLedgerDb,
  workflowId: string,
  nodeId: string,
  signature: string,
  graphVersion: number,
): boolean {
  const row = db.prepare(
    `SELECT 1 AS found
     FROM lane_pilot_evolve_negative
     WHERE workflow_id = ? AND node_id = ? AND variant_signature = ? AND graph_version = ?
     LIMIT 1`,
  ).get(workflowId, nodeId, signature, graphVersion) as { found?: unknown } | undefined;
  return row !== undefined;
}

/**
 * Enqueues a hypothesis for a workflow node after enforcing the per-workflow active cap
 * and checking the version-scoped negative archive.
 */
export function queueHypothesis(
  db: EvolveLedgerDb,
  input: QueueHypothesisInput,
  log?: EvolveLogSink,
): QueueHypothesisResult {
  const workflowId = input.workflowId.trim();
  const nodeId = input.nodeId.trim();
  if (
    !workflowId ||
    !nodeId ||
    !Number.isFinite(input.graphVersion) ||
    !ARM_KINDS.includes(input.armKind) ||
    !HYPOTHESIS_SOURCES.includes(input.source) ||
    typeof input.variant !== "object" ||
    input.variant === null ||
    Array.isArray(input.variant)
  ) {
    return { ok: false, reason: "invalid_input" };
  }

  const variantKeys = Object.keys(input.variant as Record<string, unknown>);
  const forbiddenKey = variantKeys.find((key) => !ALLOWED_VARIANT_KEY_SET.has(key));
  if (forbiddenKey !== undefined) {
    log?.warn?.(`evolve hypothesis refused wf=${workflowId}: variant_key_forbidden (${forbiddenKey})`);
    return { ok: false, reason: "variant_key_forbidden" };
  }

  const graphVersion = Math.trunc(input.graphVersion);
  const signature = variantSignature(nodeId, input.armKind, input.variant);
  const variantJson = canonicalJson(input.variant);
  const id = input.id?.trim() || newId("evh");
  const now = input.now ?? Date.now();
  const cap = input.activeCap ?? EVOLVE_THRESHOLDS.activeCap;

  const outcome = db.transaction((): QueueHypothesisResult => {
    if (!input.bypassCap && activeCount(db, workflowId) >= cap) {
      return { ok: false, reason: "cap" };
    }
    if (hasNegative(db, workflowId, nodeId, signature, graphVersion)) {
      return { ok: false, reason: "negative" };
    }
    db.prepare(
      `INSERT INTO lane_pilot_evolve_hypothesis
        (id, workflow_id, node_id, arm_kind, variant_json, variant_signature, graph_version, source, state, draft_id, scorecard_json, reason, created_at, decided_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, NULL, ?, ?, NULL)`,
    ).run(
      id,
      workflowId,
      nodeId,
      input.armKind,
      variantJson,
      signature,
      graphVersion,
      input.source,
      input.draftId ?? null,
      input.reason ?? null,
      now,
    );
    return { ok: true, hypothesis: getHypothesis(db, id)! };
  })();

  if (!outcome.ok) {
    log?.warn?.(`evolve hypothesis refused wf=${workflowId}: ${outcome.reason}`);
    return outcome;
  }
  log?.info?.(`evolve hypothesis wf=${workflowId} node=${nodeId} arm=${input.armKind} state=queued`);
  return outcome;
}

/** Reads a hypothesis by ID, or `null` when absent. */
export function getHypothesis(db: EvolveLedgerDb, id: string): EvolveHypothesisRow | null {
  const row = db.prepare(
    `SELECT id, workflow_id, node_id, arm_kind, variant_json, variant_signature, graph_version, source, state, draft_id, scorecard_json, reason, created_at, decided_at
     FROM lane_pilot_evolve_hypothesis
     WHERE id = ?`,
  ).get(id) as Record<string, unknown> | undefined;
  return row ? mapHypothesisRow(row) : null;
}

/** Lists hypotheses filtered optionally by `workflowId` and/or `state`. */
export function listHypotheses(
  db: EvolveLedgerDb,
  filter: { workflowId?: string | undefined; state?: HypothesisState | readonly HypothesisState[] | undefined } = {},
): EvolveHypothesisRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.workflowId) {
    where.push("workflow_id = ?");
    params.push(filter.workflowId);
  }
  if (filter.state !== undefined) {
    const states = Array.isArray(filter.state) ? filter.state : [filter.state];
    if (states.length === 0) return [];
    where.push(`state IN (${states.map(() => "?").join(", ")})`);
    params.push(...states);
  }
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT id, workflow_id, node_id, arm_kind, variant_json, variant_signature, graph_version, source, state, draft_id, scorecard_json, reason, created_at, decided_at
     FROM lane_pilot_evolve_hypothesis
     ${whereClause}
     ORDER BY created_at ASC, id ASC`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapHypothesisRow);
}

/** Transitions a hypothesis state and optionally attaches draft ID, scorecard, or reason. */
export function setHypothesisState(
  db: EvolveLedgerDb,
  input: SetHypothesisStateInput,
  log?: EvolveLogSink,
): EvolveHypothesisRow | null {
  if (!HYPOTHESIS_STATES.includes(input.state)) {
    throw new Error(`invalid hypothesis state: ${input.state}`);
  }
  const current = getHypothesis(db, input.id);
  if (!current) return null;

  const now = input.now ?? Date.now();
  const draftId = input.draftId === undefined ? current.draftId : input.draftId;
  const reason = input.reason === undefined ? current.reason : input.reason;
  const scorecardJson = input.scorecard === undefined
    ? current.scorecardJson
    : input.scorecard === null
      ? null
      : JSON.stringify(input.scorecard);
  const decidedAt = ACTIVE_SET.has(input.state) ? null : (current.decidedAt ?? now);

  db.prepare(
    `UPDATE lane_pilot_evolve_hypothesis
     SET state = ?, draft_id = ?, scorecard_json = ?, reason = ?, decided_at = ?
     WHERE id = ?`,
  ).run(input.state, draftId, scorecardJson, reason, decidedAt, input.id);

  log?.info?.(`evolve hypothesis wf=${current.workflowId} node=${current.nodeId} arm=${current.armKind} state=${input.state}`);
  return getHypothesis(db, input.id);
}

/** Records a disproven variant in the append-only negative archive (idempotent per key). */
export function addNegative(
  db: EvolveLedgerDb,
  input: AddNegativeInput,
): { added: boolean; variantSignature: string } {
  const workflowId = input.workflowId.trim();
  const nodeId = input.nodeId.trim();
  const reason = input.reason.trim();
  if (!workflowId || !nodeId || !reason || !Number.isFinite(input.graphVersion)) {
    throw new Error("addNegative requires workflowId, nodeId, graphVersion, and reason");
  }
  let signature = input.variantSignature?.trim();
  if (!signature) {
    if (!input.armKind || !ARM_KINDS.includes(input.armKind)) {
      throw new Error("addNegative requires variantSignature or armKind + variant");
    }
    signature = variantSignature(nodeId, input.armKind, input.variant);
  }
  const graphVersion = Math.trunc(input.graphVersion);
  const at = input.now ?? Date.now();
  const res = db.prepare(
    `INSERT OR IGNORE INTO lane_pilot_evolve_negative
      (workflow_id, node_id, variant_signature, graph_version, reason, at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(workflowId, nodeId, signature, graphVersion, reason, at);
  return { added: res.changes > 0, variantSignature: signature };
}

/** Lists negative archive entries for a workflow. */
export function listNegatives(db: EvolveLedgerDb, workflowId: string): EvolveNegativeRow[] {
  const rows = db.prepare(
    `SELECT workflow_id, node_id, variant_signature, graph_version, reason, at
     FROM lane_pilot_evolve_negative
     WHERE workflow_id = ?
     ORDER BY at ASC, node_id ASC`,
  ).all(workflowId) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    workflowId: String(row.workflow_id),
    nodeId: String(row.node_id),
    variantSignature: String(row.variant_signature),
    graphVersion: Number(row.graph_version),
    reason: String(row.reason),
    at: Number(row.at),
  }));
}

/** Opens a live canary trial row for a hypothesis. */
export function openTrial(db: EvolveLedgerDb, input: OpenTrialInput): EvolveTrialRow {
  const hypothesisId = input.hypothesisId.trim();
  const workflowId = input.workflowId.trim();
  const candidateDraftId = input.candidateDraftId.trim();
  if (!hypothesisId || !workflowId || !candidateDraftId || !Number.isFinite(input.baselineVersion)) {
    throw new Error("openTrial requires hypothesisId, workflowId, baselineVersion, and candidateDraftId");
  }
  const share = input.share ?? EVOLVE_THRESHOLDS.canaryShare;
  if (!Number.isFinite(share) || share <= 0 || share > 1) {
    throw new Error("openTrial share must be in (0, 1]");
  }
  const trialId = input.trialId?.trim() || newId("evt");
  const openedAt = input.now ?? Date.now();
  db.prepare(
    `INSERT INTO lane_pilot_evolve_trial
      (trial_id, hypothesis_id, workflow_id, baseline_version, candidate_draft_id, share, state, opened_at, closed_at, reason)
     VALUES (?, ?, ?, ?, ?, ?, 'open', ?, NULL, NULL)`,
  ).run(trialId, hypothesisId, workflowId, Math.trunc(input.baselineVersion), candidateDraftId, share, openedAt);

  return mapTrialRow(
    db.prepare(
      `SELECT trial_id, hypothesis_id, workflow_id, baseline_version, candidate_draft_id, share, state, opened_at, closed_at, reason
       FROM lane_pilot_evolve_trial
       WHERE trial_id = ?`,
    ).get(trialId) as Record<string, unknown>,
  );
}

/** Closes an open trial with a terminal state (`promoted|retired|rolled_back`). */
export function closeTrial(db: EvolveLedgerDb, input: CloseTrialInput): EvolveTrialRow | null {
  const nextState: string = input.state;
  if (!EVOLVE_TRIAL_STATES.includes(input.state) || nextState === "open") {
    throw new Error(`closeTrial requires a terminal state, got ${input.state}`);
  }
  const closedAt = input.now ?? Date.now();
  const res = db.prepare(
    `UPDATE lane_pilot_evolve_trial
     SET state = ?, closed_at = ?, reason = ?
     WHERE trial_id = ? AND state = 'open'`,
  ).run(input.state, closedAt, input.reason ?? null, input.trialId);
  if (res.changes === 0) return null;
  const row = db.prepare(
    `SELECT trial_id, hypothesis_id, workflow_id, baseline_version, candidate_draft_id, share, state, opened_at, closed_at, reason
     FROM lane_pilot_evolve_trial
     WHERE trial_id = ?`,
  ).get(input.trialId) as Record<string, unknown> | undefined;
  return row ? mapTrialRow(row) : null;
}

/** Reads a canary trial by ID, or `null` when absent. */
export function getTrial(db: EvolveLedgerDb, trialId: string): EvolveTrialRow | null {
  const row = db.prepare(
    `SELECT trial_id, hypothesis_id, workflow_id, baseline_version, candidate_draft_id, share, state, opened_at, closed_at, reason
     FROM lane_pilot_evolve_trial
     WHERE trial_id = ?`,
  ).get(trialId) as Record<string, unknown> | undefined;
  return row ? mapTrialRow(row) : null;
}

/** Returns the currently open canary trial for a workflow, or `null` if none is open. */
export function openTrialFor(db: EvolveLedgerDb, workflowId: string): EvolveTrialRow | null {
  const row = db.prepare(
    `SELECT trial_id, hypothesis_id, workflow_id, baseline_version, candidate_draft_id, share, state, opened_at, closed_at, reason
     FROM lane_pilot_evolve_trial
     WHERE workflow_id = ? AND state = 'open'
     ORDER BY opened_at DESC, trial_id DESC
     LIMIT 1`,
  ).get(workflowId) as Record<string, unknown> | undefined;
  return row ? mapTrialRow(row) : null;
}

/** Atomically claims a one-shot evolve flag key (`INSERT OR IGNORE`); returns `true` only on first claim. */
export function claimEvolveFlag(db: EvolveLedgerDb, key: string, value = "1"): boolean {
  const res = db.prepare(
    `INSERT OR IGNORE INTO lane_pilot_evolve_flag (key, value)
     VALUES (?, ?)`,
  ).run(key, value);
  return res.changes > 0;
}
