import { expect, it } from "vitest";
import { DOCS_WORKTREE_PREFIX, docsWorktreeKey, REGRESS_MARKER_TTL_MS, REGRESS_WORKTREE_PREFIX, regressWorktreeKey, regressWorktreePath, SELF_REPAIR_STATE_KEY, selfRepairWorktrees } from "../src/rooms/contracts/worktrees";

// Pin the KV liveness keys: rows written by older builds carry these strings and the janitor must still read them.
it("keeps the worktree liveness keys byte-identical", () => {
  expect(DOCS_WORKTREE_PREFIX).toBe("docs-worktree:");
  expect(docsWorktreeKey("host1", "docs-abcdef")).toBe("docs-worktree:host1:docs-abcdef");
  expect(REGRESS_WORKTREE_PREFIX).toBe("regress-worktree:");
  expect(regressWorktreeKey("/tmp/wt/1")).toBe("regress-worktree:/tmp/wt/1");
  expect(regressWorktreePath("regress-worktree:/tmp/wt/1")).toBe("/tmp/wt/1");
  expect(REGRESS_MARKER_TTL_MS).toBe(6 * 3_600_000);
  expect(SELF_REPAIR_STATE_KEY).toBe("self-repair:state");
});

it("reads worktrees a self-repair state still holds, pending spawns included", () => {
  const state = { signatures: {
    a: { worktree: { hostId: "h1", path: "/p1", branch: "b1" } },
    b: { worktree: null, pending: { worktree: { hostId: "h2", path: "/p2" } } },
    c: {},
  } };
  expect(selfRepairWorktrees(state)).toEqual([
    { signature: "a", worktree: { hostId: "h1", path: "/p1", branch: "b1" } },
    { signature: "b", worktree: { hostId: "h2", path: "/p2" } },
  ]);
  expect(selfRepairWorktrees(null)).toEqual([]);
});
