import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, listOpenWorktrees, openDatabase, registerWorktree } from "../src/rooms/plugin-db";
import { adoptLegacyWorktrees, reconcileWorktreeRegistry } from "../src/rooms/stability/server/worktree-janitor";
import { writerLeftWorktree } from "../src/rooms/writer/server/left-worktree";

// magicseo T3.3 (2026-10-30): the writer blocked on a question, the reconcile removed its worktree 4 s later,
// the reopened writer found no folder and moved itself to the main checkout.
describe("a blocked writer keeps its worktree", () => {
  const setup = (state: string, updatedAgoMs: number) => {
    const bb = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const db = openDatabase(bb);
    const now = Date.now();
    createRun(db, "run", "proj", "cli", "/repo");
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T3.3','run','bb','{}',0)").run();
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,reason,created_at,updated_at,workspace_path) VALUES('a1','run','T3.3',?,1,NULL,?,?,'/wt/a1/magicseo')")
      .run(state, now - 3 * 3_600_000, now - updatedAgoMs);
    registerWorktree(db, { host: "mini", path: "/wt/a1/magicseo", branch: null, owner_kind: "attempt", owner_id: "a1" }, now - 3 * 3_600_000);
    const removed: string[] = [];
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false,
      host: { call: async (_name: string, input: { worktreePath: string }) => { removed.push(input.worktreePath); return { removed: true }; } } } as never;
    return { ctx, removed, now };
  };

  it("a just-blocked attempt's copy stays", async () => {
    const { ctx, removed, now } = setup("blocked", 4_000);
    expect(await reconcileWorktreeRegistry(ctx, now)).toBe(0);
    expect(removed).toEqual([]);
  });

  it("a just-failed attempt's copy stays for the retry", async () => {
    const { ctx, removed, now } = setup("validation_failed", 60_000);
    expect(await reconcileWorktreeRegistry(ctx, now)).toBe(0);
    expect(removed).toEqual([]);
  });

  it("past the grace the copy goes", async () => {
    const { ctx, removed, now } = setup("blocked", 3 * 3_600_000);
    expect(await reconcileWorktreeRegistry(ctx, now)).toBe(1);
    expect(removed).toEqual(["/wt/a1/magicseo"]);
  });

  it("an accepted attempt's copy goes at once", async () => {
    const { ctx, now } = setup("accepted", 4_000);
    expect(await reconcileWorktreeRegistry(ctx, now)).toBe(1);
  });
});

describe("the deployed build's KV-marked worktrees", () => {
  it("are adopted into the registry at boot, and the reconcile keeps them", async () => {
    const bb = createFakePluginHost({ pluginId: "lane-pilot" }).bb;
    const db = openDatabase(bb);
    const now = Date.now();
    // Old-shape markers with no registry rows: docs reuse key, in-flight regress key, self-repair state record.
    await bb.storage.kv.set("docs-worktree:mini:docs-abc123", { path: "/wt/docs/magicseo" });
    await bb.storage.kv.set("regress-worktree:/wt/regress/magicseo", { hostId: "ovh", basePath: "/repo", at: now - 60_000 });
    await bb.storage.kv.set("regress-worktree:/wt/regress/stale", { hostId: "ovh", basePath: "/repo", at: now - 7 * 3_600_000 });
    await bb.storage.kv.set("self-repair:state", { signatures: { sig1: { worktree: { hostId: "mini", basePath: "/repo", path: "/wt/sr/fix", branch: "lane/self-repair-x" } } } });
    expect(await adoptLegacyWorktrees({ bb, db } as never, now)).toBe(3);
    const rows = listOpenWorktrees(db);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ host: "mini", path: "/wt/docs/magicseo", owner_kind: "docs", owner_id: "docs-abc123" }),
      expect.objectContaining({ host: "ovh", path: "/wt/regress/magicseo", owner_kind: "regress" }),
      expect.objectContaining({ host: "mini", path: "/wt/sr/fix", owner_kind: "self-repair", owner_id: "sig1", branch: "lane/self-repair-x" }),
    ]));
    expect(rows.some((row) => row.path === "/wt/regress/stale")).toBe(false);
    // A second boot adopts nothing: the registry already knows them.
    expect(await adoptLegacyWorktrees({ bb, db } as never, now)).toBe(0);
    const removed: string[] = [];
    const ctx = { bb, db, log: () => undefined, isDisposed: () => false,
      host: { call: async (_name: string, input: { worktreePath: string }) => { removed.push(input.worktreePath); return { removed: true }; } } } as never;
    expect(await reconcileWorktreeRegistry(ctx, now)).toBe(0);
    expect(removed).toEqual([]);
  });
});

describe("a writer that left its worktree", () => {
  const sdk = (path: string | null) => ({
    threads: { get: async () => ({ environmentId: "env1" }) },
    environments: { get: async () => (path === null ? null : { path }) },
  });

  it("is seen when its thread moved to the main checkout", async () => {
    expect(await writerLeftWorktree(sdk("/Users/v/plugins/magicseo"), "thr", "/Users/v/.lane-pilot/worktrees/a1/magicseo")).toBe("/Users/v/plugins/magicseo");
  });

  it("is not seen in its own worktree, its root, or when the lookup fails", async () => {
    expect(await writerLeftWorktree(sdk("/wt/a1/magicseo"), "thr", "/wt/a1/magicseo")).toBeNull();
    expect(await writerLeftWorktree(sdk("/wt/a1"), "thr", "/wt/a1/magicseo")).toBeNull();
    expect(await writerLeftWorktree(sdk(null), "thr", "/wt/a1/magicseo")).toBeNull();
  });
});
