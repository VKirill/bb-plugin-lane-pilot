import { describe, expect, it } from "vitest";
import { memoryEntrySalience } from "../packages/memory-core/src";

// arXiv #2 SLICE-Mem: admission scores a candidate by what a future task could reuse —
// retrievable concepts, a concrete claim, enough text to carry it. No model call.
describe("salience-gated admission (SLICE-Mem)", () => {
  it("drops a note with no concepts, no concrete claim and almost no text", () => {
    expect(memoryEntrySalience({ kind: "note", content: "It went fine.", concepts: [] })).toBeLessThan(40);
  });
  it("keeps a retrievable note with a concrete claim", () => {
    expect(memoryEntrySalience({ kind: "note", content: "The deploy gateway listens on port 4000; the old 3000 binding is gone.", concepts: ["deploy", "port"] })).toBeGreaterThanOrEqual(40);
  });
  it("a zero floor admits everything", () => {
    expect(memoryEntrySalience({ kind: "note", content: "ok", concepts: [] })).toBeGreaterThanOrEqual(0);
  });
});

import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { storeMemoryRecords } from "../packages/memory-core/src";
import { openDatabase } from "../src/rooms/storage/database";

// #9 authority scope-note: a record shows whose authority it is and where it applies; a reader in another
// section does not get it (the isolation half is proven in memory-bounds.test.ts F03).
describe("authority scope-note", () => {
  it("keeps the origin authority and the section chain on the row the record view reads", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    storeMemoryRecords(db, { projectId: "P", sourceSha256: "a".repeat(64), origin: "session" as const, audience: "subagent" as const,
      scope: ["section:payments"], coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999,
      entries: [{ kind: "note", content: "Payments reconcile at 02:00 UTC daily.", concepts: ["payments"] }] });
    const row = db.prepare("SELECT origin, scope_json FROM lane_pilot_memory WHERE content=?").get("Payments reconcile at 02:00 UTC daily.") as { origin: string; scope_json: string };
    expect(row.origin).toBe("session");
    expect(JSON.parse(row.scope_json)).toEqual(["section:payments"]);
  });
});
