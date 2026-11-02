/**
 * The staged A/B decision over replay verdicts (pure; tests/pm-replay.test.ts). Arms: `base` is the PM surface as it
 * runs today, `candidate` is the same plus the rule(s) on trial.
 *
 * Stage 1 — the scenarios tied to the rule's incident must pass on the candidate arm (a scenario the base already
 * passes proves nothing by itself but does not block either).
 * Stage 2 — the whole active set on the candidate arm: no scenario may be a new FAIL versus the base arm's latest
 * verdict. Judge noise is allowed for: a regression FAIL counts only when it reproduces on a second sample.
 *
 * `adopt` confirms the rule at once; `retry` asks for one more sample of the named scenarios; `reject` keeps the rule
 * on its normal trial (or retires it when its own incident still fails) — never asks the owner.
 */
export type ArmVerdict = { verdict: string; sample: number };

export type ReplayDecision =
  | { action: "adopt"; reason: string }
  | { action: "reject"; reason: string; retireIncident: boolean }
  | { action: "retry"; scenarioIds: string[]; reason: string }
  | { action: "wait"; reason: string };

const PASS = new Set(["PASS"]);
const failed = (v: ArmVerdict | undefined): boolean => !!v && v.verdict === "FAIL";
const passed = (v: ArmVerdict | undefined): boolean => !!v && PASS.has(v?.verdict ?? "");

export function decideReplay(input: {
  /** Scenarios tied to the rule's incident. */
  incidentIds: readonly string[];
  /** Latest base verdict per scenario id. */
  base: ReadonlyMap<string, ArmVerdict>;
  /** Candidate verdicts per scenario id (a scenario may have two samples under ids `id` and `id#2`). */
  candidate: ReadonlyMap<string, ArmVerdict>;
  /** Every active scenario id (the full set stage 2 must cover). */
  activeIds: readonly string[];
}): ReplayDecision {
  const secondSample = (id: string): ArmVerdict | undefined => input.candidate.get(`${id}#2`);
  const candFail = (id: string): boolean => {
    const first = input.candidate.get(id);
    if (!failed(first)) return false;
    const second = secondSample(id);
    return second === undefined ? true : failed(second); // no second sample yet counts as reproducing only via retry
  };

  const incidents = input.incidentIds;
  const missing = incidents.filter((id) => !input.candidate.has(id));
  if (missing.length) return { action: "wait", reason: `incident scenarios not replayed yet: ${missing.join(", ")}` };

  const incidentFails = incidents.filter(candFail);
  const incidentRetry = incidents.filter((id) => failed(input.candidate.get(id)) && !secondSample(id));
  if (incidentRetry.length) return { action: "retry", scenarioIds: incidentRetry, reason: "an incident FAIL needs a second sample before it counts" };
  if (incidentFails.length) {
    return { action: "reject", retireIncident: true, reason: `the rule's own incident scenario still fails twice: ${incidentFails.join(", ")}` };
  }
  // Fixed = at least one incident scenario the base failed now passes (or was already green on both).
  const fixes = incidents.filter((id) => passed(input.candidate.get(id)) && failed(input.base.get(id)));
  const allPass = incidents.every((id) => passed(input.candidate.get(id)));
  if (!allPass) return { action: "wait", reason: "incident scenarios have no clear PASS on the candidate arm" };
  if (!fixes.length && !incidents.every((id) => passed(input.candidate.get(id)) || passed(input.base.get(id)))) {
    return { action: "wait", reason: "no incident verdict on either arm is decisive" };
  }

  // Stage 2: the rest of the active set.
  const rest = input.activeIds.filter((id) => !incidents.includes(id));
  const unrest = rest.filter((id) => !input.candidate.has(id));
  if (unrest.length) return { action: "wait", reason: `${unrest.length} active scenario(s) not replayed on the candidate arm` };
  const regressRetry = rest.filter((id) => failed(input.candidate.get(id)) && !failed(input.base.get(id)) && !secondSample(id));
  if (regressRetry.length) return { action: "retry", scenarioIds: regressRetry, reason: "possible regressions need a second sample" };
  const regressions = rest.filter((id) => candFail(id) && !failed(input.base.get(id)));
  if (regressions.length) {
    return { action: "reject", retireIncident: false, reason: `new FAIL on the active set vs the base arm: ${regressions.join(", ")}` };
  }
  return { action: "adopt", reason: fixes.length ? `fixes ${fixes.join(", ")} with no new FAIL on the active set` : "incident scenarios pass and the active set shows no new FAIL" };
}

/** A replay run's own receipt line for the morning/status report. */
export function replayLine(s: { harvested: number; ran: number; adopted: number; rejected: number; costUsd: number }): string {
  return `pm-replay: harvested ${s.harvested}, ran ${s.ran}, adopted ${s.adopted}, rejected ${s.rejected}, $${s.costUsd.toFixed(2)}`;
}
