import { describe, expect, it } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { syncOwnsBarrier } from "../src/rooms/writer/server/owns-barrier-sync";

// EXT05 (layers audit 2026-11-15): an in-place owns_paths change goes out only when the worktree's barrier follows it.
const before = { owns_paths: ["src/a.ts"], never_touch: ["secrets/**"] } as unknown as TaskV2;
const after = { owns_paths: ["src/a.ts", "src/b.ts"], never_touch: ["secrets/**"] } as unknown as TaskV2;

function world(answer: (input: { ownsPaths: string[] }, nth: number) => unknown, settings: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; ownsPaths: string[]; worktreePath: string }> = [];
  const ctx = {
    db: { prepare: () => ({ get: () => undefined, all: () => [] }) },
    effectiveProjectSettings: async () => ({ values: settings }),
    log: () => undefined,
    host: { call: async (method: string, input: { ownsPaths: string[]; worktreePath: string }) => {
      calls.push({ method, ownsPaths: input.ownsPaths, worktreePath: input.worktreePath });
      return answer(input, calls.length);
    } },
  } as never;
  const sync = (from: TaskV2, to: TaskV2, worktreePath: string | null = "/lane/repo/a1") =>
    syncOwnsBarrier(ctx, { projectId: "p", runId: "r", hostId: "h1", worktreePath, from, to });
  return { calls, sync };
}

const applied = () => ({ hostId: "h1", status: "applied", locked: 0, unlocked: 1 });

describe("syncOwnsBarrier", () => {
  it("brings the worktree's barrier to the new contract before the change goes out", async () => {
    const w = world(applied);
    expect(await w.sync(before, after)).toEqual({ ok: true });
    expect(w.calls).toEqual([{ method: "gitOwnsBarrier", ownsPaths: ["src/a.ts", "src/b.ts"], worktreePath: "/lane/repo/a1" }]);
  });

  it("asks nothing when owns_paths and never_touch did not change, the attempt has no worktree, or the barrier is off", async () => {
    const w = world(applied);
    expect(await w.sync(before, { ...before, title: "Other words" } as TaskV2)).toEqual({ ok: true });
    expect(await w.sync(before, after, null)).toEqual({ ok: true });
    expect(w.calls).toEqual([]);
    const off = world(applied, { "writer.owns_barrier": "off" });
    expect(await off.sync(before, after)).toEqual({ ok: true });
    expect(off.calls).toEqual([]);
  });

  it("refuses the change when the host worker has no such operation, and has nothing to put back", async () => {
    const w = world(() => { throw Object.assign(new Error("no such host method"), { code: "unknown_method" }); });
    const result = await w.sync(before, after);
    expect(result).toMatchObject({ ok: false, uncertain: false });
    expect(w.calls).toHaveLength(1);
  });

  it("refuses an unknown answer as uncertain, after one call that brings the old contract's barrier back", async () => {
    const w = world((_input, nth) => { if (nth === 1) throw new Error("host call timed out"); return applied(); });
    const result = await w.sync(before, after);
    expect(result).toMatchObject({ ok: false, uncertain: true });
    expect(w.calls.map((call) => call.ownsPaths)).toEqual([["src/a.ts", "src/b.ts"], ["src/a.ts"]]);
    // A rollback that fails as well is still uncertain, never «no change».
    const both = world(() => { throw new Error("transport down"); });
    expect(await both.sync(before, after)).toMatchObject({ ok: false, uncertain: true });
  });

  it("never reads an answer without a known status as done: undefined, null or another status is uncertain", async () => {
    for (const odd of [undefined, null, {}, { status: "partial" }]) {
      const w = world((_input, nth) => (nth === 1 ? odd : applied()));
      expect(await w.sync(before, after)).toMatchObject({ ok: false, uncertain: true });
      expect(w.calls).toHaveLength(2);
    }
  });
});
