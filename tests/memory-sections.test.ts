import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/storage/database";
import { isSharedScope, resolveProjectKind, searchMemoryRecords, sharedScope, storeMemoryRecords } from "../packages/memory-core/src";

const setup = (scope: string[], content: string) => {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  storeMemoryRecords(db, { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent", coreBudget: 999, noteBudget: 999, indexBudget: 999, scope, entries: [{ kind: "note", content, concepts: ["deploy"] }] });
  return db;
};

describe("M7 sections are developments of their own", () => {
  it("auto resolves umbrella only when sections are in use; standalone otherwise", () => {
    expect(resolveProjectKind("auto", true)).toBe("umbrella");
    expect(resolveProjectKind("auto", false)).toBe("standalone");
    expect(resolveProjectKind("standalone", true)).toBe("standalone");
  });

  it("shared marker reads as project-wide, scope with a reason keeps it", () => {
    expect(isSharedScope(sharedScope("hub-infra"))).toBe(true);
    expect(isSharedScope(["section:a"])).toBe(false);
    expect(sharedScope("hub infra")[0]).toBe("project:hub-infra");
  });

  it("a pre-M7 bare [] scope stays project-wide in an umbrella and reads as legacy_scope", () => {
    const db = setup([], "deploy the invoice service on the hub gateway");
    const sectioned = searchMemoryRecords(db, "P", "invoice service deploy", 10, "bm25", "subagent", "", { chain: ["section:x"], umbrella: true });
    expect(sectioned.length).toBeGreaterThan(0);
    expect(sectioned[0]!.legacyScope).toBe(true);
    const standalone = searchMemoryRecords(db, "P", "invoice service deploy", 10, "bm25", "subagent", "", { chain: ["section:x"], umbrella: false });
    expect(standalone.length).toBeGreaterThan(0);
    db.close();
  });

  it("a post-M7 unassigned write reaches no section of an umbrella", () => {
    const db = setup(["unassigned"], "deploy the invoice service on the hub gateway");
    const sectioned = searchMemoryRecords(db, "P", "invoice service deploy", 10, "bm25", "subagent", "", { chain: ["section:x"], umbrella: true });
    expect(sectioned.map((row) => row.id)).toEqual([]);
    db.close();
  });

  it("a record marked project:hub-infra reaches every section of an umbrella", () => {
    const db = setup(sharedScope("hub-infra"), "the hub gateway deploys with env BB_CLI");
    const found = searchMemoryRecords(db, "P", "hub gateway deploy", 10, "bm25", "subagent", "", { chain: ["section:x"], umbrella: true });
    expect(found.length).toBeGreaterThan(0);
    db.close();
  });
});
