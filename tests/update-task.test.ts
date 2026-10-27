import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase, createRun, createTask, createAttempt, countAttempts, getAttempt, getTask, getTaskGitBase, getTaskPlan, loadPrototypeConfig,
  savePrototypeConfig, listStageReceipts, saveProjectSetting, transitionAttempt } from "../src/rooms/storage/database";
import { createWriterUpdateTask } from "../src/rooms/writer/server/update-task";
import { registerDispatchExecutors, startDispatchRun } from "../src/rooms/writer/server/dispatch-workflow";
import { builtinWorkflow } from "../src/rooms/workflow";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
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
    display_title: "Тестовая задача",
    kind: "feature",
    area: "feature:update-task",
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

  /** The task's pipeline run as a dispatch leaves it: the real executors on a real engine, waiting at the writer (the folder is not git, the writer queue is a stub). */
  async function dispatched(ctx: ServerCore, services: Services, task: TaskV2 = baseTask, config = loadPrototypeConfig(db, projectId)!) {
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", resolveWorkflow: (id, version) => builtinWorkflow(id, version) });
    registerDispatchExecutors(engine);
    // The pipeline's browser-check gate (registered by the qa room in the plugin): these tasks have no qa_url, so it never runs a check.
    engine.register("lp.qa-gate", { reentrant: true, run: async () => ({ output: { run: false } }) });
    const started: string[] = [];
    Object.assign(services, { workflowEngine: engine, isLiveFolder: async () => false, startWriterTask: (input: { task: TaskV2 }) => { started.push(input.task.title); } });
    const mutable = ctx as unknown as { host?: unknown; refreshRun?: unknown };
    mutable.host ??= { call: async (method: string) => (method === "gitOwnershipBase" ? { status: "not-git" } : { status: "ready", entries: [] }) };
    mutable.refreshRun ??= () => undefined;
    const run = startDispatchRun(engine, { ctx, services, threadId: pmThreadId, projectId, runId, taskId, attemptId: "att-1", config, runConfig: config,
      workspacePath: "/ws", task, plan: task.objective, lintWarnings: [] });
    expect((await run.done).status).toBe("waiting");
    return { engine, started, pipelineRunId: run.runId };
  }

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
      configForRun: async (id: string) => loadPrototypeConfig(db, id),
      log: () => {},
    } as unknown as ServerCore;

    const services = {
      activeWriterTasks: new Set<string>(),
      stability: { loadParked: async () => [] },
    } as unknown as Services;

    const { engine, started, pipelineRunId } = await dispatched(ctx, services);
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
    expect(res.critiqueAllowed).toBe(true);

    // The critique went again through the task's own pipeline run, from pm-read, and the run waits for the writer once more.
    expect(engine.get(pipelineRunId)?.status).toBe("waiting");
    const rerun = db.prepare("SELECT detail FROM lane_pilot_wf_event WHERE run_id=? AND kind='rerun'").all(pipelineRunId) as Array<{ detail: string }>;
    expect(rerun).toHaveLength(1);
    expect(rerun[0]!.detail).toContain("node pm-read");
    const critiques = db.prepare("SELECT input_json FROM lane_pilot_wf_step WHERE run_id=? AND node_id IN ('plan-critique','plan-critique-quick') AND state='succeeded'").all(pipelineRunId);
    expect(critiques).toHaveLength(1);
    // The one pipeline run: no second run was started, and the writer's own queue was not started a second time by the update.
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_run WHERE workflow_id='lp-task-pipeline'").get()).toEqual({ n: 1 });
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(getAttempt(db, "att-1")).toMatchObject({ state: "queued", reason: null });

    // A second update goes again the same way: the first left the run waiting and the attempt free.
    const again = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...updatedTask, title: "Updated twice" }, plan: "Third plan" });
    expect(again.ok).toBe(true);
    expect(engine.get(pipelineRunId)?.status).toBe("waiting");
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_event WHERE run_id=? AND kind='rerun'").get(pipelineRunId)).toEqual({ n: 2 });
    expect((getTask(db, taskId)?.contract as TaskV2).title).toBe("Updated twice");
  });

  it("keeps the base commit the task already has when its pipeline goes again", async () => {
    createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
    createAttempt(db, { id: "att-1", runId, taskId });
    const sha = "a".repeat(40);
    const ctx = { bb: fakeBb as never, db, state: { disposed: false }, configForRun: async (id: string) => loadPrototypeConfig(db, id), log: () => {},
      host: { call: async (method: string) => (method === "gitOwnershipBase"
        ? { status: "ready", baseRef: "main", baseSha: sha, headSha: sha, branch: "main", compareCommitted: true } : { status: "ready", entries: [] }) } } as unknown as ServerCore;
    const services = { activeWriterTasks: new Set<string>(), stability: { loadParked: async () => [] } } as unknown as Services;
    const { engine, pipelineRunId } = await dispatched(ctx, services);
    expect(getTaskGitBase(db, taskId)).toMatchObject({ base_sha: sha });
    const res = await createWriterUpdateTask(ctx, services).updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, title: "Updated title" }, plan: "New plan" });
    expect(res.ok).toBe(true);
    expect(engine.get(pipelineRunId)?.status).toBe("waiting");
    expect(getTaskGitBase(db, taskId)).toMatchObject({ base_sha: sha });
  });

  it("refuses an update of a task that has no pipeline run, and changes nothing", async () => {
    createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
    createAttempt(db, { id: "att-1", runId, taskId });
    const ctx = { bb: fakeBb as never, db, state: { disposed: false }, configForRun: async (id: string) => loadPrototypeConfig(db, id), log: () => {} } as unknown as ServerCore;
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0" });
    const { updateTask } = createWriterUpdateTask(ctx, { activeWriterTasks: new Set<string>(), stability: { loadParked: async () => [] }, workflowEngine: engine } as unknown as Services);
    const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, title: "Updated title" }, plan: "New plan" });
    expect(res).toMatchObject({ ok: false, error: { code: "pipeline_run_missing", sideEffects: "none" } });
    expect((getTask(db, taskId)?.contract as TaskV2).title).toBe("Original title");
  });

  it("updates a task of a chat that switched Lane Pilot on in the composer: no project config, the run's own (Vampirism Fire 2026-10-23)", async () => {
    createTask(db, { id: taskId, runId, kind: "bb", contract: baseTask });
    createAttempt(db, { id: "att-1", runId, taskId });
    const runConfig = loadPrototypeConfig(db, projectId);
    const asked: string[] = [];
    const ctx = { bb: fakeBb as never, db, state: { disposed: false }, log: () => {},
      configForRun: async (id: string) => { asked.push(id); return runConfig; } } as unknown as ServerCore;
    const services = { activeWriterTasks: new Set<string>(), stability: { loadParked: async () => [] } } as unknown as Services;
    await dispatched(ctx, services);
    db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id=? AND key=?").run(projectId, "hostId");
    expect(loadPrototypeConfig(db, projectId)).toBeNull();
    asked.length = 0;
    const { updateTask } = createWriterUpdateTask(ctx, services);
    const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...baseTask, title: "Updated title" }, plan: "New plan" });
    expect(res.ok).toBe(true);
    expect(asked).toEqual([projectId]);
  });

  it("moves the PM's contract into the repository its task works in, and refuses one that leaves it (BB-сервис 2026-10-11)", async () => {
    // The task was moved at dispatch into the repository plugins/p of the run folder /ws.
    const moved: TaskV2 = { ...baseTask, project_cwd: "/ws/plugins/p", owns_paths: ["src/**"], expected_outputs: ["out.txt"], verification: [{ command: "npm test", cwd: "/ws/plugins/p" }] };
    createTask(db, { id: taskId, runId, kind: "bb", contract: moved });
    createAttempt(db, { id: "att-1", runId, taskId });
    const ctx = { bb: fakeBb as never, db, state: { disposed: false }, configForRun: async (id: string) => loadPrototypeConfig(db, id), log: () => {} } as unknown as ServerCore;
    const services = { activeWriterTasks: new Set<string>(), stability: { loadParked: async () => [] } } as unknown as Services;
    await dispatched(ctx, services, moved);
    const { updateTask } = createWriterUpdateTask(ctx, services);
    // The PM sends it as it wrote it: from the run folder, with a reference file of another plugin.
    const asWritten: TaskV2 = { ...baseTask, title: "Updated title", owns_paths: ["plugins/p/src/**"], expected_outputs: ["plugins/p/out.txt"],
      read_first: ["plugins/q/x.ts"], verification: [{ command: "npm test", cwd: "/ws/plugins/p" }] };
    const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: asWritten, plan: "Updated plan" });
    expect(res.ok).toBe(true);
    expect(getTask(db, taskId)?.contract).toMatchObject({ title: "Updated title", project_cwd: "/ws/plugins/p", owns_paths: ["src/**"], expected_outputs: ["out.txt"], read_first: [] });
    expect(getTaskPlan(db, taskId)).toContain("- /ws/plugins/q/x.ts");
    const leaves = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...asWritten, owns_paths: ["plugins/p/src/**", "plugins/q/**"] }, plan: "Updated plan" });
    expect(leaves).toMatchObject({ ok: false, error: { code: "validation_failed", hint: expect.stringContaining("/ws/plugins/p, the repository this task works in") } });
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
      configForRun: async (id: string) => loadPrototypeConfig(db, id),
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
            if (method === "gitOwnershipBase") return { status: "not-git" };
            if (method === "snapshotDryRun") {
              return { entries: (input.paths ?? []).map((path) => ({ path, kind: kinds[path.slice("/ws/".length)] ?? "missing" })) };
            }
            return { exitCode: 0, stdout: "", stderr: "" };
          },
        },
        state: { disposed: false },
      configForRun: async (id: string) => loadPrototypeConfig(db, id),
        log: () => {},
      } as unknown as ServerCore;
      const services = { activeWriterTasks: new Set<string>(), stability: { loadParked: async () => [] } } as unknown as Services;
      return { updateTask: createWriterUpdateTask(ctx, services).updateTask, calls, ctx, services };
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

    it("sends the task standard back too: a title missing, too long, no kind, no area", async () => {
      const { updateTask } = setup();
      const res = await update(updateTask, { title: "New", display_title: "x".repeat(1001), kind: undefined, area: undefined });
      expect(res.ok).toBe(false);
      expect(res.error).toMatchObject({ code: "validation_failed", findings: expect.arrayContaining([
        expect.objectContaining({ code: "display_title_too_long" }), expect.objectContaining({ code: "kind_missing" }), expect.objectContaining({ code: "area_missing" })]) });
      expect(hintOf(res)).toContain("the task was not changed");
      unchanged();
      const none = await update(updateTask, { title: "New", display_title: undefined });
      expect(hintOf(none)).toContain("display_title is missing");
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
      const { updateTask, ctx, services } = setup({});
      await dispatched(ctx, services);
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
      configForRun: async (id: string) => loadPrototypeConfig(db, id),
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

    it("fixes a blocked task dispatched before the task standard: the title and kind come in place, an area it never had is not demanded", async () => {
      const { display_title: _title, kind: _kind, area: _area, ...old } = baseTask;
      createTask(db, { id: taskId, runId, kind: "bb", contract: old });
      createAttempt(db, { id: "att-1", runId, taskId });
      db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, thread_id='thr-w', workspace_path='/ws/worktrees/att-1' WHERE id='att-1'").run(`needs_human: ${question}`);
      const { updateTask } = setup();
      const res = await updateTask({ projectId, runId, pmThreadId, taskId, task: { ...old, display_title: "Правка проверки", kind: "fix", verification: newVerification } });
      expect(res).toMatchObject({ ok: true, state: "running" });
      expect(res.changed).toEqual(expect.arrayContaining(["verification", "display_title", "kind"]));
    });

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
