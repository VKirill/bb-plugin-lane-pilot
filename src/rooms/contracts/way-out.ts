/**
 * The way out of a blocked or waiting state: the one action the PM should take next, matched by the reason's code
 * prefix (the same prefixes `failureClass` and `unknown-codes` know). Every line a PM reads — the pushed digest,
 * the wait receipts, the health/fact tools — names its way out, so a reason never reads as «stuck».
 * A reason nothing names returns null and the line stays as today; a reason that only ever means «give up»
 * is listed in NO_WAY_OUT below so the register is complete on purpose, not by accident.
 *
 * This table is the source for «what to do when the reason is X»: the lane-pilot skill runbook (references/ops*.md) quotes it row for row
 * (each row's first cell keeps the reason code in backticks) and `tests/way-out-agreement.test.ts` refuses a drift.
 * Each row carries its `key` — the reason prefix the runbook names the row by.
 *
 * Text is short English: one tool call to make, or «ask the owner: <what>», or «nothing: it resumes by itself
 * when <condition>». Internal codes stay machine-readable; the line around them is for a person.
 */

/** One row: the reason's stable key, the pattern it matches, then what the PM does. First match wins, most specific first. */
export const WAY_OUT: ReadonlyArray<readonly [key: string, pattern: RegExp, wayOut: string]> = [
  // A judgment or contract stop the PM or owner must answer — never self-heals.
  ["planner_rounds_exhausted", /^planner_(?:rounds_exhausted|stopped)/, "the planner revised the plan the critic returned and could not get it passed (its rounds are spent, or it needs a field only the PM owns): read the findings of every round (plannerLoop.rounds in the reply), then fix the plan/contract in place with lane_pilot_update_task (taskId, task, plan) — pm-read and the critique run again, no attempt is spent; do not cancel and redispatch"],
  ["plan_critique_blocked", /^(?:structural_)?plan_critique_blocked/, "the plan critique refused the contract: fix the plan/contract in place with lane_pilot_update_task (taskId, task, plan) — pm-read and the critique run again, no attempt is spent; do not cancel and redispatch"],
  ["plan_critique_failed", /^plan_critique_failed/, "the plan critique itself failed — the error after the colon is the critic's (a thread timeout, an invalid answer), not a refusal of the plan: send the task again, pm-read and the critique rerun; a repeat failure means the critic provider is down — wait it out"],
  ["question_unanswered", /question_unanswered/, "the writer's question stood unanswered and the attempt is closed — answering it now fails: dispatch a new task whose contract carries the answer (owns_paths and the checks settled)"],
  ["verdict_block", /^verdict_block/, "stopped by a block verdict (the reason names the stage, the finding and its file:line): do not send the same task again; settle what the finding says, by a different approach or by asking the owner, then dispatch a new task"],
  ["needs_human", /needs_human/i, "answer_writer: answer its question with lane_pilot_answer_writer (taskId, answer); a question about the checks/acceptance/paths is fixed in place instead with lane_pilot_update_task (taskId, task: the whole corrected contract); neither answers: ask the owner once with lane_pilot_ask_owner"],
  // The task's own attempts are spent or judged: read what failed, change it, dispatch again.
  ["retry limit", /^retry limit \d+ exhausted/, "the task's attempts are spent — what failed too often is after the colon: read the last attempt (`bb lane-pilot timeline <task-id>`), change what made it fail (the contract, the check, the size), then dispatch again; the same contract fails the same way"],
  ["repeated_failure", /^repeated_failure|^narrow_brief/, "two attempts failed the same way (the reason keeps what actually failed): change the contract or the approach, then dispatch again — the same contract fails the same way"],
  ["test_fit", /^test_fit:/, "the writer weakened or removed tests that existed on the base: if removing them is the task, name the files in the contract's `test_removals`, then send the task again; otherwise fix the change and resend it"],
  ["owner_word: no", /^owner_word: the owner said no/, "the owner said no to this task: it does not land — ask him what he wants instead; do not send it again"],
  ["owner_word", /^owner_word/, "verified but waits for the owner's word to land on main: ask him once with lane_pilot_ask_owner, record the answer with lane_pilot_queue {action:\"word\", taskId, decision, text}, then send the task again (the same writer thread merges)"],
  // Held states: nothing to do — the machine resumes itself.
  ["quarantine", /^quarantine/, "a regression finding quarantines a file this task touches: if the change was meant, settle it with lane_pilot_regression {action:\"settle\", id, reason}; a real break is fixed in a task that owns the shared files and names the row in fixes_regressions:[<id>]; the waiting task starts by itself within 30 s of the row closing"],
  ["owner_present", /owner_present/, "nothing: the owner is working in this writer provider; the task resumes by itself when they leave (the chain already moved to the next one)"],
  ["usage_window", /usage_window/, "nothing: this provider's usage window is nearly spent; the task resumes by itself when the window resets"],
  ["breaker_open", /breaker_open/, "nothing: this provider is paused after errors; the task resumes by itself when its breaker closes"],
  ["thread_not_started", /thread_not_started/, "nothing while the chain has another writer: this provider could not start its session, it is set aside for an hour and the next writer takes the task, no attempt spent. If the task ended on it, the whole chain was down: tell the owner in one line which provider fails to start"],
  ["core_unsupported", /core_unsupported|^writer_provider_unavailable/, "every writer in the chain is unusable by this core — it does not pass by itself: move a running task to a supported model with lane_pilot_reassign_task (taskId, model), or tell the owner in one line which provider to enable for the project"],
  ["waiting_writer:", /^waiting_writer:/, "nothing: every writer is held; the task resumes by itself when one frees up"],
  ["waiting: the run is paused", /^waiting: the run is paused/, "nothing: the run is paused; the task starts by itself once the run is resumed (`bb lane-pilot resume <run-id>` when the cause is gone)"],
  ["waiting: held until", /^waiting: held until/, "release it with lane_pilot_queue {action:\"release\", taskIds} (or wait for its held_until date)"],
  // Budgets: money already moved, so read the receipts before judging.
  ["budget_exceeded", /budget_exceeded|run budget exceeded/i, "the run hit a budget limit: check its step receipts with lane_pilot_workflow_status (a step that already acted is done — not nothing sent), then raise the run.max_* setting or finish the run"],
  // Git-side stops.
  ["merge_conflict", /merge_conflict/i, "nothing: main moved while it ran — it is redone on the new main for free"],
  ["owns_paths rejected", /owns_paths rejected|writer changed paths outside owns_paths|repo_edited/i, "the writer touched files outside owns_paths/never_touch, or the repo was edited while it ran: commit or discard those edits in the checkout, narrow owns_paths, then send the task again"],
  ["interrupted by a reload", /interrupted by a plugin reload|Lane Pilot was reloaded/i, "send the task again with lane_pilot_dispatch_writer (same contract): a reload cut the dispatch mid-flight, no attempt was spent"],
  // Provider faults that are worth one retry.
  ["provider_error", /provider_error|writer_stream_error|timeout/i, "nothing: a provider fault starts the next writer of the chain by itself; a running task stuck on a dead provider moves with lane_pilot_reassign_task (taskId, model); the same fault on every writer means the provider side is down — wait it out"],
  ["waiting_secret", /^waiting_secret/, "waiting for an Env Catalog secret: call env_request for each name in the reason; the task restarts by itself once it is saved"],
  ["verification timed out", /verification timed out after \d+s/, "the check timed out: its retry budget is separate from the task's attempts; raise timeout_sec or narrow the command, then send the task again"],
  ["verification failed", /^verification failed/, "the task's own checks are red: read the check output in the reason, fix the code or the check, then send the task again"],
  // Machine faults that read like task failures: not the contract's to fix, but nothing retries them either.
  ["cannot read writer-workspace", /cannot read writer-workspace/, "the writer's workspace could not be read — a machine fault, not the task's code. A missing shell (spawn … ENOENT) parks the task and it restarts by itself after a short wait; any other error: send the task again, and if it repeats tell the owner which machine fails"],
  ["writer stop observed", /writer stop observed/, "its writer thread stopped before the checks ran — the attempt ended without a result: send the task again if the work is still needed"],
];

/**
 * The way out of this reason, or null when nothing is named (the line stays as it reads today).
 * `state` is kept for callers that hold it (waiting vs blocked shapes differ in the digest).
 * `failureCode` is the attempt's structured failure code: it answers the two verification rows directly, so a caller
 * that has it need not rely on the reason's wording (a wrapped reason still names the check after its prefix).
 */
export function wayOut(state: string, reason: string | null | undefined, failureCode?: string | null): string | null {
  const text = (reason ?? "").trim();
  if (!text) return null;
  const byKey = new Map(WAY_OUT.map(([key, , out]) => [key, out]));
  if (failureCode === "verification_timeout") return byKey.get("verification timed out") ?? null;
  if (failureCode === "verification_failed") return byKey.get("verification failed") ?? null;
  for (const [, pattern, out] of WAY_OUT) if (pattern.test(text)) return out;
  return null;
}

/**
 * Reasons that occur in the record but have no way out by design — the task is over, or the reason
 * itself is the whole story. Comment says why each is out, so a gap in the table reads as a choice.
 */
export const NO_WAY_OUT: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  { pattern: /^canceled|cancel/i, why: "the PM canceled it itself — the state is the answer" },
  { pattern: /^accepted/i, why: "accepted is a result, not a stop" },
  { pattern: /^reassigned:/, why: "the PM already moved it to a fresh writer thread" },
];
