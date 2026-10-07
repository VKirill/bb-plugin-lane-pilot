import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, createRun, createTask, createAttempt, getTask, getTaskPlan, savePrototypeConfig, listStageReceipts, saveProjectSetting, transitionAttempt } from "../src/database";
import { createWriterUpdateTask } from "../src/server/writer/update-task";
import type { TaskV2 } from "../src/contracts";
import type { ServerCore } from "../src/server/core";
import type { Services } from "../src/server/services";

describe("lane_pilot_update_task", () => {
  let db: ReturnType<typeof openDatabase>;
  let disposeHost: (() => Promise<void>) | null = null;
  const runId = "run-test-update";
  const projectId = "proj-test";
  const pmThreadId = "pm-thread-1";
  const taskId = "task-to-update";

  const fakeHost = {
    call: async () => ({ status: "ready", entries: [] }),
  };

  const fakeBb = {
    storage: { kv: { get: async () => null, set: async () => {}, delete: async () => {}, list: async () => [] } },
    hosts: {
      experimental_client: () => fakeHost,
    },
    sdk: {
      files: {
        write: async () => {},
        read: async () => null,
      },
      threads: {
        send: async () => {},
      },
    },
    log: {
      warn: () => {},
      info: () => {},
    },
  };

  const baseTask: TaskV2 = {
    schema_version: 2,
    id: taskId,
    title: "Original title",
    risk: "low",
    lane: "core",
    project_cwd: "/ws",
    read_first: [],
    interfaces: [],
    invariants: [],
    out_of_scope: [],
    expected_outputs: ["out.txt"],
    owns_paths: ["src/**"],
    never_touch: [],
    depends_on: ["dep-1"],
    objective: "Original objective",
    acceptance: ["all pass"],
    verify: "tests",
    verification: [{ command: "npm test", cwd: "/ws" }],
  };

  beforeEach(() => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    db = openDatabase(bb);
    disposeHost = () => harness.lifecycle.dispose();
    createRun(db, runId, projectId, "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host-1");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run(pmThreadId, runId);
    savePrototypeConfig(db, {
      projectId,
      hostId: "host-1",
      pmWorkspacePath: "/ws",
      writerWorkspacePath: "/ws",
      pmProviderId: "p1",
      pmModel: "m1",
      writerProviderId: "p1",
      writerModel: "m1",
    });
  });

  afterEach(async () => {
    await disposeHost?.();
    disposeHost = null;
  });

  it("updates a queued task in place, replaces plan and contract, keeps queue and id, and reruns critique", async () => {
    createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
    createAttempt(db, { id: "att-1", runId, taskId });

    const ctx = {
      bb: fakeBb as never,
      db,
      state: { disposed: false },
      log: () => {},
    } as unknown as ServerCore;

    const services = {
      activeWriterTasks: new Set<string>(),
      stability: { loadParked: async () => [] },
    } as unknown as Services;

    const { updateTask } = createWriterUpdateTask(ctx, services);

    const updatedTask: TaskV2 = {
      ...baseTask,
      title: "Updated title",
      objective: "Updated objective",
      expected_outputs: ["out-updated.txt"],
    };

    const res = await updateTask({
      projectId,
      runId,
      pmThreadId,
      taskId,
      task: updatedTask,
      plan: "New canonical plan for task",
    });

    expect(res.ok).toBe(true);
    expect(res.taskId).toBe(taskId);
    expect(res.state).toBe("queued");

    const inDb = getTask(db, taskId);
    expect((inDb?.contract as TaskV2).title).toBe("Updated title");
    expect((inDb?.contract as TaskV2).expected_outputs).toEqual(["out-updated.txt"]);
    expect((inDb?.contract as TaskV2).depends_on).toEqual(["dep-1"]);

    const planInDb = getTaskPlan(db, taskId);
    expect(planInDb).toBe("New canonical plan for task");

    const receipts = listStageReceipts(db, runId, taskId);
    expect(receipts.some((r) => r.stageId === "plan-critique")).toBe(true);
  });

  it("returns task_started if the task already started", async () => {
    createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
    createAttempt(db, { id: "att-1", runId, taskId });
    // Transition attempt to running
    db.prepare("UPDATE lane_pilot_attempt SET state='running', thread_id='thr-w' WHERE id='att-1'").run();

    const ctx = {
      bb: fakeBb as never,
      db,
      state: { disposed: false },
      log: () => {},
    } as unknown as ServerCore;

    const services = {
      activeWriterTasks: new Set<string>(),
    } as unknown as Services;

    const { updateTask } = createWriterUpdateTask(ctx, services);

    const res = await updateTask({
      projectId,
      runId,
      pmThreadId,
      taskId,
      plan: "Trying to edit running task",
    });

    expect(res.ok).toBe(false);
    expect(res.error).toMatchObject({
      code: "task_started",
      retryable: false,
      sideEffects: "none",
    });
  });

  describe("contract lint (the same rules as dispatch)", () => {
    const setup = (kinds: Record<string, string> = {}) => {
      createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
      createAttempt(db, { id: "att-1", runId, taskId });
      const calls: string[] = [];
      const ctx = {
        bb: fakeBb as never,
        db,
        host: {
          call: async (method: string, input: { paths?: string[] }) => {
            calls.push(method);
            if (method === "snapshotDryRun") {
              return { entries: (input.paths ?? []).map((path) => ({ path, kind: kinds[path.slice("/ws/".length)] ?? "missing" })) };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        state: { disposed: false },
        log: () => {},
      } as unknown as ServerCore;
      const services = { activeWriterTasks: new Set<string>(), stability: { loadParked: async () => [] } } as unknown as Services;
      return { updateTask: createWriterUpdateTask(ctx, services).updateTask, calls };
    };
    const update = (updateTask: ReturnType<typeof setup>["updateTask"], task: Partial<TaskV2>) =>
      updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, depends_on: [], ...task } });
    const hintOf = (res: Record<string, unknown>) => String((res.error as { hint: string }).hint);
    const unchanged = () => expect((getTask(db, taskId)?.contract as TaskV2).title).toBe("Original title");

    it("sends every contract error back in one message and leaves the stored task alone", async () => {
      const { updateTask } = setup({ "src/a.ts": "directory" });
      const res = await update(updateTask, { title: "New", read_first: ["src/a.ts"], owns_paths: ["../x"], expected_outputs: ["lib/z.ts"] });
      expect(res.ok).toBe(false);
      expect(res.error).toMatchObject({ code: "validation_failed", findings: expect.any(Array) });
      expect(hintOf(res)).toContain("the task was not changed");
      expect(hintOf(res)).toContain("read_first is a directory, not a file: src/a.ts");
      expect(hintOf(res)).toContain("unsafe ownership path pattern: ../x");
      expect(hintOf(res)).toContain("lib/z.ts");
      unchanged();
    });

    it("rejects a read_first file that does not exist on the writer's machine", async () => {
      const { updateTask } = setup({});
      const res = await update(updateTask, { title: "New", read_first: ["src/gone.ts"] });
      expect(hintOf(res)).toContain("read_first source is missing: src/gone.ts");
      unchanged();
    });

    it("rejects a folder filter without a trailing slash, a rule the old update checks did not have", async () => {
      const { updateTask } = setup({ tests: "directory" });
      const res = await update(updateTask, { title: "New", verification: [{ command: "npx vitest run tests", cwd: "/ws" }] });
      expect(hintOf(res)).toContain("write tests/");
      unchanged();
    });

    it("rejects depends_on a task that ended blocked", async () => {
      createTask(db, { id: "dep-1", runId, kind: "bb", contract: { ...baseTask, id: "dep-1" } });
      createAttempt(db, { id: "dep-att", runId, taskId: "dep-1" });
      transitionAttempt(db, "dep-att", "queued");
      transitionAttempt(db, "dep-att", "blocked", { reason: "stuck" });
      const { updateTask } = setup({});
      const res = await update(updateTask, { title: "New", depends_on: ["dep-1"] });
      expect(res.error).toMatchObject({ code: "validation_failed", replan: true });
      expect(hintOf(res)).toContain("replan: depends_on dep-1 ended blocked");
      unchanged();
    });

    it("rejects a whole-suite run without the sandbox-unsafe excludes, with the flags to add", async () => {
      saveProjectSetting(db, projectId, "verification.sandbox_unsafe", ["tests/pipeline.test.ts"]);
      const { updateTask } = setup({});
      const res = await update(updateTask, { title: "New", verification: [{ command: "npx vitest run", cwd: "/ws" }] });
      expect(res.error).toMatchObject({ missingExcludes: ["tests/pipeline.test.ts"], suggestedFlags: '--exclude "tests/pipeline.test.ts"' });
      unchanged();
    });

    it("does not count the task being updated as an open task to overlap", async () => {
      const { updateTask } = setup({});
      const res = await update(updateTask, { title: "New" });
      expect(res.ok).toBe(true);
      expect((getTask(db, taskId)?.contract as TaskV2).title).toBe("New");
    });
  });
});
