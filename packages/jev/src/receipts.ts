import type Database from "better-sqlite3";

/**
 * One row per judgment asked (or skipped): what was decided and by whom, the answers as probabilities, whether it went on to
 * a stronger judge, and how long it took. The state itself is never stored, only its hash and size. `outcome` is filled
 * later (the escalated judge agreed or not) and is the label the thresholds are calibrated on.
 * Appended to the plugin's migrations (append only).
 */
export const jevMigrations: string[] = [
  `CREATE TABLE lane_pilot_jev_receipt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    judgment TEXT NOT NULL,
    version INTEGER NOT NULL,
    model TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('shadow','active')),
    project_id TEXT,
    run_id TEXT,
    subject TEXT,
    input_sha256 TEXT NOT NULL,
    input_chars INTEGER NOT NULL,
    questions INTEGER NOT NULL,
    batch_size INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL CHECK(status IN ('ok','disabled','timeout','error','breaker_open','budget','invalid')),
    answers_json TEXT,
    decision TEXT,
    decided_by TEXT NOT NULL CHECK(decided_by IN ('jev','fallback','escalated')),
    escalated_to TEXT,
    thresholds_json TEXT,
    latency_ms INTEGER,
    tokens_in INTEGER,
    tokens_out INTEGER,
    outcome TEXT,
    outcome_at INTEGER,
    at INTEGER NOT NULL
  )`,
  `CREATE INDEX lane_pilot_jev_receipt_j ON lane_pilot_jev_receipt(judgment, at)`,
  `CREATE INDEX lane_pilot_jev_receipt_p ON lane_pilot_jev_receipt(project_id, at)`,
  `CREATE INDEX lane_pilot_jev_receipt_r ON lane_pilot_jev_receipt(run_id)`,
];

export type JevReceipt = {
  judgment: string; version: number; model?: string | null; mode: "shadow" | "active";
  projectId?: string | null; runId?: string | null; subject?: string | null;
  inputSha256: string; inputChars: number; questions: number; batchSize?: number;
  status: "ok" | "disabled" | "timeout" | "error" | "breaker_open" | "budget" | "invalid";
  answers?: unknown; decision?: string | null; decidedBy: "jev" | "fallback" | "escalated"; escalatedTo?: string | null; thresholds?: unknown;
  latencyMs?: number | null; tokensIn?: number | null; tokensOut?: number | null; at?: number;
};

const KEEP_ROWS = 50_000;
const KEEP_MS = 30 * 24 * 3600_000;

export function insertReceipt(db: Database.Database, receipt: JevReceipt): number {
  const at = receipt.at ?? Date.now();
  const row = db.prepare(`INSERT INTO lane_pilot_jev_receipt (judgment,version,model,mode,project_id,run_id,subject,input_sha256,input_chars,questions,batch_size,status,answers_json,decision,decided_by,escalated_to,thresholds_json,latency_ms,tokens_in,tokens_out,at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    receipt.judgment, receipt.version, receipt.model ?? null, receipt.mode, receipt.projectId ?? null, receipt.runId ?? null, receipt.subject ?? null,
    receipt.inputSha256, receipt.inputChars, receipt.questions, receipt.batchSize ?? 1, receipt.status,
    receipt.answers === undefined ? null : JSON.stringify(receipt.answers), receipt.decision ?? null, receipt.decidedBy, receipt.escalatedTo ?? null,
    receipt.thresholds === undefined ? null : JSON.stringify(receipt.thresholds), receipt.latencyMs ?? null, receipt.tokensIn ?? null, receipt.tokensOut ?? null, at);
  // Roughly one receipt in a hundred also prunes: a row count and an age bound, like the check-duration table.
  if (Number(row.lastInsertRowid) % 100 === 0) pruneReceipts(db, at);
  return Number(row.lastInsertRowid);
}

export function recordOutcome(db: Database.Database, id: number, outcome: string, at = Date.now()): void {
  db.prepare("UPDATE lane_pilot_jev_receipt SET outcome=?, outcome_at=? WHERE id=?").run(outcome, at, id);
}

export function pruneReceipts(db: Database.Database, now = Date.now()): void {
  db.prepare("DELETE FROM lane_pilot_jev_receipt WHERE at < ?").run(now - KEEP_MS);
  db.prepare("DELETE FROM lane_pilot_jev_receipt WHERE id <= (SELECT id FROM lane_pilot_jev_receipt ORDER BY id DESC LIMIT 1 OFFSET ?)").run(KEEP_ROWS);
}

export type JevReceiptSummary = { judgment: string; mode: string; status: string; decided_by: string; n: number; avg_latency_ms: number | null; avg_tokens_in: number | null };

/** The query of the evaluation (section 7): counts, latency and tokens by judgment, mode, status and who decided. */
export function summarizeReceipts(db: Database.Database, sinceMs = 0): JevReceiptSummary[] {
  return db.prepare(`SELECT judgment, mode, status, decided_by, count(*) AS n, round(avg(latency_ms)) AS avg_latency_ms, round(avg(tokens_in)) AS avg_tokens_in
    FROM lane_pilot_jev_receipt WHERE at >= ? GROUP BY 1,2,3,4 ORDER BY 1,2,3,4`).all(sinceMs) as JevReceiptSummary[];
}
