/** The per-task pipeline every dispatch runs through (PM read, critiques, ownership base, writer). */
export const LP_TASK_PIPELINE = "lp-task-pipeline";
/** The graph that runs once a task is accepted: memory maintenance and project life, side by side (started by the merge, never offered). */
export const AFTER_ACCEPT = "lp.after-accept";
/** The graph of one docs unit of the night (prepare, write, verify, commit), started by the nightly docs schedules. */
export const DOCS_NIGHT = "lp.docs-night";
/** The graph of the docs upkeep of one accepted task, started by the hourly docs-maintenance schedule. */
export const DOCS_MAINTENANCE = "lp.docs-maintenance";
/** The graph of one self-repair (worktree, repair thread, verdict and merge), started by the self-repair watcher. */
export const SELF_REPAIR = "lp.self-repair";
/** The graph of the router's model step (`lane_pilot_route` escalates a request System One cannot decide alone): one read-only helper thread, a real run of its own. */
export const ROUTE_WORKFLOW = "lp.route";
/** The outer chain of the chains spec: analyze, plan, build, check, close. */
export const ANALYZE_PLAN_EXECUTE = "analyze-plan-execute";

/** Off keeps the previous issue-quick graph (triage, plan, build). Anything else, including a missing row, is the short path. */
export const ISSUE_QUICK_SHORT_PATH = "issue_quick.short_path";

/** The idempotency key prefix of a run a schedule started; the origin is read back from it (and from the parent run) after a reload. */
export const SCHEDULE_RUN_KEY_PREFIX = "wf-schedule:";
