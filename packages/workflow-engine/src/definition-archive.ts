import type Database from "better-sqlite3";
import { parseWorkflowObject, type Workflow } from "./schema";

/** Appended to the plugin's migrations (append only): archived workflow revisions so pinned subworkflows stay resolvable. */
export const workflowDefinitionArchiveMigrations: string[] = [
  `CREATE TABLE lane_pilot_wf_definition (workflow_id TEXT NOT NULL, version INTEGER NOT NULL, definition_sha256 TEXT NOT NULL, definition_json TEXT NOT NULL, scope TEXT NOT NULL, archived_at INTEGER NOT NULL, PRIMARY KEY (workflow_id, version, definition_sha256))`,
];

export type ArchiveLogger = {
  debug?: (message: string) => void;
  warn?: (message: string) => void;
};

export type ArchiveDefinitionInput = {
  workflowId: string;
  version: number;
  sha: string;
  json: string;
  scope: string;
  archivedAt?: number;
};

export type ArchiveOptions = {
  log?: ArchiveLogger;
  bestEffort?: boolean;
};

const INSERT_SQL = `INSERT OR IGNORE INTO lane_pilot_wf_definition (workflow_id, version, definition_sha256, definition_json, scope, archived_at)
  VALUES (?, ?, ?, ?, ?, ?)`;

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** Archives a single workflow revision (idempotent via INSERT OR IGNORE). */
export function archiveDefinition(
  db: Database.Database,
  input: ArchiveDefinitionInput,
  options?: ArchiveOptions,
): boolean {
  try {
    const result = db.prepare(INSERT_SQL).run(
      input.workflowId,
      input.version,
      input.sha,
      input.json,
      input.scope,
      input.archivedAt ?? Date.now(),
    );
    if (result.changes > 0) {
      options?.log?.debug?.(`wf.archive wf=${input.workflowId} v=${input.version} sha=${input.sha.slice(0, 8)}`);
    }
    return result.changes > 0;
  } catch (cause) {
    options?.log?.warn?.(`wf.archive write failed wf=${input.workflowId}: ${errorMessage(cause)}`);
    if (!options?.bestEffort) throw cause;
    return false;
  }
}

/** Archives many workflow definitions in one transaction (used for built-ins at startup). */
export function archiveDefinitionBatch(
  db: Database.Database,
  entries: readonly ArchiveDefinitionInput[],
  options?: ArchiveOptions,
): number {
  if (!entries.length) return 0;
  let written = 0;
  try {
    const stmt = db.prepare(INSERT_SQL);
    const now = Date.now();
    db.transaction(() => {
      for (const entry of entries) {
        const result = stmt.run(entry.workflowId, entry.version, entry.sha, entry.json, entry.scope, entry.archivedAt ?? now);
        if (result.changes > 0) {
          written += 1;
          options?.log?.debug?.(`wf.archive wf=${entry.workflowId} v=${entry.version} sha=${entry.sha.slice(0, 8)}`);
        }
      }
    })();
    return written;
  } catch (cause) {
    options?.log?.warn?.(`wf.archive write failed wf=${entries[0]!.workflowId}: ${errorMessage(cause)}`);
    if (!options?.bestEffort) throw cause;
    return written;
  }
}

/** Returns the newest archived definition for `(workflowId, version)`, or null when absent/unreadable. */
export function archivedDefinition(db: Database.Database, workflowId: string, version: number): Workflow | null {
  if (!(db as { open?: boolean }).open) return null;
  try {
    const row = db.prepare(
      `SELECT definition_json FROM lane_pilot_wf_definition
       WHERE workflow_id = ? AND version = ?
       ORDER BY archived_at DESC, rowid DESC
       LIMIT 1`,
    ).get(workflowId, version) as { definition_json: string } | undefined;
    if (!row) return null;
    const parsed = parseWorkflowObject(JSON.parse(row.definition_json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type HubDefinitionRow = {
  workflowId: string;
  version: number;
  sha256: string;
  definitionJson: string;
  scope: string;
  archivedAt: number;
};

/**
 * Returns the newest archived revision per `workflow_id` whose `scope !== 'builtin'`.
 * Covers published non-built-in graphs and hub-evolved revisions of built-in graphs.
 */
export function listLatestHubDefinitions(db: Database.Database): HubDefinitionRow[] {
  if (!(db as { open?: boolean }).open) return [];
  const hasTable = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='lane_pilot_wf_definition'")
    .get();
  if (!hasTable) return [];
  const rows = db
    .prepare(
      `SELECT workflow_id, version, definition_sha256, definition_json, scope, archived_at
       FROM lane_pilot_wf_definition
       ORDER BY workflow_id ASC, version DESC, archived_at DESC, rowid DESC`,
    )
    .all() as Array<{
      workflow_id: string;
      version: number;
      definition_sha256: string;
      definition_json: string;
      scope: string;
      archived_at: number;
    }>;
  const seen = new Set<string>();
  const latest: HubDefinitionRow[] = [];
  for (const row of rows) {
    if (seen.has(row.workflow_id)) continue;
    seen.add(row.workflow_id);
    if (row.scope === "builtin") continue;
    latest.push({
      workflowId: row.workflow_id,
      version: row.version,
      sha256: row.definition_sha256,
      definitionJson: row.definition_json,
      scope: row.scope,
      archivedAt: row.archived_at,
    });
  }
  return latest;
}
