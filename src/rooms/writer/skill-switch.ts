import { randomUUID } from "node:crypto";
import { extractSkillSequence } from "../contracts";
import type Database from "better-sqlite3";
import { listSkillMetrics, recordSkillMetric } from "../storage";

export type Db = Pick<Database.Database, "prepare" | "transaction">;

export type SkillSwitchRecord = {
  id: string;
  attemptId: string;
  taskId: string;
  runId: string | null;
  projectId: string;
  skillCount: number;
  switchCount: number;
  skillsJson: string;
  outcome: string;
  recordedAt: number;
};

export type SkillSwitchStats = {
  totalTasks: number;
  avgSwitches: number;
  lowSwitchTotal: number;
  lowSwitchFailures: number;
  lowSwitchFailRate: number;
  highSwitchTotal: number;
  highSwitchFailures: number;
  highSwitchFailRate: number;
};

/**
 * Calculates the number of skill switches (transitions between different skills in sequence).
 * e.g., [A, A, B, C, C, B] -> 3 switches (A->B, B->C, C->B).
 */
export function calculateSkillSwitches(sequence: readonly string[]): {
  uniqueSkills: string[];
  switchCount: number;
} {
  const uniqueSkills = [...new Set(sequence)];
  let switchCount = 0;

  for (let i = 1; i < sequence.length; i++) {
    if (sequence[i] !== sequence[i - 1]) {
      switchCount++;
    }
  }

  return { uniqueSkills, switchCount };
}

export function recordSkillSwitchMetric(
  db: Db,
  input: {
    attemptId: string;
    taskId: string;
    runId?: string | null;
    projectId: string;
    events?: readonly unknown[];
    skills?: readonly string[];
    outcome: "accepted" | "failed" | "blocked" | "validation_failed" | string;
    now?: number;
  },
): SkillSwitchRecord {
  const now = input.now ?? Date.now();
  const sequence = extractSkillSequence(input.events ?? [], input.skills ?? []);
  const { uniqueSkills, switchCount } = calculateSkillSwitches(sequence);

  const id = `skm_${randomUUID().slice(0, 12)}`;
  const record: SkillSwitchRecord = {
    id,
    attemptId: input.attemptId,
    taskId: input.taskId,
    runId: input.runId ?? null,
    projectId: input.projectId,
    skillCount: uniqueSkills.length,
    switchCount,
    skillsJson: JSON.stringify(sequence),
    outcome: input.outcome === "accepted" ? "accepted" : "failed",
    recordedAt: now,
  };

  try {
    recordSkillMetric(db as never, record);
  } catch {
    // Non-blocking in case of DB lock or schema delay
  }

  return record;
}

export function getSkillSwitchStats(
  db: Db,
  sinceMs: number = 0,
  now: number = Date.now(),
): SkillSwitchStats | null {
  try {
    const rows = listSkillMetrics(db as never, sinceMs, now);

    if (!rows.length) return null;

    let totalSwitches = 0;
    let lowTotal = 0;
    let lowFails = 0;
    let highTotal = 0;
    let highFails = 0;

    for (const row of rows) {
      totalSwitches += row.switch_count;
      const failed = row.outcome !== "accepted";
      if (row.switch_count <= 1) {
        lowTotal++;
        if (failed) lowFails++;
      } else {
        highTotal++;
        if (failed) highFails++;
      }
    }

    const totalTasks = rows.length;
    const avgSwitches = Math.round((totalSwitches / totalTasks) * 10) / 10;
    const lowSwitchFailRate = lowTotal > 0 ? lowFails / lowTotal : 0;
    const highSwitchFailRate = highTotal > 0 ? highFails / highTotal : 0;

    return {
      totalTasks,
      avgSwitches,
      lowSwitchTotal: lowTotal,
      lowSwitchFailures: lowFails,
      lowSwitchFailRate,
      highSwitchTotal: highTotal,
      highSwitchFailures: highFails,
      highSwitchFailRate,
    };
  } catch {
    // The stats cannot be read: the caller reads no metrics rather than a false zero.
    return null;
  }
}

/**
 * Morning line for the wall morning summary.
 */
export function skillSwitchMorningLine(
  db: Db,
  now: number = Date.now(),
  windowMs: number = 24 * 3_600_000,
): string | null {
  const stats = getSkillSwitchStats(db, now - windowMs, now);
  if (!stats || stats.totalTasks === 0) return null;

  const lowPct = Math.round(stats.lowSwitchFailRate * 100);
  const highPct = Math.round(stats.highSwitchFailRate * 100);

  return `Метрика переключения навыков: оценено ${stats.totalTasks} задач, в среднем ${stats.avgSwitches} переключений (провал: ${lowPct}% при 0-1 переключениях vs ${highPct}% при 2+).`;
}
