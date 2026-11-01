/**
 * The tables of the lead («Штурман», .agents/plans/2026-11-01-lead-agent-roadmap.md §3.2).
 *
 * `lane_pilot_decision`: one row per question the owner is asked on a surface (a task's landing word, a phase's turn, the lead's own
 * proposals): the situation and the options as the surface saw them, the prediction written BEFORE the owner answered, his answer, the
 * judge's verdict and his own label. The exam that opens a class's right to decide reads only rows predicted before they were answered
 * (`predicted_at < answered_at`) in the split `exam`; a `backtest` row (a historical decision predicted after the fact) is a measurement
 * and never counts.
 * `lane_pilot_lead_road`: the road tree (WP0): directions and options with a reason and evidence; a rejected branch keeps its reason.
 * `lane_pilot_lead_tick`: one receipt per tick of the lead (WP3): what it read, proposed, acted on, deferred, and what it cost.
 * `lane_pilot_lead_right`: the tier a class holds (WP4), changed only by the nightly exam; `owner_only` is never changed by it.
 * `lane_pilot_lead_label`: the owner's labels on a decision (kind judge: his verdict; kind novelty: new|known), the kappa's ground truth.
 */
export const leadMigrations: readonly string[] = [
  `CREATE TABLE lane_pilot_decision (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    run_id TEXT,
    surface TEXT NOT NULL,
    class TEXT NOT NULL,
    risk TEXT,
    situation_json TEXT NOT NULL,
    options_json TEXT NOT NULL,
    prediction_json TEXT,
    predicted_at INTEGER,
    predictor TEXT,
    answer_json TEXT,
    answered_at INTEGER,
    answered_by TEXT,
    judge_verdict TEXT CHECK(judge_verdict IN ('exact','partial','miss','deferred')),
    judge_model TEXT,
    judged_at INTEGER,
    owner_label TEXT CHECK(owner_label IN ('exact','partial','miss','deferred')),
    labeled_at INTEGER,
    policy_version INTEGER,
    split TEXT NOT NULL CHECK(split IN ('exam','design','backtest')),
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_decision_class ON lane_pilot_decision(class, answered_at)`,
  `CREATE TABLE lane_pilot_lead_road (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    project_id TEXT,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('direction','option')),
    source TEXT NOT NULL CHECK(source IN ('owner','lead','pm','wall','bench')),
    why TEXT NOT NULL,
    evidence_json TEXT NOT NULL DEFAULT '[]',
    cost_estimate TEXT,
    class TEXT,
    state TEXT NOT NULL CHECK(state IN ('open','proposed','accepted','later','rejected','done')),
    proposed_at INTEGER,
    decided_at INTEGER,
    decision_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_lead_road_parent ON lane_pilot_lead_road(parent_id)`,
  `CREATE TABLE lane_pilot_lead_tick (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    wf_run_id TEXT,
    trigger TEXT NOT NULL,
    state_json TEXT,
    candidates_json TEXT,
    proposed_json TEXT,
    acted_json TEXT,
    deferred_json TEXT,
    tokens INTEGER,
    cost_micro_usd INTEGER,
    identity_sha TEXT,
    status TEXT NOT NULL CHECK(status IN ('running','ok','no_receipt','budget','error','off'))
  )`,
  `CREATE INDEX lane_pilot_lead_tick_started ON lane_pilot_lead_tick(started_at)`,
  `CREATE TABLE lane_pilot_lead_right (
    class TEXT PRIMARY KEY,
    tier TEXT NOT NULL CHECK(tier IN ('decides','proposes','owner_only')),
    n INTEGER, k INTEGER, m REAL, wilson_lb REAL, coverage REAL, kappa REAL,
    since INTEGER NOT NULL,
    policy_version INTEGER,
    last_exam_at INTEGER,
    reasons_json TEXT NOT NULL DEFAULT '[]'
  )`,
  `CREATE TABLE lane_pilot_lead_label (
    id TEXT PRIMARY KEY,
    decision_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('judge','novelty')),
    value TEXT NOT NULL,
    by TEXT NOT NULL,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_lead_label_decision ON lane_pilot_lead_label(decision_id, kind)`,
  // 0.1.455: a proposal of class schedule carries the schedule itself; the branch keeps it until the owner's «да» or the act step creates it.
  `ALTER TABLE lane_pilot_lead_road ADD COLUMN payload_json TEXT`,
];
