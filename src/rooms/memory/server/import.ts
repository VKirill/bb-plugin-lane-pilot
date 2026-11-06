import { redactKnown, sha256Hex } from "@lane-pilot/kit";
import { maskPii, scrubQuote } from "../../anamnesis";
import { memoryTokens, relevantRecords, sameSubject, searchMemoryRecords, storeMemoryRecords,
  type MemoryCandidate, type MemoryDatabase, type MemorySettings } from "@lane-pilot/memory-core";

/**
 * M1: one door for the old memory stores (BB memory, Claude Code auto-memory, the agentmemory archive).
 * Every JSONL line passes the same mask and the same store write path as an agent write; the report is the receipt.
 */

export const MEMORY_IMPORT_SOURCES = ["bb-memory", "claude-files", "agentmemory"] as const;
export type MemoryImportSource = (typeof MEMORY_IMPORT_SOURCES)[number];

export const MEMORY_IMPORT_USAGE = [
  "scripts/memory-import.sh <bb-memory|claude-files|agentmemory> <jsonl> <project-id> [--dry-run]   (RPC memory_import; the report lands next to the jsonl)",
  "scripts/memory-import.sh eval <report.json>   (RPC memory_import_eval)",
].join("\n");

/** Source kinds the collectors emit, mapped to the tag the store keeps in concepts (`kind:<value>`; the store's own kind stays `note`). */
const KIND_MAP: Record<string, string> = {
  user: "preference", feedback: "rule", project: "fact", reference: "fact",
  process: "procedure", decision: "fact", procedure: "procedure", fact: "fact", preference: "preference", rule: "rule",
};

const MAX_ENTRY_BYTES = 64_000;
const MASK_MAX_CHARS = 64_000;
const TOO_SHORT_CHARS = 20;
const MAX_CONCEPTS = 24;

/** A line that only points at code or history the repo already records is not a fact worth a slot. */
const POINTER_ONLY = /^(?:(?:see|см\.?|see also|ref|reference)\s+)?(?:https?:\/\/\S+|~?\/[\w.@~+/-]+|(?:[\w.@-]+\/)+[\w.@-]+|[0-9a-f]{7,40})$/i;

const isPointerOnly = (text: string) => !text.includes("\n") && text.length <= 300 && POINTER_ONLY.test(text.trim());

/** The same mask chain an agent write passes: known secrets, quote scrub, PII. */
export function maskImportContent(content: string): string {
  return maskPii(scrubQuote(redactKnown(content), MASK_MAX_CHARS)).text;
}

const toEpochMs = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === "string" && value.trim()) { const parsed = Date.parse(value); return Number.isNaN(parsed) ? null : parsed; }
  return null;
};

const normalizeConcepts = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim().toLowerCase()).filter(Boolean).map((item) => item.slice(0, 100)))].slice(0, MAX_CONCEPTS - 1);
};

export type ImportOutcome = {
  line: number; source_id: string;
  outcome: "added" | "merged_with" | "dropped";
  id?: string; reason?: string;
  /** The mapped source kind (`preference`, `rule`, `fact`, `procedure`), kept as concept `kind:<value>`. */
  kind?: string;
  concepts?: string[];
  /** The masked content, kept so import-eval can build questions without re-reading the store. */
  content?: string;
  /** The collector's own origin string (machine:path, bb:project:id), kept in the report only. */
  origin?: string;
  superseded?: string[];
  created_at?: number | null;
};

export type ImportReport = {
  source: MemoryImportSource; projectId: string; generatedAt: number; dryRun: boolean;
  counts: { added: number; merged_with: number; dropped: number };
  byReason: Record<string, number>;
  /** Existing notes the budget made room for, and replacements held for a person — the store's own receipts. */
  evictedIds: string[]; heldIds: string[];
  outcomes: ImportOutcome[];
};

const DRY_RUN = Symbol("dry-run");

function dropReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/credential/.test(message)) return "secret";
  if (/instruction override/.test(message)) return "instruction_to_reader";
  if (/budget exceeded|64000 byte/.test(message)) return "oversize";
  return "rejected";
}

type ActiveRow = { id: string; kind: string; content: string; concepts_json: string; valid_from: number | null; created_at: number };

const activeRows = (db: MemoryDatabase, projectId: string): ActiveRow[] =>
  db.prepare("SELECT id,kind,content,concepts_json,valid_from,created_at FROM lane_pilot_memory WHERE project_id=? AND status='active'")
    .all(projectId) as ActiveRow[];

/** A source record older than the fact already stored must not replace it: the store stamps writes with now, so the claim date travels in valid_from. */
function staleSuperseded(rows: ActiveRow[], entry: { content: string; concepts: string[] }, createdAt: number | null): boolean {
  if (createdAt == null) return false;
  return rows.some((row) => (row.valid_from ?? row.created_at) > createdAt
    && row.kind === "note"
    && sameSubject(entry, { content: row.content, concepts: JSON.parse(row.concepts_json) as string[] }));
}

export type MemoryImportOptions = {
  db: MemoryDatabase; projectId: string; source: MemoryImportSource; jsonl: string;
  settings: MemorySettings;
  dryRun?: boolean; now?: number;
};

/**
 * Import one JSONL file of `{source_id, content, kind?, concepts?, created_at?, origin?}` lines.
 * Exactly one outcome per line; the whole run is one transaction, so `--dry-run` computes the real outcomes and rolls every write back.
 */
export function runMemoryImport(options: MemoryImportOptions): ImportReport {
  const { db, projectId, source, settings } = options;
  const now = options.now ?? Date.now();
  const personalBot = settings.personalBot;
  const outcomes: ImportOutcome[] = [];
  const evictedIds: string[] = [];
  const heldIds: string[] = [];
  const budgets = { coreBudget: settings.coreBudget, noteBudget: settings.noteBudget, indexBudget: settings.indexBudget };
  const lineOrigin = (line: Record<string, unknown>) => typeof line.origin === "string" && line.origin.trim() ? line.origin.trim() : undefined;

  const importLine = (line: Record<string, unknown>, index: number) => {
    const sourceId = typeof line.source_id === "string" ? line.source_id.trim() : "";
    const createdAt = toEpochMs(line.created_at);
    const origin = lineOrigin(line);
    const base: Omit<ImportOutcome, "outcome"> = { line: index + 1, source_id: sourceId || `line-${index + 1}`, created_at: createdAt, ...(origin ? { origin } : {}) };
    if (!sourceId) return { ...base, outcome: "dropped" as const, reason: "invalid" };
    if (typeof line.content !== "string" || !line.content.trim()) return { ...base, outcome: "dropped" as const, reason: "empty" };

    const masked = maskImportContent(line.content);
    if (!masked.trim()) return { ...base, outcome: "dropped" as const, reason: "empty" };
    if (isPointerOnly(masked)) return { ...base, outcome: "dropped" as const, reason: "not_a_fact" };
    if (masked.length < TOO_SHORT_CHARS) return { ...base, outcome: "dropped" as const, reason: "too_short" };
    if (Buffer.byteLength(masked, "utf8") > MAX_ENTRY_BYTES) return { ...base, outcome: "dropped" as const, reason: "oversize" };

    const kind = typeof line.kind === "string" ? KIND_MAP[line.kind.trim().toLowerCase()] : undefined;
    const concepts = [...normalizeConcepts(line.concepts), ...(kind ? [`kind:${kind}`] : [])].slice(0, MAX_CONCEPTS);
    const entry: MemoryCandidate = { kind: "note", content: masked, concepts,
      sourceFileId: `import:${source}:${sourceId}`, ...(createdAt != null ? { validFrom: createdAt } : {}) };

    if (createdAt != null && staleSuperseded(activeRows(db, projectId), entry, createdAt)) return { ...base, outcome: "dropped" as const, reason: "stale_superseded", kind, concepts, content: masked };

    try {
      const result = storeMemoryRecords(db, { projectId, personalBot, audience: "subagent",
        sourceSha256: sha256Hex(`import:${source}:${sourceId}`), entries: [entry], scope: [],
        trust: "confirmed", origin: "import", now, ...budgets });
      evictedIds.push(...result.evictedIds);
      heldIds.push(...result.heldIds);
      const shared = { kind, concepts, content: masked };
      if (result.insertedIds.length) return { ...base, ...shared, outcome: "added" as const, id: result.insertedIds[0],
        ...(result.supersededIds.length ? { superseded: result.supersededIds } : {}) };
      if (result.corroboratedIds.length) return { ...base, ...shared, outcome: "merged_with" as const, id: result.corroboratedIds[0]! };
      return { ...base, ...shared, outcome: "dropped" as const, reason: "duplicate" };
    } catch (cause) {
      return { ...base, outcome: "dropped" as const, reason: dropReason(cause), kind, concepts, content: masked };
    }
  };

  const work = () => {
    for (const [index, raw] of options.jsonl.split("\n").entries()) {
      const text = raw.trim();
      if (!text) continue;
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { outcomes.push({ line: index + 1, source_id: `line-${index + 1}`, outcome: "dropped", reason: "invalid" }); continue; }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) { outcomes.push({ line: index + 1, source_id: `line-${index + 1}`, outcome: "dropped", reason: "invalid" }); continue; }
      outcomes.push(importLine(parsed as Record<string, unknown>, index));
    }
    if (options.dryRun) throw DRY_RUN;
  };

  try { db.transaction(work).immediate(); }
  catch (cause) { if (cause !== DRY_RUN) throw cause; }

  const counts = { added: 0, merged_with: 0, dropped: 0 };
  const byReason: Record<string, number> = {};
  for (const outcome of outcomes) {
    counts[outcome.outcome]++;
    if (outcome.reason) byReason[outcome.reason] = (byReason[outcome.reason] ?? 0) + 1;
  }
  return { source, projectId, generatedAt: now, dryRun: options.dryRun === true, counts, byReason, evictedIds, heldIds, outcomes };
}

/** Plain-Russian one-line summary for the owner; reasons stay English `word` tokens for the log. */
export function formatImportSummary(report: ImportReport): string {
  const reasons = Object.entries(report.byReason).sort((a, b) => b[1] - a[1]).map(([reason, n]) => `${reason} ${n}`).join(", ");
  const dry = report.dryRun ? " (прогон всухую, ничего не записано)" : "";
  return `Импорт ${report.source}${dry}: добавлено ${report.counts.added}, объединено ${report.counts.merged_with}, пропущено ${report.counts.dropped}${reasons ? ` (${reasons})` : ""}.`;
}

/* ---- import-eval: the 30+10 gate set (§6 gate 3) ---- */

export type ImportEvalResult = {
  projectId: string; source: string; evaluatedAt: number;
  questions: number; hits: number; silentQuestions: number; silent: number;
  results: Array<{ source_id: string; id: string; query: string; hit: boolean }>;
  silentResults: Array<{ query: string; empty: boolean }>;
};

/** The PM path's search, exactly as pmMemoryContext runs it: ranked records, then the relevance floor, top 5. */
export function pmTopIds(db: MemoryDatabase, projectId: string, query: string, settings: MemorySettings): string[] {
  const records = searchMemoryRecords(db, projectId, query, 100, settings.searchEngine, settings.audience, settings.personalBot, { chain: [] });
  return relevantRecords(db, projectId, query, records, { audience: settings.audience, personalBot: settings.personalBot, floor: settings.queryFloor === false ? null : undefined }).slice(0, 5).map((record) => record.id);
}

const evalQuery = (outcome: ImportOutcome): string | null => {
  if (!outcome.content) return null;
  const words = memoryTokens(outcome.content).slice(0, 3);
  if (!words.length) return null;
  const concept = outcome.concepts?.find((item) => !item.startsWith("kind:")) ?? outcome.concepts?.[0];
  return [concept, ...words].filter(Boolean).join(" ");
};

/**
 * Count how many imported records the PM search can still find, and that absent-word questions stay silent.
 * `topIds` is injectable so the counting logic is testable on a fake store.
 */
export function evalMemoryImport(report: ImportReport, topIds: (query: string) => string[], now = Date.now()): ImportEvalResult {
  const picked = report.outcomes.filter((outcome) => (outcome.outcome === "added" || outcome.outcome === "merged_with") && outcome.id);
  const sample = picked.slice(0, 30);
  const results = sample.flatMap((outcome) => {
    const query = evalQuery(outcome);
    if (!query) return [];
    return [{ source_id: outcome.source_id, id: outcome.id!, query, hit: topIds(query).includes(outcome.id!) }];
  });
  // Words that cannot be in the corpus: a nonce per question. Under the floor the honest answer is «nothing».
  const silentResults = Array.from({ length: 10 }, (_, index) => {
    const query = `zzq${index}xjv ${"qw" + index}plugh ${"zx" + index}vbn`;
    return { query, empty: topIds(query).length === 0 };
  });
  return { projectId: report.projectId, source: report.source, evaluatedAt: now,
    questions: results.length, hits: results.filter((row) => row.hit).length,
    silentQuestions: silentResults.length, silent: silentResults.filter((row) => row.empty).length,
    results, silentResults };
}

export function formatImportEval(result: ImportEvalResult): string {
  return `hit ${result.hits}/${result.questions}, silent ${result.silent}/${result.silentQuestions}`;
}
