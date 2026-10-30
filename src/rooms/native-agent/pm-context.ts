import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { redactKnownDeep } from "@lane-pilot/kit";

export type Db = Pick<Database.Database, "prepare" | "transaction">;

export const PM_CONTEXT_MAX_CHARS = 2000;

export type PmContextTask = {
  id: string;
  title: string;
  state: string;
};

export type PmContextRule = {
  id: string;
  text: string;
};

export type PmContextWall = {
  classKey: string;
  failureClass: string;
  reasonNorm: string;
};

export type PmContextData = {
  projectId: string;
  activeRunId?: string | null;
  runObjective?: string | null;
  acceptedTasks: PmContextTask[];
  openTasks: PmContextTask[];
  activeRules: PmContextRule[];
  openWalls: PmContextWall[];
  now?: number;
};

const clip = (text: string | null | undefined, max: number): string =>
  text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : "";

/**
 * Builds concise, structured Markdown content for context.md.
 * Designed per CLM pattern (arXiv 2609.37725) to provide the PM with verbatim
 * project context without requiring per-turn LLM re-summarization.
 */
export function buildPmContextContent(data: PmContextData): {
  content: string;
  sectionsCount: number;
  bytes: number;
} {
  const sections: string[] = [];

  sections.push(`# Project Context: ${data.projectId}`);

  // 1. Active State
  const activeLines = [
    `Run: ${data.activeRunId || "none"}`,
    `Objective: ${clip(data.runObjective || "none", 300)}`,
  ];
  sections.push(`## Active State\n${activeLines.join("\n")}`);

  // 2. Recent Accepted Tasks
  const acceptedLines = data.acceptedTasks.length
    ? data.acceptedTasks.map((t) => `- ${t.id}: ${clip(t.title, 120)} (accepted)`)
    : ["- (none recently)"];
  sections.push(`## Recent Accepted Tasks\n${acceptedLines.join("\n")}`);

  // 3. Open Tasks & Blockers
  const openLines = data.openTasks.length
    ? data.openTasks.map((t) => `- ${t.id}: ${clip(t.title, 120)} [${t.state}]`)
    : ["- (all current tasks accepted)"];
  sections.push(`## Open Tasks & Blockers\n${openLines.join("\n")}`);

  // 4. Memory & Rules
  if (data.activeRules.length) {
    const ruleLines = data.activeRules.map((r) => `- [${r.id}] ${clip(r.text, 200)}`);
    sections.push(`## Active Project Rules\n${ruleLines.join("\n")}`);
  }

  // 5. Open Walls
  if (data.openWalls.length) {
    const wallLines = data.openWalls.map((w) => `- ${w.failureClass}: ${clip(w.reasonNorm, 160)}`);
    sections.push(`## Open Failure Classes\n${wallLines.join("\n")}`);
  }

  const content = sections.join("\n\n") + "\n";
  const bytes = Buffer.byteLength(content, "utf8");

  return {
    content,
    sectionsCount: sections.length,
    bytes,
  };
}

/**
 * Compiles context.md content directly from the database for a given project.
 */
export function compilePmContextFromDb(
  db: Db,
  projectId: string,
  now = Date.now(),
): { content: string; sectionsCount: number; bytes: number } {
  // 1. Active run
  const runRow = db.prepare(`
    SELECT id, objective FROM lane_pilot_run
    WHERE project_id = ? AND state = 'running'
    ORDER BY created_at DESC LIMIT 1
  `).get(projectId) as { id: string; objective: string | null } | undefined;

  const titleOf = (raw: string | null | undefined): string => {
    if (!raw) return "";
    try {
      const parsed = JSON.parse(raw);
      return String(parsed.title ?? parsed.display_title ?? parsed.objective ?? "");
    } catch {
      return "";
    }
  };

  // 2. Recent accepted tasks
  const acceptedRows = db.prepare(`
    SELECT t.id, t.contract_json
    FROM lane_pilot_task t
    JOIN lane_pilot_run r ON r.id = t.run_id
    WHERE r.project_id = ? AND EXISTS (
      SELECT 1 FROM lane_pilot_attempt a WHERE a.task_id = t.id AND a.state = 'accepted'
    )
    ORDER BY t.created_at DESC LIMIT 5
  `).all(projectId) as Array<{ id: string; contract_json: string }>;

  // 3. Open or failed tasks
  const openRows = db.prepare(`
    SELECT t.id, t.contract_json, COALESCE(
      (SELECT a.state FROM lane_pilot_attempt a WHERE a.task_id = t.id ORDER BY a.created_at DESC LIMIT 1),
      'pending'
    ) as state
    FROM lane_pilot_task t
    JOIN lane_pilot_run r ON r.id = t.run_id
    WHERE r.project_id = ? AND NOT EXISTS (
      SELECT 1 FROM lane_pilot_attempt a WHERE a.task_id = t.id AND a.state = 'accepted'
    )
    ORDER BY t.created_at DESC LIMIT 5
  `).all(projectId) as Array<{ id: string; contract_json: string; state: string }>;

  // 4. Memory rules (if table exists)
  let ruleRows: Array<{ id: string; text: string }> = [];
  try {
    ruleRows = db.prepare(`
      SELECT id, text FROM lane_pilot_memory
      WHERE project_id = ? AND audience IN ('pm', 'both') AND (state = 'active' OR state IS NULL)
      ORDER BY created_at DESC LIMIT 5
    `).all(projectId) as Array<{ id: string; text: string }>;
  } catch {
    ruleRows = [];
  }

  // 5. Open walls
  let wallRows: Array<{ classKey: string; failureClass: string; reasonNorm: string }> = [];
  try {
    const rawWalls = db.prepare(`
      SELECT class_key, failure_class, reason_norm
      FROM lane_pilot_wall_class
      WHERE state = 'open'
      ORDER BY last_seen DESC LIMIT 5
    `).all() as Array<{ class_key: string; failure_class: string; reason_norm: string }>;
    wallRows = rawWalls.map((w) => ({
      classKey: w.class_key,
      failureClass: w.failure_class,
      reasonNorm: w.reason_norm,
    }));
  } catch {
    wallRows = [];
  }

  return buildPmContextContent({
    projectId,
    activeRunId: runRow?.id ?? null,
    runObjective: runRow?.objective ?? null,
    acceptedTasks: acceptedRows.map((r) => ({ id: r.id, title: titleOf(r.contract_json), state: "accepted" })),
    openTasks: openRows.map((r) => ({ id: r.id, title: titleOf(r.contract_json), state: r.state })),
    activeRules: ruleRows.map((r) => ({ id: r.id, text: r.text })),
    openWalls: wallRows.map((w) => ({ classKey: w.classKey, failureClass: w.failureClass, reasonNorm: w.reasonNorm })),
    now,
  });
}

/**
 * Saves context.md directly into the database table `lane_pilot_pm_context`.
 * No files are written to the project workspace.
 */
export function savePmContext(
  db: Db,
  projectId: string,
  now = Date.now(),
): { bytes: number; sectionsCount: number } {
  const { content, sectionsCount, bytes } = compilePmContextFromDb(db, projectId, now);
  const sanitized = redactKnownDeep(content);

  try {
    db.prepare(`
      INSERT OR REPLACE INTO lane_pilot_pm_context
        (project_id, context_md, bytes, sections_count, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(projectId, sanitized, bytes, sectionsCount, now);
  } catch {
    // Non-blocking
  }

  return { bytes, sectionsCount };
}

/**
 * Reads stored context_md from the database table for PM prompt assembly.
 */
export function getStoredPmContext(db: Db, projectId: string): string | null {
  try {
    const row = db.prepare(`
      SELECT context_md FROM lane_pilot_pm_context WHERE project_id = ?
    `).get(projectId) as { context_md: string } | undefined;
    return row?.context_md ?? null;
  } catch {
    return null;
  }
}

/**
 * Formats context.md text for inclusion in the PM prompt:
 * Enforces a strict ceiling of <= 2000 characters with an explicit truncation note,
 * and strips secrets using `redactKnownDeep`.
 */
export function formatPmContextSection(rawContext: string | null | undefined): string {
  if (!rawContext) return "";
  const sanitized = redactKnownDeep(rawContext).trim();
  if (!sanitized) return "";

  if (sanitized.length <= PM_CONTEXT_MAX_CHARS) {
    return sanitized;
  }

  const notice = "\n... [truncated to 2000 chars]";
  const head = sanitized.slice(0, PM_CONTEXT_MAX_CHARS - notice.length).trimEnd();
  return head + notice;
}

export type PmContextSummary = {
  projectsCount: number;
  totalBytes: number;
  avgKb: number;
};

export function getPmContextSummary(
  db: Db,
  sinceMs: number = 0,
  now: number = Date.now(),
): PmContextSummary | null {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(DISTINCT project_id) as projects,
        COALESCE(SUM(bytes), 0) as total_bytes
      FROM lane_pilot_pm_context
      WHERE updated_at >= ? AND updated_at <= ?
    `).get(sinceMs, now) as { projects: number; total_bytes: number } | undefined;

    if (!row || row.projects === 0) return null;
    return {
      projectsCount: row.projects,
      totalBytes: row.total_bytes,
      avgKb: Math.max(1, Math.round(row.total_bytes / row.projects / 1024)),
    };
  } catch {
    return null;
  }
}

/**
 * Morning line for the wall morning summary.
 */
export function pmContextMorningLine(
  db: Db,
  now: number = Date.now(),
  windowMs: number = 24 * 3_600_000,
): string | null {
  const summary = getPmContextSummary(db, now - windowMs, now);
  if (!summary || summary.projectsCount === 0) return null;
  return `PM context.md: обновлён для ${summary.projectsCount} проектов (в среднем ${summary.avgKb} КБ).`;
}
