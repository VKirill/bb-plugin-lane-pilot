import { listTaskAcceptanceRows, listWriterThreadTurns } from "../../../storage";
import { computeWriterReuseStats, type WriterReuseStats } from "../../models/writer-reuse-stats";

type Db = { prepare(sql: string): { all(...args: unknown[]): unknown[] } };

export type { WriterReuseStats };

/** How often writers start cold versus continue, and how fast tasks land, for one project since `since`. */
export function writerReuseStats(db: Db, projectId: string, since: number): WriterReuseStats {
  const tasks = listTaskAcceptanceRows(db as never, projectId, since);
  const threads = listWriterThreadTurns(db as never, projectId, since);
  return computeWriterReuseStats(tasks, threads);
}
