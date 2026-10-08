/**
 * Which side a failed writer attempt is on, so the reaction fits the cause (Kubernetes podFailurePolicy, Buildkite
 * automatic retry, Temporal non-retryable errors): only `task` and `provider` failures spend the task's two attempts.
 * - merge: main moved while the task ran; redone on the new main for free.
 * - dirty_base: git refused the merge over uncommitted edits in the base checkout (the owner's, or bookkeeping Lane Pilot left
 *   there). Another writer run cannot clear them, so the task is parked like an infra fault, backed off and restarted after the
 *   edits are committed; it is uncharged, and it counts in the 7-day error budget (the work did not land) without tripping
 *   the version's canary (a release did not cause it).
 * - harness: Lane Pilot's own fault; the task is parked and restarts by itself once a fix ships.
 * - infra: the machine (disk, git lock, host offline); parked and retried with a backoff.
 * - contract, judgment: the PM's to fix or answer; never retried as is.
 * - contract also holds a task that waits for a secret (`waiting_secret:NAME`, Env Catalog): uncharged and restarted when the secret is saved.
 * - budget: a run hit run.max_*; uncharged, not parked, not retried.
 * - limit: the writer's provider takes no work now (plan, quota, credits, or its breaker is open); uncharged, the task
 *   moves down the writer chain at once.
 */
export type FailureClass = "task" | "provider" | "merge" | "dirty_base" | "harness" | "infra" | "contract" | "judgment" | "budget" | "limit";

import { cleanCheckOutput } from "@lane-pilot/kit";

/** The reason recorded when the writer gave no answer at all; the only empty_output that reads as a provider fault. */
export const NO_ANSWER_REASON = "writer returned no output";

const JUDGMENT = /needs_human/i;
const MERGE = /(^|: )merge_conflict/i;
// Before 0.1.117 a merge that git refused for another reason (a stale index.lock) was called a conflict with no files. Those rows
// are still in the database, but no code path writes that reason any more (git-integrate.ts answers `failed`, i.e. merge_failed,
// when git names no file), so one that is read now is a conflict like any other: a free redo, not a fault of Lane Pilot (hub
// 2026-10-08: 35 of the 106 «harness» faults of the 7-day budget were these).
/** «retry limit 2 exhausted: X» (reconcile.ts, writer/start.ts, rpc/runs.ts) is X tried too often: it is classified by X. */
const RETRY_LIMIT_WRAPPER = /^retry limit \d+ exhausted:\s*/i;
/** A red check: the task's, unless the reason carries the environment marker. Its output is a log, not a statement about Lane Pilot. */
const CHECK_FAILED = /^verification failed\b/;
/** The attempt replayed on a moved main failed the task's own checks there; part of the merge-conflict reason, so the redo is free. */
export const REPLAY_CHECK_FAILED = "checks red after the replay on main";
// Linux git 2.43 names no lock in «Unable to write index» (OVH 2026-10-06); the wording is added beside index.lock.
const INFRA = /ENOSPC|no space left|PermissionError|disk_low|index\.lock|unable to write (new )?index|host is not connected|host offline|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED/i;
// A permission error is the machine's only when it is not a check's own output: a red test that logs «EACCES» is the task's
// (0.1.177). A reason built from a check names the environment itself (ENVIRONMENT_REASON); any other reason keeps the wording.
const PERMISSION = /\b(?:EACCES|EPERM)\b|permission denied/i;
/** The marker validate-output puts after «verification failed (cmd): » when the check died of the environment, not of the code. */
export const ENVIRONMENT_REASON = "environment: ";
const CHECK_REASON = /verification failed \([^)]*\): /;
const isEnvironmentReason = (text:string):boolean => {
  const check = CHECK_REASON.exec(text);
  return check ? text.slice(check.index + check[0].length).startsWith(ENVIRONMENT_REASON) : PERMISSION.test(text);
};
// Same list the self-repair watcher treats as Lane Pilot's own fault, plus the thread lookups that broke on 2026-10-04.
const HARNESS = /internal_error|merge_failed|merge_queue_timeout|ownership run scope invalid|spawn failed|thread_provisioning_failed|EROFS|execution_packet_failed|snapshot_failed|helper_context|workspace path is inside|stale API handle|ownership git base|cannot compare pre-existing|reconcile_|attempt_worktree_|attempt_workspace_|writer reconcile|its retry was lost|reconcile completed on a short page|sticky_send_failed|sticky_failed/i;
// A folder without git is a mode of its own (live-folder.ts): its limits are the folder's, so the owner's to settle — never a
// fault of Lane Pilot to park, and a leftover «not a git repository» reads the same.
const NO_GIT = /not a git repository|no-git mode/i;
const CONTRACT = /^merge_blocked:|^missing expected_outputs|output_unowned|depends_on .*(ended|no such task)|plan critique|critique_blocked/i;
const BUDGET = /^run_budget_exceeded:/;
/** git refused a merge over someone's uncommitted edits in the base checkout: a dirty base, the merge waits for a commit — a writer cannot clear it. */
const DIRTY_BASE = /would be overwritten by merge|base checkout has uncommitted changes/i;
/** A run task whose contract names an unsafe path (`../other-repo/`): the PM's contract to fix, not Lane Pilot's fault. */
const UNSAFE_CONTRACT = /ownership run scope invalid: run task [^:]+: unsafe/i;
/** A critic's block verdict (verdict.ts): the task is stopped, not redone, until the PM or the owner changes the approach. */
const VERDICT_BLOCK = /^verdict_block:/;
/** A task waits for an Env Catalog secret its checks declare (J6): the PM's to ask the owner for, never the writer's fault. */
const WAITING_SECRET = /^waiting_secret:/;
export const isWaitingSecret = (reason:string | null | undefined):boolean => WAITING_SECRET.test(reason ?? "");
/** The task spent its overall writer-attempt budget (retry-budget.ts): ends for the PM, never parked or redriven. */
const RETRY_BUDGET = /^retry_budget_exhausted:/;
const LIMIT = /writer_provider_limit:|^writer_provider_unavailable:(breaker_open|usage_window)/;
/** A writer that stayed silent through its nudges (writer-silence.ts): the provider's session hung, not the task's work. */
export const WRITER_SILENT_REASON = "writer_silent_after_nudge";
const SILENT = /^writer_silent_after_nudge/;
export const isWriterSilent = (reason:string | null | undefined):boolean => SILENT.test(reason ?? "");
// An empty_output is a provider fault only when the writer gave no answer; an answer with no files is the task's.
const PROVIDER_STATES = new Set(["provider_error", "timeout"]);

// Reasons Lane Pilot writes itself for work that is the task's: ownership, empty answers, the critic, the session caps.
const TASK_REASON = /owns_paths|outside|ownership|changed no files|no files|code_critique|critique|acceptance|repeated_failure|no progress|wall limit|turn cap|follow_up|fixture|writer_output_not_accepted|stopped by/i;

/**
 * The class and whether a rule decided it. `confident: false` is the default `task` that nothing matched: the reasons Lane
 * Pilot writes itself are all rules, so this is a reason from a tool, a provider or a check the rules have not seen, and the
 * one the Jev judgment `failure.class` (J-4, src/jev/judgments/failure-class.ts) may be asked about.
 */
export function classifyFailure(state:string, reason:string | null | undefined):{ cls:FailureClass; confident:boolean } {
  const text = (reason ?? "").replace(RETRY_LIMIT_WRAPPER, "");
  const sure = (cls:FailureClass) => ({ cls, confident:true });
  if (VERDICT_BLOCK.test(text)) return sure("contract");
  if (JUDGMENT.test(text)) return sure("judgment");
  if (BUDGET.test(text) || RETRY_BUDGET.test(text)) return sure("budget");
  if (LIMIT.test(text)) return sure("limit");
  if (SILENT.test(text)) return sure("provider");
  if (NO_GIT.test(text) || WAITING_SECRET.test(text)) return sure("contract");
  if (MERGE.test(text)) return sure("merge");
  if (DIRTY_BASE.test(text) && !/^merge_blocked:/.test(text)) return sure("dirty_base");
  if (UNSAFE_CONTRACT.test(text)) return sure("contract");
  if (INFRA.test(text) || isEnvironmentReason(text)) return sure("infra");
  // The words of HARNESS (EROFS, spawn failed, …) in a check's output belong to the check (hub: a red vitest printing EROFS counted as a fault).
  if (!CHECK_FAILED.test(text) && HARNESS.test(text)) return sure("harness");
  if (CONTRACT.test(text)) return sure("contract");
  if (PROVIDER_STATES.has(state) || /^(writer_provider_unavailable|writer_model_unavailable|writer_service_tier_unavailable)/.test(text)) return sure("provider");
  if (state === "empty_output") return sure(text.includes(NO_ANSWER_REASON) ? "provider" : "task");
  // A red check is the task's by rule; any other reason nothing matched is not known to be.
  return { cls:"task", confident:CHECK_FAILED.test(text) || TASK_REASON.test(text) || !text.trim() };
}

export function failureClass(state:string, reason:string | null | undefined):FailureClass {
  return classifyFailure(state, reason).cls;
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
// An error line that names a path or a system call (`EACCES: permission denied, rmSync '/x/.output'`, `npm error code EACCES`),
// or the shell refusing the command itself (`sh: 1: vitest: Permission denied`).
const ENVIRONMENT_LINE = new RegExp([
  /\b(?:EACCES|EPERM|EEXIST)\b[^\n]*(?:['"`]\/|['"`][A-Za-z]:\\|\bsyscall\b|\b(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|mkdir|mkdirSync|mkdtemp|open|openSync|opendir|scandir|copyfile|cp|rename|symlink|link|chmod|chown|access|lstat|utime)\b)/.source,
  /^[^\n]*: (?:\S+: )?permission denied\s*$/.source,
  /\bnpm (?:error|ERR!) (?:code )?(?:EACCES|EPERM)\b/.source,
].join("|"), "im");
// A test runner reporting failing tests (vitest/jest «1 failed», node --test «fail 1», TAP «not ok», assertions, compiler errors): the
// code is red whatever else the output says, and a test that logs an EACCES string is not an environment fault.
const TEST_REPORT_RED = /\b[1-9]\d* (?:failed|failing)\b|^\W*(?:#|ℹ)?\s*fail [1-9]|^\s*not ok \d+|^\s*(?:FAIL|✗|×|✖)\s|\bAssertionError\b|\berror TS\d+\b/im;
/** A failing check whose output shows the environment broke it: no writer can fix that in owns_paths. */
export const isEnvironmentCheckFailure = (check:{ stdout?:string; stderr?:string }):boolean => {
  const output = `${check.stderr ?? ""}\n${check.stdout ?? ""}`;
  return ENVIRONMENT_LINE.test(output) && !TEST_REPORT_RED.test(output);
};

/** Failures that do not spend one of the task's attempts. */
export const FREE_CLASSES:ReadonlySet<FailureClass> = new Set(["merge", "dirty_base", "harness", "infra", "budget", "limit"]);
/** What the PM does next about a task that did not end accepted, by its failure class; shown in wait receipts. */
export function nextStep(state:string, reason:string | null | undefined):string {
  if (["queued", "running", "spawn_requested", "validating"].includes(state)) return "wait: the writer is still on it";
  if (VERDICT_BLOCK.test(reason ?? "")) return "stopped by a block verdict (the reason names the stage, the finding and its file:line): do not send the same task again; settle what the finding says, by a different approach or by asking the owner, then dispatch a new task";
  if (NO_GIT.test(reason ?? "")) return "the folder has no git and does not fit the no-git mode (too many files or owned bytes): put it under git, or narrow owns_paths, then dispatch again";
  if (RETRY_BUDGET.test(reason ?? "")) return "the task spent its overall retry budget: read the failures, fix the plan or contract and dispatch it again as a new task";
  if (WAITING_SECRET.test(reason ?? "")) return "waiting for an Env Catalog secret: call env_request for each name in the reason (or ask the owner to add it to the setting Secrets checks may use); the task restarts by itself once it is saved, no attempt is spent";
  switch (failureClass(state, reason)) {
    case "judgment": return "answer_writer: answer its question with lane_pilot_answer_writer (taskId, answer); the writer continues in its thread";
    case "harness": case "infra": return "parked: restarts by itself once the fault clears; do nothing";
    case "limit": return "moves down the writer chain by itself; do nothing";
    case "merge": return "redone on the new main by itself; do nothing";
    case "dirty_base": return "the main checkout has uncommitted changes in files this task changes (see the reason): commit or discard them there; the task is parked and restarts by itself after a backoff (three tries), then redispatch it";
    case "contract": return "fix the contract: lane_pilot_update_task if it has not started, else dispatch it again with the changed contract";
    case "budget": return "the run hit its budget: raise run.max_* or finish the run";
    default: return "its writer session ended without green checks: read the reason, fix the plan or contract and dispatch it again";
  }
}

/** What a wait receipt adds for a writer's unanswered question in a folder without git: its files stay put, so the folder stays locked. */
export function liveFolderLockNote(state:string, reason:string | null | undefined, liveFolder:boolean):string {
  return liveFolder && state === "blocked" && failureClass(state, reason) === "judgment"
    ? "; this folder has no git, so it stays locked: other tasks for it queue until this question is answered (or the task is sent again)" : "";
}

/** Parked failures: the task waits for a fix or the machine, then restarts by itself. */
export const PARKED_CLASSES:ReadonlySet<FailureClass> = new Set(["harness", "infra", "dirty_base"]);
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
