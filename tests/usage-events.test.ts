import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, saveProjectSetting } from "../src/rooms/plugin-db";
import {
  mountUsageSnapshots,
  USAGE_SKIP_KEY,
  USAGE_SNAPSHOT_SCHEDULE,
} from "../src/rooms/usage/server";
import { attachTokenUsage } from "../src/rooms/usage/server/handlers/token-usage-events";
import { queryTokenUsage } from "../src/rooms/usage/server/services/token-usage";
import { mountRateLimitWatch } from "../src/rooms/stability/server";
import { ensureProjectSchedules, ensureSystemSchedules, isSystemScheduleCreator, systemStarterOf } from "../src/rooms/schedule/server";

const flush = () => new Promise((resolve) => setTimeout(resolve, 25));

function usageEvent(seq: number, tokens: number, turnId = `turn_${seq}`, createdAt = Date.now()) {
  return {
    seq,
    createdAt,
    type: "thread/tokenUsage/updated",
    data: {
      turnId,
      model: "claude-sonnet-4-6",
      providerId: "claude-code",
      tokenUsage: {
        last: { inputTokens: tokens, outputTokens: 2, cachedInputTokens: 0, totalTokens: tokens + 2 },
        total: { inputTokens: tokens, outputTokens: 2, cachedInputTokens: 0, totalTokens: tokens + 2 },
      },
    },
  };
}

let dispose: (() => Promise<void>) | undefined;
afterEach(async () => {
  await dispose?.();
  dispose = undefined;
});

describe("event-driven token usage and usage snapshots (Task 17)", () => {
  it("replays cursors on ready, folds incremental turn events via bb.events, and registers no cron schedules", async () => {
    const eventsByThread: Record<string, unknown[]> = {
      thr_replay: [usageEvent(1, 100, "turn_1")],
      thr_live: [],
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        projects: { list: async () => [{ id: "proj_a", name: "Proj A" }] },
        threads: {
          list: async () => [
            { id: "thr_replay", projectId: "proj_a", providerId: "claude-code" },
            { id: "thr_live", projectId: "proj_a", providerId: "claude-code" },
          ],
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "proj_a", providerId: "claude-code" }),
          events: {
            list: async ({ threadId, afterSeq }: { threadId: string; afterSeq?: string }) => {
              const after = Number(afterSeq ?? 0);
              return (eventsByThread[threadId] ?? []).filter((ev) => Number((ev as { seq: number }).seq) > after);
            },
          },
        },
      } as never,
    });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    attachTokenUsage({ bb, db, isDisposed: () => false });
    await flush();

    // Cursor replay on ready folded thr_replay.
    const initial = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(initial.byModel.reduce((sum, row) => sum + row.total, 0)).toBe(102);
    expect(harness.registrations.schedules).toEqual([]);

    // Live turn event folds newly arrived events for thr_live without full sweep.
    eventsByThread.thr_live.push(usageEvent(1, 200, "turn_2"));
    await harness.behavior.emitThreadEvent("thread.idle", {
      thread: { id: "thr_live", projectId: "proj_a", providerId: "claude-code", title: "Live" },
    } as never);
    await flush();
    const afterIdle = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(afterIdle.byModel.reduce((sum, row) => sum + row.total, 0)).toBe(304);

    // Experimental thread events fold consecutive turns and never double-count seq 1.
    eventsByThread.thr_live.push(usageEvent(2, 50, "turn_3"));
    await harness.behavior.emitThreadEvent("experimental_thread.events" as never, {
      thread: { id: "thr_live", status: "active" },
      sequence: 2,
    } as never);
    await flush();
    const afterExp = await queryTokenUsage({ bb, db }, { range: "7d" });
    expect(afterExp.byModel.reduce((sum, row) => sum + row.total, 0)).toBe(356);
  });

  it("pushes usage snapshots on cap change, rate limit / token usage change, and host connect without a cron schedule", async () => {
    let usedPercent = 25;
    let hostSubscriber: ((ev: { entity: "host"; type: "changed"; id?: string; changes: string[] }) => void) | null = null;
    const providerListHosts: string[] = [];
    const writes: Array<{ hostId: string; snapshot: Record<string, unknown> }> = [];
    const threadEvents: Record<string, unknown[]> = {
      thr_rl: [],
      thr_tok: [],
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: (call) => {
        if (call.method === "writeUsageSnapshot") {
          const input = call.input as { requestedHostId: string; snapshot: Record<string, unknown> };
          writes.push({ hostId: input.requestedHostId, snapshot: input.snapshot });
        }
        return { ok: true };
      },
      sdk: {
        hosts: {
          list: async () => [{ id: "h1", name: "Mac mini", connected: true, status: "connected" }],
        },
        providers: {
          list: async ({ hostId }: { hostId: string }) => { providerListHosts.push(hostId); return []; },
          models: async () => ({ models: [] }),
        },
        threads: {
          list: async () => [{ id: "thr_tok", projectId: "proj_a", providerId: "claude-code" }],
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, projectId: "proj_a", providerId: "claude-code" }),
          events: {
            list: async ({ threadId, afterSeq }: { threadId: string; afterSeq?: string }) => {
              const after = Number(afterSeq ?? 0);
              return (threadEvents[threadId] ?? []).filter((ev) => Number((ev as { seq: number }).seq) > after);
            },
          },
        },
        subscribe: ({ event, callback }: { event: string; callback: typeof hostSubscriber }) => {
          if (event === "host:changed") hostSubscriber = callback;
          return () => { hostSubscriber = null; };
        },
      } as never,
    });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const providerUsage = {
      readings: async () => ({
        measuredAt: "2026-11-25T10:00:00.000Z",
        windows: [{ label: "five-hour", usedPercent, resetsAt: "2026-11-25T15:00:00.000Z", model: null }],
      }),
    };
    const snapshots = mountUsageSnapshots({ bb, db, isDisposed: () => false }, providerUsage);
    mountRateLimitWatch({ bb, db, isDisposed: () => false } as never, { onUpdated: () => { void snapshots.push(); } });
    attachTokenUsage({ bb, db, isDisposed: () => false });
    expect(harness.registrations.schedules.map((s) => s.name)).not.toContain(USAGE_SNAPSHOT_SCHEDULE);

    // 1. Initial ready push writes once.
    await snapshots.push();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.snapshot).toMatchObject({ skipPercent: 90, skipSetByHuman: false });

    // 2. Cap setting change pushes updated skipPercent immediately.
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, USAGE_SKIP_KEY, 70);
    await flush();
    expect(writes).toHaveLength(2);
    expect(writes[1]!.snapshot).toMatchObject({ skipPercent: 70, skipSetByHuman: true });

    // 3. Rate limit update event triggers usage snapshot push when window percent changes.
    usedPercent = 55;
    threadEvents.thr_rl.push({
      seq: 1,
      createdAt: Date.now() + 1000,
      type: "provider/rateLimits/updated",
      data: {
        rateLimits: { kind: "subscription-window", status: "warning", providerId: "claude-code", windows: [{ label: "five-hour", status: "warning", resetsAtMs: Date.now() + 3600_000 }] },
      },
    });
    await harness.behavior.emitThreadEvent("experimental_thread.events" as never, {
      thread: { id: "thr_rl", status: "active" },
      sequence: 1,
    } as never);
    await flush();
    expect(writes).toHaveLength(3);
    expect((writes[2]!.snapshot.windows as Array<{ usedPercent: number }>)[0]!.usedPercent).toBe(55);

    // 4. Token usage increment triggers push when reading moved.
    usedPercent = 60;
    threadEvents.thr_tok.push(usageEvent(1, 150, "turn_tok", Date.now() + 2000));
    await harness.behavior.emitThreadEvent("thread.idle", { thread: { id: "thr_tok", projectId: "proj_a", providerId: "claude-code", title: "T" } } as never);
    await flush();
    expect(writes).toHaveLength(4);

    // 5. Host connect forces snapshot push for the connected host even if reading matches previous cache, and refreshes model catalog.
    expect(hostSubscriber).not.toBeNull();
    hostSubscriber!({ entity: "host", type: "changed", id: "h1", changes: ["host-connected"] });
    await flush();
    expect(writes).toHaveLength(5);
    expect(providerListHosts).toContain("h1");
  });

  it("creates per-project calendar rows for backlog-scan and lead-tick once while keeping system schedules unchanged", async () => {
    const rows: Array<{ id: string; project_id: string; created_by: string; workflowId: string; cron: string }> = [];
    const kv = new Map<string, unknown>();
    const deps = {
      list: () => rows,
      save: async (raw: unknown, by: string) => {
        const spec = raw as { projectId: string; task: { workflowId: string }; when: { cron: string } };
        const id = `sch_${rows.length + 1}`;
        rows.push({ id, project_id: spec.projectId, created_by: by, workflowId: spec.task.workflowId, cron: spec.when.cron });
        return { ok: true as const, schedule: { id } };
      },
      kv: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: unknown) => { kv.set(k, v); } },
      log: () => undefined,
    };
    expect(await ensureSystemSchedules(deps)).toEqual(["worktree-cleanup-hourly", "worktree-cleanup-daily", "owner-push", "daily-report", "review-desk"]);
    const first = await ensureProjectSchedules(deps, ["proj_a", "*", "proj_b"], { leadCron: "15 8 * * *" });
    expect(first).toEqual([
      { projectId: "proj_a", key: "backlog-scan" },
      { projectId: "proj_a", key: "lead-tick" },
      { projectId: "proj_b", key: "backlog-scan" },
      { projectId: "proj_b", key: "lead-tick" },
    ]);
    expect(rows.filter((r) => r.project_id === "proj_a").map((r) => [r.created_by, r.workflowId, r.cron])).toEqual([
      ["system:backlog-scan", "lp.backlog-scan", "3 * * * *"],
      ["system:lead-tick", "lead-tick", "15 8 * * *"],
    ]);
    expect(await ensureProjectSchedules(deps, ["proj_a", "proj_b"])).toEqual([]);
    // Deleted row stays deleted on subsequent startup.
    rows.splice(rows.findIndex((r) => r.project_id === "proj_a" && r.created_by === "system:backlog-scan"), 1);
    expect(await ensureProjectSchedules(deps, ["proj_a", "proj_b"])).toEqual([]);
    expect(systemStarterOf("system:backlog-scan")).toBe("backlog-scan");
    expect(systemStarterOf("system:lead-tick")).toBeNull();
    expect(isSystemScheduleCreator("system:backlog-scan")).toBe(true);
    expect(isSystemScheduleCreator("system:lead-tick")).toBe(true);
  });
});
