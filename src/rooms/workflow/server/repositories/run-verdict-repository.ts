import type { OwnerRefusalReason, RunVerdict, RunVerdictSource } from "@lane-pilot/contracts";

type VerdictStmt = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type RunVerdictDb = {
  prepare(sql: string): VerdictStmt;
};

export type RunVerdictRow = {
  runId: string;
  workflowId: string;
  graphVersion: number;
  verdict: RunVerdict;
  source: RunVerdictSource;
  reason: OwnerRefusalReason | null;
  note: string | null;
  decidedAt: number;
};

export type SetRunVerdictInput = {
  runId: string;
  workflowId: string;
  graphVersion: number;
  verdict: RunVerdict;
  source: RunVerdictSource;
  reason?: OwnerRefusalReason | null | undefined;
  note?: string | null | undefined;
  decidedAt?: number | undefined;
};

export type RunVerdictPort = (input: SetRunVerdictInput) => void | Promise<void>;

const verdictPorts = new WeakMap<object, Set<RunVerdictPort>>();

/** Registers a post-write verdict listener scoped to `db`; returns an unsubscribe handle. */
export function registerRunVerdictPort(db: RunVerdictDb, port: RunVerdictPort): () => void {
  let ports = verdictPorts.get(db as object);
  if (!ports) {
    ports = new Set();
    verdictPorts.set(db as object, ports);
  }
  ports.add(port);
  return () => {
    ports?.delete(port);
  };
}

const NOTE_MAX = 2000;

function mapVerdictRow(row: Record<string, unknown>): RunVerdictRow {
  return {
    runId: String(row.run_id),
    workflowId: String(row.workflow_id),
    graphVersion: Number(row.graph_version),
    verdict: String(row.verdict) as RunVerdict,
    source: String(row.source) as RunVerdictSource,
    reason: (row.reason as OwnerRefusalReason | null) ?? null,
    note: (row.note as string | null) ?? null,
    decidedAt: Number(row.decided_at),
  };
}

/**
 * Persists a verdict for a workflow run.
 * An `owner` verdict overrides `human_node` and prior `owner` verdicts; `human_node` never overrides `owner`.
 */
export function setRunVerdict(
  db: RunVerdictDb,
  input: SetRunVerdictInput,
  options?: { onVerdict?: RunVerdictPort },
): { written: boolean } {
  const note = input.note?.trim() ? input.note.trim().slice(0, NOTE_MAX) : null;
  const reason = input.reason ?? null;
  const decidedAt = input.decidedAt ?? Date.now();
  const result = db.prepare(
    `INSERT INTO lane_pilot_wf_run_verdict
      (run_id, workflow_id, graph_version, verdict, source, reason, note, decided_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(run_id) DO UPDATE SET
       workflow_id = excluded.workflow_id,
       graph_version = excluded.graph_version,
       verdict = excluded.verdict,
       source = excluded.source,
       reason = excluded.reason,
       note = excluded.note,
       decided_at = excluded.decided_at
     WHERE excluded.source = 'owner' OR lane_pilot_wf_run_verdict.source <> 'owner'`,
  ).run(
    input.runId,
    input.workflowId,
    input.graphVersion,
    input.verdict,
    input.source,
    reason,
    note,
    decidedAt,
  );
  const written = result.changes > 0;
  if (written) {
    const notify = (port: RunVerdictPort) => {
      try {
        void Promise.resolve(port(input)).catch(() => undefined);
      } catch {
        // Post-verdict hooks must not fail verdict persistence.
      }
    };
    if (options?.onVerdict) notify(options.onVerdict);
    const registered = verdictPorts.get(db as object);
    if (registered) {
      for (const port of registered) notify(port);
    }
  }
  return { written };
}

/** Reads the verdict for a run, or `null` when unreviewed. */
export function getRunVerdict(db: RunVerdictDb, runId: string): RunVerdictRow | null {
  const row = db.prepare(
    `SELECT run_id, workflow_id, graph_version, verdict, source, reason, note, decided_at
     FROM lane_pilot_wf_run_verdict
     WHERE run_id = ?`,
  ).get(runId) as Record<string, unknown> | undefined;
  return row ? mapVerdictRow(row) : null;
}

/** Lists run verdicts filtered by optional workflowId and since epoch ms, newest first. */
export function listRunVerdicts(
  db: RunVerdictDb,
  filter: { workflowId?: string | undefined; since?: number | undefined; limit?: number | undefined } = {},
): RunVerdictRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.workflowId) {
    where.push("workflow_id = ?");
    params.push(filter.workflowId);
  }
  if (filter.since !== undefined) {
    where.push("decided_at >= ?");
    params.push(filter.since);
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 500, 2000));
  params.push(limit);
  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(
    `SELECT run_id, workflow_id, graph_version, verdict, source, reason, note, decided_at
     FROM lane_pilot_wf_run_verdict
     ${whereClause}
     ORDER BY decided_at DESC, run_id ASC
     LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map(mapVerdictRow);
}
