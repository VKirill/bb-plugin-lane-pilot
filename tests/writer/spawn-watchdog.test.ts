import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnWriterAttemptWatched } from "../../src/rooms/writer/server/services/spawn-watchdog";
import type { SpawnInput, SpawnResult } from "../../src/rooms/writer/server/services/spawn-types";

afterEach(() => { vi.useRealTimers(); });

describe("writer start watchdog", () => {
  it("stops polling once the database is closed instead of throwing from its timer", () => {
    vi.useFakeTimers();
    // A closed better-sqlite3 handle: any prepare() throws «The database connection is not open».
    const db = { open: false, prepare: () => { throw new TypeError("The database connection is not open"); } };
    void spawnWriterAttemptWatched({ db: db as never, log: () => {} }, { attemptId: "a1" } as SpawnInput, () => new Promise<SpawnResult>(() => {}));
    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
