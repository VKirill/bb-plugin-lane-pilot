import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { recordMemoryAccepted, recordMemoryMixed, searchMemoryRecords, storeMemoryRecords } from "../packages/memory-core/src";
import { openDatabase } from "../src/rooms/storage/database";

const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
const OLD = "Service deployment uses port 3000 for the API gateway.";
const NEW = "Service deployment uses port 4000 for the API gateway.";

// arXiv #15: a same-subject replacement of a note recent accepted work still cites is a conflict, not a silent overwrite.
describe("stability check before supersede", () => {
  it("holds the replacement pair instead of superseding a recently used note", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const first = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: OLD, concepts: ["deployment", "port"] }] });
    recordMemoryMixed(db, "P", first.insertedIds, Date.now());
    recordMemoryAccepted(db, "P", first.insertedIds);
    const second = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: NEW, concepts: ["deployment", "port"] }] });
    expect(second.supersededIds).toEqual([]);
    expect(second.heldIds).toEqual(first.insertedIds);
    // Both stay active in the table but invisible to readers while held.
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_memory WHERE status='active'").get()).toEqual({ n: 2 });
    expect(searchMemoryRecords(db, "P", "deployment port", 10, "auto", "subagent", "", {})).toEqual([]);
    expect(db.prepare("SELECT state FROM lane_pilot_memory_conflict").all()).toEqual([{ state: "held" }]);
  });

  it("still supersedes a note nobody was given recently", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: OLD, concepts: ["deployment", "port"] }] });
    const second = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: NEW, concepts: ["deployment", "port"] }] });
    expect(second.supersededIds).toHaveLength(1);
    expect(second.heldIds).toEqual([]);
  });
});
