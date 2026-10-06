export const TARGET_SHA = "dd77b26792eca15e8bde03fd26754922ea7ab4f0";
export const UPSTREAM_REPO = "https://github.com/VKirill/claude-lane-stack";
export const OPENCODE_PLUGIN = "./plugins/opencode-lane.ts";
export const OPENCODE_OLD_PLUGIN = "./plugins/lane-context.ts";

export const S8_RELATIVE_PATHS = [
  ".agents/routing.profile.yaml",
  ".agents/night-shift.yaml",
  ".agents/capabilities.json",
] as const;

export const EXTERNAL_OPS = [
  "npm install -g @rama_nigg/open-cursor",
  "open-cursor install",
  "claude plugin marketplace add/update",
  "claude plugin install lane-stack@claude-lane-stack",
  "claude plugin uninstall fast-jev-compaction@*",
] as const;

export const EXTERNAL_OPS_BY_ACTION = {
  install: EXTERNAL_OPS,
  connect: [] as readonly string[],
  rollback: [] as readonly string[],
} as const;

export const EXTERNAL_OPS_WARNING =
  "откат не гарантированно вернёт систему в исходное состояние — будет зафиксировано состояние до и после, не восстановление";

export function cliReceiptRunKey(runId: string): string {
  return `cli.receipt.run.${runId}`;
}

export function cliReceiptAttemptKey(attemptId: string): string {
  return `cli.receipt.attempt.${attemptId}`;
}

export const PLUGIN_ID = "lane-pilot";
export const INSTALLED_GUARD = "~/.agents/hooks/guard_shell.py";
export const MAIN_ATTEMPT_LIMIT = 2;

/** Reason of a queued attempt whose dispatch still waits for pm-read and plan critique; a reload ends such an attempt. */
export const DISPATCH_STAGES_PENDING = "dispatch_stages_pending: pm-read and plan critique are still running";
/** The same task id with the same contract and plan inside this window is the same dispatch, not a new task. */
export const DISPATCH_IDEMPOTENT_WINDOW_MS = 30 * 60_000;
