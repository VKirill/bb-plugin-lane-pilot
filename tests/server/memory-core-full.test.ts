import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { coreShelf, memoryMaintenancePrompt, memoryRecordId, parseMemoryCandidates, parseMemorySettings, storeMemoryRecords, storeMemoryRecordsKeepingOverflow } from "../../packages/memory-core/src";

/**
 * The after-acceptance graph went red 17 times in a day (workflow:d993969ffaae, hub 2026-10-27/28) because the memory maintainer's batch
 * was refused whole: the core of proj_ejbam66722 held 3070 of 3072 tokens and the store counts the active core plus the new core entries.
 * The other two refusals were a stray key in one entry. The outputs below are the maintainers' real answers (bb thread output).
 */
type Db = ReturnType<typeof openDatabase>;
const fixture = (name: string) => readFileSync(new URL(`../fixtures/memory-maintainer/${name}.json`, import.meta.url), "utf8");
const settings = parseMemorySettings({});
const base = { projectId: "proj_ejbam66722", audience: "subagent" as const, sourceSha256: "a".repeat(64), coreBudget: 3072, noteBudget: 24000, indexBudget: 65536 };

/** A core of 3070 tokens (30 records of 100 and one of 70), as on the hub when item-fixes was refused with 3135/3072. */
function fullCore(): Db {
  const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
  const entries = [...Array.from({ length: 30 }, (_, index) => ({ kind: "core" as const, content: `Convention ${String(index).padStart(2, "0")} `.padEnd(400, "x"), concepts: ["convention"] })),
    { kind: "core" as const, content: "Last convention ".padEnd(280, "y"), concepts: ["convention"] }];
  storeMemoryRecords(db, { ...base, sourceSha256: "b".repeat(64), entries, coreBudget: 1_000_000 });
  return db;
}

describe("a full project core no longer fails memory maintenance", () => {
  it("reproduces the hub refusal with the old door", () => {
    const db = fullCore();
    expect(coreShelf(db, base.projectId, "", "subagent").tokens).toBe(3070);
    const entries = parseMemoryCandidates(fixture("item-fixes-core-full"), settings);
    expect(() => storeMemoryRecords(db, { ...base, entries })).toThrow("memory core budget exceeded: 3135/3072 tokens");
  });

  it("keeps every entry of the real batch: the core entries that do not fit are stored as notes", () => {
    const db = fullCore();
    const entries = parseMemoryCandidates(fixture("item-fixes-core-full"), settings);
    const stored = storeMemoryRecordsKeepingOverflow(db, { ...base, entries });
    expect(stored.demoted).toBe(2);
    expect(stored.insertedIds).toHaveLength(entries.length);
    expect(stored.entries.every((entry) => entry.kind === "note")).toBe(true);
    for (const entry of stored.entries) expect(stored.insertedIds).toContain(memoryRecordId(base.projectId, entry.kind, entry.content));
    // The core itself is not touched: curated records are never evicted by this door.
    expect(coreShelf(db, base.projectId, "", "subagent").tokens).toBe(3070);
  });

  it("demotes only what does not fit, the last core entry first", () => {
    const db = fullCore();
    const small = { kind: "core" as const, content: "x", concepts: [] };
    const big = { kind: "core" as const, content: "a core entry that is far too long for two tokens", concepts: [] };
    const stored = storeMemoryRecordsKeepingOverflow(db, { ...base, entries: [small, big] });
    expect(stored.demoted).toBe(1);
    expect(stored.entries.map((entry) => entry.kind)).toEqual(["core", "note"]);
  });

  it("still throws a refusal that is not the core budget", () => {
    const db = fullCore();
    expect(() => storeMemoryRecordsKeepingOverflow(db, { ...base, noteBudget: 1, entries: [{ kind: "note", content: "word ".repeat(50), concepts: [] }] })).toThrow("note budget");
  });

  it("an outdated core record named in supersedes makes room for its replacement", () => {
    const db = fullCore();
    const shelf = coreShelf(db, base.projectId, "", "subagent");
    const stored = storeMemoryRecordsKeepingOverflow(db, { ...base, entries: [{ kind: "core", content: "A short convention that replaces an outdated one", concepts: [], supersedes: [shelf.replaceable[0]!.id.slice(0, 12)] }] });
    expect(stored.demoted).toBe(0);
    expect(stored.supersededIds).toEqual([shelf.replaceable[0]!.id]);
  });

  it("tells the maintainer how full the core is and which core records it may replace", () => {
    const db = fullCore();
    const { tokens, replaceable } = coreShelf(db, base.projectId, "", "subagent");
    const prompt = memoryMaintenancePrompt({ task: {}, acceptedResult: {}, settings, core: { tokens, records: replaceable } });
    expect(prompt).toContain("CORE holds 3070 of 3072 tokens now");
    expect(prompt).toContain("EXISTING CORE");
    expect(prompt).toContain(`${replaceable[0]!.id.slice(0, 12)}: ${replaceable[0]!.content.slice(0, 40)}`);
    expect(memoryMaintenancePrompt({ task: {}, acceptedResult: {}, settings })).not.toContain("CORE holds");
  });
});

describe("a stray key in one entry no longer loses the whole batch", () => {
  it("reads `\"review\": true` as the concept review (model-guide-fix2)", () => {
    const entries = parseMemoryCandidates(fixture("model-guide-fix2-review-flag"), settings);
    expect(entries).toHaveLength(6);
    expect(entries[0]!.concepts).toContain("review");
  });

  it("drops an empty extra like `\"concepts_extra\": []` (model-accept-fixes)", () => {
    expect(parseMemoryCandidates(fixture("model-accept-fixes-empty-extra"), settings)).toHaveLength(5);
  });

  it("still refuses a key that carries something", () => {
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x y z", concepts: [], audience: "pm" }], settings)).toThrow("unsupported fields");
    expect(() => parseMemoryCandidates([{ kind: "note", content: "x y z", concepts: [], review: "yes" }], settings)).toThrow("unsupported fields");
  });
});
