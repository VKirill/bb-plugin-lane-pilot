/**
 * The way out of a blocked or waiting state: the one action the PM should take next, matched by the reason's code
 * prefix (the same prefixes `failureClass` and `unknown-codes` know). Every line a PM reads — the pushed digest,
 * the wait receipts, the health/fact tools — names its way out, so a reason never reads as «stuck».
 * A reason nothing names returns null and the line stays as today; a reason that only ever means «give up»
 * is listed in NO_WAY_OUT below so the register is complete on purpose, not by accident.
 *
 * Text is short English: one tool call to make, or «ask the owner: <what>», or «nothing: it resumes by itself
 * when <condition>». Internal codes stay machine-readable; the line around them is for a person.
 */

/** One row: the prefix, then what the PM does. First match wins, most specific first. */
const WAY_OUT: ReadonlyArray<readonly [pattern: RegExp, wayOut: string]> = [
  // A judgment or contract stop the PM or owner must answer — never self-heals.
  [/^plan_critique_blocked/, "the plan critique refused the contract: fix the plan/contract, then send the task again as a new dispatch (lane_pilot_update_task if it has not started)"],
  [/^verdict_block|^question_unanswered/, "stopped by a block verdict (the reason names the stage, the finding and its file:line): do not send the same task again; settle what the finding says, by a different approach or by asking the owner, then dispatch a new task"],
  [/needs_human/i, "answer_writer: answer its question with lane_pilot_answer_writer (taskId, answer); a question about the checks/acceptance/paths is fixed in place instead with lane_pilot_update_task (taskId, task: the whole corrected contract); neither answers: ask the owner once with lane_pilot_ask_owner"],
  // Held states: nothing to do — the machine resumes itself.
  [/^quarantine/, "a regression finding quarantines a file this task touches: settle it with lane_pilot_regression {action:\"settle\", id, reason} (or fix the red check), then send the task again"],
  [/^waiting_writer:owner_present/, "nothing: the owner is working in this writer provider; the task resumes by itself when they leave"],
  [/^waiting_writer:usage_window/, "nothing: this provider's usage window is nearly spent; the task resumes by itself when the window resets"],
  [/^waiting_writer:breaker_open/, "nothing: this provider is paused after errors; the task resumes by itself when its breaker closes"],
  [/^waiting_writer:core_unsupported|^writer_provider_unavailable/, "every writer in the chain is unusable by this core: enable a supported provider for the run or reassign the task with lane_pilot_reassign_task"],
  [/^waiting_writer:/, "nothing: every writer is held; the task resumes by itself when one frees up"],
  [/^waiting: the run is paused/, "nothing: the run is paused; the task starts by itself once the run is resumed"],
  [/^waiting: held until/, "release it with lane_pilot_queue {action:\"release\", taskIds} (or wait for its held_until date)"],
  // Budgets: money already moved, so read the receipts before judging.
  [/^run_budget_exceeded|^budget_exceeded|^run budget exceeded/i, "the run hit a budget limit: check its step receipts with lane_pilot_workflow_status (a step that already acted is done — not nothing sent), then raise the run.max_* setting or finish the run"],
  // Git-side stops.
  [/^merge_conflict|merge_conflict/i, "nothing: main moved while it ran — it is redone on the new main for free"],
  [/owns_paths rejected|writer changed paths outside owns_paths|repo_edited/i, "the writer touched files outside owns_paths/never_touch, or the repo was edited while it ran: commit or discard those edits in the checkout, narrow owns_paths, then send the task again"],
  [/interrupted by a plugin reload|Lane Pilot was reloaded/i, "send the task again: a reload cut the dispatch mid-flight, no attempt was spent"],
  // Provider faults that are worth one retry.
  [/provider_error|writer_stream_error|timeout/i, "the writer's provider faulted or timed out: retry once with lane_pilot_update_task (or move it to the next writer with lane_pilot_reassign_task); a repeat fault means the provider itself is down — wait it out"],
  [/^waiting_secret/, "waiting for an Env Catalog secret: call env_request for each name in the reason; the task restarts by itself once it is saved"],
  [/verification timed out after \d+s/, "the check timed out: its retry budget is separate from the task's attempts; raise timeout_sec or narrow the command, then send the task again"],
  [/^verification failed/, "the task's own checks are red: read the check output in the reason, fix the code or the check, then send the task again"],
];

/**
 * The way out of this reason, or null when nothing is named (the line stays as it reads today).
 * `state` is kept for callers that hold it (waiting vs blocked shapes differ in the digest).
 */
export function wayOut(state: string, reason: string | null | undefined): string | null {
  const text = (reason ?? "").trim();
  if (!text) return null;
  for (const [pattern, out] of WAY_OUT) if (pattern.test(text)) return out;
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
