import Database from "better-sqlite3";
import { addToIndexes, memoryRecordId, trigramReady } from "@lane-pilot/memory-core";
import { migrations } from "../../storage";
import { OFFTOPIC, candidateQuestions, classify, folderKey, fileKey, notesNaming, queryOf, type EvalQuestion } from "./questions";
import type { EvalData, RawNote } from "./source";

/** The one scope the corpus lives in: a person's memory is one pile, whichever project a note came from. */
export const EVAL_PROJECT = "memory-eval";

export type EvalScope = "project" | "pile";
/** `scope` is the project id the note is stored under: its own project (as production keeps it) or the one pile of a person's memory. */
export type CorpusNote = RawNote & { synthetic: boolean; origin: string; scope: string };
export type SizePlan = {
  size: number;
  scope: EvalScope;
  notes: CorpusNote[];
  questions: EvalQuestion[];
  composition: { gold: number; fill: number; synthetic: number; core: number; /** Notes in the largest scope, the pool a search really sees. */ pool: number };
};

/** Deterministic random numbers, so a run can be repeated and compared. */
export function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index--) { const other = Math.floor(random() * (index + 1)); [out[index], out[other]] = [out[other]!, out[index]!]; }
  return out;
}

/** Share of the corpus the gold notes of the chosen questions may take: a small corpus is dense with answers, a large one is not. */
const goldShare = (size: number) => size <= 30 ? 0.5 : size <= 300 ? 0.35 : size <= 1000 ? 0.2 : 0.1;
const MAX_POSITIVES = 80;

/**
 * A copy of a real note that cannot answer any question: every folder of every path in it is renamed (`apps/api/x.ts` becomes
 * `apps-s3/api-s3/x.ts`; renaming only the first folder would leave the last two, which the writer's brief matches by), the words stay.
 * Padding that reads like the project but names files nobody touched.
 */
export function syntheticCopy(note: RawNote, round: number): CorpusNote {
  const content = note.content.replace(/(^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)+)([A-Za-z0-9_.-]*)/g, (_all, lead: string, dirs: string, file: string) =>
    `${lead}${dirs.replace(/([A-Za-z0-9_.-]+)\//g, `$1-s${round}/`)}${file}`);
  const text = content === note.content ? `${note.content} (series s${round})` : content;
  return { ...note, id: memoryRecordId(EVAL_PROJECT, note.kind, text), content: text, synthetic: true, origin: "eval-synthetic", scope: note.projectId, useCount: 0, acceptedCount: 0 };
}

export type PlanInput = { data: EvalData; size: number; seed: number; scope?: EvalScope; skipProjects: ReadonlySet<string>; skipTask: (taskId: string) => boolean; now?: number };

export function planCorpus(input: PlanInput): SizePlan {
  const { data, size } = input;
  const random = prng(input.seed * 7919 + size);
  const universe = data.notes.filter((note) => !input.skipProjects.has(note.projectId) && note.origin !== "probe");
  const classified = candidateQuestions(data.questions, { projects: input.skipProjects, task: input.skipTask })
    .map((question) => classify(question, universe)).filter((item): item is NonNullable<typeof item> => item !== null);
  const positives = shuffled(classified.filter((item) => item.kind === "positive"), random);
  const negatives = shuffled(classified.filter((item) => item.kind === "negative"), random);

  // Positives first, while their answers fit in the share of the corpus they may take.
  const budget = Math.max(6, Math.round(size * goldShare(size)));
  const goldIds = new Set<string>();
  const chosen: typeof positives = [];
  for (const item of positives) {
    if (chosen.length >= MAX_POSITIVES) break;
    const next = item.gold.filter((note) => !goldIds.has(note.id)).length;
    if (goldIds.size + next > budget) continue;
    for (const note of item.gold) goldIds.add(note.id);
    chosen.push(item);
  }
  const chosenNegatives = negatives.slice(0, Math.max(4, chosen.length));

  const byId = new Map(universe.map((note) => [note.id, note]));
  const picked = new Map<string, CorpusNote>();
  const add = (note: RawNote) => { if (!picked.has(note.id)) picked.set(note.id, { ...note, synthetic: false, origin: "eval", scope: note.projectId, useCount: 0, acceptedCount: 0 }); };
  for (const id of goldIds) add(byId.get(id)!);
  const goldCount = picked.size;
  for (const note of shuffled(universe, random)) { if (picked.size >= size) break; add(note); }
  const fill = picked.size - goldCount;
  let synthetic = 0;
  const base = shuffled(universe, random);
  for (let round = 1; picked.size < size && base.length; round++) {
    for (const note of base) {
      if (picked.size >= size) break;
      const copy = syntheticCopy(note, round);
      if (!picked.has(copy.id)) { picked.set(copy.id, copy); synthetic += 1; }
    }
    if (round > 50) break;
  }

  // Times move together so the 90-day idle rule of the search never hides a note because the run is later than the data.
  const newest = Math.max(0, ...universe.map((note) => note.createdAt), ...data.questions.map((question) => question.startedAt));
  const shift = (input.now ?? Date.now()) - newest - 3_600_000;
  const scope = input.scope ?? "project";
  const notes = [...picked.values()].map((note) => ({ ...note, createdAt: note.createdAt + shift, scope: scope === "pile" ? EVAL_PROJECT : note.projectId }));
  const sizes = new Map<string, number>();
  for (const note of notes) sizes.set(note.scope, (sizes.get(note.scope) ?? 0) + 1);
  const largest = [...sizes].sort((a, b) => b[1] - a[1])[0] ?? [EVAL_PROJECT, 0];

  const questions: EvalQuestion[] = [];
  const answer = (projectId: string, startedAt: number, produced: readonly string[]) => {
    const files = produced.map(fileKey).filter((key): key is string => key !== null);
    const folders = produced.map(folderKey).filter((key): key is string => key !== null);
    const real = notes.filter((note) => !note.synthetic);
    const gold = notesNaming(real, projectId, startedAt, files);
    const area = notesNaming(real, projectId, startedAt, folders).filter((note) => !gold.includes(note));
    return { gold: gold.map((note) => note.id), area: area.map((note) => note.id) };
  };
  for (const item of [...chosen, ...chosenNegatives]) {
    const { question } = item;
    const startedAt = question.startedAt + shift;
    const found = answer(question.projectId, startedAt, question.produced);
    // A positive whose answer the corpus no longer holds (cannot happen by construction) or a negative that gained one is dropped, not bent.
    if (item.kind === "positive" ? found.gold.length === 0 : found.gold.length > 0 || found.area.length > 0) continue;
    questions.push({ id: question.taskId, kind: item.kind, projectId: question.projectId, taskId: question.taskId, startedAt, query: queryOf(question.task), text: { title: question.task.title, objective: question.task.objective, acceptance: question.task.acceptance },
      scope: scope === "pile" ? EVAL_PROJECT : question.projectId, paths: { owns_paths: question.task.owns_paths, read_first: question.task.read_first }, produced: question.produced, gold: found.gold, area: found.area });
  }
  OFFTOPIC.forEach((item, index) => questions.push({ id: `offtopic-${index + 1}`, kind: "offtopic", projectId: "none", taskId: `offtopic-${index + 1}`, startedAt: (input.now ?? Date.now()),
    query: `${item.title}\n${item.objective}`, text: { title: item.title, objective: item.objective, acceptance: [] }, scope: largest[0], paths: { owns_paths: item.owns_paths, read_first: [] }, produced: [], gold: [], area: [] }));

  return { size, scope, notes, questions, composition: { gold: goldCount, fill, synthetic, core: notes.filter((note) => note.kind === "core").length, pool: largest[1] } };
}

/** A database with the production schema and the corpus in it, written and indexed the way the write door does. */
export function buildEvalDb(plan: SizePlan): Database.Database {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  trigramReady(db);
  const insert = db.prepare(`INSERT INTO lane_pilot_memory(id,project_id,personal_bot,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin)
    VALUES(?,?,'',?,'subagent',?,?,?,?,'confirmed',?)`);
  db.transaction(() => {
    for (const note of plan.notes) {
      insert.run(note.id, note.scope, note.kind, note.content, JSON.stringify(note.concepts), "eval", note.createdAt, note.origin);
      addToIndexes(db, note.scope, note.id, note.content, note.concepts);
    }
  })();
  return db;
}
