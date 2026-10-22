import type { RawNote, RawQuestion } from "./source";

/**
 * The questions of the evaluation and their gold answers, made from what really happened.
 *
 * A question is an accepted task: its words and its path lists are what the production retrieval is given at dispatch. The gold
 * answer is which notes the accepted solution depended on, and it comes from the OUTCOME, not from the retrieval: the files the
 * accepted attempt actually produced (the acceptance receipt's `produced`). A note is gold when it was written before the attempt
 * started and names one of those files (its last two path segments). That is independent of the contract's path lists the retrieval
 * reads, but it is a lower bound: a note can help without naming a produced file. So precision against gold is a floor, and a
 * delivered note that names the same folder is reported apart (`area`) so the reader can see how much of the miss is only «nearby».
 *
 * A negative question is a real task for which the right answer is nothing: no earlier note names any file or folder the solution touched.
 */
export type QuestionKind = "positive" | "negative" | "offtopic";
export type EvalQuestion = {
  id: string; kind: QuestionKind; projectId: string; taskId: string; startedAt: number;
  /** What `writerKnowledge` searches with: title, objective and acceptance. */
  query: string;
  text: { title: string; objective: string; acceptance: string[] };
  /** The project id the search is scoped to (the notes it can see). */
  scope: string;
  paths: { owns_paths: string[]; read_first: string[] };
  produced: string[];
  /** Ids of the corpus notes that are the right answer; empty for a negative question. */
  gold: string[];
  /** Ids of the corpus notes that are not gold but name a folder of the solution (a delivered one is «nearby», not wrong). */
  area: string[];
};

const segments = (path: string) => path.split("/").filter(Boolean);
const isFile = (last: string | undefined) => Boolean(last && /\.[A-Za-z0-9]+$/.test(last));

/** `dir/file.ts` of `a/b/dir/file.ts`; null for a path of one segment (`package.json` names nothing). */
export function fileKey(path: string): string | null {
  const parts = segments(path);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
}
/** The last two folders of a path (`b/dir`), the anchor the writer's brief matches notes by. */
export function folderKey(path: string): string | null {
  let parts = segments(path);
  if (isFile(parts.at(-1))) parts = parts.slice(0, -1);
  return parts.length >= 2 ? parts.slice(-2).join("/") : null;
}

const unique = <T>(items: Iterable<T>): T[] => [...new Set(items)];
const keys = (paths: readonly string[], of: (path: string) => string | null) => unique(paths.map(of).filter((item): item is string => item !== null));

/** Notes of the project written before `before` that name one of the keys. */
export function notesNaming(notes: readonly RawNote[], projectId: string, before: number, needles: readonly string[]): RawNote[] {
  if (!needles.length) return [];
  return notes.filter((note) => note.projectId === projectId && note.createdAt < before && needles.some((needle) => note.content.includes(needle)));
}

/** The words a writer's brief is searched with (`writerKnowledge`: title, objective, acceptance). */
export const queryOf = (task: RawQuestion["task"]) => `${task.title}\n${task.objective}\n${task.acceptance.join(" ")}`;

/** One accepted attempt per task, the first, from the projects and tasks worth asking about. */
export function candidateQuestions(questions: readonly RawQuestion[], skip: { projects: ReadonlySet<string>; task: (taskId: string) => boolean }): RawQuestion[] {
  const seen = new Set<string>();
  const out: RawQuestion[] = [];
  for (const question of [...questions].sort((a, b) => a.startedAt - b.startedAt)) {
    if (skip.projects.has(question.projectId) || skip.task(question.taskId) || seen.has(question.taskId)) continue;
    seen.add(question.taskId);
    out.push(question);
  }
  return out;
}

export type Classified = { question: RawQuestion; kind: "positive" | "negative"; gold: RawNote[]; area: RawNote[] };

/**
 * Positive: at least one earlier note names a produced file. Negative: no earlier note names a produced file or its folder (strict:
 * the right answer is nothing). A task with a note about its folder only is neither, and is left out: its answer is ambiguous.
 * A task that produced nothing nameable is left out too.
 */
export function classify(question: RawQuestion, notes: readonly RawNote[]): Classified | null {
  const fileKeys = keys(question.produced, fileKey);
  if (!fileKeys.length) return null;
  const gold = notesNaming(notes, question.projectId, question.startedAt, fileKeys);
  const folderKeys = keys(question.produced, folderKey);
  const area = notesNaming(notes, question.projectId, question.startedAt, folderKeys).filter((note) => !gold.includes(note));
  if (gold.length) return { question, kind: "positive", gold, area };
  if (!area.length) return { question, kind: "negative", gold: [], area: [] };
  return null;
}

/** Questions nothing in a project's memory could answer: they must get nothing back. */
export const OFFTOPIC: ReadonlyArray<{ title: string; objective: string; owns_paths: string[] }> = [
  { title: "Borscht recipe for twelve guests", objective: "Write a family recipe with beets, cabbage and sour cream, with times for each step.", owns_paths: ["kitchen/recipes/borscht.md"] },
  { title: "Weather forecast widget for Lisbon", objective: "Show a three day forecast with wind and tide tables for the Lisbon harbour webcam page.", owns_paths: ["harbour/weather/lisbon.vue"] },
  { title: "zqxjvk wkpqzt", objective: "zqxjvk wkpqzt xvbnm qwrtp", owns_paths: ["zz/qq/file.ts"] },
  { title: "Орнитологический атлас", objective: "Составить таблицу перелётных птиц средней полосы по месяцам наблюдений.", owns_paths: ["atlas/birds/migration.md"] },
  { title: "Chess opening trainer", objective: "Drill the Sicilian Najdorf with spaced repetition and a pgn importer.", owns_paths: ["games/chess/trainer.ts"] },
  { title: "Квартальный отчёт по складу", objective: "Свести остатки, списания и инвентаризацию склада в одну ведомость за квартал.", owns_paths: ["warehouse/reports/quarter.xlsx"] },
];
