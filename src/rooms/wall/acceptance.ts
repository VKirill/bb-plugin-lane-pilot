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

/** A changed file of a repair's branch: its path and git's letter (A added, M modified, D deleted); a bare path has no known status. */
export type RepairFile = string | { path: string; status: string };
const isTestFile = (path: string) => /(^|\/)tests?\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path);

/**
 * What the descriptor of a night repair says: the repository files its branch changed and the proofs the policy asks of
 * `lp_fault_repair`, plus whether every test the branch touched is new (an existing test changed or deleted could loosen the judge).
 */
export function repairChange(files: readonly RepairFile[], proofs: { benchSubset: boolean; revertible: boolean }): ChangeDescriptor {
  const entries = files.map((file) => (typeof file === "string" ? { path: file, status: "?" } : file));
  const testsUntouched = entries.every((file) => !isTestFile(file.path) || file.status === "A");
  return { kind: "lp_fault_repair", files: entries.map((file) => file.path), attrs: { bench_subset_passed: proofs.benchSubset, auto_revertible: proofs.revertible, tests_untouched: testsUntouched } };
}

/**
 * Entries a night repair may still merge with the strict proofs: it changes the judge or the graph, and Matvey's rule is «only with
 * your yes if you have no rollbacks» (#31448) — the night has them (canary, bench subset, recurrence revert the merge). The other
 * owner_only entries (money, secrets, irreversible data, the bench set, the policy itself, access fences, outside the repository,
 * the standing prohibitions) are what the night never does.
 */
export const STRICT_PROOF_ENTRIES = ["judge_gates", "judge_thresholds", "rule_trial_apply", "rule_always_on", "default_model_change", "new_pipeline_stage", "graph_edit", "memory_core_edit"] as const;

export type GateDecision = { decision: "merge" | "reject"; requested: Tier; tier: Tier; reason: string; matched: Array<{ id: string; tier: Tier }>; strict?: boolean };

/**
 * No repair waits for the owner (owner 2026-10-22: «я вообще не должен участвовать»): a held branch was released unread after a week.
 * night_decides merges; a change of the judge or the graph merges only with the strict proofs (bench subset passed, revertible, no
 * existing test changed or deleted); anything else, or a change without those proofs, is rejected with its reason and the class's
 * round counts as failed, so the ladder moves on.
 */
export function gateRepair(change: ChangeDescriptor): GateDecision {
  const answer = authorize(change);
  const base = { requested: answer.requested, tier: answer.tier, matched: answer.matched };
  if (answer.tier === "night_decides") return { ...base, decision: "merge", reason: answer.reason };
  const restrictive = answer.matched.filter((hit) => hit.tier !== "night_decides");
  const strictOnly = restrictive.length > 0 && restrictive.every((hit) => (STRICT_PROOF_ENTRIES as readonly string[]).includes(hit.id));
  const attrs = change.attrs ?? {};
  const proofs = attrs.bench_subset_passed === true && attrs.auto_revertible === true && attrs.tests_untouched === true;
  if (strictOnly && proofs) return { ...base, decision: "merge", strict: true, reason: `${answer.reason}; merged on the strict proofs (bench subset, revertible, no existing test changed)` };
  const missing = !strictOnly ? `the night never does ${restrictive.filter((hit) => !(STRICT_PROOF_ENTRIES as readonly string[]).includes(hit.id)).map((hit) => hit.id).join(", ") || "an unknown change"}`
    : [attrs.bench_subset_passed !== true && "no passed bench subset", attrs.auto_revertible !== true && "not revertible", attrs.tests_untouched !== true && "an existing test was changed or deleted"].filter(Boolean).join(", ");
  return { ...base, decision: "reject", reason: `${answer.reason}; rejected: ${missing}` };
}
