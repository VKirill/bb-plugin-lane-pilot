import { estimateTokens, memoryContext, searchMemoryRecords, storeMemoryRecords, type MemoryAudience, type MemoryCandidate, type MemoryKind, type MemoryTrust } from "@lane-pilot/memory-core";
import type { LanePilotDatabase } from "../../storage";
import { mixWriterMemory } from "../../memory/server";

/**
 * Frozen 40-case gate (5 groups × 8). No model.
 * ponytail: checks the search pack and the writer pack only. Cold tier, episodes, council and the BB catalog are not
 * folded into this text; the upgrade is to pass those packed strings through the same forbid and budget checks.
 */
export const GATE_GROUPS = ["namespace", "change", "no-answer", "needed", "budget"] as const;

export type GateNote = {
  key: string; content: string; concepts?: string[];
  projectId?: string; scope?: string[]; audience?: MemoryAudience; personalBot?: string;
  kind?: MemoryKind; trust?: MemoryTrust; origin?: string; sourceSha256?: string;
  validUntil?: number; sourceFileId?: string; supersedes?: string[];
};
export type GateCase = {
  id: string; group: (typeof GATE_GROUPS)[number];
  projectId?: string; chain?: string[]; audience?: MemoryAudience; personalBot?: string;
  query: string; budget: number; role?: "search" | "writer";
  paths?: { owns_paths: string[]; read_first: string[] };
  want?: string[]; forbid?: string[]; whole?: string[];
  notes?: GateNote[]; expectThrow?: string;
  activeCount?: { key: string; count: number }; trustStays?: { key: string; trust: MemoryTrust };
};
export type MemoryGate = { seed: number; notes: GateNote[]; cases: GateCase[] };
export type GateReport = { cases: number; leaks: string[]; overflows: string[]; cutRules: string[]; misses: string[]; errors: string[] };

const limits = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 99_999 };
const sha = (char: string) => char.repeat(64);

function plant(db: LanePilotDatabase, note: GateNote, ids: Map<string, { id: string; content: string }>): void {
  const projectId = note.projectId ?? "P";
  const entry: MemoryCandidate = { kind: note.kind ?? "note", content: note.content, concepts: note.concepts ?? ["gate"],
    ...(note.supersedes?.length ? { supersedes: note.supersedes.map((key) => { const id = ids.get(key)?.id; if (!id) throw new Error(`missing ${key}`); return id.slice(0, 12); }) } : {}),
    ...(note.validUntil != null ? { validUntil: note.validUntil } : {}), ...(note.sourceFileId ? { sourceFileId: note.sourceFileId } : {}) };
  const stored = storeMemoryRecords(db, { ...limits, projectId, audience: note.audience ?? "subagent", personalBot: note.personalBot ?? "",
    sourceSha256: note.sourceSha256 ?? sha("a"), scope: note.scope ?? [], trust: note.trust, origin: note.origin, entries: [entry] });
  const id = stored.insertedIds[0] ?? stored.records.find((row) => row.content === note.content)?.id;
  if (id) ids.set(note.key, { id, content: note.content });
}

export function runMemoryGate(db: LanePilotDatabase, fixture: MemoryGate): GateReport {
  const ids = new Map<string, { id: string; content: string }>();
  const report: GateReport = { cases: fixture.cases.length, leaks: [], overflows: [], cutRules: [], misses: [], errors: [] };
  for (const group of GATE_GROUPS) if (fixture.cases.filter((item) => item.group === group).length !== 8) report.errors.push(`${group} is not 8`);
  for (const note of fixture.notes) plant(db, note, ids);
  for (const item of fixture.cases) {
    if (item.expectThrow) {
      try { for (const note of item.notes ?? []) plant(db, note, ids); report.errors.push(`${item.id} stored`); }
      catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); if (!message.includes(item.expectThrow)) report.errors.push(`${item.id} threw ${message}`); }
      continue;
    }
    try { for (const note of item.notes ?? []) plant(db, note, ids); }
    catch (cause) { report.errors.push(`${item.id} ${cause instanceof Error ? cause.message : String(cause)}`); continue; }
    if (item.activeCount) {
      const row = ids.get(item.activeCount.key);
      const count = row ? (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory WHERE project_id=? AND status='active' AND content=?").get(item.projectId ?? "P", row.content) as { n: number }).n : -1;
      if (count !== item.activeCount.count) report.errors.push(`${item.id} active ${count}`);
    }
    if (item.trustStays) {
      const row = ids.get(item.trustStays.key);
      const trust = row ? (db.prepare("SELECT trust FROM lane_pilot_memory WHERE id=?").get(row.id) as { trust: string } | undefined)?.trust : "";
      if (trust !== item.trustStays.trust) report.errors.push(`${item.id} trust ${trust}`);
    }
    const projectId = item.projectId ?? "P";
    const audience = item.audience ?? "subagent";
    const personalBot = item.personalBot ?? "";
    const chain = item.chain ?? [];
    const packed = item.role === "writer"
      ? mixWriterMemory(db, { projectId, query: item.query, task: item.paths ?? { owns_paths: [], read_first: [] }, searchEngine: "auto", personalBot, ruleMemoryIds: new Set(), chain })
      : memoryContext(searchMemoryRecords(db, projectId, item.query, 20, "auto", audience, personalBot, { chain }), item.query, item.budget);
    const text = packed.text;
    const tokens = "estimatedTokens" in packed ? packed.estimatedTokens : estimateTokens(text);
    if (tokens > item.budget) report.overflows.push(item.id);
    for (const key of item.want ?? []) if (!text.includes(ids.get(key)?.content ?? key)) report.misses.push(`${item.id} ${key}`);
    for (const key of item.forbid ?? []) if (text.includes(ids.get(key)?.content ?? `\0${key}`)) report.leaks.push(`${item.id} ${key}`);
    for (const key of item.whole ?? []) {
      const body = ids.get(key)?.content ?? "";
      if (text.includes(body.slice(0, 24)) && !text.includes(body)) report.cutRules.push(`${item.id} ${key}`);
    }
  }
  return report;
}
