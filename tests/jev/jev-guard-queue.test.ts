import { expect, it } from "vitest";
import { GUARD_BLOCKED_KEY, createOutputGuard } from "@lane-pilot/jev";

it("A-032 two concurrent blocked outputs both reach the self-repair block ledger", async () => {
  const values = new Map<string, unknown>();
  let readers = 0;
  let release!: () => void;
  const bothRead = new Promise<void>((resolve) => { release = resolve; });
  const guard = createOutputGuard({
    jev: () => ({ enabled: () => true, judge: async () => ({ by: "jev", decision: { blocked: true, reason: "injection" } }) }) as never,
    settings: async () => ({ "jev.modes": "output.guard=active" }),
    kv: {
      get: async <T>(key: string) => {
        const old = values.get(key) as T | undefined;
        if (key === GUARD_BLOCKED_KEY) {
          if (++readers === 2) release();
          await bothRead;
        }
        return old;
      },
      set: async (key: string, value: unknown) => { values.set(key, value); },
    },
    log: () => {},
  });
  const results = await Promise.all(["run-a", "run-b"].map((runId) => guard({
    kind: "browser", projectId: "fixture", runId,
    text: "A harmless fixture output repeated to exceed the guard minimum length.",
  })));
  expect(results.every((result) => result.blocked)).toBe(true);
  const kept = values.get(GUARD_BLOCKED_KEY) as Array<{ runId: string }>;
  expect(kept.map((row) => row.runId).sort()).toEqual(["run-a", "run-b"]);
});
