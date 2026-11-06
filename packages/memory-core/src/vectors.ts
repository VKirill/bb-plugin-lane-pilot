import { createHash } from "node:crypto";
import type { MemoryDatabase } from "./store";

/**
 * Search by meaning. Every active record has a vector of `EMBED_DIM` numbers made by `EMBED_MODEL` from its text; a question gets a
 * vector the same way, and the records are ranked by the cosine of the two (the vectors are unit length, so it is the dot product).
 *
 * Measured on the hub copy 2026-11-06 (853 questions written from 298 real records plus 228 checked to have no answer):
 * the wanted record is in the first five for 98.1% of the questions (words alone 59.7%; adding the word ranking to the meaning one
 * only lowered it). The embedding is made outside (`src/rooms/memory/server/embeddings.ts`, Google gemini-embedding-2) and handed in:
 * this package only stores vectors and ranks. No vector for a question or a project means the word search, as before.
 */
export const EMBED_MODEL = "gemini-embedding-2";
export const EMBED_DIM = 768;

const ready = new WeakMap<object, boolean>();

/** The vector table, made on first use like the trigram index; where it cannot be made the search stays on words. */
export function vectorsReady(db: MemoryDatabase): boolean {
  const known = ready.get(db);
  if (known !== undefined) return known;
  let ok = false;
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS lane_pilot_memory_vec (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, model TEXT NOT NULL,
      content_sha TEXT NOT NULL, vec BLOB NOT NULL, created_at INTEGER NOT NULL)`).run();
    db.prepare("CREATE INDEX IF NOT EXISTS lane_pilot_memory_vec_project ON lane_pilot_memory_vec(project_id, model)").run();
    ok = true;
  } catch { ok = false; }
  ready.set(db, ok);
  return ok;
}

export const contentSha = (content: string): string => createHash("sha256").update(content).digest("hex").slice(0, 32);

/** The text a record is embedded from: its first line as the title, the whole record as the text (the format the model documents). */
export const documentText = (content: string): string => `title: ${content.split("\n")[0]!.slice(0, 80)} | text: ${content.slice(0, 6000)}`;
export const queryText = (query: string): string => `task: search result | query: ${query.slice(0, 2000)}`;

/** Active records with no vector of the current model, or one made from an older text; newest first. */
export function pendingVectors(db: MemoryDatabase, limit: number): Array<{ id: string; projectId: string; content: string }> {
  if (!vectorsReady(db) || limit <= 0) return [];
  const rows = db.prepare(`SELECT m.id, m.project_id, m.content, v.content_sha AS sha, v.model AS model FROM lane_pilot_memory m
    LEFT JOIN lane_pilot_memory_vec v ON v.id=m.id WHERE m.status='active' ORDER BY m.created_at DESC`)
    .all() as Array<{ id: string; project_id: string; content: string; sha: string | null; model: string | null }>;
  return rows.filter((row) => row.model !== EMBED_MODEL || row.sha !== contentSha(row.content)).slice(0, limit)
    .map((row) => ({ id: row.id, projectId: row.project_id, content: row.content }));
}

export function storeVectors(db: MemoryDatabase, rows: ReadonlyArray<{ id: string; projectId: string; content: string; vector: Float32Array }>, now = Date.now()): void {
  if (!rows.length || !vectorsReady(db)) return;
  const put = db.prepare("INSERT OR REPLACE INTO lane_pilot_memory_vec (id,project_id,model,content_sha,vec,created_at) VALUES(?,?,?,?,?,?)");
  db.transaction(() => { for (const row of rows) put.run(row.id, row.projectId, EMBED_MODEL, contentSha(row.content), Buffer.from(unit(row.vector).buffer), now); })();
}

const unit = (vector: Float32Array): Float32Array => {
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(vector, (value) => value / norm);
};

type Matrix = { key: string; ids: string[]; data: Float32Array; dim: number };
const matrices = new WeakMap<object, Map<string, Matrix>>();

/** The project's vectors in one array, kept until a vector of the project is added or replaced. */
function projectMatrix(db: MemoryDatabase, projectId: string): Matrix | null {
  const stamp = db.prepare("SELECT count(*) AS n, COALESCE(max(created_at),0) AS last FROM lane_pilot_memory_vec WHERE project_id=? AND model=?").get(projectId, EMBED_MODEL) as { n: number; last: number };
  if (!stamp.n) return null;
  const key = `${stamp.n}|${stamp.last}`;
  const byProject = matrices.get(db) ?? new Map<string, Matrix>();
  matrices.set(db, byProject);
  const known = byProject.get(projectId);
  if (known?.key === key) return known;
  const rows = db.prepare("SELECT id, vec FROM lane_pilot_memory_vec WHERE project_id=? AND model=?").all(projectId, EMBED_MODEL) as Array<{ id: string; vec: Buffer }>;
  const dim = rows[0]!.vec.byteLength / 4;
  const data = new Float32Array(rows.length * dim);
  rows.forEach((row, index) => data.set(new Float32Array(row.vec.buffer.slice(row.vec.byteOffset, row.vec.byteOffset + dim * 4)), index * dim));
  const matrix = { key, ids: rows.map((row) => row.id), data, dim };
  byProject.set(projectId, matrix);
  return matrix;
}

/** Every vectored record of the project with its cosine to the question, best first; null when the project has no vectors yet. */
export function denseRank(db: MemoryDatabase, projectId: string, query: Float32Array): Array<{ id: string; similarity: number }> | null {
  if (!vectorsReady(db)) return null;
  const matrix = projectMatrix(db, projectId);
  if (!matrix || matrix.dim !== query.length) return null;
  const q = unit(query);
  const out = matrix.ids.map((id, row) => {
    let dot = 0;
    const base = row * matrix.dim;
    for (let i = 0; i < matrix.dim; i++) dot += matrix.data[base + i]! * q[i]!;
    return { id, similarity: dot };
  });
  return out.sort((a, b) => b.similarity - a.similarity);
}

/**
 * Question vectors an async caller made before a sync search: the search paths are synchronous (the writer's brief, the PM context),
 * the embedding call is not, so the caller awaits the embedding first and the search finds the vector here by the question's text.
 * A question nobody embedded is searched by words, as before.
 * ponytail: a process-wide map of the last 256 questions; pass the vector through SearchOptions if two callers ever need different ones.
 */
const queryVectors = new Map<string, Float32Array>();
export function rememberQueryVector(query: string, vector: Float32Array): void {
  queryVectors.delete(query);
  queryVectors.set(query, unit(vector));
  if (queryVectors.size > 256) queryVectors.delete(queryVectors.keys().next().value!);
}
export const queryVectorFor = (query: string): Float32Array | undefined => queryVectors.get(query);
