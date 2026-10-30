import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { fileFingerprint, storeMemoryRecords } from "../../packages/memory-core/src";
import { openDatabase } from "../../src/rooms/storage/database";
import { mixWriterMemory } from "../../src/rooms/memory/server/memory-mix";

const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 999, noteBudget: 9_999, indexBudget: 99_999 };
const task = { owns_paths: ["src/rooms/widget.ts"], read_first: [] as string[] };

describe("writer memory and file drift", () => {
  it("leaves out a note about a file that changed since the note was stored", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    const files = new Map<string, Uint8Array>([
      ["src/rooms/widget.ts", new TextEncoder().encode("one")],
      ["src/rooms/stable.ts", new TextEncoder().encode("stay")],
      ["src/rooms/legacy.ts", new TextEncoder().encode("old")],
    ]);
    const readFile = (path: string) => files.get(path) ?? null;
    const changed = "The widget layout lives in src/rooms/widget.ts";
    const stable = "The widget layout also uses src/rooms/stable.ts";
    const legacy = "The widget layout mentions src/rooms/legacy.ts";
    storeMemoryRecords(db, { projectId: "P", ...limits, readFile, entries: [
      { kind: "note", content: changed, concepts: ["widget"] },
      { kind: "note", content: stable, concepts: ["widget"] },
    ] });
    storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: legacy, concepts: ["widget"] }] });
    const stored = db.prepare("SELECT file_fingerprint AS fingerprint FROM lane_pilot_memory WHERE content=?").get(changed) as { fingerprint: string };
    expect(stored.fingerprint).toBe(fileFingerprint([{ path: "src/rooms/widget.ts", bytes: files.get("src/rooms/widget.ts")! }]));
    files.set("src/rooms/widget.ts", new TextEncoder().encode("two"));
    files.set("src/rooms/legacy.ts", new TextEncoder().encode("rewritten"));
    const mix = mixWriterMemory(db, { projectId: "P", query: "widget layout", task, searchEngine: "fts5", personalBot: "", ruleMemoryIds: new Set(), readFile });
    expect(mix.text).not.toContain("widget.ts");
    expect(mix.text).toContain("stable.ts");
    expect(mix.text).toContain("legacy.ts");
  });
});
