import type { LanePilotDatabase } from "../../storage";

/**
 * Which skills a PM session opens (audit Fable 5.1, finding 8). The bundled PostToolUse hook sees the
 * Skill tool and fires `bb lane-pilot pm-skill-use` detached; `bb lane-pilot pm-skills` reads the counts.
 * The name is stored exactly as the session shows it (`bb-global-skills:lane-pilot-ops` included);
 * the read side folds the scoped spelling into the bare one.
 */
export const PM_SKILLS_USAGE = "bb lane-pilot pm-skills [--days N] [--json]";

export function recordPmSkillUse(db: LanePilotDatabase, row: { threadId: string; projectId: string; skill: string; at?: number }): void {
  db.prepare("INSERT INTO lane_pilot_pm_skill_use(thread_id,project_id,skill,used_at) VALUES(?,?,?,?)")
    .run(row.threadId, row.projectId, row.skill, row.at ?? Date.now());
}

export type PmSkillCount = { skill: string; uses: number; threads: number };

/** The bare name the CLI counts: `bb-global-skills:lane-pilot-ops` and `lane-pilot-ops` are one skill. */
export function pmSkillName(name: string): string {
  const at = name.lastIndexOf(":");
  return (at >= 0 ? name.slice(at + 1) : name).trim();
}

/** Counts per skill over `days`; `scope:name` and `name` aggregate as one skill. */
export function pmSkillUseCounts(db: LanePilotDatabase, options: { days?: number; now?: number } = {}): PmSkillCount[] {
  const days = options.days && options.days > 0 ? Math.floor(options.days) : 14;
  const since = (options.now ?? Date.now()) - days * 86_400_000;
  const rows = db.prepare("SELECT skill, thread_id FROM lane_pilot_pm_skill_use WHERE used_at>=?").all(since) as Array<{ skill: string; thread_id: string }>;
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

export function runPmSkillsCli(db: LanePilotDatabase, args: string[]): { exitCode: number; stdout?: string; stderr?: string } {
  const daysAt = args.indexOf("--days");
  const days = daysAt >= 0 ? Number(args[daysAt + 1]) : undefined;
  const rows = pmSkillUseCounts(db, { ...(days && Number.isFinite(days) ? { days } : {}) });
  if (args.includes("--json")) return { exitCode: 0, stdout: JSON.stringify({ days: days ?? 14, skills: rows }, null, 2) };
  return { exitCode: 0, stdout: rows.map((row) => `${row.skill} — ${row.uses} (${row.threads} thread${row.threads === 1 ? "" : "s"})`).join("\n") || "no PM skill calls recorded" };
}

export function runPmSkillUseCli(db: LanePilotDatabase, args: string[]): { exitCode: number; stdout?: string; stderr?: string } {
  const flagValues = new Set<number>();
  const threadAt = args.indexOf("--thread");
  const projectAt = args.indexOf("--project");
  if (threadAt >= 0) flagValues.add(threadAt + 1);
  if (projectAt >= 0) flagValues.add(projectAt + 1);
  const skill = args.find((arg, index) => !arg.startsWith("--") && !flagValues.has(index));
  const threadId = threadAt >= 0 ? args[threadAt + 1] : undefined;
  if (!skill || !threadId) return { exitCode: 1, stderr: "bb lane-pilot pm-skill-use <skill> --thread <thread-id> [--project <project-id>]" };
  recordPmSkillUse(db, { threadId, projectId: projectAt >= 0 ? args[projectAt + 1] ?? "" : "", skill });
  return { exitCode: 0, stdout: JSON.stringify({ ok: true }) };
}
