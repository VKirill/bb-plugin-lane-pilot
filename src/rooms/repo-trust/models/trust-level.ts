import type { QualityMode, RepoTrustOutput } from "../../contracts";

/** Rolling window (days) used for rollback counts and first-try acceptance in `repo_trust`. */
export const TRUST_WINDOW_DAYS = 30;
export const TRUST_WINDOW_MS = TRUST_WINDOW_DAYS * 86_400_000;

/** Rollback count thresholds for repository trust level classification. */
export const TRUST_HIGH_MAX_ROLLBACKS = 0;
export const TRUST_LOW_MIN_ROLLBACKS = 3;

export type TrustLevel = RepoTrustOutput["level"];
export type TrustGateState = RepoTrustOutput["gate"]["state"];
export type TrustRule = RepoTrustOutput["rules"][number];

/** Computes repository trust level solely from Lane Pilot's gate ledger and 30-day revert receipts. */
export function computeTrustLevel(input: {
  gateState: TrustGateState;
  fresh: boolean;
  rollbacks30d: number;
}): TrustLevel {
  if (input.gateState === "failed" || input.rollbacks30d >= TRUST_LOW_MIN_ROLLBACKS) return "low";
  if (input.gateState === "none") return "unknown";
  if (input.gateState === "passed" && input.fresh && input.rollbacks30d <= TRUST_HIGH_MAX_ROLLBACKS) return "high";
  return "medium";
}

/** Maps project/section `quality_mode` and workspace mode (`adoc.040`) to read-only action-class rules. */
export function buildTrustRules(settings: {
  qualityMode: QualityMode;
  workspaceMode: unknown;
}): TrustRule[] {
  const workspace = typeof settings.workspaceMode === "string" ? settings.workspaceMode.trim().toLowerCase() : "auto";
  const mergeMode: TrustRule["mode"] =
    settings.qualityMode === "full" || workspace === "in_place" ? "ask" : "auto";
  const migrationsMode: TrustRule["mode"] =
    settings.qualityMode === "full" ? "owner_only" : settings.qualityMode === "quick" ? "auto" : "ask";
  return [
    { actionClass: "merge_without_owner", mode: mergeMode },
    { actionClass: "migrations", mode: migrationsMode },
    { actionClass: "deploy", mode: "owner_only" },
  ];
}
