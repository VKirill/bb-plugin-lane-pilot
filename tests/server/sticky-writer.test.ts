import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createAttempt, createRun, createTask, getAttempt, getReasoningTrace, openDatabase, saveReasoningTrace, setAttemptWorkspace, transitionAttempt } from "../../src/rooms/storage/database";
import { validateTaskV2 } from "../../src/rooms/tasks/task-v2";
import { sameArea } from "../../src/rooms/writer/server/start";
import { STICKY_MAX_TURNS, STICKY_WINDOW_MS, areaHistoryText, createWriterSticky, loadArea, loadFollowUp, nextAreaRecord, retryInSameThread } from "../../src/rooms/writer/server/sticky";
import { stickyTurnPrompt } from "../../src/rooms/writer/server/writer-task";

const base = "/home/ubuntu/apps/selfystudio";
const worktree = "/home/ubuntu/.bb/environments/env_a/selfystudio";
const task = (id: string, area?: string) => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "medium", lane: "writer", project_cwd: base, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: ["apps/marketing/page.vue"], owns_paths: ["apps/marketing/**"], never_touch: [], depends_on: [],
  objective: `Do ${id}`, acceptance: ["works"], verify: "none", verification: [], ...(area ? { area } : {}),
}) as never;

function setup(options: { threadStatus?: string; envArchived?: boolean; usedShare?: number; sync?: string } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const sent: Array<{ threadId: string; text: string }> = [];
  const calls: string[] = [];
  const sdk = {
    threads: {
      get: vi.fn(async () => ({ status: options.threadStatus ?? "idle", archivedAt: null })),
      context: vi.fn(async () => ({ usage: { usedTokens: (options.usedShare ?? 0.2) * 200_000, modelContextWindow: 200_000 } })),
      compact: vi.fn(async () => { calls.push("compact"); return { ok: true }; }),
      updatePluginMetadata: vi.fn(async () => ({})),
      send: vi.fn(async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return {}; }),
    },
    environments: { get: vi.fn(async () => ({ id: "env_a", archivedAt: options.envArchived ? 1 : null })) },
  };
  const host = { call: vi.fn(async (method: string) => {
    calls.push(method);
    if (method === "gitSyncWorktree") return { hostId: "h", status: options.sync ?? "synced", head: "abc", reason: options.sync === "conflict" ? "conflicts: page.vue" : null };
    return { hostId: "h", linked: [] };
  }) };
  const ctx = { bb: { storage: bb.storage, sdk }, db, host, log: () => undefined, isDisposed: () => false } as never;
  const services = { workspaceDirt: vi.fn(async () => ({ ok: true, paths: [], snapshots: [] })) } as never;
  createRun(db, "run", "P", "bb", base);
  return { bb, harness, db, sdk, host, sent, calls, sticky: createWriterSticky(ctx, services) };
}

/** An accepted task of area `cards` in a BB worktree environment, recorded the way start.ts records it. */
async function acceptedInArea(env: ReturnType<typeof setup>, acceptedAgo = 0) {
  env.bb.storage.kv;
  createTask(env.db, { id: "gc-hub", runId: "run", kind: "bb", contract: task("gc-hub", "page:/cards") });
  createAttempt(env.db, { id: "a1", runId: "run", taskId: "gc-hub" });
  setAttemptWorkspace(env.db, "a1", { path: worktree, environmentId: "env_a", decision: { strategy: "provision_attempt_worktree" } });
  transitionAttempt(env.db, "a1", "spawn_requested");
  transitionAttempt(env.db, "a1", "running", { threadId: "thr_w" });
  saveReasoningTrace(env.db, { attemptId: "a1", runId: "run", threadId: "thr_w", providerId: "claude-code", model: "opus", effectiveReasoningLevel: "high", serviceTier: null } as never);
  transitionAttempt(env.db, "a1", "accepted");
  await env.sticky.noteAccepted("P", "run", task("gc-hub", "page:/cards"), "a1", ["apps/marketing/page.vue"]);
  if (acceptedAgo) {
    const record = await loadArea(env.bb.storage.kv, "P", "page:/cards");
    await env.bb.storage.kv.set("area:P:page:/cards", { ...record!, acceptedAt: Date.now() - acceptedAgo } as never);
  }
}

describe("area records and rules", () => {
  it("accepts an area in the task contract and matches areas case-insensitively", () => {
    expect(validateTaskV2(task("x", "page:/tools/cards")).ok).toBe(true);
    expect(sameArea("page:/Cards", " page:/cards ")).toBe(true);
    expect(sameArea("page:/cards", undefined)).toBe(false);
    expect(sameArea(undefined, undefined)).toBe(false);
  });

  it("keeps the newest tasks first, without duplicates, and tells a fresh writer about them", () => {
    const first = nextAreaRecord(null, { area: "page:/cards", runId: "r", threadId: "t1", attemptId: "a1", task: task("one"), produced: ["a.vue"], now: 1 });
    const second = nextAreaRecord(first, { area: "page:/cards", runId: "r", threadId: "t1", attemptId: "a2", task: task("two"), produced: ["b.vue", "a.vue"], now: 2 });
    expect(second.tasks.map((row) => row.taskId)).toEqual(["two", "one"]);
    expect(second.files).toEqual(["b.vue", "a.vue"]);
    expect(second.attemptId).toBe("a2");
    const text = areaHistoryText(second);
    expect(text).toContain("Area «page:/cards»");
    expect(text).toContain("two: Task two. Do two");
    expect(text).toContain("Files of this area: b.vue, a.vue");
    expect(areaHistoryText(null)).toBe("");
  });

  it("redoes in the same thread only what the writer itself can fix", () => {
    expect(retryInSameThread("validation_failed", "verification failed (npx vitest run greeting-card): exit 1")).toBe(true);
    expect(retryInSameThread("validation_failed", "missing expected_outputs: CardMockCard.vue")).toBe(true);
    expect(retryInSameThread("validation_failed", "writer changed paths outside owns_paths or inside never_touch: x")).toBe(true);
    expect(retryInSameThread("empty_output", "writer changed no files")).toBe(true);
    expect(retryInSameThread("validation_failed", "merge_conflict: main changed since this attempt started: page.vue")).toBe(false);
    expect(retryInSameThread("validation_failed", "merge_failed: git merge failed: index.lock")).toBe(false);
    expect(retryInSameThread("blocked", "needs_human: which color?")).toBe(false);
    expect(retryInSameThread("provider_error", "writer thread status error")).toBe(false);
  });

  it("sends only what changed in a continued turn", () => {
    const next = stickyTurnPrompt({ kind: "next-task", task: task("gc-faq", "page:/cards") });
    expect(next).toContain("Next task for you in the same area");
    expect(next).toContain("\"id\": \"gc-faq\"");
    expect(next).not.toContain("previous_attempt");
    const retry = stickyTurnPrompt({ kind: "retry", task: task("gc-faq"), previousAttempt: "Failure: verification failed" });
    expect(retry).toContain("fix them in place");
    expect(retry).toContain("<previous_attempt>\nFailure: verification failed\n</previous_attempt>");
  });
});

describe("hot writer of an area", () => {
  it("offers the area's writer of this run while its thread and environment are alive", async () => {
    const env = setup();
    await acceptedInArea(env);
    const hot = await env.sticky.hotWriter("P", "run", "PAGE:/cards");
    expect(hot).toMatchObject({ threadId: "thr_w", attemptId: "a1", workspacePath: worktree, environmentId: "env_a", turns: 1 });
    expect(await env.sticky.hotWriter("P", "other-run", "page:/cards")).toBeNull();
    expect(await env.sticky.hotWriter("P", "run", "page:/other")).toBeNull();
    expect(await env.sticky.hotWriter("P", "run", undefined)).toBeNull();
    await env.harness.lifecycle.dispose();
  });

  it("starts fresh when the writer is stale, busy, archived or used up", async () => {
    const stale = setup();
    await acceptedInArea(stale, STICKY_WINDOW_MS + 1);
    expect(await stale.sticky.hotWriter("P", "run", "page:/cards")).toBeNull();
    const busy = setup({ threadStatus: "active" });
    await acceptedInArea(busy);
    expect(await busy.sticky.hotWriter("P", "run", "page:/cards")).toBeNull();
    const archived = setup({ envArchived: true });
    await acceptedInArea(archived);
    expect(await archived.sticky.hotWriter("P", "run", "page:/cards")).toBeNull();
    const used = setup();
    await acceptedInArea(used);
    for (let index = 0; index < STICKY_MAX_TURNS; index += 1) {
      createAttempt(used.db, { id: `u${index}`, runId: "run", taskId: "gc-hub" });
      transitionAttempt(used.db, `u${index}`, "accepted", { threadId: "thr_w" });
    }
    expect(await used.sticky.hotWriter("P", "run", "page:/cards")).toBeNull();
  });
});

describe("continuing a writer thread", () => {
  it("syncs the worktree to main, binds the attempt to it and sends the turn", async () => {
    const env = setup();
    await acceptedInArea(env);
    createTask(env.db, { id: "gc-faq", runId: "run", kind: "bb", contract: task("gc-faq", "page:/cards") });
    createAttempt(env.db, { id: "a2", runId: "run", taskId: "gc-faq" });
    const hot = (await env.sticky.hotWriter("P", "run", "page:/cards"))!;
    const turn = await env.sticky.continueInThread({ runId: "run", taskId: "gc-faq", attemptId: "a2", config: { hostId: "h" } as never,
      writer: hot, prompt: "next", kind: "next-task" });
    expect(turn).toMatchObject({ ok: true, workspacePath: worktree });
    expect(env.calls.slice(0, 2)).toEqual(["gitSyncWorktree", "gitPrepareWorktree"]);
    expect(env.sent).toEqual([{ threadId: "thr_w", text: "next" }]);
    const attempt = getAttempt(env.db, "a2")!;
    expect(attempt).toMatchObject({ state: "running", thread_id: "thr_w", workspace_path: worktree, environment_id: "env_a" });
    expect(getReasoningTrace(env.db, "a2")).toMatchObject({ attemptId: "a2", threadId: "thr_w", model: "opus" });
    expect(await loadFollowUp(env.bb.storage.kv, "a2")).toBeGreaterThan(0);
    expect(env.calls).not.toContain("compact");
  });

  it("compacts a nearly full thread before the turn", async () => {
    const env = setup({ usedShare: 0.8 });
    await acceptedInArea(env);
    createAttempt(env.db, { id: "a2", runId: "run", taskId: "gc-hub" });
    const hot = (await env.sticky.hotWriter("P", "run", "page:/cards"))!;
    expect((await env.sticky.continueInThread({ runId: "run", taskId: "gc-hub", attemptId: "a2", config: { hostId: "h" } as never, writer: hot, prompt: "p", kind: "next-task" })).ok).toBe(true);
    expect(env.calls).toContain("compact");
  });

  it("leaves the attempt unbound for a fresh spawn when main conflicts with the worktree", async () => {
    const env = setup({ sync: "conflict" });
    await acceptedInArea(env);
    createAttempt(env.db, { id: "a2", runId: "run", taskId: "gc-hub" });
    const hot = (await env.sticky.hotWriter("P", "run", "page:/cards"))!;
    const turn = await env.sticky.continueInThread({ runId: "run", taskId: "gc-hub", attemptId: "a2", config: { hostId: "h" } as never, writer: hot, prompt: "p", kind: "next-task" });
    expect(turn).toMatchObject({ ok: false, bound: false });
    expect(turn.ok ? "" : turn.reason).toContain("worktree_sync_conflict");
    expect(getAttempt(env.db, "a2")!.workspace_path).toBeNull();
    expect(env.sent).toEqual([]);
  });

  it("redoes a failed check in the same thread, keeping the worktree unsynced", async () => {
    const env = setup();
    createTask(env.db, { id: "t", runId: "run", kind: "bb", contract: task("t") });
    createAttempt(env.db, { id: "f1", runId: "run", taskId: "t" });
    setAttemptWorkspace(env.db, "f1", { path: base, environmentId: null, decision: {} });
    transitionAttempt(env.db, "f1", "spawn_requested");
    transitionAttempt(env.db, "f1", "running", { threadId: "thr_r" });
    transitionAttempt(env.db, "f1", "validation_failed", { reason: "verification failed (npm test): exit 1" });
    const redo = (await env.sticky.retryWriter("f1", "run"))!;
    expect(redo).toMatchObject({ threadId: "thr_r", workspacePath: base });
    createAttempt(env.db, { id: "f2", runId: "run", taskId: "t" });
    const turn = await env.sticky.continueInThread({ runId: "run", taskId: "t", attemptId: "f2", config: { hostId: "h" } as never, writer: redo,
      prompt: "fix", kind: "retry", dirtBefore: [] });
    expect(turn.ok).toBe(true);
    expect(env.calls).not.toContain("gitSyncWorktree");
    transitionAttempt(env.db, "f2", "validation_failed", { reason: "verification failed (npm test): exit 1" });
    // One writer session: a second failure is another feedback turn in the same thread, up to the turn cap (then a stop, no fresh writer).
    expect(await env.sticky.retryWriter("f2", "run")).toMatchObject({ threadId: "thr_r", turns: 2 });
    expect(env.sticky.sessionLimit("f2")).toBeNull();
    expect(await env.sticky.retryWriter("f2", "run", 2)).toBeNull();
    expect(env.sticky.sessionLimit("f2", 2)).toBe("turn limit 2 reached");
  });

  it("gives a conflict with main back to its writer to resolve, but never Lane Pilot faults or someone's uncommitted edits", async () => {
    const env = setup();
    createTask(env.db, { id: "t", runId: "run", kind: "bb", contract: task("t") });
    const failed = (id: string, reason: string) => {
      createAttempt(env.db, { id, runId: "run", taskId: "t" });
      setAttemptWorkspace(env.db, id, { path: base, environmentId: null, decision: {} });
      transitionAttempt(env.db, id, "spawn_requested");
      transitionAttempt(env.db, id, "running");
      transitionAttempt(env.db, id, "validation_failed", { threadId: `thr_${id}`, reason });
    };
    failed("m1", "merge_conflict: main changed since this attempt started: page.vue");
    expect(await env.sticky.retryWriter("m1", "run")).toMatchObject({ kind: "merge", threadId: "thr_m1" });
    failed("m2", "merge_conflict: base checkout has uncommitted changes in files this attempt also changes: page.vue");
    expect(await env.sticky.retryWriter("m2", "run")).toBeNull();
    failed("m3", "merge_failed: git merge failed: index.lock");
    expect(await env.sticky.retryWriter("m3", "run")).toBeNull();
    failed("m4", "merge_conflict: main changed since this attempt started: ");
    expect(await env.sticky.retryWriter("m4", "run")).toBeNull();
  });

  it("tells the writer which files conflict and to keep main's work", () => {
    const text = stickyTurnPrompt({ kind: "merge", task: task("t"), conflicts: ["page.vue", "faq.vue"] });
    expect(text).toContain("conflicts in: page.vue, faq.vue");
    expect(text).toContain("never drop main's changes");
    expect(text).toContain("NEEDS_HUMAN");
  });
});
