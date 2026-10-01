import type { MemoryCandidate } from "@lane-pilot/memory-core";
import type { InsightsDatabase } from "./routing-stats";

export type LessonSource =
  | { kind: "night_finding"; runId: string; taskId: string; severity: "blocking" | "warning"; path: string; finding: string; suggestedFix: string; at: number }
  | { kind: "rejection"; runId: string; taskId: string; stage: string; reason: string; at: number }
  | { kind: "attempt_failure"; runId: string; taskId: string; reason: string; at: number };

type ReceiptRow = { run_id: string; task_id: string; stage_id: string; state: string; result_json: string | null; reason: string | null; updated_at: number };
type AttemptRow = { run_id: string; task_id: string; reason: string | null; updated_at: number };

const LESSON_STAGES = ["night-review", "acceptance-receipt", "verification", "code-critique", "plan-critique"] as const;
// `needs_human:` is a question for the owner about one task, not a mistake the next writer should avoid.
const NOISE = /retry limit|attempts exhausted|canceled by|thread deleted|plugin reload|^needs_human:/i;

function nightFindings(row: ReceiptRow): LessonSource[] {
  if (!row.result_json) return [];
  try {
    const result = JSON.parse(row.result_json) as { findings?: Array<{ severity?: unknown; path?: unknown; finding?: unknown; suggestedFix?: unknown }> };
    return (result.findings ?? []).flatMap((item) => {
      if ((item.severity !== "blocking" && item.severity !== "warning") || typeof item.path !== "string" || typeof item.finding !== "string") return [];
      return [{ kind: "night_finding" as const, runId: row.run_id, taskId: row.task_id, severity: item.severity, path: item.path, finding: item.finding, suggestedFix: typeof item.suggestedFix === "string" ? item.suggestedFix : "", at: row.updated_at }];
    });
  } catch {
    return [];
  }
}

/** Receipts and attempt reasons a project can learn from, newest first. */
export function collectLessonSources(db: InsightsDatabase, filter: { projectId: string; since: number; limit?: number }): LessonSource[] {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 2000);
  const receipts = db.prepare(`SELECT s.run_id, s.task_id, s.stage_id, s.state, s.result_json, s.reason, s.updated_at
    FROM lane_pilot_stage_receipt s JOIN lane_pilot_run r ON r.id=s.run_id
    WHERE r.project_id=? AND s.updated_at>=? AND s.stage_id IN (${LESSON_STAGES.map(() => "?").join(",")})
    ORDER BY s.updated_at DESC LIMIT ?`).all(filter.projectId, filter.since, ...LESSON_STAGES, limit) as ReceiptRow[];
  const attempts = db.prepare(`SELECT a.run_id, a.task_id, a.reason, a.updated_at
    FROM lane_pilot_attempt a JOIN lane_pilot_run r ON r.id=a.run_id
    WHERE r.project_id=? AND a.updated_at>=? AND a.state IN ('failed','blocked','rejected','validation_failed') AND a.reason IS NOT NULL
    ORDER BY a.updated_at DESC LIMIT ?`).all(filter.projectId, filter.since, limit) as AttemptRow[];
  const sources: LessonSource[] = [];
  for (const row of receipts) {
    if (row.stage_id === "night-review") sources.push(...nightFindings(row));
    else if ((row.state === "failed" || row.state === "blocked") && row.reason && !NOISE.test(row.reason)) {
      sources.push({ kind: "rejection", runId: row.run_id, taskId: row.task_id, stage: row.stage_id, reason: row.reason, at: row.updated_at });
    }
  }
  for (const row of attempts) {
    if (row.reason && !NOISE.test(row.reason)) sources.push({ kind: "attempt_failure", runId: row.run_id, taskId: row.task_id, reason: row.reason, at: row.updated_at });
  }
  return sources.sort((a, b) => b.at - a.at);
}

function pathConcepts(path: string): string[] {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  const dirs = parts.slice(0, -1).slice(0, 3);
  const file = parts.at(-1)?.replace(/\.[a-z0-9]+$/i, "");
  return [...dirs, ...(file ? [file] : [])].map((part) => part.toLowerCase());
}

const clip = (text: string, max: number) => text.replace(/\s+/g, " ").trim().slice(0, max);

/**
 * Lessons are `note` records phrased as a rule for the next writer, not as a log line. Two sources
 * that produce the same text collapse into one candidate.
 */
export function lessonCandidates(sources: readonly LessonSource[]): MemoryCandidate[] {
  const seen = new Set<string>();
  const result: MemoryCandidate[] = [];
  for (const source of sources) {
    let content: string;
    let concepts: string[];
    if (source.kind === "night_finding") {
      content = `Night review (${source.severity}) in ${source.path}: ${clip(source.finding, 600)}${source.suggestedFix ? ` Fix: ${clip(source.suggestedFix, 400)}` : ""}`;
      concepts = ["lesson", "night-review", source.severity, ...pathConcepts(source.path)];
    } else if (source.kind === "rejection") {
      content = `${source.stage} rejected a writer result: ${clip(source.reason, 800)}`;
      concepts = ["lesson", source.stage, "rejected"];
    } else {
      content = `A writer attempt failed: ${clip(source.reason, 800)}`;
      concepts = ["lesson", "attempt", "failed"];
    }
    const key = content.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({ kind: "note", content, concepts: [...new Set(concepts)].slice(0, 24) });
  }
  return result;
}
