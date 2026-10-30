import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { dropMemoryIndexes, retireStaleCuratorClaims, searchMemoryRecords, storeMemoryRecords } from "../../packages/memory-core/src";

const limits = { projectId: "P", audience: "subagent" as const, sourceSha256: "a".repeat(64), coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999 };

describe("retired memory-profile curator", () => {
  it("expires a note that says the nightly curator is running", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const stale = storeMemoryRecords(db, { ...limits, entries: [{ kind: "note", content: "The nightly memory-profile curator is running and updates the card.", concepts: ["profile"] }] }).insertedIds[0]!;
    const kept = storeMemoryRecords(db, { ...limits, entries: [{ kind: "note", content: "Writers keep one port per service in src/home/port.ts.", concepts: ["port"] }] }).insertedIds[0]!;
    expect(retireStaleCuratorClaims(db, "P", (projectId, id) => dropMemoryIndexes(db, projectId, id))).toEqual([stale]);
    expect(db.prepare("SELECT status, expired_reason FROM lane_pilot_memory WHERE id=?").get(stale)).toEqual({ status: "expired", expired_reason: "dated" });
    const found = searchMemoryRecords(db, "P", "nightly curator port", 10, "auto").map((row) => row.id);
    expect(found).toEqual([kept]);
  });
});
