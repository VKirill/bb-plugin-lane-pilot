import type { RulesDatabase } from "./rule-schema";

// ---- the maturation ladder (SMA k_lib_ladder) ----

/** Rule tiers by measured benefit, low to high. */
export const RULE_TIERS = ["note", "warning", "soft-deny", "auto-fix"] as const;
export type RuleTier = (typeof RULE_TIERS)[number];

/** A rule's tier and when it last moved: the latest `tier` row in lane_pilot_rule_event; no row is `note`, moved never. It is a label only: nothing refuses or edits work by it. */
export function ruleTierState(db: RulesDatabase, projectId: string, ruleId: string): { tier: RuleTier; movedAt: number | null } {
  const row = db.prepare("SELECT detail, at FROM lane_pilot_rule_event WHERE project_id=? AND rule_id=? AND action='tier' ORDER BY at DESC, id DESC LIMIT 1").get(projectId, ruleId) as { detail: string | null; at: number } | undefined;
  return (RULE_TIERS as readonly string[]).includes(row?.detail ?? "") ? { tier: row!.detail as RuleTier, movedAt: row!.at } : { tier: "note", movedAt: null };
}
export const ruleTier = (db: RulesDatabase, projectId: string, ruleId: string): RuleTier => ruleTierState(db, projectId, ruleId).tier;

/**
 * The ladder move for one rule (SMA k_lib_ladder): up one step when the rule is confirmed and was applied at least
 * `riseAfterApplied` times with no recurrence; down one step at `dropAfterRecurrences` recurrences. `auto-fix` needs a
 * promoted mechanism, `soft-deny` needs form `check` or `hook`.
 */
export function ruleLadderStep(tier: RuleTier, stats: { confirmed: boolean; applied: number; recurrences: number }, caps: { hasMechanism: boolean; form: string | null }, thresholds = { riseAfterApplied: 10, dropAfterRecurrences: 2 }): "up" | "down" | "stay" {
  const index = RULE_TIERS.indexOf(tier);
  if (stats.recurrences >= thresholds.dropAfterRecurrences && index > 0) return "down";
  const next = RULE_TIERS[index + 1];
  if (!next || !stats.confirmed || stats.applied < thresholds.riseAfterApplied || stats.recurrences > 0) return "stay";
  if (next === "soft-deny" && caps.form !== "check" && caps.form !== "hook") return "stay";
  if (next === "auto-fix" && !caps.hasMechanism) return "stay";
  return "up";
}
