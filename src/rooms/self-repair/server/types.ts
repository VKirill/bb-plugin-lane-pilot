export type Incident = {
  signature: string;
  kind: "triage" | "blocked" | "stuck" | "log" | "repeat" | "queued" | "stage" | "parked" | "breaker" | "drill" | "hook" | "guard" | "owner" | "night";
  projectId: string;
  runId: string;
  taskId: string;
  attemptId: string;
  pmThreadId: string | null;
  writerThreadId: string | null;
  reason: string;
  at: number;
  /** The Lane Pilot version that was running when it happened; null — before this load, maybe already fixed. */
  version?: string | null;
};

export const VERDICTS = ["fixed", "already-fixed", "not-lane-pilot", "needs-owner"] as const;
export type Verdict = (typeof VERDICTS)[number];

/** The repair thread's own git worktree on lane/self-repair-…, forked from the shared checkout's HEAD (E2). */
export type RepairWorktree = { hostId: string; basePath: string; path: string; branch: string; mergeTries?: number };

export type SignatureRecord = {
  firstAt: number; lastAt: number; count: number; threadId: string | null; spawnedAt: number | null; samples: Incident[];
  spawnVersion?: string; verdict?: Verdict | null;
  /** Set while the repair's worktree exists; null/absent once it was merged or released. */
  worktree?: RepairWorktree | null;
  /** What became of the repair's branch: «merged <sha>», «up-to-date», «released», or why it was left. */
  outcome?: string | null;
  /**
   * The full SHA of the merge `outcome` names («merged <12 chars>» is for people). The night loop reverts by this value; a revert needs 40-64
   * hex, so the short text can never be its input (wall repairs wr_8462ad860c03, wr_16de9a4704de, wr_662642de0aa6: every revert refused).
   */
  mergedCommit?: string | null;
  /** A needs-owner repair keeps its worktree until the owner answers or this time passes: «go ahead» continues in that worktree. */
  ownerWaitUntil?: number | null;
  /** When the owner's «go ahead» went into the thread: its old needs-owner report is not read again before the new turn starts. */
  continuedAt?: number | null;
  /**
   * A spawn that threw, so whether the thread exists is unknown. Its worktree is kept and the next pass repeats the spawn
   * under the same key (the same thread comes back when it was made); only a spawn that cannot be settled releases it.
   */
  pending?: { worktree: RepairWorktree; at: number } | null;
  /** The graph run (`lp.self-repair`) that works on this repair, and how many runs the watcher has started for it; absent for a direct repair. */
  runId?: string | null;
  runTries?: number;
  /** Bumped by every write a graph step makes, so the watcher's own write at the end of a pass does not undo it. */
  rev?: number;
};

export type SelfRepairState = {
  cursor: number; lastTickAt: number | null; signatures: Record<string, SignatureRecord>; spawned: Array<{ at: number; threadId: string; signature: string }>;
  /** A signature Jev filed under a known group (J-10): the next sighting goes there without asking again. */
  aliases: Record<string, string>;
  /** A merge Jev proposed (active: applied, shadow: only recorded) whose receipt waits for a label: the target group's
   * verdict says whether the shared cause was real (agree), and the signature's own repair says it was not (disagree). */
  mergeSuggestions: Record<string, { group: string; receiptId: number; at: number }>;
};

/** Last owner (user-initiated) message time per PM thread; missing or null is unread and treated as live. */
export type PmLastOwnerAt = Record<string, number | null>;

export type SelfRepairConfig = {
  enabled: boolean;
  projectId: string;
  environmentId: string;
  /** Project Folders section the repair threads are filed in («Исправления» under lane-pilot); null — the project root. */
  sectionId: string | null;
  providerId: string;
  model: string;
  reasoningLevel: string;
  maxPerDay: number;
  /** Projects whose failures are deliberate (the sandbox). */
  ignoreProjects: string[];
  /** Where the run data lives, as the repair thread is told to reach it: the hub's ssh command, its SQLite file and the plugin log. */
  hubSsh: string;
  hubDb: string;
  hubLog: string;
};
