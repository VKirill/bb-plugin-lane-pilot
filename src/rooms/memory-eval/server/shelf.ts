import Database from "better-sqlite3";
import {
  memoryUsefulness, recordMemoryAccepted, recordMemoryMixed, searchMemoryRecords, storeMemoryRecords, trigramReady,
  type MemoryCandidate, type MemoryRecord,
} from "@lane-pilot/memory-core";
import { migrations } from "../../storage";
import { pathAnchors } from "../../writer";
import { candidateQuestions, classify, queryOf, type Classified } from "./questions";
import type { EvalData, RawNote } from "./source";

/**
 * The shelf replay (SMA block 4 «Next» and the P0-3 finding): notes live one to two days because about 2.5 are written per accepted task
 * while the shelf holds about 130. This replays the hub's own history, batch by batch and task by task in time order, through the real
 * write door (`storeMemoryRecords` with its budgets and eviction) and the real search, and asks at every real task: was a note that
 * names a file the accepted solution produced still on the shelf («gold on shelf»), and did the writer's pick put one in front of it
 * (hit@3). It is how the options for the supply problem were measured instead of argued:
 *
 *  - `order`: the brief's three notes by `legacy` (the more often a note was in an accepted brief, the earlier it goes; the behaviour
 *    before this change) or by `relevance` (the order of the search, best match first), as now;
 *  - `noteBudget`: `memory.note_budget`, 8000 tokens by default before this change, 24000 now;
 *  - `cap`: at most this many notes kept per accepted task, the most path-rich first (the other option in docs/memory.md).
 */
export type ShelfConfig = { name: string; order: "legacy" | "relevance"; noteBudget: number; cap?: number };
export type ShelfResult = { name: string; questions: number; goldOnShelf: number; hit3: number; written: number; evicted: number; activeNotes: number };

export const SHELF_CONFIGS: readonly ShelfConfig[] = [
  { name: "legacy order, budget 8000 (before)", order: "legacy", noteBudget: 8000 },
  { name: "relevance order, budget 8000", order: "relevance", noteBudget: 8000 },
  { name: "relevance order, budget 24000", order: "relevance", noteBudget: 24000 },
  { name: "relevance order, budget 8000, cap 1 per task", order: "relevance", noteBudget: 8000, cap: 1 },
  { name: "relevance order, budget 8000, cap 2 per task", order: "relevance", noteBudget: 8000, cap: 2 },
  { name: "relevance order, budget 24000, cap 2 per task", order: "relevance", noteBudget: 24000, cap: 2 },
];

const pathCount = (content: string) => new Set(content.match(/[\w.@-]+\/[\w./@-]+/g) ?? []).size;
/** How likely a note is to outlive its task: the files it names (a hub folder is read again), then its length. */
export const durabilityScore = (entry: Pick<MemoryCandidate, "content">) => Math.min(pathCount(entry.content), 6) * 100 + Math.min(entry.content.length, 600) / 6;

const anchored = (found: readonly MemoryRecord[], anchors: readonly string[]) => found.filter((note) => !note.concepts.includes("lesson") && anchors.some((anchor) => note.content.includes(anchor)));
const core = (found: readonly MemoryRecord[], skip: ReadonlySet<string>) => found.filter((note) => note.kind === "core" && !skip.has(note.id) && !note.concepts.includes("lesson"));
const byUse = (a: MemoryRecord, b: MemoryRecord) => memoryUsefulness(b) - memoryUsefulness(a);

/** The three notes a writer's brief would carry, by the order under test. */
export function pickThree(found: readonly MemoryRecord[], anchors: readonly string[], order: ShelfConfig["order"]): MemoryRecord[] {
  const about = anchored(found, anchors);
  const sorted = order === "legacy" ? [...about].sort(byUse) : about;
  const rest = core(found, new Set(sorted.map((note) => note.id)));
  return [...sorted, ...(order === "legacy" ? [...rest].sort(byUse) : rest)].slice(0, 3);
}

type Event = { at: number; batch?: RawNote[]; projectId?: string; asked?: Classified };

export async function replayShelf(data: EvalData, config: ShelfConfig, skip: { projects: ReadonlySet<string>; task: (taskId: string) => boolean }): Promise<ShelfResult> {
  const universe = data.notes.filter((note) => !skip.projects.has(note.projectId));
  const asked = candidateQuestions(data.questions, skip).map((question) => classify(question, universe.filter((note) => note.kind === "note")))
    .filter((item): item is Classified => item !== null && item.kind === "positive");
  const db = new Database(":memory:");
  try {
    for (const statement of migrations) db.exec(statement);
    trigramReady(db);
    const batches = new Map<string, RawNote[]>();
    for (const note of universe) { const key = `${note.projectId}|${note.createdAt}`; (batches.get(key) ?? batches.set(key, []).get(key)!).push(note); }
    const events: Event[] = [
      ...[...batches.values()].map((notes): Event => ({ at: notes[0]!.createdAt, batch: notes, projectId: notes[0]!.projectId })),
      ...asked.map((item): Event => ({ at: item.question.startedAt, asked: item })),
    ].sort((a, b) => a.at - b.at || (a.batch ? 1 : -1));
    let questions = 0, onShelf = 0, hits = 0, written = 0, evicted = 0, tick = 0;
    for (const event of events) {
      if (++tick % 200 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
      if (event.batch) {
        const entries = event.batch.map((note): MemoryCandidate => ({ kind: note.kind, content: note.content, concepts: note.concepts }));
        const kept = config.cap === undefined ? entries : [...entries.filter((entry) => entry.kind === "core"),
          ...entries.filter((entry) => entry.kind === "note").sort((a, b) => durabilityScore(b) - durabilityScore(a)).slice(0, config.cap)];
        if (!kept.length) continue;
        try {
          const result = storeMemoryRecords(db, { projectId: event.projectId!, audience: "subagent", sourceSha256: `batch${event.at}`, entries: kept, coreBudget: 3072, noteBudget: config.noteBudget, indexBudget: 65536, now: event.at });
          written += result.insertedIds.length; evicted += result.evictedIds.length;
        } catch { /* a batch over a budget is refused whole, as in production */ }
        continue;
      }
      const { question, gold } = event.asked!;
      const goldIds = new Set(gold.map((note) => note.id));
      const live = db.prepare("SELECT id FROM lane_pilot_memory WHERE project_id=? AND status='active' AND kind='note'").all(question.projectId) as Array<{ id: string }>;
      const found = searchMemoryRecords(db, question.projectId, queryOf(question.task), 100, "auto", "subagent", "");
      const picked = pickThree(found, pathAnchors(question.task), config.order).map((note) => note.id);
      questions += 1;
      if (live.some((row) => goldIds.has(row.id))) onShelf += 1;
      if (picked.some((id) => goldIds.has(id))) hits += 1;
      recordMemoryMixed(db, question.projectId, picked, question.startedAt);
      recordMemoryAccepted(db, question.projectId, picked);
    }
    const active = (db.prepare("SELECT count(*) n FROM lane_pilot_memory WHERE status='active' AND kind='note'").get() as { n: number }).n;
    return { name: config.name, questions, goldOnShelf: questions ? onShelf / questions : 0, hit3: questions ? hits / questions : 0, written, evicted, activeNotes: active };
  } finally { db.close(); }
}

export async function runShelfReplay(data: EvalData, skip: { projects: ReadonlySet<string>; task: (taskId: string) => boolean }, configs: readonly ShelfConfig[] = SHELF_CONFIGS): Promise<ShelfResult[]> {
  const out: ShelfResult[] = [];
  for (const config of configs) out.push(await replayShelf(data, config, skip));
  return out;
}

export function formatShelf(results: readonly ShelfResult[]): string {
  const pct = (value: number) => `${(value * 100).toFixed(0)}%`;
  return ["shelf replay: the hub's history through the real write door, hit@3 at every real task that had an answer on record",
    "configuration                                    tasks  gold on shelf  hit@3  notes written  evicted  active at end",
    ...results.map((row) => `${row.name.padEnd(48)} ${String(row.questions).padEnd(6)} ${pct(row.goldOnShelf).padEnd(14)} ${pct(row.hit3).padEnd(6)} ${String(row.written).padEnd(14)} ${String(row.evicted).padEnd(8)} ${row.activeNotes}`)].join("\n");
}
