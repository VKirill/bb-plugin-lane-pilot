import { randomUUID } from "node:crypto";
import { extractSkillSequence } from "../../../contracts";
import type Database from "better-sqlite3";
import { recordSkillMetric } from "../../../storage";
export type Db = Pick<Database.Database, "prepare" | "transaction">;
import { calculateSkillSwitches, type SkillSwitchRecord } from "../../models/skill-switch";

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
