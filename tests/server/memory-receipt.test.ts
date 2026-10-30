import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { recordMemoryReceipt } from "../../packages/memory-core/src";

describe("a retrieval receipt", () => {
  it("stores ids and a token count, not the note text", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    recordMemoryReceipt(db, { projectId: "P", role: "writer", returnedIds: ["a", "b"], packedIds: ["a"], tokens: 12, now: 50 });
    const row = db.prepare("SELECT project_id, role, returned_ids, packed_ids, tokens FROM lane_pilot_memory_receipt").get() as { project_id: string; role: string; returned_ids: string; packed_ids: string; tokens: number };
    expect(row).toEqual({ project_id: "P", role: "writer", returned_ids: '["a","b"]', packed_ids: '["a"]', tokens: 12 });
    expect(JSON.stringify(row)).not.toContain("secret");
  });
});
