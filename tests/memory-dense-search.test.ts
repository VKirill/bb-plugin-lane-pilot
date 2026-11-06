import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { EMBED_DIM, DENSE_FLOOR, pendingVectors, rememberQueryVector, relevantRecords, searchMemoryRecords, storeMemoryRecords, storeVectors } from "../packages/memory-core/src";
import { openDatabase } from "../src/rooms/storage/database";
import { embedPending, embedQuery, setEmbedder } from "../src/rooms/memory/server/embeddings";

/** The meaning search (vectors.ts): a question that shares no word with the record still finds it; without vectors it is the word search. */
const limits = { sourceSha256: "c".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const axis = (i: number, j = i, mix = 0) => { const v = new Float32Array(EMBED_DIM); v[i] = 1 - mix; v[j] += mix; return v; };

function setup() {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  const add = (content: string) => storeMemoryRecords(db, { projectId: "P", personalBot: "", ...limits, entries: [{ kind: "note", content, concepts: [] }] }).insertedIds[0]!;
  return { db, backup: add("bb-backups: /opt/backups/bb-backup.sh runs at 04:00 and 16:00 UTC."), web: add("BB web lives at https://bb.vechkasov.pro behind Caddy.") };
}

describe("meaning search", () => {
  it("ranks by cosine when the question was embedded, and keeps the word search otherwise", () => {
    const { db, backup, web } = setup();
    storeVectors(db, [{ id: backup, projectId: "P", content: "x", vector: axis(0) }, { id: web, projectId: "P", content: "y", vector: axis(1) }]);
    const query = "Как настроены резервные копии сервера?";
    expect(searchMemoryRecords(db, "P", query, 5, "auto", "subagent", "", { includeObserved: true })).toEqual([]); // no shared word
    rememberQueryVector(query, axis(0, 1, 0.2));
    const found = searchMemoryRecords(db, "P", query, 5, "auto", "subagent", "", { includeObserved: true });
    expect(found.map((record) => record.id)).toEqual([backup, web]);
    expect(found[0]!.similarity).toBeGreaterThan(found[1]!.similarity!);
    // The floor drops the record whose cosine is below DENSE_FLOOR.
    const kept = relevantRecords(db, "P", query, found);
    expect(kept.map((record) => record.id)).toEqual([backup]);
    expect(found[1]!.similarity!).toBeLessThan(DENSE_FLOOR);
  });

  it("embeds the records that have no vector, and a failed embedder leaves the search on words", async () => {
    const { db, backup } = setup();
    expect(pendingVectors(db, 10)).toHaveLength(2);
    setEmbedder(async (texts) => texts.map((_, index) => axis(index)));
    expect(await embedPending(db, async (texts) => texts.map((_, index) => axis(index)))).toBe(2);
    expect(pendingVectors(db, 10)).toHaveLength(0);
    setEmbedder(async () => null);
    expect(await embedQuery("bb-backup schedule")).toBe(false);
    expect(searchMemoryRecords(db, "P", "bb-backup schedule", 5, "auto", "subagent", "", { includeObserved: true }).map((record) => record.id)).toContain(backup);
    setEmbedder(null);
  });
});
