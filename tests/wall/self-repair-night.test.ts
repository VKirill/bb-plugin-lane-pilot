import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/storage/database";
import { createSelfRepair, readRepairRecord } from "../../src/rooms/self-repair/server/self-repair";
import { setRepairHooks, type NightAssignment, type RepairHooks } from "../../src/rooms/self-repair/server/hooks";
import type { ServerCore } from "../../src/rooms/core/server/core";

/** The watcher's tick with the night loop's hooks: the loop queues, the watcher spawns and merges, the loop is asked before every merge. */
function setup(threadStatus: Record<string, string> = {}, outputs: Record<string, string> = {}) {
  const spawns: Array<Record<string, unknown>> = [];
  const hostCalls: Array<{ method: string; input: Record<string, unknown> }> = [];
  let next = 0;
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      environments: { get: async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_mac", path: "/repo/lane-pilot" }) as never },
      plugins: { callRpc: async () => ({ ok: true }) },
      threads: {
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs[threadId] ?? "" }) as never,
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: threadStatus[threadId] ?? "idle" }) as never,
        events: { list: async () => [] },
        spawn: async (input: unknown) => { spawns.push(input as Record<string, unknown>); return { id: `thr_night${++next}` } as never; },
      },
    } as never,
  });
  const db = openDatabase(bb);
  const host = {
    call: async (method: string, input: Record<string, unknown>) => {
      hostCalls.push({ method, input });
      if (method === "gitCreateWorktree") return { status: "ready", path: `/wt/${String(input.name)}/lane-pilot`, branch: `lane/${String(input.name)}`, reason: null };
      if (method === "gitIntegrate") return { status: "merged", commit: "abcdef1234567890", conflicts: [], reason: null };
      return { ok: true };
    },
  };
  const ctx = { bb, db, host, log: () => undefined, isDisposed: () => false } as unknown as ServerCore;
  return { ctx, spawns, hostCalls };
}

const assignment = (patch: Partial<NightAssignment> = {}): NightAssignment => ({
  id: "wr_1", signature: "night:abc123def456:harness: internal_error: lock", brief: "NIGHT REPAIR OF A CLASS\nSITE: <file>:<line>",
  samples: [{ signature: "night:abc123def456:harness: internal_error: lock", kind: "night", projectId: "proj_real", runId: "-", taskId: "-", attemptId: "lpattempt_1", pmThreadId: null, writerThreadId: null, reason: "internal_error: lock", at: Date.now() - 1000, version: "0.1.268" }], ...patch,
});

function hooks(queue: NightAssignment[], decision: "merge" | "hold" | "release" = "merge") {
  const log = { started: [] as Array<{ id: string; threadId: string; branch: string }>, failed: [] as string[], gate: [] as string[], settled: [] as Array<{ signature: string; outcome: string; verdict: string | null; commit: string | null }> };
  const api: RepairHooks = {
    nextAssignment: () => queue[0] ?? null,
    started: (id, info) => { log.started.push({ id, threadId: info.threadId, branch: info.branch }); queue.shift(); },
    startFailed: (id, reason) => { log.failed.push(`${id}: ${reason}`); queue.shift(); },
    mergeGate: async (signature) => { log.gate.push(signature); return decision; },
    settled: (signature, info) => { log.settled.push({ signature, ...info }); },
  };
  return { api, log };
}

describe("the night loop on the self-repair path", () => {
  it("the watcher starts a queued night repair with the loop's brief, in its own worktree", async () => {
    const { ctx, spawns } = setup();
    const { api, log } = hooks([assignment(), assignment({ id: "wr_2", signature: "night:other:harness: other" })]);
    setRepairHooks(ctx, api);
    const repair = createSelfRepair(ctx);
    const first = await repair.tick({});
    expect(first.reason).toBe("started");
    expect(spawns).toHaveLength(1);
    const prompt = String(spawns[0]!.prompt);
    expect(prompt).toContain("You are the Lane Pilot self-repair engineer");
    expect(prompt).toContain("NIGHT REPAIR OF A CLASS");
    expect(prompt.indexOf("NIGHT REPAIR OF A CLASS")).toBeLessThan(prompt.indexOf("Done when:"));
    expect((spawns[0]!.pluginMetadata as { signature: string }).signature).toBe("night:abc123def456:harness: internal_error: lock");
    expect(log.started).toEqual([expect.objectContaining({ id: "wr_1", threadId: "thr_night1" })]);
    expect(log.started[0]!.branch).toMatch(/^lane\/self-repair-/);
    const record = await readRepairRecord(ctx.bb, "night:abc123def456:harness: internal_error: lock");
    expect(record).toMatchObject({ threadId: "thr_night1", verdict: null });
  });

  it("does not start a second repair while the first one works", async () => {
    const { ctx, spawns } = setup({ thr_night1: "active" });
    setRepairHooks(ctx, hooks([assignment(), assignment({ id: "wr_2", signature: "night:other:harness: other" })]).api);
    const repair = createSelfRepair(ctx);
    await repair.tick({});
    expect((await repair.tick({})).spawned).toBeNull();
    expect(spawns).toHaveLength(1);
  });

  it("an informed round runs on the other model the loop names", async () => {
    const { ctx, spawns } = setup();
    setRepairHooks(ctx, hooks([assignment({ selection: { providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: "medium" } })]).api);
    await createSelfRepair(ctx).tick({});
    expect(spawns[0]).toMatchObject({ providerId: "codex", model: "gpt-6.1-sol" });
  });

  it("is not counted against the daily limit and is never started by the watcher's own due rule", async () => {
    const { ctx, spawns } = setup();
    const repair = createSelfRepair(ctx);
    await repair.setConfig({ maxPerDay: 0 });
    setRepairHooks(ctx, hooks([assignment()]).api);
    expect((await repair.tick({})).reason).toBe("started");
    expect(spawns).toHaveLength(1);
    // A night signature in the state is never "due": with no assignment queued, a tick starts nothing.
    setRepairHooks(ctx, hooks([]).api);
    expect((await repair.tick({})).spawned).toBeNull();
    expect(spawns).toHaveLength(1);
  });

  it("a fixed night repair is merged only when the loop says so: merge goes through, hold waits on its branch, release gives the worktree back", async () => {
    for (const [decision, expectMerge, expectRemove] of [["merge", true, false], ["hold", false, false], ["release", false, true]] as const) {
      const { ctx, hostCalls } = setup({}, { thr_night1: "done\nSELF-REPAIR-VERDICT: fixed" });
      const { api, log } = hooks([assignment()], decision);
      setRepairHooks(ctx, api);
      const repair = createSelfRepair(ctx);
      await repair.tick({});                                   // starts the repair
      await repair.tick({});                                   // reads its verdict (the thread is idle) and settles the worktree
      expect(log.gate, decision).toEqual(["night:abc123def456:harness: internal_error: lock"]);
      expect(hostCalls.some((call) => call.method === "gitIntegrate"), decision).toBe(expectMerge);
      expect(hostCalls.some((call) => call.method === "gitRemoveWorktree"), decision).toBe(expectRemove);
      if (decision === "merge") expect(log.settled).toEqual([expect.objectContaining({ commit: "abcdef123456", verdict: "fixed" })]);
      if (decision === "release") expect(log.settled).toEqual([expect.objectContaining({ outcome: expect.stringMatching(/released/), commit: null })]);
      if (decision === "hold") {
        expect(log.settled).toEqual([]);
        expect((await readRepairRecord(ctx.bb, "night:abc123def456:harness: internal_error: lock"))!.worktreePath).toMatch(/^\/wt\//);
      }
    }
  });

  it("a verdict that is not fixed releases the worktree and tells the loop (a failed move)", async () => {
    const { ctx, hostCalls } = setup({}, { thr_night1: "no\nSELF-REPAIR-VERDICT: needs-owner" });
    const { api, log } = hooks([assignment()]);
    setRepairHooks(ctx, api);
    const repair = createSelfRepair(ctx);
    await repair.tick({});
    await repair.tick({});
    expect(log.gate).toEqual([]);
    expect(hostCalls.some((call) => call.method === "gitIntegrate")).toBe(false);
    expect(log.settled).toEqual([expect.objectContaining({ verdict: "needs-owner", commit: null })]);
  });

  it("without the loop the watcher is as before", async () => {
    const { ctx, spawns } = setup();
    expect((await createSelfRepair(ctx).tick({})).spawned).toBeNull();
    expect(spawns).toEqual([]);
  });
});
