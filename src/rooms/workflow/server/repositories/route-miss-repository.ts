import { isKnownGraphCategory } from "@lane-pilot/contracts";
import { maskCredentials, redactSecrets, sha256Hex } from "@lane-pilot/kit";
import { normalizeText, type MissKind } from "@lane-pilot/workflow-engine";

type RouteMissStmt = {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
};

export type RouteMissDb = {
  prepare(sql: string): RouteMissStmt;
};

export type RouteMissLogSink = {
  debug?: ((message: string) => void) | undefined;
  warn?: ((message: string) => void) | undefined;
};

export type RouteMissSource = "pm_route" | "errand_route";

export type RecordRouteMissInput = {
  projectId?: string | null | undefined;
  source: RouteMissSource;
  kind: MissKind;
  brief: string;
  topWorkflowId?: string | null | undefined;
  confidence?: number | null | undefined;
  category?: string | null | undefined;
  secrets?: Iterable<string> | undefined;
  now?: number | undefined;
};

export type RouteMissRow = {
  missId: string;
  projectId: string | null;
  source: RouteMissSource;
  kind: MissKind;
  briefHash: string;
  briefExcerpt: string;
  topWorkflowId: string | null;
  confidence: number | null;
  category: string | null;
  createdAt: number;
};

const EXCERPT_MAX = 200;

/** Records one catalog miss idempotently per (source, normalized brief, UTC day). */
export function recordRouteMiss(
  db: RouteMissDb,
  input: RecordRouteMissInput,
  log?: RouteMissLogSink,
): { recorded: boolean; missId: string } | null {
  try {
    const explicitMasked = input.secrets ? redactSecrets(input.brief, input.secrets) : input.brief;
    const redacted = maskCredentials(explicitMasked).text;
    const briefHash = sha256Hex(normalizeText(redacted));
    const briefExcerpt = redacted.slice(0, EXCERPT_MAX);
    const now = input.now ?? Date.now();
    const day = new Date(now).toISOString().slice(0, 10);
    const missId = sha256Hex(`${input.source}|${briefHash}|${day}`);
    const topWorkflowId = input.topWorkflowId?.trim() || null;
    const confidence = input.confidence !== null && input.confidence !== undefined && Number.isFinite(input.confidence)
      ? Math.round(input.confidence)
      : null;
    const category = input.category && isKnownGraphCategory(input.category) ? input.category : null;

    const result = db.prepare(
      `INSERT OR IGNORE INTO lane_pilot_route_miss
        (miss_id, project_id, source, kind, brief_hash, brief_excerpt, top_workflow_id, confidence, category, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      missId,
      input.projectId ?? null,
      input.source,
      input.kind,
      briefHash,
      briefExcerpt,
      topWorkflowId,
      confidence,
      category,
      now,
    );

    log?.debug?.(`route miss kind=${input.kind} source=${input.source} top=${topWorkflowId ?? "none"} conf=${confidence ?? "none"}`);
    return { recorded: result.changes > 0, missId };
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    log?.warn?.(`route miss write failed: ${message}`);
    return null;
  }
}

/** Lists recorded catalog misses since the given epoch ms, newest first. */
export function listRouteMisses(
  db: RouteMissDb,
  filter: { since: number; projectId?: string | null | undefined; limit?: number | undefined },
): RouteMissRow[] {
  const where = ["created_at >= ?"];
  const params: unknown[] = [filter.since];
  if (filter.projectId) {
    where.push("project_id = ?");
    params.push(filter.projectId);
  }
  const limit = Math.max(1, Math.min(filter.limit ?? 500, 2000));
  params.push(limit);
  const rows = db.prepare(
    `SELECT miss_id, project_id, source, kind, brief_hash, brief_excerpt, top_workflow_id, confidence, category, created_at
     FROM lane_pilot_route_miss
     WHERE ${where.join(" AND ")}
     ORDER BY created_at DESC, miss_id ASC
     LIMIT ?`,
  ).all(...params) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    missId: String(row.miss_id),
    projectId: (row.project_id as string | null) ?? null,
    source: String(row.source) as RouteMissSource,
    kind: String(row.kind) as MissKind,
    briefHash: String(row.brief_hash),
    briefExcerpt: String(row.brief_excerpt),
    topWorkflowId: (row.top_workflow_id as string | null) ?? null,
    confidence: row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    category: (row.category as string | null) ?? null,
    createdAt: Number(row.created_at),
  }));
}
