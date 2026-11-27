/**
 * Setting keys shared by the catalog rows and the rooms that read or write them; consumers import the
 * name instead of spelling the literal. Keys without a catalog row (webhook, worker, install receipt)
 * still live here so the read and the write cannot drift.
 */
export const SETTING_WRITER_SILENCE_NUDGE_MIN = "writer.silence_nudge_min";
export const WRITER_PROVIDER_KEY = "writer.provider";
export const WRITER_MODEL_KEY = "writer.model";
export const ONBOARDING_PROVIDER_KEY = "onboarding.provider";
export const ONBOARDING_MODEL_KEY = "onboarding.model";
export const HELPER_CONTEXT_MODE_KEY = "helper.context_mode";
export const SETTING_WRITER_CAPACITY_WAIT_MAX_MIN = "writer.capacity_wait_max_min";
export const SETTING_EVENTS_WEBHOOK_URL = "events.webhook_url";
export const SETTING_WORKER_STRICT_USER = "worker.strict_user";
export const SETTING_WORKER_USER = "worker.user";
export const SETTING_CODEX_LEAN_ROLES = "codex.lean_roles";
export const SETTING_INSTALL_LAST_RECEIPT = "install.lastReceipt";
export const SETTING_EPISODES_PROCESS_KEY = "episodes.process_key";
export const SETTING_BACKLOG_SCAN_MINUTES = "backlog.scan_minutes";
export const SETTING_VERIFICATION_PROJECT_SUITE = "verification.project_suite";
export const SETTING_WORKFLOW_DISABLED = "workflow.disabled";
export const SETTING_LOOPS_MODE = "loops.mode";

export const PATHS_DEDUPE_THRESHOLD_KEY = "paths.dedupe_threshold";
export const DEFAULT_PATHS_DEDUPE_THRESHOLD = 0.8;
export const PATHS_BRANCH_DRAFT_REPEATS_KEY = "paths.branch_draft_repeats";
export const DEFAULT_PATHS_BRANCH_DRAFT_REPEATS = 3;
export const PATHS_BRANCH_WINDOW_DAYS_KEY = "paths.branch_window_days";
export const DEFAULT_PATHS_BRANCH_WINDOW_DAYS = 30;
