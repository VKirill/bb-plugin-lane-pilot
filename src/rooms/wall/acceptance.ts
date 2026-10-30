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
  /**
   * The bench subset: the deployed version's arm against the previous version's, noise-aware (`bench compare`). `inconclusive`: the arms
   * were compared and too little was measured to call it; it is no evidence either way, like `unavailable`.
   */
  bench: "pass" | "fail" | "unavailable" | "pending" | "inconclusive";
  /**
   * Failures of the repaired class among the attempts of the deployed version. `exposed`: the attempts counted are those exposed to the class (projects the
   * class was journaled in); false when that is unknown, and then a quiet run of attempts says nothing about the class.
   */
  recurrence: { failures: number; attempts: number; exposed: boolean } | null;
  /** The plugin runs `versionBefore` again after a deploy: the train rolled back. */
  trainRolledBack: boolean;
  /**
   * The repair changes the judge or the graph (merged on the strict path): the recurrence of its class cannot vouch for it, only the bench
   * subset of the shipped version can.
   */
  requireBench?: boolean;
  /** The version the plugin runs now when it is neither `versionBefore` nor `deployedVersion`: a later release came in, and everything measured since is not the candidate's alone. */
  supersededBy?: string | null;
  /** Now, to tell how long the evidence has been awaited (`EVIDENCE_WAIT_MS`). */
  now?: number;  /** The weekly sealed-set probe flagged a pass gap over `bench.sealed_gap_pp`: the night keeps measuring but accepts no new fixes while it holds. */
  sealedGap?: boolean;
};

export type AcceptanceCheck = { name: string; ok: boolean | null; detail: string };
export type Acceptance = {
  /** `inconclusive`: no evidence came, for or against, and none will (a later release came in, or the wait ran out). It is not an acceptance. */
  state: "pending" | "accepted" | "red" | "rolled_back" | "inconclusive";
  checks: AcceptanceCheck[];
  reason: string;
  /** The class kept failing on the new version although the repair stays: the round counts as failed. */
  recurred: boolean;
  /** `revert`: the night reverts the merge in code (canary or bench red); the train's own rollback needs nothing. */
  action: "none" | "revert";
};

/** The attempts of the deployed version the recurrence is judged on. */
export const RECURRENCE_MIN_ATTEMPTS = 10;
/** How long a deployed repair waits for its evidence (a bench result, enough attempts of the new version) before it is settled as inconclusive. */
export const EVIDENCE_WAIT_MS = 72 * 3_600_000;
/** How long an open repair (running, fixed, held, merged) may sit without a verdict. Same horizon as a harness trial. */
export const REPAIR_DEADLINE_MS = 14 * 86_400_000;

export type RepairDeadlineInput = {
  state: string;
  createdAt: number;
  now: number;
  /** A verdict already computed from collected evidence. Absent means nothing was measured. */
  collected?: "accepted" | "red" | "rolled_back" | "inconclusive" | "pending" | null;
};

/**
 * Past the deadline an open repair is closed from what was collected: accept, reject, or insufficient data.
 * Inside the deadline it stays open.
 */
export function closeExpiredRepair(row: RepairDeadlineInput, deadlineMs = REPAIR_DEADLINE_MS): { close: false } | { close: true; state: "accepted" | "red" | "unproven"; reason: string } {
  if (row.now - row.createdAt < deadlineMs) return { close: false };
  if (row.collected === "accepted") return { close: true, state: "accepted", reason: "deadline passed; the collected evidence accepts the repair" };
  if (row.collected === "red" || row.collected === "rolled_back") return { close: true, state: "red", reason: "deadline passed; the collected evidence rejects the repair" };
  const days = Math.round(deadlineMs / 86_400_000);
  return { close: true, state: "unproven", reason: `insufficient data: open as ${row.state} past the ${days}-day deadline without a verdict` };
}

export function decideAcceptance(e: AcceptanceEvidence): Acceptance {
  const checks: AcceptanceCheck[] = [];
  const out = (state: Acceptance["state"], reason: string, extra: Partial<Acceptance> = {}): Acceptance => ({ state, checks, reason, recurred: false, action: "none", ...extra });
  if (!e.merged) return out("pending", "the branch is not merged");
  if (e.trainRolledBack) {
    checks.push({ name: "release train", ok: false, detail: `the plugin runs ${e.versionBefore} again: the train rolled the deploy back` });
    return out("rolled_back", "the release train rolled the deploy back (red drill, red canary at the reload or a failed push)");
  }
  if (!e.deployedVersion) return out("pending", "merged; waits for the release train");
  // Waiting for evidence ends: a later release makes what is measured since not the candidate's alone, and a wait past the limit will not be answered by more waiting.
  const waited = e.now !== undefined && e.deployedAt !== null && e.now - e.deployedAt >= EVIDENCE_WAIT_MS;
  const wait = (reason: string): Acceptance => e.supersededBy
    ? out("inconclusive", `${reason}; ${e.supersededBy} was released after ${e.deployedVersion}, so nothing measured since is this repair's alone`)
    : waited ? out("inconclusive", `${reason}; the evidence did not come within ${EVIDENCE_WAIT_MS / 3_600_000} hours`) : out("pending", reason);
  checks.push({ name: "release train", ok: true, detail: `${e.versionBefore} -> ${e.deployedVersion}; the train refuses a red suite, so a shipped version had a green one` });
  const fireDrill = e.drill && e.drill.version === e.deployedVersion && !(e.deployedAt !== null && e.drill.at < e.deployedAt) ? e.drill : null;
  if (fireDrill && !fireDrill.ok) {
    checks.push({ name: "deploy drill", ok: false, detail: "red" });
    return out("rolled_back", "the drill is red: the train restores the previous dist", { action: "none" });
  }
  // A drill receipt of this exact version is the evidence; the train's rollback on a red one is an inference («the plugin runs it, so its drill was green»), not a
  // receipt. Without a receipt the drill is unmeasured and the repair is not accepted on it (Astra, 2026-10-27); the wait ends in `inconclusive`, never in `accepted`.
  checks.push({ name: "deploy drill", ok: fireDrill ? true : null, detail: fireDrill ? "green (drill receipt of this version)" : "no drill receipt for the deployed version: not evidence" });
  if (!e.canary || e.canary.version !== e.deployedVersion) {
    checks.push({ name: "canary", ok: null, detail: "no canary report for the deployed version yet" });
    return wait("waiting for the canary of the deployed version");
  }
  checks.push({ name: "canary", ok: !e.canary.tripped, detail: e.canary.tripped ? "tripped" : e.canary.windowOpen ? "quiet so far (window open)" : "quiet (window closed)" });
  if (e.canary.tripped) return out("red", "the canary tripped on the deployed version: the night reverts the merge", { action: "revert" });
  if (e.canary.windowOpen) return wait("the canary window is still open");
  checks.push({ name: "bench subset", ok: e.bench === "pass" ? true : e.bench === "fail" ? false : null,
    detail: e.bench === "unavailable" ? "no runnable bench set: not compared" : e.bench === "inconclusive" ? "compared, and too little was measured to call it: no evidence either way" : e.bench });
  if (e.bench === "fail") return out("red", "the bench subset is worse than the previous version: the night reverts the merge", { action: "revert" });
  if (e.bench === "pending") return wait("the bench subset is running");
  if (e.sealedGap) {
    checks.push({ name: "sealed set gap", ok: false, detail: "the sealed set trails the open set by more than the threshold: the night may be fit to the open tasks" });
    return wait("possible overfit: the sealed set lags the open set beyond bench.sealed_gap_pp; new fixes are not accepted while the gap holds");
  }
  const attempts = e.recurrence?.attempts ?? 0;
  const recurred = Boolean(e.recurrence && attempts >= RECURRENCE_MIN_ATTEMPTS && e.recurrence.failures > 0);
  checks.push({ name: "class recurrence on the new version", ok: e.recurrence ? !recurred : null,
    detail: e.recurrence ? `${e.recurrence.failures} of ${e.recurrence.attempts} ${e.recurrence.exposed ? "attempts exposed to the class" : "attempts (exposure to the class unknown)"}${attempts < RECURRENCE_MIN_ATTEMPTS ? " (too few to judge)" : ""}` : "no attempts yet" });
  // A repair whose class kept failing on the new version did not do what it was made for. Nothing in these inputs measures an effect of a kept part (there is no
  // baseline), so it is not accepted: a failed round, and the night reverts the merge. A repair of the judge or the graph is judged by the bench alone.
  if (recurred && !e.requireBench) {
    return out("red", `the class still happens on the new version (${e.recurrence!.failures} of ${attempts} attempts) and nothing measured shows the repair helped: not accepted, the night reverts the merge`, { action: "revert", recurred: true });
  }
  // A quiet canary and a shipped version are the absence of a failure, not a proof. The repair stays only on a result: the bench subset passed, or enough
  // attempts of the new version that were exposed to the class (attempts of projects it never ran in prove nothing). A repair of the judge or the graph needs
  // the bench result itself (an unavailable bench with no attempts once read «all checks green»).
  const judged = Boolean(e.recurrence?.exposed && attempts >= RECURRENCE_MIN_ATTEMPTS);
  if (e.requireBench ? e.bench !== "pass" : e.bench !== "pass" && !judged) {
    return wait(e.requireBench ? `no proof yet: a repair of the judge or the graph needs a passed bench subset (bench ${e.bench})`
      : `no proof yet: no passed bench subset (bench ${e.bench}) and ${e.recurrence?.exposed ? attempts : 0} of ${RECURRENCE_MIN_ATTEMPTS} attempts of the new version exposed to the class`);
  }
  if (!fireDrill) return wait("no drill receipt for the deployed version");
  return out("accepted", recurred ? "the repair stays (the bench subset of the judge or graph repair passed) but the class still happens: the round counts as failed"
    : checks.every((check) => check.ok === true) ? "all checks green" : "no check is red and the proof holds", { recurred });
}

/** A changed file of a repair's branch: its path and git's letter (A added, M modified, D deleted); a bare path has no known status. */
export type RepairFile = string | { path: string; status: string };
const isTestFile = (path: string) => /(^|\/)tests?\//.test(path) || /\.test\.[cm]?[jt]sx?$/.test(path);

/**
 * What the descriptor of a night repair says: the repository files its branch changed and what is known of the repair before it ships, plus whether
 * every test the branch touched is new (an existing test changed or deleted could loosen the judge).
 * `bench_subset_passed` and `auto_revertible` are the names the night policy's table asks for: a runnable bench subset that judges the repair after the
 * deploy, and a revert that is in working order. They are claims for the ordinary tier (docs/wall.md, known limits), never a result; the strict path
 * reads `bench_available` and `rollback_path_ok`, which say what they are.
 */
export function repairChange(files: readonly RepairFile[], proofs: { benchAvailable: boolean; rollbackOk: boolean }): ChangeDescriptor {
  const entries = files.map((file) => (typeof file === "string" ? { path: file, status: "?" } : file));
  const testsUntouched = entries.every((file) => !isTestFile(file.path) || file.status === "A");
  return { kind: "lp_fault_repair", files: entries.map((file) => file.path), attrs: { bench_subset_passed: proofs.benchAvailable, auto_revertible: proofs.rollbackOk,
    bench_available: proofs.benchAvailable, rollback_path_ok: proofs.rollbackOk, tests_untouched: testsUntouched } };
}

/**
 * Entries a night repair may still merge with the strict proofs: it changes the judge or the graph, and Matvey's rule is «only with
 * your yes if you have no rollbacks» (#31448) — the night has them (canary, bench subset, recurrence revert the merge). The other
 * owner_only entries (money, secrets, irreversible data, the bench set, the policy itself, access fences, outside the repository,
 * the standing prohibitions) are what the night never does.
 */
export const STRICT_PROOF_ENTRIES = ["judge_gates", "judge_thresholds", "rule_trial_apply", "rule_always_on", "default_model_change", "new_pipeline_stage", "graph_edit", "memory_core_edit"] as const;

export type GateDecision = { decision: "merge" | "reject"; requested: Tier; tier: Tier; reason: string; matched: Array<{ id: string; tier: Tier }>; strict?: boolean; provisional?: boolean };

/**
 * No repair waits for the owner (owner 2026-10-22: «я вообще не должен участвовать»): a held branch was released unread after a week.
 * night_decides merges; a change of the judge or the graph merges only provisionally: the bench subset can be runnable and the revert in working
 * order before the merge, but neither is a result of THIS candidate, which exists only once the train ships it. Such a merge is therefore pending
 * (`provisional`), and its acceptance needs the passed bench subset of the shipped version (`AcceptanceEvidence.requireBench`); an existing test
 * changed or deleted still rejects it. Anything else, or a change without those conditions, is rejected with its reason and the class's
 * round counts as failed, so the ladder moves on.
 */
export function gateRepair(change: ChangeDescriptor): GateDecision {
  const answer = authorize(change);
  const base = { requested: answer.requested, tier: answer.tier, matched: answer.matched };
  if (answer.tier === "night_decides") return { ...base, decision: "merge", reason: answer.reason };
  const restrictive = answer.matched.filter((hit) => hit.tier !== "night_decides");
  const strictOnly = restrictive.length > 0 && restrictive.every((hit) => (STRICT_PROOF_ENTRIES as readonly string[]).includes(hit.id));
  const attrs = change.attrs ?? {};
  const conditions = attrs.bench_available === true && attrs.rollback_path_ok === true && attrs.tests_untouched === true;
  if (strictOnly && conditions) return { ...base, decision: "merge", strict: true, provisional: true, reason: `${answer.reason}; merged provisionally (bench subset runnable, revert in working order, no existing test changed): accepted only on a passed bench subset of the shipped version` };
  const missing = !strictOnly ? `the night never does ${restrictive.filter((hit) => !(STRICT_PROOF_ENTRIES as readonly string[]).includes(hit.id)).map((hit) => hit.id).join(", ") || "an unknown change"}`
    : [attrs.bench_available !== true && "no runnable bench subset", attrs.rollback_path_ok !== true && "the revert is not in working order", attrs.tests_untouched !== true && "an existing test was changed or deleted"].filter(Boolean).join(", ");
  return { ...base, decision: "reject", reason: `${answer.reason}; rejected: ${missing}` };
}

/** Files every release rewrites (its notes and version): a later release touching only these says nothing about a repair. */
const RELEASE_NOISE = /^(CHANGELOG\.md|README\.md|package(-lock)?\.json|docs\/)/;

/**
 * Whether a release that came after the repair's own voids its evidence: only when it changed a file the repair changed or a source file of its failure
 * class. With 4-6 releases a day a rule that voided on any release let the night accept nothing (Fable's recheck of 0.1.341, R5). `laterFiles` null
 * (the files of the release are unknown) cannot show the release was unrelated, so it voids.
 */
export function laterReleaseTouches(input: { repairFiles: readonly string[]; classFiles: readonly string[]; laterFiles: readonly string[] | null }): boolean {
  if (!input.laterFiles) return true;
  const mine = new Set([...input.repairFiles, ...input.classFiles].filter((path) => !RELEASE_NOISE.test(path)));
  return input.laterFiles.some((path) => mine.has(path));
}
