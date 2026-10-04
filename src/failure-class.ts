/**
 * Which side a failed writer attempt is on, so the reaction fits the cause (Kubernetes podFailurePolicy, Buildkite
 * automatic retry, Temporal non-retryable errors): only `task` and `provider` failures spend the task's two attempts.
 * - merge: main moved while the task ran; redone on the new main for free.
 * - harness: Lane Pilot's own fault; the task is parked and restarts by itself once a fix ships.
 * - infra: the machine (disk, git lock, host offline); parked and retried with a backoff.
 * - contract, judgment: the PM's to fix or answer; never retried as is.
 */
export type FailureClass = "task" | "provider" | "merge" | "harness" | "infra" | "contract" | "judgment";

const JUDGMENT = /needs_human/i;
const MERGE = /^merge_conflict/i;
const INFRA = /ENOSPC|no space left|disk_low|index\.lock|host is not connected|host offline|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED/i;
// Same list the self-repair watcher treats as Lane Pilot's own fault, plus the thread lookups that broke on 2026-10-04.
const HARNESS = /internal_error|merge_failed|merge_queue_timeout|ownership run scope invalid|spawn failed|thread_provisioning_failed|EROFS|execution_packet_failed|snapshot_failed|helper_context|workspace path is inside|stale API handle|ownership git base|cannot compare pre-existing|reconcile_|attempt_worktree_|attempt_workspace_|writer reconcile|its retry was lost/i;
const CONTRACT = /^missing expected_outputs|output_unowned|depends_on .*(ended|no such task)|plan critique|critique_blocked/i;
const PROVIDER_STATES = new Set(["provider_error", "timeout", "empty_output"]);

export function failureClass(state:string, reason:string | null | undefined):FailureClass {
  const text = reason ?? "";
  if (JUDGMENT.test(text)) return "judgment";
  if (MERGE.test(text)) return "merge";
  if (INFRA.test(text)) return "infra";
  if (HARNESS.test(text)) return "harness";
  if (CONTRACT.test(text)) return "contract";
  if (PROVIDER_STATES.has(state) || /^(writer_provider_unavailable|writer_model_unavailable|writer_service_tier_unavailable)/.test(text)) return "provider";
  return "task";
}

/** Failures that do not spend one of the task's attempts. */
export const FREE_CLASSES:ReadonlySet<FailureClass> = new Set(["merge", "harness", "infra"]);
/** Parked failures: the task waits for a fix or the machine, then restarts by itself. */
export const PARKED_CLASSES:ReadonlySet<FailureClass> = new Set(["harness", "infra"]);
/** Free retries a task may take on top of its two attempts, so a repeating free failure still ends. */
export const FREE_RETRY_LIMIT = 3;

/** A reason with ids, hashes, numbers and paths taken out: the same fault on different tasks reads the same. */
export function failureFingerprint(reason:string | null | undefined):string {
  return (reason ?? "").toLowerCase()
    .replace(/\b(lp(attempt|run)|thr|env|term|host|proj|ask)_[a-z0-9]+/g, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hash>")
    .replace(/(\/[\w.@-]+)+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ").trim().slice(0, 120);
}
