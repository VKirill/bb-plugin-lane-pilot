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
  // NOTE: appended statements belong at the END of `migrations` in src/rooms/migrations.ts (index-locked), not here.
];

export type JevReceipt = {
  judgment: string; version: number; model?: string | null; mode: "shadow" | "active";
  projectId?: string | null; runId?: string | null; subject?: string | null;
  inputSha256: string; inputChars: number; questions: number; batchSize?: number;
  status: "ok" | "disabled" | "timeout" | "error" | "breaker_open" | "budget" | "invalid";
  answers?: unknown; decision?: string | null; decidedBy: "jev" | "fallback" | "escalated"; escalatedTo?: string | null; thresholds?: unknown;
  latencyMs?: number | null; tokensIn?: number | null; tokensOut?: number | null; at?: number;
  /** Top-level state field names and their serialized sizes — never the content (audit requirement: the watch sees what left). */
  fields?: Record<string, number>;
  /** The judgment's input as JSON, already redacted. Stored only for the sampled receipts (one in five, `sampledInput`), capped at 8 KB. */
  inputJson?: string | null;
};

const KEEP_ROWS = 50_000;
const KEEP_MS = 30 * 24 * 3600_000;

export const INPUT_JSON_CAP = 8 * 1024;
export const INPUT_JSON_TRUNC = "…[truncated]";

/**
 * One receipt in five keeps its input (deterministic on the input hash, so a repeated state either always or never lands
 * in the sample): the nightly model relabeler re-renders the judgment's questions from it. Capped at 8 KB; a longer input
 * is cut with a marker and `input_json` then holds JSON that may not parse — the labeler skips what it cannot parse.
 */
export function sampledInput(inputSha256: string, text: string | null | undefined): string | null {
  if (!text) return null;
  if (Number.parseInt(inputSha256.slice(0, 8), 16) % 5 !== 0) return null;
  return text.length > INPUT_JSON_CAP ? `${text.slice(0, INPUT_JSON_CAP - INPUT_JSON_TRUNC.length)}${INPUT_JSON_TRUNC}` : text;
}

export function insertReceipt(db: Database.Database, receipt: JevReceipt): number {
  const at = receipt.at ?? Date.now();
  const row = db.prepare(`INSERT INTO lane_pilot_jev_receipt (judgment,version,model,mode,project_id,run_id,subject,input_sha256,input_chars,questions,batch_size,status,answers_json,decision,decided_by,escalated_to,thresholds_json,latency_ms,tokens_in,tokens_out,fields_json,input_json,at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    receipt.judgment, receipt.version, receipt.model ?? null, receipt.mode, receipt.projectId ?? null, receipt.runId ?? null, receipt.subject ?? null,
    receipt.inputSha256, receipt.inputChars, receipt.questions, receipt.batchSize ?? 1, receipt.status,
    receipt.answers === undefined ? null : JSON.stringify(receipt.answers), receipt.decision ?? null, receipt.decidedBy, receipt.escalatedTo ?? null,
    receipt.thresholds === undefined ? null : JSON.stringify(receipt.thresholds), receipt.latencyMs ?? null, receipt.tokensIn ?? null, receipt.tokensOut ?? null,
    receipt.fields === undefined ? null : JSON.stringify(receipt.fields), sampledInput(receipt.inputSha256, receipt.inputJson), at);
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

// ---- outcome-sweep reads: the unlabeled receipts a judgment's sweep labels, and the labeled sample a gate counts ----

/** Unlabeled decided receipts of a judgment made by Jev itself (the route workflow sweep). */
export function unlabeledJevReceipts(db: Database.Database, judgment: string): Array<{ id: number; run_id: string | null; decision: string; at: number }> {
  return db.prepare(`SELECT id, run_id, decision, at FROM lane_pilot_jev_receipt
    WHERE judgment = ? AND outcome IS NULL AND status = 'ok' AND decided_by = 'jev' AND decision IS NOT NULL`)
    .all(judgment) as Array<{ id: number; run_id: string | null; decision: string; at: number }>;
}

/** Unlabeled decided receipts of a judgment that carry a subject (the plan-fact sweep). */
export function unlabeledSubjectReceipts(db: Database.Database, judgment: string): Array<{ id: number; run_id: string | null; subject: string | null }> {
  return db.prepare(`SELECT r.id, r.run_id, r.subject FROM lane_pilot_jev_receipt r
    WHERE r.judgment = ? AND r.outcome IS NULL AND r.status = 'ok' AND r.decision IS NOT NULL`)
    .all(judgment) as Array<{ id: number; run_id: string | null; subject: string | null }>;
}

/** Unlabeled receipts a Jev-decided judgment pinned to a run and a subject (the writer-model sweep). */
export function unlabeledJevSubjectReceipts(db: Database.Database, judgment: string): Array<{ id: number; run_id: string; subject: string }> {
  return db.prepare(`SELECT id, run_id, subject FROM lane_pilot_jev_receipt
    WHERE judgment = ? AND outcome IS NULL AND status = 'ok' AND decided_by = 'jev' AND decision IS NOT NULL
      AND run_id IS NOT NULL AND subject IS NOT NULL`)
    .all(judgment) as Array<{ id: number; run_id: string; subject: string }>;
}

/** Unlabeled decided receipts of a judgment with their run ids (the caller filters by the run's own state). */
export function unlabeledRunReceipts(db: Database.Database, judgment: string): Array<{ id: number; run_id: string | null; decision: string }> {
  return db.prepare(`SELECT id, run_id, decision FROM lane_pilot_jev_receipt
    WHERE judgment = ? AND outcome IS NULL AND status = 'ok' AND decision IS NOT NULL`)
    .all(judgment) as Array<{ id: number; run_id: string | null; decision: string }>;
}

/** The labeled outcomes of a judgment (the live gate's agree/disagree sample). */
export function labeledOutcomes(db: Database.Database, judgment: string): string[] {
  return (db.prepare(`SELECT outcome FROM lane_pilot_jev_receipt WHERE judgment=? AND status='ok' AND outcome IS NOT NULL AND decision IS NOT NULL`)
    .all(judgment) as Array<{ outcome: string }>).map((row) => row.outcome);
}

/** How many receipts a judgment has written (the report's call count). */
export function countJudgmentReceipts(db: Database.Database, judgment: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM lane_pilot_jev_receipt WHERE judgment=?`).get(judgment) as { n: number }).n;
}

/** plan.fact receipts Jev decided itself (the CLI's blind-read comparison reads the stage side itself). */
export function listPlanFactJevReceipts(db: Database.Database): Array<{ id: number; run_id: string; subject: string; decision: string | null }> {
  return db.prepare(`SELECT id, run_id, subject, decision FROM lane_pilot_jev_receipt
    WHERE judgment = 'plan.fact' AND status = 'ok' AND decided_by = 'jev'`).all() as Array<{ id: number; run_id: string; subject: string; decision: string | null }>;
}

export function jevDecisionCounts(db: Database.Database, judgment: string, since: number): Array<{ decision: string; n: number }> {
  return db.prepare("SELECT decision, count(*) AS n FROM lane_pilot_jev_receipt WHERE judgment=? AND at>=? AND decision IS NOT NULL GROUP BY decision")
    .all(judgment, since) as Array<{ decision: string; n: number }>;
}

export function jevCostStats(db: Database.Database, judgment: string, since: number): { n: number; tin: number | null; ms: number | null } {
  return db.prepare(`SELECT count(*) AS n, sum(tokens_in) AS tin, avg(latency_ms) AS ms FROM lane_pilot_jev_receipt WHERE judgment=? AND at>=?`)
    .get(judgment, since) as { n: number; tin: number | null; ms: number | null };
}

export function jevReceiptDecision(db: Database.Database, id: number): string | null {
  return (db.prepare("SELECT decision FROM lane_pilot_jev_receipt WHERE id=?").get(id) as { decision: string | null } | undefined)?.decision ?? null;
}

export function jevMaturedJudgmentCount(db: Database.Database): number {
  return (db.prepare(`SELECT judgment, COUNT(*) AS n FROM lane_pilot_jev_receipt WHERE outcome IS NOT NULL AND (outcome LIKE 'agree%' OR outcome LIKE 'disagree%') GROUP BY judgment HAVING n >= 50`)
    .all() as Array<{ judgment: string }>).length;
}

export function listJevRebenchReceipts(db: Database.Database, judgments: readonly string[], since: number, projectId?: string | null): Array<{
  id: number; judgment: string; decision: string | null; decided_by: string; model: string | null; subject: string | null; project_id: string | null; outcome: string | null; run_id: string | null;
}> {
  return db.prepare(`
    SELECT r.id, r.judgment, r.decision, r.decided_by, r.model, r.subject, r.project_id, r.outcome, r.run_id
    FROM lane_pilot_jev_receipt r
    WHERE r.judgment IN (${judgments.map(() => "?").join(",")}) AND r.at >= ? ${projectId ? "AND r.project_id = ?" : ""}
    ORDER BY r.at DESC
  `).all(...judgments, since, ...(projectId ? [projectId] : [])) as Array<{
    id: number; judgment: string; decision: string | null; decided_by: string; model: string | null; subject: string | null; project_id: string | null; outcome: string | null; run_id: string | null;
  }>;
}
