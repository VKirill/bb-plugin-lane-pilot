export type RawNote = {
  id: string; projectId: string; kind: "core" | "note"; content: string; concepts: string[]; createdAt: number;
  status: string; trust: string; origin: string; useCount: number; acceptedCount: number;
  /** Section chain stored on the row. Empty is the project root. Named sections so it does not collide with the eval's project scope. */
  sections: string[]; audience: string; personalBot: string;
};
export type RawTask = { title: string; objective: string; acceptance: string[]; owns_paths: string[]; read_first: string[] };
export type RawQuestion = {
  attemptId: string; taskId: string; projectId: string; startedAt: number; attemptNo: number;
  /** The files the accepted attempt changed (the acceptance receipt's `produced`). */
  produced: string[];
  /** The ids of the notes the brief of that attempt carried (what the writer actually read). */
  picked: string[];
  task: RawTask;
};
export type EvalData = { notes: RawNote[]; questions: RawQuestion[]; origin: "live" | "extract";
  /** Misses the owner flagged ("I had to remind you"), each tied to the record that held the answer: extra gold cases. */
  misses?: Array<{ projectId: string; query: string; noteId: string }> };

/** The fields of the eval report a consumer (the lead's exam) reads; src/rooms/memory-eval's full report covers them. */
export type MemoryEvalReport = {
  sizes: Array<{
    questions: { positive: number; negative: number; offtopic: number };
    scores: Array<{ id: string; production: boolean; hit: { mean: number }; falseHit: { mean: number } }>;
  }>;
  caveats: string[];
};
/** The memory evaluation runner, implemented by src/rooms/memory-eval and handed to the lead. */
export type MemoryEvalRunner = {
  load(db: unknown): EvalData;
  run(data: EvalData, options: unknown): Promise<MemoryEvalReport>;
};
