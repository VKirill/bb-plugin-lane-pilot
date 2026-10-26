import { EXISTENCE_ONLY_WORDS } from "../baseline";
import { INVARIANT_WORDS } from "./plan-fact";

/**
 * The words the gates decide by, one line each, for the agents the gates judge. A gate that reads «as now» as «the code stays untouched», or
 * a `test -f` as no red check, rejects honest work whose author was never told the word (Matvey Maslov's class 2: the rule lived in a file the
 * model never opened). The words come from the constants the gates themselves read, so a gate cannot change without its brief changing.
 */

/** Lint and baseline codes a planner or writer meets, with the one line of what each means and what to do. A test holds each against its source. */
export const GATE_CODES: Readonly<Record<string, string>> = {
  check_not_runnable: "a verification program is not on the writer machine's PATH: use a command that exists there",
  check_cannot_run: "the check cannot run on the base at all (exit 127, a missing tool, folder or package.json, a rejected flag): fix the command or cwd, or drop it",
  red_outside_task: "a check is red on the base in files outside owns_paths: narrow it to the task's files or widen owns_paths",
  output_unowned: "an expected output lies outside owns_paths: add it to owns_paths or drop it",
  test_unowned: "the tests of an owned file lie outside owns_paths: add them to owns_paths or to never_touch",
  verification_cwd: "a check's cwd is outside the project",
  verification_empty_check: "a check passes whatever the writer does: replace it with one that fails when the work is missing",
  verification_existence_on_base: "an existence check is already true on the base",
  no_red_before_green: "no check fails before the work: add one that is red now",
  no_red_on_base: "every check already passes on the base, so none can show the work: add a check that is red now",
  verification_masked_exit: "a pipe hides the exit code: start with set -o pipefail",
  verification_pass_with_no_tests: "a flag lets the check pass with no test run: name the test file exactly",
  whole_suite_with_gate: "a check runs the whole suite, which the integration gate runs once per batch: check only this task's files",
  criteria_subjective: "a criterion rests on subjective words no command can decide: name the exact string, value or exit code",
  question_unanswered: "a writer's question stood unanswered: settle owns_paths and the checks in the contract before the start",
};

const quoted = (words: readonly string[]) => words.map((word) => `"${word}"`).join(", ");

/**
 * The block, as lines. The planner, who writes the contract, gets all of it; the writer, who only does the work, gets the two rules that judge
 * its answer and its checks (the codes are the contract's, and a writer never writes one).
 */
export function gateVocabularyLines(audience: "planner" | "writer" = "planner"): string[] {
  return [
    "Gate vocabulary: the gates that judge this work decide by these exact words.",
    `- An acceptance item with ${quoted(INVARIANT_WORDS)} is read as "this stays untouched": its proof is code left as it was, never a new test or a changed file. For new behaviour, say what it does, without these words.`,
    `- ${EXISTENCE_ONLY_WORDS.map((word) => `\`${word}\``).join(", ")} only prove that a file or word exists. For a fix they are not the check that is red before the work: a fix needs a command that runs the behaviour, fails now and passes after it.`,
    ...(audience === "writer" ? [] : [`- Codes a contract is sent back with: ${Object.entries(GATE_CODES).map(([code, meaning]) => `${code} (${meaning})`).join("; ")}.`]),
  ];
}
