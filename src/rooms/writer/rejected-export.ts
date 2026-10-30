import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { redactKnownDeep } from "@lane-pilot/kit";

export type Db = Pick<Database.Database, "prepare" | "transaction">;

export type RejectedTrajectoryEntry = {
  timestamp: number;
  isoDate: string;
  attemptId: string;
  taskId: string;
  runId: string | null;
  projectId: string;
  state: string;
  reason: string | null;
  task: {
    id: string;
    title: string;
    objective?: string;
    acceptance: readonly string[];
    owns_paths: readonly string[];
  };
  verdict: {
    state: string;
    reason?: string | null;
    failureClass?: string | null;
  };
  transcript: {
    events?: unknown[];
    summary?: string;
  };
};

export type RecordRejectedInput = {
  attemptId: string;
  taskId: string;
  runId?: string | null;
  projectId: string;
  state: string;
  reason?: string | null;
  task?: unknown;
  failureClass?: string | null;
  events?: readonly unknown[];
  output?: unknown;
  now?: number;
};

const clip = (text: string | null | undefined, max: number): string =>
  text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : "";

/**
 * Records an unverified or rejected writer attempt into the database.
 * No files are written on the server.
 * All secrets are strictly stripped via `redactKnownDeep`.
 */
export function recordRejectedTrajectory(
  db: Db,
  input: RecordRejectedInput,
): { id: string; bytes: number } | null {
  const now = input.now ?? Date.now();
  const taskObj = (input.task && typeof input.task === "object" ? input.task : {}) as Record<string, unknown>;

  const rawEntry: RejectedTrajectoryEntry = {
    timestamp: now,
    isoDate: new Date(now).toISOString(),
    attemptId: input.attemptId,
    taskId: input.taskId,
    runId: input.runId ?? null,
    projectId: input.projectId,
    state: input.state,
    reason: input.reason ?? null,
    task: {
      id: String(taskObj.id ?? input.taskId),
      title: clip(String(taskObj.title ?? ""), 300),
      objective: clip(String(taskObj.objective ?? ""), 1_000),
      acceptance: Array.isArray(taskObj.acceptance) ? taskObj.acceptance.map((a) => clip(String(a), 300)) : [],
      owns_paths: Array.isArray(taskObj.owns_paths) ? taskObj.owns_paths.map((p) => clip(String(p), 200)) : [],
    },
    verdict: {
      state: input.state,
      reason: clip(input.reason, 1_000),
      failureClass: input.failureClass ?? null,
    },
    transcript: {
      events: (input.events ?? []).slice(0, 50),
      summary: clip(typeof input.output === "string" ? input.output : JSON.stringify(input.output ?? ""), 2_000),
    },
  };

  // Strictly redact all secrets and sensitive credentials
  const sanitized = redactKnownDeep(rawEntry);
  const jsonStr = JSON.stringify(sanitized);
  const bytes = Buffer.byteLength(jsonStr, "utf8");
  const id = `rjt_${randomUUID().slice(0, 12)}`;

  try {
    db.prepare(`
      INSERT OR REPLACE INTO lane_pilot_rejected_trajectory
        (id, attempt_id, task_id, run_id, project_id, state, trajectory_json, bytes, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.attemptId,
      input.taskId,
      input.runId ?? null,
      input.projectId,
      input.state,
      jsonStr,
      bytes,
      now,
    );
    return { id, bytes };
  } catch {
    return null;
  }
}

/**
 * Reads rejected trajectories from database and exports as JSONL.
 * Writes to outputPath on the caller's machine if specified, or returns lines.
 */
export async function exportRejectedTrajectories(
  db: Db,
  options: {
    sinceMs?: number;
    projectId?: string;
    outputPath?: string;
  } = {},
): Promise<{ count: number; bytes: number; content: string; outputPath?: string }> {
  const since = options.sinceMs ?? 0;
  const rows = options.projectId
    ? db.prepare(`
        SELECT trajectory_json, bytes
        FROM lane_pilot_rejected_trajectory
        WHERE recorded_at >= ? AND project_id = ?
        ORDER BY recorded_at ASC
      `).all(since, options.projectId) as Array<{ trajectory_json: string; bytes: number }>
    : db.prepare(`
        SELECT trajectory_json, bytes
        FROM lane_pilot_rejected_trajectory
        WHERE recorded_at >= ?
        ORDER BY recorded_at ASC
      `).all(since) as Array<{ trajectory_json: string; bytes: number }>;

  const lines = rows.map((r) => r.trajectory_json).join("\n") + (rows.length ? "\n" : "");
  const totalBytes = Buffer.byteLength(lines, "utf8");

  if (options.outputPath) {
    await mkdir(dirname(options.outputPath), { recursive: true });
    await writeFile(options.outputPath, lines, "utf8");
  }

  return {
    count: rows.length,
    bytes: totalBytes,
    content: lines,
    ...(options.outputPath ? { outputPath: options.outputPath } : {}),
  };
}

export type RejectedTrajectoriesSummary = {
  count: number;
  totalBytes: number;
  kb: number;
};

export function getRejectedTrajectoriesSummary(
  db: Db,
  sinceMs: number = 0,
  now: number = Date.now(),
): RejectedTrajectoriesSummary | null {
  try {
    const row = db.prepare(`
      SELECT
        COUNT(*) as count,
        COALESCE(SUM(bytes), 0) as total_bytes
      FROM lane_pilot_rejected_trajectory
      WHERE recorded_at >= ? AND recorded_at <= ?
    `).get(sinceMs, now) as { count: number; total_bytes: number } | undefined;

    if (!row || row.count === 0) return null;
    return {
      count: row.count,
      totalBytes: row.total_bytes,
      kb: Math.round(row.total_bytes / 1024),
    };
  } catch {
    return null;
  }
}

/**
 * Morning line for the wall morning summary.
 */
export function rejectedTrajectoriesMorningLine(
  db: Db,
  now: number = Date.now(),
  windowMs: number = 24 * 3_600_000,
): string | null {
  const summary = getRejectedTrajectoriesSummary(db, now - windowMs, now);
  if (!summary || summary.count === 0) return null;
  return `Экспорт отклонённых траекторий: сохранено ${summary.count} траекторий (${summary.kb} КБ, без секретов).`;
}

export const WRITER_USAGE = "bb lane-pilot writer trajectories export [--since <iso|ms>] [--out <path>] [--project <id>]";

export async function runWriterCli(
  db: Db,
  args: string[],
): Promise<{ exitCode: number; stdout?: string; stderr?: string }> {
  const [sub, action, ...rest] = args;
  if (sub === "trajectories" && action === "export") {
    let sinceMs = 0;
    let outputPath: string | undefined;
    let projectId: string | undefined;

    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === "--since" && rest[i + 1]) {
        const val = rest[++i]!;
        sinceMs = isNaN(Number(val)) ? Date.parse(val) : Number(val);
      } else if (arg === "--out" && rest[i + 1]) {
        outputPath = rest[++i];
      } else if (arg === "--project" && rest[i + 1]) {
        projectId = rest[++i];
      }
    }

    try {
      const result = await exportRejectedTrajectories(db, { sinceMs, projectId, outputPath });
      if (outputPath) {
        return {
          exitCode: 0,
          stdout: `Exported ${result.count} rejected trajectories (${result.bytes} bytes) to ${outputPath}`,
        };
      }
      return { exitCode: 0, stdout: result.content };
    } catch (cause) {
      return { exitCode: 1, stderr: `failed to export trajectories: ${cause instanceof Error ? cause.message : String(cause)}` };
    }
  }

  return { exitCode: 1, stderr: `usage: ${WRITER_USAGE}` };
}
