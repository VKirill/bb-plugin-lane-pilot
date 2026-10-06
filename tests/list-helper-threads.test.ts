import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../src/server/core";
import { createAttempt, createRun, createTask, openDatabase, saveStageReceipt, setRunThread, transitionAttempt } from "../src/database";
import { runsRpc } from "../src/server/rpc/runs";
import type { Services } from "../src/server/services";

function setupHost() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "writer" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const services = {
    activate: async () => ({ ok: true }),
    listedAgentProfiles: async () => [],
    resolveProjectWriterHost: async () => ({ status: "resolved" }),
    resumeOrphans: () => undefined,
  } as unknown as Services;
  const handlers = runsRpc(ctx, services);
  return { bb, harness, db, handlers };
}

describe("list_helper_threads RPC", () => {
  it("pages of 100 with more than 100 children", async () => {
    const { harness, handlers } = setupHost();
    const children = Array.from({ length: 150 }, (_, i) => ({
      id: `thr_child_${i}`,
      title: `Task ${i}`,
      status: "active",
      archivedAt: null,
    }));

    const requestedLimits: number[] = [];
    harness.sdk.stub("threads.list", async (args: { limit?: number; offset?: number }) => {
      requestedLimits.push(args.limit ?? 0);
      const offset = args.offset ?? 0;
      const limit = args.limit ?? 100;
      return children.slice(offset, offset + limit);
    });

    const result = await handlers.list_helper_threads({ threadId: "thr_pm" });
    expect(requestedLimits).toEqual([100, 100]);
    expect(result.threads).toHaveLength(150);
  });

  it("logs list error once per minute and keeps other pages", async () => {
    const { bb, harness, handlers } = setupHost();
    let callCount = 0;
    harness.sdk.stub("threads.list", async (args: { offset?: number }) => {
      callCount += 1;
      if (args.offset === 0) {
        return [{ id: "thr_ok", title: "Task OK", status: "active", archivedAt: null }];
      }
      throw new Error("network error on page 2");
    });

    const warnSpy = bb.log.warn as unknown as { mock?: { calls: unknown[][] } };
    const result = await handlers.list_helper_threads({ threadId: "thr_pm" });
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.id).toBe("thr_ok");

    // Calling again within 1 minute does not log again
    await handlers.list_helper_threads({ threadId: "thr_pm" });
  });

  it("lists an idle writer with an open attempt with its phase", async () => {
    const { harness, db, handlers } = setupHost();
    createRun(db, "run_1", "proj_1", "bb");
    setRunThread(db, "run_1", "thr_pm");
    createTask(db, { id: "task_1", runId: "run_1", kind: "bb", contract: { id: "task_1" } });
    createAttempt(db, { id: "att_1", runId: "run_1", taskId: "task_1" });
    transitionAttempt(db, "att_1", "running", { threadId: "thr_writer_1" });
    saveStageReceipt(db, {
      runId: "run_1",
      taskId: "task_1",
      stageId: "verification",
      contractVersion: 1,
      state: "running",
      inputSha256: "sha",
      outputSha256: null,
      attempt: 1,
      providerId: null,
      model: null,
      threadId: "thr_writer_1",
      result: null,
      reason: null,
      updatedAt: Date.now(),
    });

    harness.sdk.stub("threads.list", async () => [
      { id: "thr_writer_1", title: "Task 1", status: "idle", archivedAt: null },
    ]);

    const result = await handlers.list_helper_threads({ threadId: "thr_pm" });
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0]?.id).toBe("thr_writer_1");
    expect(result.threads[0]?.phase).toBe("проверка");
  });

  it("does not list an idle thread whose attempt ended", async () => {
    const { harness, db, handlers } = setupHost();
    createRun(db, "run_1", "proj_1", "bb");
    setRunThread(db, "run_1", "thr_pm");
    createTask(db, { id: "task_1", runId: "run_1", kind: "bb", contract: { id: "task_1" } });
    createAttempt(db, { id: "att_1", runId: "run_1", taskId: "task_1" });
    transitionAttempt(db, "att_1", "accepted", { threadId: "thr_writer_1" });

    harness.sdk.stub("threads.list", async () => [
      { id: "thr_writer_1", title: "Task 1", status: "idle", archivedAt: null },
    ]);

    const result = await handlers.list_helper_threads({ threadId: "thr_pm" });
    expect(result.threads).toHaveLength(0);
  });

  it("returns queued tasks that have no thread", async () => {
    const { harness, db, handlers } = setupHost();
    createRun(db, "run_1", "proj_1", "bb");
    setRunThread(db, "run_1", "thr_pm");
    createTask(db, { id: "task_queued_1", runId: "run_1", kind: "bb", contract: { id: "task_queued_1" } });
    createAttempt(db, { id: "att_q1", runId: "run_1", taskId: "task_queued_1" }); // default state is queued, no thread_id

    harness.sdk.stub("threads.list", async () => []);

    const result = await handlers.list_helper_threads({ threadId: "thr_pm" });
    expect(result.queued).toEqual(["task_queued_1"]);
  });

  it("hides workspace-provisioner threads", async () => {
    const { harness, handlers } = setupHost();
    harness.sdk.stub("threads.list", async () => [
      { id: "thr_wp", title: "Provisioner", status: "active", archivedAt: null },
    ]);
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "workspace-provisioner" }));

    const result = await handlers.list_helper_threads({ threadId: "thr_pm" });
    expect(result.threads).toHaveLength(0);
  });
});
