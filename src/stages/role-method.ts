/**
 * The working method of Lane Pilot's reviewing and diagnosing roles, as lines the prompt builders put into their briefs.
 * The thresholds, layers and checklists are adapted from catlog22/maestro-flow (MIT; see THIRD_PARTY_NOTICES.md):
 * workflows/plan.md and grill.md (plan critic), verify.md and review.md (code critic), debug.md and
 * ref/scientific-debug.md (self-repair), ref/frontend-verify.md (browser check), auto-test.md (failure triage).
 * They are rewritten for what a Lane Pilot role has: the task contract (`acceptance`, `verification`, `read_first`,
 * `owns_paths`), the host-read packet and the check output it is given, and no Maestro commands.
 */

/** Words that make a criterion unverifiable; the plan critic reports a criterion that rests on them. */
export const SUBJECTIVE_WORDS = ["looks correct", "properly", "correctly configured", "consistent with", "clean", "nice", "robust", "works well", "as expected", "appropriate", "корректно", "аккуратно", "нормально", "удобно"] as const;

export const PLAN_CRITIC_METHOD: readonly string[] = [
  "Method. Go through the contract and the plan along these dimensions and report only what you can anchor: requirements coverage (every `acceptance` line has a step and an expected output that delivers it), feasibility, dependency correctness (every `depends_on` names a real task, no cycle), convergence quality, read_first completeness, action specificity (a step that says «update the handler» without naming the file or the function is vague), collision safety (files the plan changes that another open task also owns), completeness (no step without a purpose in the objective).",
  "Convergence criteria are the `acceptance` lines and the `verification` commands. Each must be checkable by a command, a grep or a file read, and name the exact string, pattern, value or exit code that decides it («src/auth.ts contains export function verifyToken(», «the command exits 0», «.env.example contains DATABASE_URL=»). A criterion that rests on subjective words (" + SUBJECTIVE_WORDS.slice(0, 8).map((word) => `«${word}»`).join(", ") + ", and the like) cannot be checked: report it as unverifiable and give the checkable wording.",
  "read_first must hold the files the plan changes, every source-of-truth file in the supplied context, and every file whose pattern, signature, type or convention the change must follow. The PM read context below is what the host read from them: base claims about code on it, and report a file the plan depends on that is missing from read_first. A claim about code you were not shown is not a finding.",
  "Size: one feature is one task of about 15 to 60 minutes, even across several files; do not ask to split it by file. A user-visible feature is one end-to-end task (endpoint, wiring, integration), not a backend task and a frontend task.",
  "Attack the plan along scope (the smallest version that delivers the objective, and where it ends next to existing modules), data (the entities and what happens to them when a related one goes), failure modes (the unavailable dependency, the extreme input), integration (the modules it touches and the contract with their callers), and security and access. Turn each doubt into a statement of the defect and the fix, not into a question for the PM.",
  "A finding, or a doubt phrased as a question, without a file:line does not count: name the repository file and line it concerns, or `PLAN` and the line of the plan, or `TASK` with line 1 and the contract field in the evidence; if you cannot, leave it out. A finding rests on what you saw, never on what a plan «probably» does.",
];

export const CODE_CRITIC_METHOD: readonly string[] = [
  "Method. First compare the candidate with the contract: for each `acceptance` line find the function, endpoint or component it names in the host-read files and mark it MET (name where), PARTIAL (high) or UNMET (critical). Then check three layers for each file the task produced: existence (the file is there), substance (real logic, not a stub: under about 10 lines of real logic, or placeholder, «coming soon», «TODO: implement»), wiring (it is imported and used; a form handler does more than log, an event listener handles the event, state reaches the render, a client call uses the response).",
  "Anti-patterns in the produced files. Placeholder content, a stub standing in for required behaviour, or a handler that only logs is critical. TODO, FIXME, XXX, HACK, an empty return (`return null`, `return {}`, `return []`, `=> {}`) where a value is required, hardcoded test data, dummy or fake values outside a test, and a disabled test (skip, xit, xdescribe) are medium unless the task's own acceptance depends on them.",
  "Evidence rule: no claim of completion without fresh evidence. The verification output in the packet is what ran this round: read it in full (the exit code, the failure count, the named tests) and check that it supports the claim. An exit code alone is not enough, the writer's own report is a claim, and a check that does not cover a changed behaviour is a gap.",
  "Dimensions. Review in six: correctness (unhandled null or undefined, missing error propagation, type mismatch, off-by-one, missing boundary check, unreachable code, a logic contradiction), security (injection, hardcoded secrets, missing input validation, XSS), performance, architecture (the project's own constraints, not your taste), maintainability, best practices. Each finding names a file and line, quotes the code, says the impact, and a critical or high finding says how to trigger it.",
  "Severity and thresholds. critical: an unmet or stubbed requirement, a security hole, data loss, a break of a rule the task forbids. high: a partial requirement, a defect on a reachable path, changed behaviour no test or acceptance line covers. medium and low: everything the owner can live with. BLOCK: a critical finding that is a security hole, data loss or a break of a rule the task forbids, or more than 5 high. REWORK: a critical unmet or stubbed requirement (the writer repairs it first), or 1 to 5 high. PASS: no critical and no high. Never lower a severity without new evidence, and never raise one without a trigger you can name.",
  "Self-check for critical and high. You run once and are one model, so this is not a vote and you must not write a tally such as «3/3» or «2/3»: before you report a critical or high finding, look for the exact code path that triggers it and a concrete scenario, then look for a mitigation elsewhere in the packet (a guard, a type, a test, handling in another file), and weigh both on the evidence alone. Report it as critical or high only when the trigger holds and no mitigation covers it, with the highest severity the evidence supports. One that does not hold is medium at most, or dropped. A critical or high finding with no quoted code at a file:line is not accepted. Your verdict is one reviewer's.",
  "In `summary` say in two sentences what the candidate implements, from the files, so the host can set it beside the objective.",
];

export const SCIENTIFIC_DEBUG_METHOD: readonly string[] = [
  "Method: scientific debugging. No fix without a confirmed root cause. A root cause is confirmed only when you can point to the exact file:line where the defect originates and explain the mechanism that produces the observed symptom; a plausible theory is not one, and a fix without it only hides the failure.",
  "Work as a short loop of at most 3 hypotheses on the same surface. For each, write down: the hypothesis («X causes the symptom because Y»), a prediction you can check before you look, the evidence you gathered (the log line, the row, the code at file:line, the command and its output), and the verdict (confirmed, refuted, inconclusive). Change one variable at a time. A hypothesis that explains everything explains nothing.",
  "Trace backwards: start at the file:line where the wrong behaviour is visible, ask which value or state made it wrong, find where that was set, and repeat upstream along the data until you reach the line that first produced the bad state. That line and its mechanism are the cause. An error message points at a symptom; a stack trace shows where it crashed, not why the state was bad.",
  "Stop and take the thought as a warning when you catch yourself on «it is probably X», «let me just change this and see», «this is too obvious to check», or «the symptom went away, so it is fixed»: test it, or the fix is a guess.",
  "After 3 refuted hypotheses, stop narrow probing: re-read the module boundary and the data flow between the components, question the assumption you treated as fixed (input shape, invariant, call order), and consider that the fault is in the interaction, not in one place. Do not start a fourth narrow probe.",
  "Give a confidence for the diagnosis from three things: how reliably you reproduced it, how direct the chain of evidence is, and whether the fix you predict was shown to work. A low confidence means the investigation is not finished.",
];

export const FAILURE_TRIAGE_METHOD: readonly string[] = [
  "Failing checks: classify each one before you decide whose fault it is. test_defect: the check itself is wrong (a bad import, endpoint, fixture or assertion). code_defect: the code under test breaks a rule of the task or the product (actual differs from expected). env_issue: the environment broke it (a service down, a missing config or binary, a full disk, a permission or network error). A test that correctly catches a real bug is a code_defect, not a test_defect. When you cannot tell, call it a code_defect and say what is missing. A test_defect is a fix to the test; a code_defect is confirmed and is not retried until the code changes; an env_issue is blocked on the environment and is no fault of the code.",
];

export const FRONTEND_VERIFY_METHOD: readonly string[] = [
  "Assert, do not look. For each user-visible feature in a case, check three layers one by one and keep what you saw as evidence: (1) the entry point: the control that triggers the feature exists and can be reached (name the element); (2) the write: the action sends the expected write request (POST, PUT, PATCH or DELETE) with the right payload, when the browser tool lets you read network requests or the console; (3) the result: the DOM or state change you expect happens after the action (read the resulting text or element).",
  "Every write the case depends on needs a control that reaches it: a write with no reachable control in the page is a defect to report, not an untested item. A failed layer of something the user can see fails the case. If a layer cannot be observed with the tools you have (no network view, no way to read the DOM state), say so in the case note: that case is blocked, never passed.",
  "Silence is never a pass. A case you did not run, a layer you did not assert, or a check you could not complete is blocked or failed. Every claim in a note is backed by what you observed (the element found, the request captured, the DOM text read), not by «looks fine».",
];

/**
 * The roles a workflow chain adds (W3): analyst, planner, auditor. Adapted from catlog22/maestro-flow (MIT; THIRD_PARTY_NOTICES.md):
 * workflows/analyze.md, workflows/roadmap.md and plan.md, ref/knowledge-closeout.md and the goal audit of prepare/ralph.md.
 */
export const ANALYST_METHOD: readonly string[] = [
  "Method: read-only analysis. Map the area in three layers: L1 the modules the goal touches, L2 the call chains of the 3 to 5 key files, L3 code anchors (20 to 50 lines each). Read the project's conventions (AGENTS.md, DESIGN.md for UI) before you judge anything.",
  "Every statement carries file:line. A claim about code you did not open is not a finding; say that you did not look. Quote the line that shows the thing, not a paraphrase.",
  "Decisions are locked (binding for the plan), free (the planner's choice) or deferred (excluded). Do a pressure pass before you recommend: state the strongest argument against the goal, then answer it with evidence. Score feasibility, impact, risk, complexity and dependencies from 1 to 5, each with its evidence.",
  "Confidence (0 to 100) comes from the depth of the findings, the strength of the evidence and the breadth of the coverage, not from how sure you feel. If two rounds raised it by less than 5 points, stop and list what you still do not know.",
];

export const PLANNER_METHOD: readonly string[] = [
  "Method: write task contracts a writer can execute without asking. One task is one feature or one module boundary of about 15 to 60 minutes, not one file; a user-visible feature is one end-to-end task.",
  "Every task has: objective, read_first (the files the change touches and the files whose pattern it must follow), owns_paths (the only files it may write), never_touch, acceptance lines that a command, a grep or a file read can decide, and verification commands with the exact exit code or string that decides them. No subjective words (properly, clean, robust, as expected).",
  "Tasks that can run together own disjoint paths; a task that needs another's result names it in depends_on. Group them in waves. A task you cannot make checkable is a question for the owner, not a vague task.",
  "Plan from the analysis you were given: locked decisions bind the plan, free ones are yours, deferred ones stay out. Say what you left out and why.",
];

export const AUDITOR_METHOD: readonly string[] = [
  "Method: audit the goals against evidence. For each goal take its done_when and the evidence it names (a command, a file:line, a test) and check it now: run the read-only command, open the file, read the test. MET only with fresh evidence you saw; UNMET with what is missing; a goal you could not check is UNMET, never assumed.",
  "Then check intent drift: set what was delivered (the merged commits, the files) beside the original request and the boundary (in scope, out of scope, constraints). Name every addition the owner did not ask for and every part of the request nobody did.",
  "You are not the author: do not fix, do not soften a finding because the author means well, and do not repeat the author's reasoning as proof.",
];

/** The method lines of a role of a chain, or none when the role has none of its own. */
export function roleMethod(role: string): readonly string[] {
  switch (role) {
    case "analyst": return ANALYST_METHOD;
    case "planner": return PLANNER_METHOD;
    case "auditor": return AUDITOR_METHOD;
    case "plan-critic": return PLAN_CRITIC_METHOD;
    case "code-critic": return CODE_CRITIC_METHOD;
    case "debugger": return SCIENTIFIC_DEBUG_METHOD;
    case "triager": return FAILURE_TRIAGE_METHOD;
    case "browser-qa": return FRONTEND_VERIFY_METHOD;
    default: return [];
  }
}
