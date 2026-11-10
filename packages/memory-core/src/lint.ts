import { estimateTokens, memoryContentIssue } from "./candidates";
import { filesDrifted, pathsNamed } from "./fingerprint";
import { idleSql, sameSubject } from "./lifecycle";
import { memoryIndexStatus, memoryWithoutTrace } from "./store";
import { conflictTableReady } from "./conflict-store";
import type { MemoryDatabase } from "./store";

/**
 * The deterministic checker of the whole memory layer (SMA k_lib_lint / k_v_lint / m_lint): an array of tiered
 * checks over the stored corpus, not the write door. `lintMemory` runs all of them and returns one stable,
 * sorted report; `reviewMemory` reads the same corpus and only collects proposals — it writes nothing.
 */
export type LintTier = "error" | "warn" | "info";
export type LintFinding = { check: string; tier: LintTier; recordId?: string; detail: string };
export type LintContext = { now: number; readFile?: (path: string) => Uint8Array | null; budgets: { coreBudget: number; noteBudget: number; indexBudget: number } };
export type LintCheck = { id: string; tier: LintTier; run(db: MemoryDatabase, projectId: string | undefined, ctx: LintContext): LintFinding[] };

type ActiveRow = { id: string; project_id: string; kind: string; content: string; concepts_json: string; origin: string | null;
  source_sha256: string | null; origin_task_id: string | null; valid_until: number | null; file_fingerprint: string | null; scope_json: string | null };

const activeRows = (db: MemoryDatabase, projectId?: string): ActiveRow[] =>
  db.prepare(`SELECT id, project_id, kind, content, concepts_json, origin, source_sha256, origin_task_id, valid_until, file_fingerprint, scope_json
    FROM lane_pilot_memory WHERE status='active'${projectId ? " AND project_id=?" : ""}`).all(...(projectId ? [projectId] : [])) as ActiveRow[];

const finding = (check: LintCheck, detail: string, recordId?: string): LintFinding => ({ check: check.id, tier: check.tier, detail, ...(recordId ? { recordId } : {}) });

const check = (id: string, tier: LintTier, run: LintCheck["run"]): LintCheck => ({ id, tier, run });

export const LINT_CHECKS: LintCheck[] = [
  // The write-door refusals, applied to what is already stored (a record planted before them, or by a broken door).
  check("secret", "error", (db, projectId) => activeRows(db, projectId)
    .filter((row) => { const issue = memoryContentIssue(row.content); return issue !== null && /credential/.test(issue); })
    .map((row) => ({ check: "secret", tier: "error" as const, recordId: row.id, detail: "stored content appears to contain a credential" }))),
  check("injection", "error", (db, projectId) => activeRows(db, projectId)
    .filter((row) => { const issue = memoryContentIssue(row.content); return issue !== null && /instruction override/.test(issue); })
    .map((row) => ({ check: "injection", tier: "error" as const, recordId: row.id, detail: "stored content talks to the assistant as an instruction override" }))),
  // No way back to where the fact came from (SMA m_lint): memoryWithoutTrace is the one definition. A warning: older records
  // predate the origin_task_id column and an owner or import record has none, so it must never make `memory lint` exit 1.
  check("no_trace", "warn", (db, projectId) => memoryWithoutTrace(db, projectId)
    .map((row) => ({ check: "no_trace", tier: "warn" as const, recordId: row.id, detail: `${row.id.slice(0, 12)} ${row.content.slice(0, 80)}` }))),
  check("dated", "warn", (db, projectId, ctx) => activeRows(db, projectId)
    .filter((row) => row.valid_until !== null && row.valid_until <= ctx.now)
    .map((row) => ({ check: "dated", tier: "warn" as const, recordId: row.id, detail: "active record past its valid_until" }))),
  check("idle", "info", (db, projectId, ctx) => {
    const sql = `SELECT id FROM lane_pilot_memory WHERE status='active'${projectId ? " AND project_id=?" : ""} AND ${idleSql("lane_pilot_memory", ctx.now)}`;
    return (db.prepare(sql).all(...(projectId ? [projectId] : [])) as Array<{ id: string }>)
      .map((row) => ({ check: "idle", tier: "info" as const, recordId: row.id, detail: "note nobody was given for 90 days" }));
  }),
  // A pointer to a record that no longer exists: a replacement name or a conflict side left dangling.
  check("broken_link", "error", (db, projectId) => {
    const out: LintFinding[] = [];
    const where = projectId ? " AND project_id=?" : "";
    const args = projectId ? [projectId] : [];
    const missing = db.prepare(`SELECT id, superseded_by FROM lane_pilot_memory WHERE superseded_by IS NOT NULL${where}
      AND NOT EXISTS (SELECT 1 FROM lane_pilot_memory target WHERE target.id=lane_pilot_memory.superseded_by)`).all(...args) as Array<{ id: string; superseded_by: string }>;
    for (const row of missing) out.push({ check: "broken_link", tier: "error", recordId: row.id, detail: `superseded_by ${row.superseded_by.slice(0, 12)} which is missing` });
    if (conflictTableReady(db)) {
      const dangling = db.prepare(`SELECT id FROM lane_pilot_memory_conflict WHERE 1=1${where} AND (
        NOT EXISTS (SELECT 1 FROM lane_pilot_memory m WHERE m.id=lane_pilot_memory_conflict.note_a)
        OR NOT EXISTS (SELECT 1 FROM lane_pilot_memory m WHERE m.id=lane_pilot_memory_conflict.note_b))`).all(...args) as Array<{ id: string }>;
      for (const row of dangling) out.push({ check: "broken_link", tier: "error", recordId: row.id, detail: "conflict names a record that is missing" });
    }
    return out;
  }),
  check("file_drift", "warn", (db, projectId, ctx) => ctx.readFile ? activeRows(db, projectId)
    .filter((row) => filesDrifted(row.file_fingerprint, pathsNamed(row.content), ctx.readFile!))
    .map((row) => ({ check: "file_drift", tier: "warn" as const, recordId: row.id, detail: "a file the note names no longer matches its stored fingerprint" })) : []),
  check("duplicate", "warn", (db, projectId) => {
    const seen = new Map<string, { id: string }>();
    const out: LintFinding[] = [];
    for (const row of activeRows(db, projectId)) {
      const key = `${row.project_id}\0${row.kind}\0${row.content.trim().replace(/\s+/g, " ").toLowerCase()}`;
      const first = seen.get(key);
      if (first) out.push({ check: "duplicate", tier: "warn", recordId: row.id, detail: `same normalized content as ${first.id.slice(0, 12)}` });
      else seen.set(key, row);
    }
    return out;
  }),
  check("bad_scope", "warn", (db, projectId) => activeRows(db, projectId)
    .filter((row) => { try { const v = JSON.parse(row.scope_json ?? "[]") as unknown; return !(Array.isArray(v) && v.every((item) => typeof item === "string")); } catch { return true; } })
    .map((row) => ({ check: "bad_scope", tier: "warn" as const, recordId: row.id, detail: "scope_json is not a list of section names" }))),
  check("budget", "warn", (db, projectId, ctx) => {
    let core = 0, note = 0;
    for (const row of activeRows(db, projectId)) { const t = estimateTokens(row.content); if (row.kind === "core") core += t; else note += t; }
    const out: LintFinding[] = [];
    if (core > ctx.budgets.coreBudget) out.push({ check: "budget", tier: "warn", detail: `core ${core}/${ctx.budgets.coreBudget} tokens` });
    if (note > ctx.budgets.noteBudget) out.push({ check: "budget", tier: "warn", detail: `notes ${note}/${ctx.budgets.noteBudget} tokens` });
    if (core + note > ctx.budgets.indexBudget) out.push({ check: "budget", tier: "warn", detail: `index ${core + note}/${ctx.budgets.indexBudget} tokens` });
    return out;
  }),
  // Index drift, the read side of rebuildMemoryIndexes: active rows an index lost and rows it still serves though the record is hidden.
  check("index_drift", "error", (db, projectId) => {
    const status = memoryIndexStatus(db, projectId);
    const out: LintFinding[] = [];
    if (status.missingIds.length) out.push({ check: "index_drift", tier: "error", detail: `fts missing ${status.missingIds.length} active id(s): ${status.missingIds.map((id) => id.slice(0, 12)).join(", ")}` });
    if (status.orphanedIds.length) out.push({ check: "index_drift", tier: "error", detail: `fts serves ${status.orphanedIds.length} id(s) with no active record: ${status.orphanedIds.map((id) => id.slice(0, 12)).join(", ")}` });
    return out;
  }),
];

const TIER_ORDER: Record<LintTier, number> = { error: 0, warn: 1, info: 2 };

/**
 * Runs every check of LINT_CHECKS and returns the findings in one stable order: error before warn before info,
 * then by check id, then by record id — the same corpus always reports the same list.
 */
export function lintMemory(db: MemoryDatabase, projectId?: string, ctx: Partial<LintContext> = {}): LintFinding[] {
  const full: LintContext = { now: ctx.now ?? Date.now(), readFile: ctx.readFile, budgets: ctx.budgets ?? { coreBudget: 3072, noteBudget: 24000, indexBudget: 65536 } };
  const findings = LINT_CHECKS.flatMap((item) => {
    try { return item.run(db, projectId, full); }
    catch (cause) { return [finding(item, `check failed: ${cause instanceof Error ? cause.message : String(cause)}`)]; }
  });
  return findings.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || a.check.localeCompare(b.check) || (a.recordId ?? "").localeCompare(b.recordId ?? ""));
}

export type ReviewProposal = { action: "supersede" | "expire"; id: string; by?: string; reason?: string };

/**
 * The corpus review (SMA k_lib_consolidate): SELECT-only, collects what a person may want to do — same-subject
 * twins to merge, idle or dated notes to expire — and writes nothing. Sorted like the lint report.
 * ponytail: same-subject pairs are found by an O(n²) scan of note pairs sharing a concept; the corpus is ~1k rows.
 */
export function reviewMemory(db: MemoryDatabase, projectId?: string, now = Date.now()): ReviewProposal[] {
  const rows = activeRows(db, projectId);
  const notes = rows.filter((row) => row.kind === "note")
    .map((row) => { let concepts: string[] = []; try { concepts = JSON.parse(row.concepts_json) as string[]; } catch { /* no tags */ } return { row, concepts }; });
  const proposals: ReviewProposal[] = [];
  for (let a = 0; a < notes.length; a++) {
    for (let b = a + 1; b < notes.length; b++) {
      const one = notes[a]!, two = notes[b]!;
      if (one.row.project_id !== two.row.project_id) continue;
      if (!one.concepts.some((concept) => two.concepts.includes(concept))) continue;
      if (!sameSubject({ content: one.row.content, concepts: one.concepts }, { content: two.row.content, concepts: two.concepts })) continue;
      proposals.push({ action: "supersede", id: one.row.id, by: two.row.id, reason: "same subject" });
    }
  }
  const idle = db.prepare(`SELECT id FROM lane_pilot_memory WHERE status='active'${projectId ? " AND project_id=?" : ""} AND ${idleSql("lane_pilot_memory", now)}`)
    .all(...(projectId ? [projectId] : [])) as Array<{ id: string }>;
  for (const row of idle) proposals.push({ action: "expire", id: row.id, reason: "idle" });
  for (const row of rows) if (row.valid_until !== null && row.valid_until <= now) proposals.push({ action: "expire", id: row.id, reason: "dated" });
  return proposals.sort((a, b) => a.action.localeCompare(b.action) || a.id.localeCompare(b.id));
}

export { memoryWithoutTrace };
