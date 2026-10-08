import { describe, expect, it } from "vitest";
import { storeMemoryRecords } from "@lane-pilot/memory-core";
import { memoryFill } from "../../src/rooms/learning/housekeeping";
import { NOW, database } from "./helpers";

const BUDGETS = () => ({ noteBudget: 40, coreBudget: 3072 });

describe("how full the memory shelves are, and why (T7)", () => {
  function note(db: ReturnType<typeof database>, content: string, at: number) {
    return storeMemoryRecords(db, { projectId: "proj_1", audience: "subagent", sourceSha256: content, entries: [{ kind: "note", content, concepts: [] }], coreBudget: 3072, noteBudget: 40, indexBudget: 65536, now: at });
  }

  it("shows a shelf at its budget, never used, evicting by age: the design working, not a fault", () => {
    const db = database();
    const evicted: string[] = [];
    for (let i = 0; i < 30; i++) evicted.push(...note(db, `Note number ${i} says something about subject${i} that is worth keeping around.`, NOW + i * 1_000).evictedIds);
    const [shelf] = memoryFill(db, BUDGETS);
    expect(shelf).toMatchObject({ projectId: "proj_1", usedNotes: 0, neverUsedNotes: shelf!.notes });
    expect(shelf!.noteTokens).toBeLessThanOrEqual(40);
    expect(shelf!.noteFill).toBeGreaterThan(0.6);
    expect(shelf!.expired).toBe(evicted.length);
    expect(evicted.length).toBeGreaterThan(20);
    // every note ties at zero use, so the oldest go first
    const alive = db.prepare("SELECT content FROM lane_pilot_memory WHERE status='active'").all() as Array<{ content: string }>;
    expect(alive.some((row) => row.content.startsWith("Note number 29"))).toBe(true);
    expect(alive.some((row) => row.content.startsWith("Note number 0 "))).toBe(false);
  });

  it("counts the notes that were used, so the figure shows whether usage drives the order", () => {
    const db = database();
    note(db, "A note a writer was given and used well in the past weeks.", NOW);
    db.prepare("UPDATE lane_pilot_memory SET use_count=3, accepted_count=3").run();
    note(db, "A note nobody was ever given at all in all the time.", NOW + 1);
    expect(memoryFill(db, BUDGETS)[0]).toMatchObject({ notes: 2, usedNotes: 1, neverUsedNotes: 1 });
  });
});
