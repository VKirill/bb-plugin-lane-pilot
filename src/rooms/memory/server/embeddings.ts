import { EMBED_DIM, EMBED_MODEL, documentText, pendingVectors, queryText, queryVectorFor, rememberQueryVector, storeVectors, type MemoryDatabase } from "@lane-pilot/memory-core";
import { scheduleIsolated, type ServerCore } from "../../core/server";
import { envCatalogKey } from "../../learning";

/**
 * The vectors of the meaning search (`packages/memory-core/src/vectors.ts`), made by Google's embedding API. One key from the Env
 * Catalog (GEMINI_API_KEY_AISTUDIO: project selfystudio, Tier 3 postpay, so the texts are not used for training); the whole memory (~930 records) is about 4 cents. No key, a timeout or
 * an error leave the search on words: nothing here can fail a search.
 */
export const EMBED_KEY_NAME = "GEMINI_API_KEY_AISTUDIO";
export const EMBED_SCHEDULE = "memory-embed";
const URL = `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents`;
const BATCH = 50, QUERY_TIMEOUT_MS = 4000, BATCH_TIMEOUT_MS = 60_000;

export type Embedder = (texts: readonly string[], timeoutMs: number) => Promise<Float32Array[] | null>;

export function googleEmbedder(key: () => Promise<string | undefined>, fetchImpl: typeof fetch = fetch): Embedder {
  return async (texts, timeoutMs) => {
    try {
      // Inside the try: a reloaded plugin's old handle throws here, and a search must still run on words.
      const apiKey = await key();
      if (!apiKey || !texts.length) return null;
      const response = await fetchImpl(`${URL}?key=${encodeURIComponent(apiKey)}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(timeoutMs),
        body: JSON.stringify({ requests: texts.map((text) => ({ model: `models/${EMBED_MODEL}`, content: { parts: [{ text }] }, outputDimensionality: EMBED_DIM })) }),
      });
      if (!response.ok) return null;
      const body = await response.json() as { embeddings?: Array<{ values?: number[] }> };
      const vectors = (body.embeddings ?? []).map((item) => Float32Array.from(item.values ?? []));
      return vectors.length === texts.length && vectors.every((vector) => vector.length === EMBED_DIM) ? vectors : null;
    } catch { return null; }
  };
}

let shared: Embedder | null = null;
/** The embedder of this server, set by `mountMemoryEmbeddings`; tests and tools may set their own. */
export const setEmbedder = (embedder: Embedder | null): void => { shared = embedder; };

/**
 * Makes the question's vector before a search, so the synchronous search paths rank by meaning (`rememberQueryVector`). Awaited by the
 * query paths; false when there is no embedder or the call failed — the search then runs on words.
 */
export async function embedQuery(query: string): Promise<boolean> {
  if (!shared || !query.trim()) return false;
  if (queryVectorFor(query)) return true;
  const vectors = await shared([queryText(query)], QUERY_TIMEOUT_MS);
  if (!vectors) return false;
  rememberQueryVector(query, vectors[0]!);
  return true;
}

/** Embeds up to `limit` records that have no current vector; returns how many were stored. */
export async function embedPending(db: MemoryDatabase, embedder: Embedder, limit = 500): Promise<number> {
  const pending = pendingVectors(db, limit);
  let stored = 0;
  for (let index = 0; index < pending.length; index += BATCH) {
    const chunk = pending.slice(index, index + BATCH);
    const vectors = await embedder(chunk.map((row) => documentText(row.content)), BATCH_TIMEOUT_MS);
    if (!vectors) break;
    storeVectors(db, chunk.map((row, at) => ({ ...row, vector: vectors[at]! })));
    stored += chunk.length;
  }
  return stored;
}

export function mountMemoryEmbeddings(ctx: ServerCore): void {
  const embedder = googleEmbedder(envCatalogKey(ctx.bb, EMBED_KEY_NAME));
  setEmbedder(embedder);
  // Every five minutes: new and changed records get their vector; a record waits at most that long before the meaning search sees it
  // (the word search finds it at once).
  scheduleIsolated(ctx.bb, EMBED_SCHEDULE, "*/5 * * * *", async (signal) => {
    if (ctx.isDisposed() || signal?.aborted) return;
    const stored = await embedPending(ctx.db, embedder);
    if (stored) ctx.log(`memory embeddings: ${stored} records`);
  }, { timeoutMs: 10 * 60_000 });
}
