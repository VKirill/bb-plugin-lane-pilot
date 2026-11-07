import { listPromotionProjectIds, listRuleForms, type RulesDatabase } from "@lane-pilot/run-insights";
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
    return listPromotionProjectIds(db);
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

