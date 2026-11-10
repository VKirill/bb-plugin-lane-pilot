import type { JevSettings } from "@lane-pilot/jev";
import type { SqlDb } from "./sql-db";

export type TaskWordDb = SqlDb;
export type WordTask = { title: string; risk?: string; objective?: string; invariants?: readonly string[] };

/** The list's row of a landing that waits for the word, one per attempt under the family's prefix (finish.ts posts, the word or the end of the wait closes). */
export const taskWordItemPrefix = (runId: string, family: string) => `task-word:${runId}:${family}:`;

/** The lead's task-word surface, implemented by src/rooms/lead and handed to the writer, the queue tool and the task_word RPC. */
export interface TaskWordPort {
  ask(db: TaskWordDb, input: { runId: string; projectId: string; family: string; task: WordTask }, settings?: JevSettings, now?: number): Promise<void>;
  answer(db: TaskWordDb, runId: string, family: string, decision: "yes" | "no", text: string, by: string, now?: number): void;
  /** Compare-and-set claim of the decision (SMA tr_approving): the second presser is refused as already decided. */
  decide(db: TaskWordDb, runId: string, family: string, decision: "yes" | "no", by: string, now?: number): { ok: true } | { ok: false; reason: string };
}
