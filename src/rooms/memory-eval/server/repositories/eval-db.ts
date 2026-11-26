import Database from "better-sqlite3";
import { addToIndexes, insertMemoryRecord, trigramReady } from "@lane-pilot/memory-core";
import type { SizePlan } from "../../models/corpus";

const HUB = "hub";

/** Opens an in-memory scratch database with the given migrations applied. */
export function openScratchEvalDb(migrations: readonly string[], withTrigram = false): Database.Database {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  if (withTrigram) trigramReady(db);
  return db;
}

/** Opens an existing extract database file read-only. */
export function openReadonlyEvalDb(path: string): Database.Database {
  return new Database(path, { readonly: true });
}

/** A writable in-memory copy of a database file (opened read-only; the file is never touched). */
export function copyOfDatabase(path: string): Database.Database {
  const source = new Database(path, { readonly: true });
  try { return new Database(source.serialize()); } finally { source.close(); }
}

/** The whole hub as one shelf: every note, its indexes and its vectors move under one project id. The copy is changed, never the original. */
export function mergeIntoHub(db: Pick<Database.Database, "prepare">): void {
  for (const table of ["lane_pilot_memory", "lane_pilot_memory_fts", "lane_pilot_memory_trgm", "lane_pilot_memory_vec", "lane_pilot_memory_vec_chunk"]) {
    try { db.prepare(`UPDATE ${table} SET project_id=?`).run(HUB); } catch { /* a table the copy does not have */ }
  }
}

/** A database with the production schema and the corpus in it, written and indexed the way the write door does. */
export function buildEvalDb(plan: SizePlan, migrations: readonly string[]): Database.Database {
  const db = openScratchEvalDb(migrations, true);
  db.transaction(() => {
    for (const note of plan.notes) {
      insertMemoryRecord(db, { id: note.id, projectId: note.scope, kind: note.kind, content: note.content, conceptsJson: JSON.stringify(note.concepts), sourceSha256: "eval", createdAt: note.createdAt, origin: note.origin });
      addToIndexes(db, note.scope, note.id, note.content, note.concepts);
    }
  })();
  return db;
}
