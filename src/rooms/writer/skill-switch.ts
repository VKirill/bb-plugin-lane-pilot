import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

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
 * Extracts the sequence of skill invocations in chronological order from thread events or tool pairs.
 * If no explicit skill events are present, falls back to the provided candidate/assigned skills.
 */
export function extractSkillSequence(
  events: readonly unknown[] = [],
  fallbackSkills: readonly string[] = [],
): string[] {
  const sequence: string[] = [];

  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const item = (event.data as { item?: Record<string, unknown> } | undefined)?.item ?? event;
    const type = String(item.type ?? "");
    const name = String(item.tool ?? item.name ?? "");

    // Direct skill tool invocations (e.g., skill({ id: "..." }))
    if (name === "skill" || name.endsWith(".skill") || type === "skill") {
      const input = (item.input ?? item.arguments ?? item.params ?? {}) as Record<string, unknown>;
      const skillId = typeof input.id === "string" ? input.id
        : typeof input.name === "string" ? input.name
        : typeof input.skill === "string" ? input.skill
        : null;
      if (skillId && skillId.trim()) {
        sequence.push(skillId.trim().toLowerCase());
        continue;
      }
    }

    // Check if tool name belongs to a known skill prefix
    if (name.includes("::") || name.includes(":")) {
      const prefix = name.split(/[:]/)[0]!.trim().toLowerCase();
      if (prefix && prefix !== "builtin" && prefix !== "tools" && prefix.length > 2) {
        sequence.push(prefix);
      }
    }
  }

  if (!sequence.length && fallbackSkills.length) {
    return [...fallbackSkills.map((s) => s.trim().toLowerCase())];
  }

  return sequence;
}

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
    db.prepare(`
      INSERT OR REPLACE INTO lane_pilot_skill_metric
        (id, attempt_id, task_id, run_id, project_id, skill_count, switch_count, skills_json, outcome, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.attemptId,
      record.taskId,
      record.runId,
      record.projectId,
      record.skillCount,
      record.switchCount,
      record.skillsJson,
      record.outcome,
      record.recordedAt,
    );
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
    const rows = db.prepare(`
      SELECT switch_count, outcome
      FROM lane_pilot_skill_metric
      WHERE recorded_at >= ? AND recorded_at <= ?
    `).all(sinceMs, now) as Array<{ switch_count: number; outcome: string }>;

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
