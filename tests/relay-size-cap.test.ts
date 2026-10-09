import { describe, expect, it } from "vitest";
import { createRelay, RELAY_LIMITS, type RelayItem } from "../src/rooms/relay/server/relay";

describe("relay-size-cap", () => {
  it("exports RELAY_LIMITS.maxStoredBytes around 200 KB", () => {
    expect(RELAY_LIMITS.maxStoredBytes).toBe(200_000);
  });

  it("drops finished items oldest first when over budget, keeping all open items", async () => {
    let stored: RelayItem[] = [];
    const nowTime = 1_000_000_000;

    // Seed with 2000 fired reminders with long notes, plus 3 open ones
    const dayAgo = 86_400_000;
    const initialItems: RelayItem[] = [];
    for (let i = 0; i < 2000; i++) {
      initialItems.push({
        kind: "remind",
        id: `fired_${i}`,
        projectId: "proj",
        threadId: "th1",
        note: `Finished note number ${i} with a lot of verbose extra text padding out the payload to make sure it consumes byte budget `.repeat(3),
        dueAt: nowTime - 2 * dayAgo + i,
        watchThreadId: null,
        createdAt: nowTime - 2 * dayAgo + i, // older than 24h so not hitting remindersPerThreadPerDay
        firedAt: nowTime - 2 * dayAgo + 5_000 + i,
        firedBy: "time",
      });
    }

    // 3 open items
    const openIds = ["open_1", "open_2", "open_3"];
    for (const openId of openIds) {
      initialItems.push({
        kind: "remind",
        id: openId,
        projectId: "proj",
        threadId: "th1",
        note: `Important open note ${openId}`,
        dueAt: nowTime + 60_000,
        watchThreadId: null,
        createdAt: nowTime - 50,
        firedAt: null,
        firedBy: null,
      });
    }

    stored = structuredClone(initialItems);

    const relay = createRelay({
      load: async () => structuredClone(stored),
      save: async (items) => {
        stored = structuredClone(items);
      },
      send: async () => undefined,
      settled: async () => false,
      output: async () => "",
      taskStates: async () => ({}),
      now: () => nowTime,
      log: () => undefined,
    });

    // A new remind triggers update()
    const newRemind = await relay.remind({
      projectId: "proj",
      threadId: "th1",
      note: "Brand new reminder",
      inMinutes: 10,
    });

    // 1. Saved JSON must be <= RELAY_LIMITS.maxStoredBytes
    const serialized = JSON.stringify(stored);
    const byteLength = Buffer.byteLength(serialized);
    expect(byteLength).toBeLessThanOrEqual(RELAY_LIMITS.maxStoredBytes);

    // 2. All open items (including the new one) must be kept
    for (const openId of openIds) {
      const found = stored.find((it) => it.id === openId);
      expect(found).toBeDefined();
      expect(found?.kind === "remind" && found.firedAt).toBeNull();
    }
    const foundNew = stored.find((it) => it.id === newRemind.id);
    expect(foundNew).toBeDefined();

    // 3. Dropped items must be the oldest finished ones
    const remainingFired = stored.filter((it) => it.kind === "remind" && it.firedAt !== null);
    expect(remainingFired.length).toBeGreaterThan(0);
    expect(remainingFired.length).toBeLessThan(2000);

    // The oldest ones (i=0, 1, 2, ...) should have been dropped first
    expect(stored.find((it) => it.id === "fired_0")).toBeUndefined();
    expect(stored.find((it) => it.id === "fired_1")).toBeUndefined();

    // The ones kept should have larger createdAt than the dropped ones
    const maxDroppedCreatedAt = initialItems
      .filter((it) => !stored.some((s) => s.id === it.id))
      .reduce((max, it) => Math.max(max, it.createdAt), 0);
    const minKeptFiredCreatedAt = remainingFired.reduce((min, it) => Math.min(min, it.createdAt), Infinity);
    expect(minKeptFiredCreatedAt).toBeGreaterThanOrEqual(maxDroppedCreatedAt);
  });

  it("truncates long text fields with «…» when only open items remain and are over budget", async () => {
    let stored: RelayItem[] = [];
    const nowTime = 1_000_000_000;

    // Create several open items with very long notes/questions
    const initialItems: RelayItem[] = [];
    for (let i = 0; i < 50; i++) {
      if (i % 2 === 0) {
        initialItems.push({
          kind: "remind",
          id: `open_rem_${i}`,
          projectId: "proj",
          threadId: `thread_${i}`,
          note: "A".repeat(8000),
          dueAt: nowTime + 100_000,
          watchThreadId: null,
          createdAt: nowTime - 1000 + i,
          firedAt: null,
          firedBy: null,
        });
      } else {
        initialItems.push({
          kind: "ask",
          id: `open_ask_${i}`,
          projectId: "proj",
          fromThreadId: `from_${i}`,
          toThreadId: `to_${i}`,
          question: "B".repeat(8000),
          createdAt: nowTime - 1000 + i,
          answeredAt: null,
        });
      }
    }

    stored = structuredClone(initialItems);
    const initialBytes = Buffer.byteLength(JSON.stringify(stored));
    expect(initialBytes).toBeGreaterThan(RELAY_LIMITS.maxStoredBytes);

    const relay = createRelay({
      load: async () => structuredClone(stored),
      save: async (items) => {
        stored = structuredClone(items);
      },
      send: async () => undefined,
      settled: async () => false,
      output: async () => "",
      taskStates: async () => ({}),
      now: () => nowTime,
      log: () => undefined,
    });

    // Trigger update via list or sweep (sweep triggers update)
    await relay.sweep();

    const finalBytes = Buffer.byteLength(JSON.stringify(stored));
    expect(finalBytes).toBeLessThanOrEqual(RELAY_LIMITS.maxStoredBytes);

    // None of the open items should be dropped
    expect(stored).toHaveLength(initialItems.length);
    for (const item of initialItems) {
      const match = stored.find((it) => it.id === item.id);
      expect(match).toBeDefined();
      if (match?.kind === "remind") {
        expect(match.note).toMatch(/…$/);
        expect(match.note.length).toBeLessThan(8000);
      } else if (match?.kind === "ask") {
        expect(match.question).toMatch(/…$/);
        expect(match.question.length).toBeLessThan(8000);
      }
    }
  });
});
