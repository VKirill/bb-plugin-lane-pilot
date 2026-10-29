/**
 * One reading of a check run, for every place that decides on one: the writer's own check, the replay before a merge, the check on
 * main after it and the integration gate. Before, each read «exit 0 / not 0 / the machine broke it» for itself and they disagreed
 * about the same failure (Astra's recheck of 0.1.336: a real red followed by a re-run that died of Studio merged in the replay and
 * dispatched a repair task after the merge).
 *
 *  - pass: it exited 0 and showed it ran a test (or is no test runner's output at all).
 *  - product_fail: it exited non-zero and the output does not blame the machine — the code is red.
 *  - environment_error: the machine broke it (the output names it), the host call failed, or the call threw — it says nothing about the code.
 *  - not_run: it exited 0 but ran no test, or its re-run printed no summary the first run printed.
 */

import { isEnvironmentCheckFailure } from "../../runs";
import { hollowRerun, noTestRanReason } from "./tests-ran";

export type CheckVerdict = "pass" | "product_fail" | "environment_error" | "not_run";
export type CheckRun = { exitCode: number; stdout?: string; stderr?: string; hostError?: boolean; threw?: boolean };
export type CheckReading = { verdict: CheckVerdict; reason: string | null };

/** What `failIfNoTestRan` writes into stderr when it turns a green that ran no test into a red. */
const NO_TEST_RED = /^check failed: the check exited 0 but\b/m;
/** spawnAsync's own error line. A test that prints the word "timeout" is not this (2026-10-29 audit A-036). */
const TRANSPORT_STOP = /^spawn \S+ (?:ETIMEDOUT|ENOBUFS)$/m;

export function readCheckRun(run: CheckRun, options: { command?: string; first?: { stdout?: string; stderr?: string } } = {}): CheckReading {
  const printed = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  if (run.threw || run.hostError || TRANSPORT_STOP.test(printed)) return { verdict: "environment_error", reason: "the check could not run on the host" };
  if (run.exitCode !== 0) {
    if (NO_TEST_RED.test(printed)) return { verdict: "not_run", reason: "the check exited 0 but ran no test" };
    return isEnvironmentCheckFailure(run) ? { verdict: "environment_error", reason: "the machine broke the check" } : { verdict: "product_fail", reason: null };
  }
  const hollow = options.first ? hollowRerun(options.first, run) : null;
  if (hollow) return { verdict: "not_run", reason: `the re-run exited 0 but ${hollow}` };
  const none = noTestRanReason(printed, options.command);
  return none ? { verdict: "not_run", reason: none } : { verdict: "pass", reason: null };
}
