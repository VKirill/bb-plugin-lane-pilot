import { expect, it } from "vitest";
import { wayOut, NO_WAY_OUT } from "../src/rooms/runs/way-out";
import { PM_CORE_TOOLS, PM_FAMILY_TOOLS, PM_TOOL_FAMILIES } from "../src/rooms/tools/pm-tool-families";

/**
 * The digest says a blocked line must name its way out. Every reason the pipeline actually writes into an
 * attempt's `reason` or a `writer-agent` pending stage is listed here; each either has a way out or is named
 * in NO_WAY_OUT on purpose. Add the reason the next time a new stop lands, or the register lies.
 */
const OCCURRING_REASONS: Array<{ reason: string; note: string }> = [
  { reason: "plan_critique_blocked", note: "the plan critique refused the contract before a writer ran" },
  { reason: "verdict_block:code-critique: The handler is a stub | src/a.ts:12 [critical]", note: "a critic's block verdict" },
  { reason: "verdict_block: question_unanswered: the writer asked again after the default answer", note: "a question nobody answered" },
  { reason: "needs_human: which port should the listener use?", note: "a writer question" },
  { reason: "quarantine: open regression P1 `npm test` blamed on P1 shares files", note: "a regression finding holds the file" },
  { reason: "waiting_writer:owner_present:claude-code", note: "the owner works in this provider" },
  { reason: "waiting_writer:usage_window:claude-code/sonnet", note: "usage window nearly spent" },
  { reason: "waiting_writer:breaker_open:codex", note: "provider breaker open" },
  { reason: "waiting_writer:core_unsupported:zcode", note: "provider not supported by this core" },
  { reason: "writer_provider_unavailable:core_unsupported", note: "a chain of nothing but unsupported providers ends blocked" },
  { reason: "waiting: the run is paused; starts by itself once it is resumed", note: "paused run" },
  { reason: "waiting: held until released", note: "lane_pilot_queue hold" },
  { reason: "run_budget_exceeded:tokens", note: "run.max_tokens hit" },
  { reason: "budget_exceeded:cost", note: "a workflow run's own budget line" },
  { reason: "merge_conflict: src/a.ts", note: "main moved while the writer ran" },
  { reason: "owns_paths rejected game/AGENTS.md, game/scripts/studio_test.py", note: "stray files outside owns_paths" },
  { reason: "repo_edited: src/b.ts may not touch: docs/x.md", note: "helper edited repository files it may not" },
  { reason: "the dispatch was interrupted by a plugin reload; send the task again", note: "reload cut the dispatch" },
  { reason: "provider_error: HTTP 502 from the model gateway", note: "provider fault" },
  { reason: "verification failed (npm test): verification timed out after 120s", note: "check timed out" },
  { reason: "waiting_secret:STRIPE_KEY", note: "an Env Catalog secret the task needs" },
  // The hub's 14-day frequency table (audit 2026-11-02, appendix): reasons WAY_OUT must know.
  { reason: "retry limit 2 exhausted: writer thread status error", note: "the task's attempts are spent" },
  { reason: "repeated_failure: verification failed (npm test): 1 failed", note: "two attempts failed the same way" },
  { reason: "test_fit: src/a.test.ts: assertion deleted (if removing these tests is the task, name the files in the contract's test_removals)", note: "the writer weakened a base test" },
  { reason: "plan_critique_failed:critique_thread_timeout", note: "the critic thread timed out" },
  { reason: "plan_critique_failed:invalid_value", note: "the critic answered something unparseable" },
  { reason: "owner_word: the owner said no to this task — not now", note: "the owner refused the merge" },
  { reason: "owner_word: owner.words is on — the task is verified and waits for the owner's word", note: "a risky task waits for his yes" },
  { reason: "cannot read writer-workspace git diff: spawn /bin/bash ENOENT", note: "a machine fault reading the worktree" },
  { reason: "writer stop observed before validation", note: "the writer thread stopped before the checks ran" },
  { reason: "waiting_writer:writer_provider_unavailable:owner_present:claude-code", note: "the real prefix chain the hold writes" },
  { reason: "waiting_writer:writer_provider_unavailable:usage_window:codex/gpt-5", note: "usage window in the parked form" },
  // Reasons that are ends, not stops: named in NO_WAY_OUT.
  { reason: "canceled", note: "the PM canceled it" },
  { reason: "accepted", note: "a result" },
  { reason: "reassigned: moved to fresh writer thread thr_abc", note: "the PM moved it" },
];

it("every occurring reason has a way out or is named in NO_WAY_OUT", () => {
  const missing: string[] = [];
  for (const { reason } of OCCURRING_REASONS) {
    const out = wayOut("blocked", reason);
    const namedNoWay = NO_WAY_OUT.some((row) => row.pattern.test(reason));
    if (!out && !namedNoWay) missing.push(reason);
  }
  expect(missing, `these reasons have no way out and are not in NO_WAY_OUT: ${missing.join(" | ")}`).toEqual([]);
});

it("names the specific ways out the digest must carry", () => {
  expect(wayOut("blocked", "plan_critique_blocked")).toMatch(/plan critique refused the contract/);
  expect(wayOut("blocked", "verdict_block:x: finding | src/a.ts:1")).toMatch(/do not send the same task again/);
  expect(wayOut("blocked", "needs_human: which port?")).toMatch(/lane_pilot_answer_writer/);
  expect(wayOut("pending", "quarantine: open regression P1 `npm test` blamed on P1 shares files")).toMatch(/lane_pilot_regression/);
  expect(wayOut("pending", "waiting_writer:owner_present:codex")).toMatch(/resumes by itself/);
  expect(wayOut("blocked", "run_budget_exceeded:tokens")).toMatch(/lane_pilot_workflow_status/);
  expect(wayOut("blocked", "budget_exceeded:cost")).toMatch(/step receipts/);
  expect(wayOut("blocked", "owns_paths rejected a.ts")).toMatch(/owns_paths/);
  expect(wayOut("blocked", "provider_error: HTTP 502")).toMatch(/starts the next writer/);
  expect(wayOut("blocked", "needs_human: q")).toMatch(/lane_pilot_ask_owner/);
  expect(wayOut("blocked", "unknown_reason_string")).toBeNull();
});

/** Tools already in the PM's set, plus names another stream adds (listed as pending until they merge). */
const PENDING_TOOL_NAMES = new Set([
  "lane_pilot_regression", // stream R1 adds this tool; listed here until it merges
]);

it("every lane_pilot tool named in a way-out string exists in the PM's tool set", () => {
  const known = new Set<string>([...PM_CORE_TOOLS, ...PM_FAMILY_TOOLS]);
  for (const family of Object.values(PM_TOOL_FAMILIES)) for (const folded of Object.values(family.actions)) known.add(folded);
  const mentioned = new Set<string>();
  for (const { reason } of OCCURRING_REASONS) {
    const out = wayOut("blocked", reason);
    if (!out) continue;
    for (const match of out.matchAll(/lane_pilot_\w+/g)) mentioned.add(match[0]);
  }
  const unknown = [...mentioned].filter((tool) => !known.has(tool) && !PENDING_TOOL_NAMES.has(tool));
  expect(unknown, `way-out strings name tools the PM does not have: ${unknown.join(", ")}`).toEqual([]);
});
