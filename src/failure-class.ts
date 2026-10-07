/**
 * Which side a failed writer attempt is on, so the reaction fits the cause (Kubernetes podFailurePolicy, Buildkite
 * automatic retry, Temporal non-retryable errors): only `task` and `provider` failures spend the task's two attempts.
 * - merge: main moved while the task ran; redone on the new main for free.
 * - harness: Lane Pilot's own fault; the task is parked and restarts by itself once a fix ships.
 * - infra: the machine (disk, git lock, host offline); parked and retried with a backoff.
 * - contract, judgment: the PM's to fix or answer; never retried as is.
 * - budget: a run hit run.max_*; uncharged, not parked, not retried.
 * - limit: the writer's provider takes no work now (plan, quota, credits, or its breaker is open); uncharged, the task
 *   moves down the writer chain at once.
 */
export type FailureClass = "task" | "provider" | "merge" | "harness" | "infra" | "contract" | "judgment" | "budget" | "limit";

import { cleanCheckOutput } from "./output-excerpt";
import { NO_ANSWER_REASON } from "./validate-output";

const JUDGMENT = /needs_human/i;
const MERGE = /(^|: )merge_conflict/i;
// Before 0.1.117 a merge that git refused for another reason (a stale index.lock) was called a conflict with no files.
const MISLABELED_MERGE = /merge_conflict: main changed since this attempt started:\s*$/i;
// Linux git 2.43 names no lock in «Unable to write index» (OVH 2026-10-06); the wording is added beside index.lock.
const INFRA = /ENOSPC|no space left|EACCES|EPERM|permission denied|PermissionError|disk_low|index\.lock|unable to write (new )?index|host is not connected|host offline|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED/i;
// Same list the self-repair watcher treats as Lane Pilot's own fault, plus the thread lookups that broke on 2026-10-04.
const HARNESS = /internal_error|merge_failed|merge_queue_timeout|ownership run scope invalid|spawn failed|thread_provisioning_failed|EROFS|execution_packet_failed|snapshot_failed|helper_context|workspace path is inside|stale API handle|ownership git base|cannot compare pre-existing|reconcile_|attempt_worktree_|attempt_workspace_|writer reconcile|its retry was lost|reconcile completed on a short page|sticky_send_failed|sticky_failed/i;
// A folder without git is a mode of its own (live-folder.ts): its limits are the folder's, so the owner's to settle — never a
// fault of Lane Pilot to park, and a leftover «not a git repository» reads the same.
const NO_GIT = /not a git repository|no-git mode/i;
const CONTRACT = /^merge_blocked:|^missing expected_outputs|output_unowned|depends_on .*(ended|no such task)|plan critique|critique_blocked/i;
const BUDGET = /^run_budget_exceeded:/;
const LIMIT = /writer_provider_limit:|^writer_provider_unavailable:breaker_open/;
/** A writer that stayed silent through its nudges (writer-silence.ts): the provider's session hung, not the task's work. */
export const WRITER_SILENT_REASON = "writer_silent_after_nudge";
const SILENT = /^writer_silent_after_nudge/;
export const isWriterSilent = (reason:string | null | undefined):boolean => SILENT.test(reason ?? "");
// An empty_output is a provider fault only when the writer gave no answer; an answer with no files is the task's.
const PROVIDER_STATES = new Set(["provider_error", "timeout"]);

export function failureClass(state:string, reason:string | null | undefined):FailureClass {
  const text = reason ?? "";
  if (JUDGMENT.test(text)) return "judgment";
  if (BUDGET.test(text)) return "budget";
  if (LIMIT.test(text)) return "limit";
  if (SILENT.test(text)) return "provider";
  if (NO_GIT.test(text)) return "contract";
  if (MISLABELED_MERGE.test(text)) return "harness";
  if (MERGE.test(text)) return "merge";
  if (INFRA.test(text)) return "infra";
  if (HARNESS.test(text)) return "harness";
  if (CONTRACT.test(text)) return "contract";
  if (PROVIDER_STATES.has(state) || /^(writer_provider_unavailable|writer_model_unavailable|writer_service_tier_unavailable)/.test(text)) return "provider";
  if (state === "empty_output") return text.includes(NO_ANSWER_REASON) ? "provider" : "task";
  return "task";
}

/**
 * Two consecutive attempts of a task family failing the same way will not get better on a third: the task is blocked
 * for the PM instead of spending another writer (and no fallback writer is started). Only the task's and the
 * provider's classes stop here — free classes have their own parks and caps.
 */
export function repeatedFailureReason(
  previous:{ state:string; reason:string | null | undefined } | null | undefined,
  current:{ state:string; reason:string | null | undefined },
):string | null {
  if (!previous) return null;
  const cls = failureClass(previous.state, previous.reason);
  // A contract failure repeats too (a contract naming outputs or paths no attempt can meet failed the same way
  // twice); free classes keep their own parks and caps, and judgment stops on its own.
  if (cls !== "task" && cls !== "provider" && cls !== "contract") return null;
  if (failureClass(current.state, current.reason) !== cls) return null;
  if (failureFingerprint(previous.reason) !== failureFingerprint(current.reason)) return null;
  return `repeated_failure: ${String(current.reason ?? current.state).slice(0, 600)}`;
}

/** A task and its redispatches and mainfixes share one family: «P1», «P1.2», «x-mainfix.2» are of «P1» / «x». */
export function taskFamily(taskId:string):string {
  let family = taskId;
  for (;;) {
    const next = family.replace(/(\.\d+)+$/, "").replace(/-mainfix$/, "");
    if (next === family) return family;
    family = next;
  }
}

// The machine, not the merged code: root-owned files left by a deploy (OVH `rmSync …/.output`), a stale output folder.
const ENVIRONMENT_CHECK_ERROR = /\b(?:EACCES|EPERM|EEXIST)\b|permission denied/i;
/** A failing check whose output shows the environment broke it: no writer can fix that in owns_paths. */
export const isEnvironmentCheckFailure = (check:{ stdout?:string; stderr?:string }):boolean =>
  ENVIRONMENT_CHECK_ERROR.test(`${check.stderr ?? ""}\n${check.stdout ?? ""}`);

/** Failures that do not spend one of the task's attempts. */
export const FREE_CLASSES:ReadonlySet<FailureClass> = new Set(["merge", "harness", "infra", "budget", "limit"]);
/** What the PM does next about a task that did not end accepted, by its failure class; shown in wait receipts. */
export function nextStep(state:string, reason:string | null | undefined):string {
  if (["queued", "running", "spawn_requested", "validating"].includes(state)) return "wait: the writer is still on it";
  if (NO_GIT.test(reason ?? "")) return "the folder has no git and does not fit the no-git mode (too many files or owned bytes): put it under git, or narrow owns_paths, then dispatch again";
  switch (failureClass(state, reason)) {
    case "judgment": return "answer_writer: answer its question with lane_pilot_answer_writer (taskId, answer); the writer continues in its thread";
    case "harness": case "infra": return "parked: restarts by itself once the fault clears; do nothing";
    case "limit": return "moves down the writer chain by itself; do nothing";
    case "merge": return "redone on the new main by itself; do nothing";
    case "contract": return "fix the contract: lane_pilot_update_task if it has not started, else dispatch it again with the changed contract";
    case "budget": return "the run hit its budget: raise run.max_* or finish the run";
    default: return "its writer session ended without green checks: read the reason, fix the plan or contract and dispatch it again";
  }
}

/** Parked failures: the task waits for a fix or the machine, then restarts by itself. */
export const PARKED_CLASSES:ReadonlySet<FailureClass> = new Set(["harness", "infra"]);
/** Free retries a task may take on top of its two attempts, so a repeating free failure still ends. */
export const FREE_RETRY_LIMIT = 3;

/** A reason with ids, hashes, numbers and paths taken out: the same fault on different tasks reads the same. */
export function failureFingerprint(reason:string | null | undefined, max = 120):string {
  return (reason ?? "").toLowerCase()
    .replace(/\b(lp(attempt|run)|thr|env|term|host|proj|ask)_[a-z0-9]+/g, "<id>")
    .replace(/\b[0-9a-f]{12,}\b/g, "<hash>")
    .replace(/(\/[\w.@-]+)+/g, "<path>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ").trim().slice(0, max);
}

/** One writer session's feedback turns: the cap, the wall-time cap, and what makes two turns the same. */
export const SESSION_MAX_TURNS = 5;
export const SESSION_MAX_MS = 120 * 60_000;

/**
 * What a failed turn failed with: the reason and the failing check's output, read the same across ids, paths, numbers
 * and timings. Two consecutive turns with this key and the writer's diff both unchanged made no progress.
 */
export function turnFailureKey(last:{ reason?:unknown; verification?:unknown }):string {
  const checks = Array.isArray(last.verification) ? last.verification as Array<{ exitCode?:number; stdout?:string; stderr?:string }> : [];
  const failed = checks.find((check) => typeof check.exitCode === "number" && check.exitCode !== 0);
  const output = failed ? cleanCheckOutput(`${failed.stderr ?? ""}\n${failed.stdout ?? ""}`).slice(-4000) : "";
  return failureFingerprint(typeof last.reason === "string" ? last.reason : "", 400) + "|" + failureFingerprint(output, 4000);
}
