import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import { CHUNK_CHARS, DOC_CHARS, EMBED_DIM, contentChunks, deleteMemoryRecord, eraseLeftovers, memoryContext, pendingChunks, rememberQueryVector, searchMemoryRecords, storeMemoryRecords } from "../../packages/memory-core/src";
import { embedPending } from "../../src/rooms/memory/server/embeddings";
import { memoryLine } from "../../src/rooms/memory/server/memory-picks";

const axis = (i: number) => { const v = new Float32Array(EMBED_DIM); v[i] = 1; return v; };
const paragraph = (word: string, n: number) => `${word} section ${n}: ` + `${word} filler sentence about the nightly job and its queue. `.repeat(28);
/** Eight paragraphs of about 1.6k characters: the fact about the zebra sits in the sixth, far beyond the 6000 characters the whole-record embedding reads. */
const LONG = [...Array.from({ length: 5 }, (_, n) => paragraph("alpha", n)), "ZEBRA section: the zebra crossing job runs at 03:10 and parks failed rows in services/zebra/park.ts. " + "zebra detail line. ".repeat(40), paragraph("omega", 6), paragraph("omega", 7)].join("\n\n");
const SHORT = "The catalog cache keeps entries for fifteen minutes in services/catalog/cache.ts.";

describe("contentChunks", () => {
  it("a record the window holds whole has no chunks; a longer one is cut at paragraph borders, about 1500 characters each, losing nothing", () => {
    expect(contentChunks(SHORT)).toEqual([]);
    expect(LONG.length).toBeGreaterThan(DOC_CHARS);
    const chunks = contentChunks(LONG);
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_CHARS + 2);
    expect(chunks.join("\n\n").replace(/\s+/g, " ")).toBe(LONG.replace(/\s+/g, " ").trim());
  });

  it("one paragraph longer than a chunk is cut by length", () => {
    const one = "x".repeat(DOC_CHARS + 100);
    expect(contentChunks(one).map((chunk) => chunk.length)).toEqual([1500, 1500, 1500, 1500, 100]);
  });
});

describe("a long record is found by a later paragraph", () => {
  const setup = async () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const limits = { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 999, noteBudget: 999_999, indexBudget: 999_999 };
    const [long] = storeMemoryRecords(db, { ...limits, entries: [{ kind: "note", content: LONG, concepts: ["jobs"] }] }).insertedIds;
    const [short] = storeMemoryRecords(db, { ...limits, entries: [{ kind: "note", content: SHORT, concepts: ["catalog"] }] }).insertedIds;
    // The stand-in model: a text that names the zebra is axis 5, the catalog is axis 2, anything else axis 0 (the head of the long record).
    const embed = async (texts: readonly string[]) => texts.map((text) => axis(/ZEBRA|zebra/.test(text) ? 5 : /catalog/.test(text) ? 2 : 0));
    await embedPending(db, embed);
    return { db, long: long!, short: short! };
  };

  it("scores the record by its best chunk, and says which", async () => {
    const { db, long, short } = await setup();
    const query = "When does the striped animal crossing job run?";
    rememberQueryVector(query, axis(5));
    const found = searchMemoryRecords(db, "P", query, 5, "auto", "subagent", "", { includeObserved: true });
    expect(found[0]!.id).toBe(long);
    expect(found[0]!.similarity).toBeCloseTo(1, 5);
    expect(contentChunks(LONG)[found[0]!.bestChunk!]).toContain("ZEBRA section");
    expect(found.map((record) => record.id)).toContain(short);
    expect(found.find((record) => record.id === short)!.bestChunk).toBeUndefined();
  });

  it("the pack shows the matched chunk, not the cut head, marked with its part", async () => {
    const { db } = await setup();
    const query = "When does the striped animal crossing job run?";
    rememberQueryVector(query, axis(5));
    const found = searchMemoryRecords(db, "P", query, 5, "auto", "subagent", "", { includeObserved: true });
    const packed = memoryContext(found, "zebra crossing job runs", 1600);
    expect(packed.text).toMatch(/part \d+\/\d+;/);
    expect(packed.text).toContain("zebra crossing job runs at 03:10");
    expect(packed.text).not.toContain("alpha section 0");
    expect(packed.estimatedTokens).toBeLessThanOrEqual(1600);
    const brief = memoryLine(found[0]!);
    expect(brief).toContain("zebra crossing job runs at 03:10");
    expect(brief).not.toContain("alpha section 0");
    expect(brief).not.toContain("[cut");
  });

  it("a word search with no vectors still shows the chunk that shares the question's words", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    storeMemoryRecords(db, { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent", coreBudget: 999, noteBudget: 999_999, indexBudget: 999_999, entries: [{ kind: "note", content: LONG, concepts: ["jobs"] }] });
    const found = searchMemoryRecords(db, "P", "zebra crossing job park", 5, "fts5", "subagent", "", { includeObserved: true });
    const line = memoryContext(found, "zebra crossing job park", 1600).text;
    expect(line).toContain("zebra crossing job runs at 03:10");
    expect(line).not.toContain("alpha section 0");
  });

  it("embeds the chunks once, and erasing the record leaves no chunk vector", async () => {
    const { db, long } = await setup();
    expect(pendingChunks(db, 10)).toEqual([]);
    expect((db.prepare("SELECT count(*) AS n FROM lane_pilot_memory_vec_chunk WHERE id=?").get(long) as { n: number }).n).toBe(contentChunks(LONG).length);
    deleteMemoryRecord(db, "P", long);
    expect(eraseLeftovers(db, "P", long)).toEqual([]);
  });
});
