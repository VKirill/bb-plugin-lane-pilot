import { listRuleForms, type RulesDatabase } from "@lane-pilot/run-insights";
import { listPromotions, type PromotionRow } from "./promotion";

/** The «rules as text vs as mechanism» counter plus the week's open promotion candidates for the wall morning. */
export type RuleFormsDigest = {
  textRules: number;
  mechanismRules: number;
  openPromotions: number;
  top: PromotionRow[];
};

export const PROMOTION_DIGEST_TOP = 10;

function projectsWithPromotions(db: RulesDatabase): string[] {
  try {
    return (db.prepare("SELECT DISTINCT project_id FROM lane_pilot_rule_promotion").all() as Array<{ project_id: string }>).map((row) => row.project_id);
  } catch { return []; }
}

function ruleCounter(db: RulesDatabase, projectIds: readonly string[]): { textRules: number; mechanismRules: number } {
  let textRules = 0, mechanismRules = 0;
  for (const projectId of projectIds.length ? projectIds : [""]) {
    for (const row of listRuleForms(db, projectId || null, ["accepted", "proposed"])) {
      if (row.mechanizedBy) mechanismRules++; else textRules++;
    }
  }
  return { textRules, mechanismRules };
}

/** The full digest for one project: the counter and at most `limit` open candidates (newest first). */
export function promotionDigest(db: RulesDatabase, projectId: string, limit: number = PROMOTION_DIGEST_TOP): RuleFormsDigest {
  const open = listPromotions(db, projectId).filter((row) => row.state === "proposed" || row.state === "owner_only");
  const counter = ruleCounter(db, [projectId]);
  return { ...counter, openPromotions: open.length, top: open.slice(0, limit) };
}

/** The same counters across the hub: the wall morning is not scoped to one project. */
export function promotionMorningLine(db: RulesDatabase): string | null {
  const projects = projectsWithPromotions(db);
  const counter = ruleCounter(db, projects);
  let open = 0;
  for (const projectId of projects) open += listPromotions(db, projectId).filter((row) => row.state === "proposed" || row.state === "owner_only").length;
  if (!counter.textRules && !counter.mechanismRules && !open) return null;
  return `Правила: текстом ${counter.textRules}, механизмом ${counter.mechanismRules}; кандидатов на механизацию ${open} — bb lane-pilot rules promote <project> --list.`;
}

/** The weekly top-10 for one project, for the PM's digest (called on the digest's day, not every day). */
export function promotionWeeklyLines(db: RulesDatabase, projectId: string): string[] | null {
  const digest = promotionDigest(db, projectId);
  if (!digest.openPromotions) return null;
  const lines = [`Правила: текстом ${digest.textRules}, механизмом ${digest.mechanismRules}; кандидатов на механизацию ${digest.openPromotions}, топ-${Math.min(digest.openPromotions, PROMOTION_DIGEST_TOP)}:`];
  for (const row of digest.top) lines.push(`  ${row.ruleId.slice(0, 13)}  ${row.state.padEnd(10)} ${row.mechanism.padEnd(16)} ${row.task.title.slice(0, 80)}`);
  lines.push(`принять: bb lane-pilot rules promote accept ${projectId} <rule-id>; отклонить: ... dismiss ...`);
  return lines;
}
