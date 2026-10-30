import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { searchMemoryRecords, storeMemoryRecords } from "../packages/memory-core/src";
import { openDatabase } from "../src/rooms/storage/database";

const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };

// arXiv #10: a stored note links back to the task it was distilled from, so a person can audit provenance.
describe("origin_task_id provenance", () => {
  it("keeps the producing task id on the record", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    storeMemoryRecords(db, { projectId: "P", ...limits, originTaskId: "task_abc123", entries: [{ kind: "note", content: "Port 3000 serves the API.", concepts: ["port"] }] });
    const row = searchMemoryRecords(db, "P", "port", 10, "auto", "subagent", "", {})[0]!;
    expect(row.originTaskId).toBe("task_abc123");
    expect(db.prepare("SELECT origin_task_id FROM lane_pilot_memory WHERE id=?").get(row.id)).toEqual({ origin_task_id: "task_abc123" });
  });
});
