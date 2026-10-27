import { insertDeferral, type DeferralDb, type DeferralKind } from "./store";

/**
 * What the register held on its first day (unreleased): the skipped tests (one entry per test file, the id is written beside each skip
 * as `// deferral:<id>`) and the five decisions the 2026-10-05 plan still waits on. They are seeded with no term: only a human sets one.
 * (The 21 rows seeded on 2026-10-22 carry the default of 14 days; the store reads them as «open, no term» without rewriting them.)
 * Seeded on start with INSERT OR IGNORE, so a term set later is never reset.
 */
export type SeedEntry = { id: string; kind: DeferralKind; area: string; what: string };

const skip = (slug: string, file: string, condition: string): SeedEntry => ({
  id: `dfr_seed_skip_${slug}`, kind: "skipped_test", area: "tests", what: `tests/${file}: skipped when ${condition}`,
});

const PLAN = ".agents/plans/2026-10-05-harness-engineering-gaps.md";
const decision = (slug: string, what: string): SeedEntry => ({ id: `dfr_seed_plan_${slug}`, kind: "plan_decision", area: "harness", what: `${what} (${PLAN}, waiting for the owner's decision)` });

export const SEED_ENTRIES: readonly SeedEntry[] = [
  skip("pipeline", "pipeline.test.ts", "the upstream agency binary is absent (NO_UPSTREAM): argv and 18-field schema checks"),
  skip("acceptance_v2", "acceptance-v2.test.ts", "the upstream agency checkout is absent (NO_UPSTREAM)"),
  skip("fault_injection", "fault-injection.test.ts", "the upstream fixture is absent (UPSTREAM_FIXTURE)"),
  skip("stability_drill", "stability-drill.test.ts", "lsof is missing (the fire drill on a scratch repository)"),
  skip("applicability", "applicability.test.ts", "the agency settings.json is absent (NO_AGENCY_SETTINGS)"),
  skip("ui_runtime", "ui-runtime.test.ts", "the upstream argparse choices are absent (NO_UPSTREAM)"),
  skip("install_failure", "install-failure.test.ts", "the upstream checkout is absent (NO_UPSTREAM): rollback and snapshot integrity"),
  skip("guard", "guard.test.ts", "the upstream PM_AGENTS is absent (NO_UPSTREAM)"),
  skip("capture_ui", "capture-ui.test.tsx", "CAPTURE is not 1 (UI screenshot HTML)"),
  skip("scenarios", "scenarios.test.ts", "the upstream checkout is absent (NO_UPSTREAM): scenarios S1-S8"),
  skip("external_skip", "external-skip.test.ts", "the upstream checkout is absent (NO_UPSTREAM): D1 skip wrappers"),
  skip("coexistence_managed_1", "upstream-adapter/coexistence-managed-1.test.ts", "the exact upstream target fixture is absent"),
  skip("coexistence_managed_2", "upstream-adapter/coexistence-managed-2.test.ts", "the exact upstream target fixture is absent"),
  skip("server_stage_live_browser", "stages/server-stage/suite.ts", "LANE_PILOT_LIVE_BROWSER is not 1 (a live host browser runner)"),
  skip("git_lock", "verification/git-lock.test.ts", "lsof is missing (stale git lock handling)"),
  skip("sandbox_home", "verification/sandbox-home.test.ts", "the host is not macOS with /usr/bin/sandbox-exec"),
  decision("harness_eval", "Harness eval / replay: a fixed set of past accepted tasks replayed against a candidate version (which projects, token budget per eval)"),
  decision("containment", "Containment of writers and critics: read-only spawn for critics, per-role bb-bridge tool filter, verify sandbox without machine env (needs BB core work)"),
  decision("code_critique_default", "Code critique on by default for risk >= medium (check critic_stats first)"),
  decision("auto_browser_qa", "Automatic browser QA for page:* tasks when the project declares a dev server"),
  decision("non_idempotent_verification", "Non-idempotent verification: verification[].idempotent:false disables the flaky re-run"),
];

/** Writes the entries that are not in the register yet; returns how many were added. */
export function seedDeferrals(db: DeferralDb, now: number): number {
  let added = 0;
  for (const entry of SEED_ENTRIES) {
    if (insertDeferral(db, {
      id: entry.id, projectId: null, what: entry.what, kind: entry.kind, area: entry.area, dueAt: null, dueSource: null, ownerRef: null, ownerQuote: null,
      state: "needs_owner_term", history: [], source: "seed", createdAt: now, updatedAt: now, closedAt: null, closedBy: null,
    }, true)) added += 1;
  }
  return added;
}
