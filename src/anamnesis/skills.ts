/**
 * Skill levels from git evidence (A7). A skill record from git carries how many commits touched it in each month; the level at
 * the end of a month is a function of what had accumulated by then: commits, months with activity, and the repositories it was used
 * in. The result is a series over time (the tab draws it; the year review reads the level at both ends of the year).
 * Pure code on counts: no commit text or diff is read, no model is asked. The spec's per-evidence Jev Score needs the content of
 * the evidence, which git skills deliberately do not keep; messages, which do have content, are not scored (see the CHANGELOG).
 */
export const LEVELS = ["familiar", "applies", "confident", "expert"] as const;
export type SkillLevel = (typeof LEVELS)[number];

export type SkillStep = { month: string; level: SkillLevel; commits: number };
/** Thresholds, lowest first: cumulative commits, months with activity, repositories. */
const RULES: Array<[SkillLevel, { commits: number; months: number; repos: number }]> = [
  ["expert", { commits: 250, months: 6, repos: 3 }],
  ["confident", { commits: 60, months: 3, repos: 2 }],
  ["applies", { commits: 15, months: 2, repos: 1 }],
  ["familiar", { commits: 3, months: 1, repos: 1 }],
];

export function levelFor(total: { commits: number; months: number; repos: number }): SkillLevel | null {
  return RULES.find(([, need]) => total.commits >= need.commits && total.months >= need.months && total.repos >= need.repos)?.[0] ?? null;
}

/**
 * The level reached at the end of each month in which it changed (a level never goes down: a skill that was not used for a while is
 * still known). `repos` is the final number of repositories, since the per-month split is not kept.
 */
export function skillSeries(byMonth: Record<string, number>, repos: number): SkillStep[] {
  const steps: SkillStep[] = [];
  let commits = 0, months = 0, best = -1;
  for (const month of Object.keys(byMonth).sort()) {
    const count = byMonth[month] ?? 0;
    if (count <= 0) continue;
    commits += count; months += 1;
    const level = levelFor({ commits, months, repos });
    const rank = level ? LEVELS.indexOf(level) : -1;
    if (level && rank > best) { best = rank; steps.push({ month, level, commits }); }
  }
  return steps;
}

export const currentLevel = (steps: readonly SkillStep[]): SkillLevel | null => steps.at(-1)?.level ?? null;

/** The level a series had reached by the end of `month` (YYYY-MM), or null before the first step. */
export function levelAt(steps: readonly SkillStep[], month: string): SkillLevel | null {
  let found: SkillLevel | null = null;
  for (const step of steps) if (step.month <= month) found = step.level;
  return found;
}

/** What a stored skill record says about its levels, tolerant of a record without them. */
export function stepsOf(attributes: Record<string, unknown>): SkillStep[] {
  const raw = attributes.levels;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item): SkillStep[] => {
    const entry = item as Partial<SkillStep> | null;
    return entry && typeof entry.month === "string" && (LEVELS as readonly string[]).includes(String(entry.level)) ? [{ month: entry.month, level: entry.level as SkillLevel, commits: Number(entry.commits) || 0 }] : [];
  });
}
