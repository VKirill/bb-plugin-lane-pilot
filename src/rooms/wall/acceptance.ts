import { authorize, type ChangeDescriptor, type Tier } from "../policy";

/**
 * Acceptance of a night repair (SMA P1-1, item 4). The merge is decided by the night policy (`gateRepair`); once the release train has
 * shipped the merge, the night reads what the train recorded and decides whether the repair stays. The train itself runs the whole suite
 * before it ships, runs the drill after the reload and rolls back to the previous dist when the drill is red; the night adds the canary, the
 * bench subset against the previous version, and the class's own recurrence on the new version. Red means a revert in code and the class
 * stays open: the round counts as failed. Nothing here asks the owner.
 */
export type AcceptanceEvidence = {
  merged: boolean;
  versionBefore: string;
  /** The version the plugin runs now when it differs from `versionBefore`; null while no release has gone out. */
  deployedVersion: string | null;
  /** The newest drill outcome (`stability:drill`), and whether every check passed. */
  drill: { version: string; at: number; ok: boolean } | null;
  deployedAt: number | null;
  /** The canary of the deployed version (`canary_status`). */
  canary: { version: string; tripped: boolean; windowOpen: boolean } | null;
  /** The bench subset: the deployed version's arm against the previous version's, noise-aware (`bench compare`). */
  bench: "pass" | "fail" | "unavailable" | "pending";
  /** Failures of the repaired class among the attempts of the deployed version. */
  recurrence: { failures: number; attempts: number } | null;
  /** The plugin runs `versionBefore` again after a deploy: the train rolled back. */
  trainRolledBack: boolean;
};

export type AcceptanceCheck = { name: string; ok: boolean | null; detail: string };
export type Acceptance = {
  state: "pending" | "accepted" | "red" | "rolled_back";
  checks: AcceptanceCheck[];
  reason: string;
  /** The class kept failing on the new version although the repair stays: the round counts as failed. */
  recurred: boolean;
  /** `revert`: the night reverts the merge in code (canary or bench red); the train's own rollback needs nothing. */
  action: "none" | "revert";
};

/** The attempts of the deployed version the recurrence is judged on. */
export const RECURRENCE_MIN_ATTEMPTS = 10;

export function decideAcceptance(e: AcceptanceEvidence): Acceptance {
  const checks: AcceptanceCheck[] = [];
  const out = (state: Acceptance["state"], reason: string, extra: Partial<Acceptance> = {}): Acceptance => ({ state, checks, reason, recurred: false, action: "none", ...extra });
  if (!e.merged) return out("pending", "the branch is not merged");
  if (e.trainRolledBack) {
    checks.push({ name: "release train", ok: false, detail: `the plugin runs ${e.versionBefore} again: the train rolled the deploy back` });
    return out("rolled_back", "the release train rolled the deploy back (red drill, red canary at the reload or a failed push)");
  }
  if (!e.deployedVersion) return out("pending", "merged; waits for the release train");
  checks.push({ name: "release train", ok: true, detail: `${e.versionBefore} -> ${e.deployedVersion}; the train refuses a red suite, so a shipped version had a green one` });
  if (!e.drill || e.drill.version !== e.deployedVersion || (e.deployedAt !== null && e.drill.at < e.deployedAt)) {
    checks.push({ name: "deploy drill", ok: null, detail: "no drill outcome for the deployed version yet" });
    return out("pending", "waiting for the drill of the deployed version");
  }
  checks.push({ name: "deploy drill", ok: e.drill.ok, detail: e.drill.ok ? "green" : "red" });
  if (!e.drill.ok) return out("rolled_back", "the drill is red: the train restores the previous dist", { action: "none" });
  if (!e.canary || e.canary.version !== e.deployedVersion) {
    checks.push({ name: "canary", ok: null, detail: "no canary report for the deployed version yet" });
    return out("pending", "waiting for the canary of the deployed version");
  }
  checks.push({ name: "canary", ok: !e.canary.tripped, detail: e.canary.tripped ? "tripped" : e.canary.windowOpen ? "quiet so far (window open)" : "quiet (window closed)" });
  if (e.canary.tripped) return out("red", "the canary tripped on the deployed version: the night reverts the merge", { action: "revert" });
  if (e.canary.windowOpen) return out("pending", "the canary window is still open");
  checks.push({ name: "bench subset", ok: e.bench === "pass" ? true : e.bench === "fail" ? false : null, detail: e.bench === "unavailable" ? "no runnable bench set: not compared" : e.bench });
  if (e.bench === "fail") return out("red", "the bench subset is worse than the previous version: the night reverts the merge", { action: "revert" });
  if (e.bench === "pending") return out("pending", "the bench subset is running");
  const recurred = Boolean(e.recurrence && e.recurrence.attempts >= RECURRENCE_MIN_ATTEMPTS && e.recurrence.failures > 0);
  checks.push({ name: "class recurrence on the new version", ok: e.recurrence ? !recurred : null,
    detail: e.recurrence ? `${e.recurrence.failures} of ${e.recurrence.attempts} attempts${e.recurrence.attempts < RECURRENCE_MIN_ATTEMPTS ? " (too few to judge)" : ""}` : "no attempts yet" });
  return out("accepted", recurred ? "the repair stays (nothing else got worse) but the class still happens: the round counts as failed" : "all checks green", { recurred });
}

/** What the descriptor of a night repair says: the repository files its branch changed and the proofs the policy asks of `lp_fault_repair`. */
export function repairChange(files: readonly string[], proofs: { benchSubset: boolean; revertible: boolean }): ChangeDescriptor {
  return { kind: "lp_fault_repair", files: [...files], attrs: { bench_subset_passed: proofs.benchSubset, auto_revertible: proofs.revertible } };
}

export type GateDecision = { decision: "merge" | "hold"; requested: Tier; tier: Tier; reason: string; matched: Array<{ id: string; tier: Tier }> };

/**
 * night_decides may merge (and the train ships it, the checks after it revert it); night_proposes and owner_only are held: the branch
 * stays, the night does not merge it and nobody is asked (the repair is logged with the policy's reason).
 */
export function gateRepair(change: ChangeDescriptor): GateDecision {
  const answer = authorize(change);
  return { decision: answer.tier === "night_decides" ? "merge" : "hold", requested: answer.requested, tier: answer.tier, reason: answer.reason, matched: answer.matched };
}
