import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, createRun, createTask, createAttempt, countAttempts, getAttempt, getTask, getTaskPlan, savePrototypeConfig, listStageReceipts, saveProjectSetting, transitionAttempt } from "../src/rooms/storage/database";
import { createWriterUpdateTask } from "../src/rooms/writer/server/update-task";
import type { TaskV2 } from "../src/rooms/contracts";
import type { ServerCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";

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

  describe("a blocked task whose writer asked a question", () => {
    const question = "Which check runs the fitness tests?";
    const newVerification = [{ command: "npx vitest run tests/fitness/", cwd: "/ws/apps/marketing" }];

    const blockedWith = (reason: string) => {
      createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
      createAttempt(db, { id: "att-1", runId, taskId });
      db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, thread_id='thr-w', workspace_path='/ws/worktrees/att-1' WHERE id='att-1'").run(reason);
    };

    const setup = (options: { failSend?: boolean; busy?: boolean } = {}) => {
      const sent: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
      const writes: Array<{ path: string; content: string }> = [];
      const started: Array<{ runId: string; taskId: string; firstAttemptId: string; writerThreadId: string; task: TaskV2 }> = [];
      const bbWithThreads = {
        ...fakeBb,
        sdk: {
          files: {
            read: async () => null,
            write: async (args: { path: string; content: string }) => { writes.push(args); },
          },
          threads: {
            send: async (args: { threadId: string; input: Array<{ text: string }> }) => {
              if (options.failSend) throw new Error("thread gone");
              sent.push(args);
            },
          },
        },
      };
      const ctx = {
        bb: bbWithThreads as never,
        db,
        host: {
          call: async (method: string, input: { paths?: string[] }) => method === "snapshotDryRun"
            ? { entries: (input.paths ?? []).map((path) => ({ path, kind: "missing" })) }
            : { exitCode: 0, stdout: "", stderr: "" },
        },
        state: { disposed: false },
        log: () => {},
        getThreadBounded: async () => ({ id: "thr-w", status: "idle" }),
        acceptedTaskWorkspace: (_runId: string, _taskId: string, _workspace: string, contract: TaskV2) =>
          ({ task: contract, path: "/ws/worktrees/att-1", environmentId: null }),
      } as unknown as ServerCore;
      const services = {
        activeWriterTasks: new Set<string>(options.busy ? [`${runId}:${taskId}`] : []),
        stability: { loadParked: async () => [] },
        startWriterTask: (input: (typeof started)[number]) => { started.push(input); },
      } as unknown as Services;
      return { updateTask: createWriterUpdateTask(ctx, services).updateTask, sent, writes, started };
    };

    it("fixes a check in place: the same attempt reopens in the same writer thread, no attempt is charged, the writer is told the change", async () => {
      blockedWith(`needs_human: ${question}`);
      const { updateTask, sent, writes, started } = setup();
      const attemptsBefore = countAttempts(db, runId, taskId);

      const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, verification: newVerification } });

      expect(res).toMatchObject({ ok: true, attemptId: "att-1", writerThreadId: "thr-w", state: "running", changed: ["verification"] });
      expect((getTask(db, taskId)?.contract as TaskV2).verification).toMatchObject(newVerification);
      expect(getAttempt(db, "att-1")?.state).toBe("running");
      expect(countAttempts(db, runId, taskId)).toBe(attemptsBefore);

      // The validation of the reopened attempt runs under the new contract.
      expect(started).toHaveLength(1);
      expect(started[0]).toMatchObject({ runId, taskId, firstAttemptId: "att-1", writerThreadId: "thr-w" });
      expect(started[0]?.task.verification).toMatchObject(newVerification);

      // The writer gets one turn in its own thread, naming the changed field with its old and new value.
      expect(sent).toHaveLength(1);
      expect(sent[0]?.threadId).toBe("thr-w");
      const turn = sent[0]!.input[0]!.text;
      expect(turn).toContain(`Your question was: ${question}`);
      expect(turn).toMatch(/- verification: \[\{"command":"npm test".*→ \[\{"command":"npx vitest run tests\/fitness\/"/);
      expect(turn).toContain("NEEDS_HUMAN:");

      // The question and the PM's fix are kept in the task folder's Q&A.
      const qa = writes.find((write) => write.path.endsWith("/QA.md"));
      expect(qa?.content).toContain(`Q (writer): ${question}`);
      expect(qa?.content).toContain("- verification:");
    });

    it("refuses to change the objective of a blocked task, with a redispatch hint, and changes nothing", async () => {
      blockedWith(`needs_human: ${question}`);
      const { updateTask, sent, started } = setup();

      const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, objective: "A different objective" } });

      expect(res.error).toMatchObject({ code: "redispatch_required", retryable: false, sideEffects: "none" });
      expect(String((res.error as { hint: string }).hint)).toContain("objective need a redispatch");
      expect((getTask(db, taskId)?.contract as TaskV2).objective).toBe("Original objective");
      expect(getAttempt(db, "att-1")?.state).toBe("blocked");
      expect(sent).toEqual([]);
      expect(started).toEqual([]);
    });

    it("a blocked task whose writer stopped on a fault, not a question, still answers task_started", async () => {
      blockedWith("retry limit 2 exhausted");
      const { updateTask, started } = setup();

      const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, verification: newVerification } });

      expect(res.error).toMatchObject({ code: "task_started", retryable: false, sideEffects: "none" });
      expect(started).toEqual([]);
    });

    it("does not touch the contract while the writer is still finishing", async () => {
      blockedWith(`needs_human: ${question}`);
      const { updateTask, started } = setup({ busy: true });

      const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, verification: newVerification } });

      expect(res.error).toMatchObject({ code: "not_reopenable", retryable: false, sideEffects: "none" });
      expect(String((res.error as { hint: string }).hint)).toContain("still finishing");
      expect((getTask(db, taskId)?.contract as TaskV2).verification[0]?.command).toBe("npm test");
      expect(getAttempt(db, "att-1")?.state).toBe("blocked");
      expect(started).toEqual([]);
    });

    it("a turn that cannot be delivered puts the stored contract and plan back and leaves the attempt blocked", async () => {
      blockedWith(`needs_human: ${question}`);
      const { updateTask, started } = setup({ failSend: true });

      const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, verification: newVerification } });

      expect(res.error).toMatchObject({ code: "not_reopenable", retryable: false, sideEffects: "none" });
      expect(String((res.error as { hint: string }).hint)).toContain("could not be delivered");
      expect((getTask(db, taskId)?.contract as TaskV2).verification[0]?.command).toBe("npm test");
      expect(getTaskPlan(db, taskId)).toBe("Original objective");
      expect(getAttempt(db, "att-1")?.state).toBe("blocked");
      expect(started).toEqual([]);
    });
  });
});
