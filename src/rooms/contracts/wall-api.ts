/** The wall's config and status reads, structurally, so a consumer (the self-improvement screen) needs no wall import. */
export interface WallConfigStatus {
  config(): Promise<{ enabled: boolean }>;
  status(): { nights: Array<{ startedAt?: number; dryRun?: boolean; spend?: unknown; cap?: unknown }>; open: number };
}

/** What a loop that ran out of tries is made of: the attempts of the tasks that tried, the facts the caller knows, and texts the hunters may cite (the phase book, the verdict). */
export type LoopEvidence = {
  subject: string;
  runId?: string | null;
  /** Task ids or families (`P1` also reads `P1.2`): their attempts, failed receipts and contracts are the evidence. */
  taskIds?: readonly string[];
  facts: readonly string[];
  texts?: ReadonlyArray<{ path: string; text: string }>;
};

/** A loop of tries that ended (see the wall's `loopExhausted`). */
export type LoopSubject = Omit<LoopEvidence, "subject"> & {
  /** A phase stage's workflow that failed, the machine's replans after a failed verification, or a topic of a run the stopper refused. */
  kind: "stage" | "replan" | "topic";
  /** Names the subject within its kind; one id, one wall, one hunt, one backlog item. */
  id: string;
  title: string;
  projectId: string;
  /** What the caller already did about it (a scope cut, a stop), for the morning-list line and the backlog item. */
  done: string;
  /** The topic stopper's key (a file or a test), read back by `loopTopics`. */
  topic?: string;
  pmThreadId?: string | null;
  /** The one notice for the PM chat, sent at once; omitted when the caller's own answer already is that notice. */
  notice?: string;
};

/** The slice of the wall a loop-exhaustion caller needs, implemented by src/rooms/wall (createWall). */
export interface WallLoopPort {
  loopExhausted(input: LoopSubject): Promise<{ key: string; created: boolean }>;
}
