/** The per-task pipeline every dispatch runs through (PM read, critiques, ownership base, writer). */
export const LP_TASK_PIPELINE = "lp-task-pipeline";
/** The graph that runs once a task is accepted: memory maintenance (started by the merge, never offered). */
export const AFTER_ACCEPT = "lp.after-accept";
/** The graph of one self-repair (worktree, repair thread, verdict and merge), started by the self-repair watcher. */
export const SELF_REPAIR = "lp.self-repair";
/** The body of the two worktree-cleanup system schedules (docs/worktrees.md); the daily pass posts its own owner line, a failure is the board's. */
export const WORKTREE_CLEANUP = "lp.worktree-cleanup";
/** The graph of the router's model step (`lane_pilot_route` escalates a request System One cannot decide alone): one read-only helper thread, a real run of its own. */
/** The outer chain of the chains spec: analyze, plan, build, check, close. */
export const ANALYZE_PLAN_EXECUTE = "analyze-plan-execute";

/** Off keeps the previous issue-quick graph (triage, plan, build). Anything else, including a missing row, is the short path. */
export const ISSUE_QUICK_SHORT_PATH = "issue_quick.short_path";

/** The idempotency key prefix of a run a schedule started; the origin is read back from it (and from the parent run) after a reload. */
export const SCHEDULE_RUN_KEY_PREFIX = "wf-schedule:";

/** Project-level workflows shown on the Work → Big projects tab and skipped during template lookup. */
export const PROJECT_WORKFLOW_IDS = ["project-start", "full-lifecycle", "roadmap-driven"] as const;
export const GENERIC_PROJECT_WORKFLOW_IDS: ReadonlySet<string> = new Set(PROJECT_WORKFLOW_IDS);
