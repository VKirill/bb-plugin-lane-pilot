import { sha256Hex } from "@lane-pilot/kit";
import type { FrozenVerdict, PendingVerdict, PlanItem, WaveRecord } from "./record";
import { canonical } from "./signatures";
import { needsChecks, needsPlanFact, runGoalPending, type TaskFact } from "./waves";

/**
 * The frozen blind verdict of the phase: decided by code from what the checks left (plan-fact of every piece, the run's goal check),
 * never from what the writer says. Its input hash freezes it: the same facts give the same verdict, new facts a new verdict.
 * `pending`: only the run's goal check is still running; the driver records nothing and asks again.
 */
/** What keeps one piece from being proved: not accepted, its promise unproved against the diff, its checks red, never run or with no receipt, the code critic blocking. Empty when it is proved. The one predicate of the blind verdict and of a scope cut. */
function pieceProof(item: PlanItem, fact: TaskFact | undefined): string[] {
  const problems: string[] = [];
  if (fact?.state !== "accepted") problems.push(`${item.id} not accepted`);
  if (fact?.planFact === "failed") problems.push(`${item.id}: plan-fact failed — the promise is not proved`);
  else if (fact?.planFact === "skipped" && needsPlanFact(item)) problems.push(`${item.id}: plan-fact was skipped — its acceptance items were not checked against the diff`);
  else if (fact?.planFact !== "passed" && fact?.planFact !== "skipped" && needsPlanFact(item)) problems.push(`${item.id}: plan-fact left no receipt — its acceptance items were not checked against the diff`);
  if (fact?.verification === "failed") problems.push(`${item.id}: its checks failed`);
  else if (fact?.verification === "skipped" && needsChecks(item)) problems.push(`${item.id}: its checks were skipped — nothing ran`);
  else if (fact?.verification !== "passed" && fact?.verification !== "skipped" && needsChecks(item)) problems.push(`${item.id}: its checks left no receipt — nothing is known to have run`);
  if (fact?.codeCritique === "blocked") problems.push(`${item.id}: the code critic blocks it`);
  return problems;
}

/** The pieces a scope cut keeps (proved) and the ones it withdraws, each with why; a piece of a wave the other model did not pass is not proved when waves are reviewed. */
export function provenPieces(items: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>, waves?: Record<string, WaveRecord>): { proven: PlanItem[]; unproven: Array<{ item: PlanItem; why: string }> } {
  const proven: PlanItem[] = [];
  const unproven: Array<{ item: PlanItem; why: string }> = [];
  for (const item of items) {
    const problems = pieceProof(item, facts.get(item.id));
    if (waves && waves[String(item.wave)]?.review?.state !== "passed") problems.push(`${item.id}: wave ${item.wave} was not passed by the other model's review`);
    if (problems.length) unproven.push({ item, why: problems.join("; ") }); else proven.push(item);
  }
  return { proven, unproven };
}

export function blindVerdict(items: readonly PlanItem[], facts: ReadonlyMap<string, TaskFact>, runGoal: { state: string; detail?: string | null; headSha?: string | null } | null, now: number,
  /** The drawing bound into the verdict (SMA p5_design): its recomputed hash and contract path; `changed` when it no longer is the confirmed one. */
  drawing?: { sha256: string; contract?: string | null; changed?: string | null }): FrozenVerdict | PendingVerdict {
  const problems: string[] = [];
  for (const item of items) problems.push(...pieceProof(item, facts.get(item.id)));
  if (drawing?.changed) problems.push(`the drawing changed since it was confirmed: ${drawing.changed}`);
  const waiting = runGoalPending(runGoal);
  if (!runGoal) problems.push("the run's goal check has not run yet");
  else if (runGoal.state === "failed") problems.push(`the run's goal check failed${runGoal.detail ? `: ${runGoal.detail}` : ""}`);
  else if (runGoal.state === "partial" || runGoal.state === "inconclusive") problems.push(`the run's goal check is ${runGoal.state}, not a full pass${runGoal.detail ? `: ${runGoal.detail}` : ""}`);
  const inputSha = sha256Hex(canonical({ items: items.map((item) => item.id), facts: items.map((item) => facts.get(item.id) ?? null), runGoal, drawing: drawing ? { sha256: drawing.sha256, contract: drawing.contract ?? null } : null }));
  const state = problems.length ? "failed" : waiting ? "pending" : "passed";
  return { state, detail: problems.join("; ") || (waiting ? "the run's goal check is still running" : "every piece accepted and proved; the composition passes on main"), mainSha: runGoal?.headSha ?? null, at: now, inputSha } as FrozenVerdict | PendingVerdict;
}

/** The verdict of a plan that found the goal already met: nothing was built, so nothing is composed; the goal audit weighs the evidence next. */
export function alreadyMetVerdict(alreadyMet: { evidence: string }, now: number): FrozenVerdict {
  return { state: "passed", detail: `already met, nothing to build: ${alreadyMet.evidence}`.slice(0, 1000), mainSha: null, at: now, inputSha: sha256Hex(canonical({ alreadyMet })) };
}
