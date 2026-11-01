/**
 * The decision journal of the lead («Штурман», .agents/plans/2026-11-01-lead-agent-roadmap.md §3.2). One row per question the owner is asked
 * on a surface (a task's landing word, a phase's turn, later the owner list and permits): the situation and the options as the surface saw
 * them, the prediction written BEFORE the owner answered, his answer, the judge's verdict and his own label. The exam that opens a class's
 * right to decide reads only rows predicted before they were answered (`predicted_at < answered_at`) in the split `exam`; a `backtest` row
 * (a historical decision predicted after the fact) is a measurement and never counts.
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
];
