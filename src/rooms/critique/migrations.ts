export const critiqueMigrations = [
  `CREATE TABLE lane_pilot_judge_calibration (
    workflow_id TEXT NOT NULL,
    judge_provider TEXT NOT NULL,
    judge_model TEXT NOT NULL,
    n INTEGER NOT NULL,
    agree INTEGER NOT NULL,
    wilson_low REAL NOT NULL,
    trusted INTEGER NOT NULL,
    at INTEGER NOT NULL,
    PRIMARY KEY (workflow_id, judge_provider, judge_model)
  )`,
] as const;
