import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { searchMemoryRecords, storeMemoryRecords } from "../packages/memory-core/src";
import { openDatabase } from "../src/rooms/storage/database";

const limits = { audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };

// arXiv #21: the row keeps who vouched for it; a second independent source confirms an observed note.
describe("verification signal on records", () => {
  it("seeds the writer as the first source and appends the corroborating one", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const content = "The API gateway listens on port 3000.";
    storeMemoryRecords(db, { projectId: "P", ...limits, sourceSha256: "a".repeat(64), trust: "observed", origin: "session", entries: [{ kind: "note", content, concepts: ["port"] }] });
    const result = storeMemoryRecords(db, { projectId: "P", ...limits, sourceSha256: "b".repeat(64), trust: "observed", origin: "session", entries: [{ kind: "note", content, concepts: ["port"] }] });
    expect(result.corroboratedIds).toHaveLength(1);
    const row = db.prepare("SELECT trust, verification_json FROM lane_pilot_memory WHERE id=?").get(result.corroboratedIds[0]!) as { trust: string; verification_json: string };
    expect(row.trust).toBe("confirmed");
    const signals = JSON.parse(row.verification_json) as Array<{ by: string; sha: string }>;
    expect(signals.map((signal) => signal.sha)).toEqual(["a".repeat(64), "b".repeat(64)]);
    const found = searchMemoryRecords(db, "P", "port", 10, "auto", "subagent", "", { includeObserved: true })[0]!;
    expect(found.verification).toHaveLength(2);
  });
});
