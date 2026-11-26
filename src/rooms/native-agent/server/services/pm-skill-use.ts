import { listPmSkillUsesSince, recordPmSkillUse as recordPmSkillUseRow, type LanePilotDatabase } from "../../../storage";
import { PM_SKILLS_USAGE, pmSkillName, type PmSkillCount } from "../../models/pm-skill";

export { PM_SKILLS_USAGE, pmSkillName, type PmSkillCount };

/**
 * Which skills a PM session opens (audit Fable 5.1, finding 8). The bundled PostToolUse hook sees the
 * Skill tool and fires `bb lane-pilot pm-skill-use` detached; `bb lane-pilot pm-skills` reads the counts.
 * The name is stored exactly as the session shows it (`bb-global-skills:lane-pilot` included);
 * the read side folds the scoped spelling into the bare one.
 */
export function recordPmSkillUse(db: LanePilotDatabase, row: { threadId: string; projectId: string; skill: string; at?: number }): void {
  recordPmSkillUseRow(db, row);
}

/** Counts per skill over `days`; `scope:name` and `name` aggregate as one skill. */
export function pmSkillUseCounts(db: LanePilotDatabase, options: { days?: number; now?: number } = {}): PmSkillCount[] {
  const days = options.days && options.days > 0 ? Math.floor(options.days) : 14;
  const since = (options.now ?? Date.now()) - days * 86_400_000;
  const rows = listPmSkillUsesSince(db, since);
  const groups = new Map<string, { uses: number; threads: Set<string> }>();
  for (const row of rows) {
    const name = pmSkillName(row.skill) || row.skill;
    const group = groups.get(name) ?? { uses: 0, threads: new Set<string>() };
    group.uses += 1;
    group.threads.add(row.thread_id);
    groups.set(name, group);
  }
  return [...groups].map(([skill, group]) => ({ skill, uses: group.uses, threads: group.threads.size }))
    .sort((a, b) => b.uses - a.uses || a.skill.localeCompare(b.skill));
}
