import type Database from "better-sqlite3";
import { memoryContext, memoryTokens, searchMemoryRecords } from "@lane-pilot/memory-core";
import { mixReviewerMemory, mixWriterMemory } from "../../memory/server";
import { pathAnchors } from "../../writer";
import type { CorpusNote } from "./corpus";
import type { EvalQuestion } from "./questions";

/**
 * The retrievals under test. The production ones are the very functions the delivery paths call (`mixWriterMemory` for the writer's
 * brief, `mixReviewerMemory` for critics and night review, `searchMemoryRecords` + `memoryContext` for the PM tool, the terminal and
 * the council); nothing is re-implemented. The plain ones are the baseline Matvey Maslov's claim asks for: a path match and a word count
 * you can explain in a sentence, with no stemming, no trigram index, no rank fusion and no usefulness weights.
 */
export type Retrieval = {
  /** Note ids in the order they would be handed over. */
  ids: string[];
  /** For a plain retrieval: why each note was chosen. */
  why?: Map<string, string>;
};
export type Retriever = {
  id: string;
  /** How many notes the path hands over at most; the metric cuts here. */
  k: number;
  group: "writer" | "query" | "reviewer";
  production: boolean;
  run: (question: EvalQuestion, excluded: ReadonlySet<string>) => Retrieval;
};

const SEARCH_LIMIT = 100;
const CONTEXT_BUDGET = 2500;

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "when", "not", "are", "was", "has", "have", "into", "only", "must", "should", "will", "can", "его", "для", "что", "это", "как", "при", "или", "если", "все", "так", "они"]);
const words = (text: string): string[] => memoryTokens(text).filter((word) => word.length >= 4 && !STOP.has(word));

export function createRetrievers(db: Database.Database, notes: readonly CorpusNote[], now?: number): Retriever[] {
  const byId = new Map(notes.map((note) => [note.id, note]));
  // The index of the plain baseline: the words of each note, and in how many notes each word appears.
  const noteWords = new Map(notes.map((note) => [note.id, new Set(words(`${note.content} ${note.concepts.join(" ")}`))]));
  // Counted per scope: a search only ever sees the notes of its own project (or the one pile).
  const frequencies = new Map<string, Map<string, number>>();
  const scopeSize = new Map<string, number>();
  for (const note of notes) {
    const frequency = frequencies.get(note.scope) ?? new Map<string, number>();
    frequencies.set(note.scope, frequency);
    scopeSize.set(note.scope, (scopeSize.get(note.scope) ?? 0) + 1);
    for (const word of noteWords.get(note.id)!) frequency.set(word, (frequency.get(word) ?? 0) + 1);
  }
  const idf = (scope: string, word: string) => Math.log(1 + (scopeSize.get(scope) ?? 1) / (frequencies.get(scope)?.get(word) ?? 1));

  const overlap = (question: EvalQuestion, note: CorpusNote) => {
    const own = noteWords.get(note.id)!;
    const shared = [...new Set(words(question.query))].filter((word) => own.has(word));
    return { shared, score: shared.reduce((sum, word) => sum + idf(note.scope, word), 0) };
  };
  const live = (question: EvalQuestion, excluded: ReadonlySet<string>) => notes.filter((note) => note.scope === question.scope && !excluded.has(note.id));

  const search = (question: EvalQuestion, excluded: ReadonlySet<string>) =>
    searchMemoryRecords(db, question.scope, question.query, SEARCH_LIMIT, "auto", "subagent", "", { chain: question.chain ?? [], ...(now !== undefined ? { now } : {}) }).filter((record) => !excluded.has(record.id));

  const retrievers: Retriever[] = [
    // Production, the writer's first brief (writerKnowledge → mixWriterMemory): the search, then the notes that name a folder of the task, then core.
    { id: "writer", k: 3, group: "writer", production: true,
      run: (question, excluded) => ({ ids: mixWriterMemory(db, { projectId: question.scope, query: question.query, task: question.paths, searchEngine: "auto", personalBot: "", ruleMemoryIds: excluded, chain: question.chain ?? [], ...(now !== undefined ? { now } : {}) }).ids }) },
    // Plain, same job: notes that name a folder of the task (substring), the one with the most uncommon task words first. Nothing else.
    { id: "plain", k: 3, group: "writer", production: false,
      run: (question, excluded) => {
        const anchors = pathAnchors(question.paths);
        const why = new Map<string, string>();
        const hits = live(question, excluded).flatMap((note) => {
          const anchor = anchors.find((item) => note.content.includes(item));
          if (!anchor) return [];
          const { shared, score } = overlap(question, note);
          why.set(note.id, `names ${anchor}; shares ${shared.length} task words`);
          return [{ note, score }];
        }).sort((a, b) => b.score - a.score || b.note.createdAt - a.note.createdAt || a.note.id.localeCompare(b.note.id));
        return { ids: hits.map((hit) => hit.note.id), why };
      } },
    // Production, the PM tool, the terminal and the council (searchMemoryRecords → memoryContext within the context budget).
    { id: "pm", k: 5, group: "query", production: true,
      run: (question, excluded) => ({ ids: memoryContext(search(question, excluded), question.query, CONTEXT_BUDGET).records.map((record) => record.id) }) },
    // Production search alone: the FTS word index and the trigram index fused, best first.
    { id: "search", k: 5, group: "query", production: true,
      run: (question, excluded) => ({ ids: search(question, excluded).map((record) => record.id) }) },
    // Diagnostic, not a delivery path: the production search with a floor, a note must share at least three task words (4+ letters) to count.
    { id: "search+floor", k: 5, group: "query", production: false,
      run: (question, excluded) => ({ ids: search(question, excluded).filter((record) => overlap(question, byId.get(record.id)!).shared.length >= 3).map((record) => record.id) }) },
    // Plain, same job as the PM tool: at least three uncommon words in common with the task (uncommon: in at most 5 % of the notes).
    { id: "plain-keyword", k: 5, group: "query", production: false,
      run: (question, excluded) => {
        const ceiling = Math.max(2, Math.floor((scopeSize.get(question.scope) ?? 0) * 0.05));
        const why = new Map<string, string>();
        const hits = live(question, excluded).flatMap((note) => {
          const { shared } = overlap(question, note);
          const rare = shared.filter((word) => (frequencies.get(note.scope)?.get(word) ?? 0) <= ceiling);
          if (rare.length < 3) return [];
          why.set(note.id, `shares ${rare.slice(0, 6).join(", ")}`);
          return [{ note, score: rare.reduce((sum, word) => sum + idf(note.scope, word), 0) }];
        }).sort((a, b) => b.score - a.score || b.note.createdAt - a.note.createdAt || a.note.id.localeCompare(b.note.id));
        return { ids: hits.map((hit) => hit.note.id), why };
      } },
    // Production, critics and the night review.
    { id: "reviewer", k: 5, group: "reviewer", production: true,
      run: (question, excluded) => ({ ids: mixReviewerMemory(db, { projectId: question.scope, task: { ...question.paths, ...question.text },
        searchEngine: "auto", personalBot: "", ruleMemoryIds: excluded, budget: CONTEXT_BUDGET, chain: question.chain ?? [], ...(now !== undefined ? { now } : {}) }).ids }) },
  ];
  return retrievers.map((retriever) => ({ ...retriever, run: (question: EvalQuestion, excluded: ReadonlySet<string>) => {
    const out = retriever.run(question, excluded);
    return { ...out, ids: out.ids.filter((id) => byId.has(id)) };
  } }));
}
