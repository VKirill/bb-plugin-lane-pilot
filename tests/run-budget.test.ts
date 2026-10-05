import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  budgetStopReason,
  createRunBudget,
  RunBudgetExceeded,
  runningWriterBudgetStop,
} from "@lane-pilot/resilience";
import { FREE_CLASSES, PARKED_CLASSES, failureClass } from "../src/failure-class";
import {
  countChargedAttempts,
  createAttempt,
  createRun,
  createTask,
  getAttempt,
  openDatabase,
  setRunThread,
  transitionAttempt,
} from "../src/database";
import { runHealth } from "../src/server/health";
import { bindRunChildBudget, fullAccessSpawn } from "../src/server/pm-spawn";
import { createStability } from "../src/server/stability";
import { createWriterFinish } from "../src/server/writer/finish";
import { createWriterSpawn } from "../src/server/writer/spawn";
import type { PrototypeConfig, TaskV2 } from "../src/contracts";

const config: PrototypeConfig = {
  projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo",
  pmProviderId: "codex", pmModel: "codex-test", writerProviderId: "codex", writerModel: "codex-test",
};
const task: TaskV2 = {
  schema_version: 2, id: "t1", title: "Write", risk: "low", lane: "writer",
  project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [],
  objective: "write", acceptance: ["file exists"], verify: "none", verification: [],
};

describe("run budget meter", () => {
  it("reserves a child up to the limit and names the stop reason", () => {
    const budget = createRunBudget({ maxChildren: 2 });
    expect(budget.reserveChild()).toEqual({ ok: true });
    expect(budget.reserveChild()).toEqual({ ok: true });
    const refused = budget.reserveChild();
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.exceeded).toBe("maxChildren");
    expect(budget.snapshot().children).toBe(2);
    expect(budgetStopReason("maxChildren")).toBe("run_budget_exceeded:child threads");
    expect(budgetStopReason("maxWallMs")).toBe("run_budget_exceeded:wall-clock ms");
    expect(budgetStopReason("maxTokens")).toBe("run_budget_exceeded:tokens");
  });

  it("stops a running writer only for wall and tokens", () => {
    const wall = createRunBudget({ maxWallMs: 10, maxChildren: 1 }, 0).check(11);
    expect(runningWriterBudgetStop(wall)).toBe("run_budget_exceeded:wall-clock ms");
    const children = createRunBudget({ maxChildren: 1 });
    children.noteChild();
    children.noteChild();
    expect(runningWriterBudgetStop(children.check())).toBeNull();
  });
});

describe("run-bound helper spawn", () => {
  it("counts a helper spawn and refuses the next over run.max_children", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      spawn: async () => ({ id: "child-1" }),
    } } as never });
    const budget = createRunBudget({ maxChildren: 1 });
    bindRunChildBudget(bb, () => budget);
    await expect(fullAccessSpawn(bb, { projectId: "P", prompt: "x", pluginMetadata: { role: "writer", lanePilotRunId: "run" } } as never))
      .resolves.toMatchObject({ id: "child-1" });
    expect(budget.snapshot().children).toBe(1);
    expect(() => fullAccessSpawn(bb, { projectId: "P", prompt: "x", pluginMetadata: { role: "docs-maintainer", lanePilotRunId: "run" } } as never))
      .toThrow("run_budget_exceeded:child threads");
    expect(budget.snapshot().children).toBe(1);
  });

  it("does not count a PM spawn or a spawn without a run id", async () => {
    const spawned: unknown[] = [];
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      spawn: async (args: unknown) => { spawned.push(args); return { id: `t${spawned.length}` }; },
    } } as never });
    const budget = createRunBudget({ maxChildren: 1 });
    bindRunChildBudget(bb, () => budget);
    await fullAccessSpawn(bb, { projectId: "P", prompt: "pm", pluginMetadata: { role: "pm", lanePilotRunId: "run" } } as never);
    await fullAccessSpawn(bb, { projectId: "P", prompt: "probe" } as never);
    expect(budget.snapshot().children).toBe(0);
    expect(spawned).toHaveLength(2);
  });

  it("turns a writer spawn over the child limit into a blocked attempt", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    setRunThread(db, "run", "pm");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const budget = createRunBudget({ maxChildren: 1 });
    budget.noteChild();
    const ctx = {
      bb: {
        storage: bb.storage,
        log: { info() {}, warn() {} },
        sdk: {
          projects: { get: async () => ({ sources: [] }) },
          providers: {
            list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
            models: async () => ({
              models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }],
            }),
          },
          files: { read: async () => ({ content: null }) },
          threads: {
            get: async () => ({ id: "pm", projectId: "P", status: "idle" }),
            spawn: async () => ({ id: "writer-1" }),
          },
        },
      },
      db,
      host: { call: async (method: string) => {
        if (method === "runCommand") return { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" };
        if (method === "gitCreateWorktree") {
          return { status: "failed", path: null, reason: "workspace_not_repo_root: /repo is not the git repo root /repo" };
        }
        return {};
      } },
      effectiveProjectSettings: async () => ({ values: { "jev.LANE_JEV_EFFORT": false, "memory.enabled": false, "adoc.040": "in_place" } }),
    };
    bindRunChildBudget(ctx.bb as never, () => budget);
    const writer = createWriterSpawn(ctx as never, {
      providerBreaker: { decide: () => ({ allow: true }) },
      ruleScan: { chainForRun: async () => [] },
    } as never);
    const result = await writer.spawnWriterAttempt({
      projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config, task, plan: "write", pmThreadId: "pm",
    });
    expect(result).toMatchObject({ ok: false, status: "blocked", reason: "run_budget_exceeded:child threads" });
    expect(getAttempt(db, "a1")?.state).toBe("blocked");
    expect(getAttempt(db, "a1")?.reason).toBe("run_budget_exceeded:child threads");
  });
});

describe("budget stop outcome", () => {
  it("is uncharged and is not parked or restarted", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      send: async () => ({}),
    } } as never });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "cli", "/repo");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm', writer_workspace_path='/repo' WHERE id='run'").run();
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES('T1','run','bb','{}',1)").run();
    createAttempt(db, { id: "a1", runId: "run", taskId: "T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr_a1" });
    transitionAttempt(db, "a1", "blocked", { reason: "run_budget_exceeded:wall-clock ms" });
    expect(failureClass("blocked", "run_budget_exceeded:wall-clock ms")).toBe("budget");
    expect(FREE_CLASSES.has("budget")).toBe(true);
    expect(PARKED_CLASSES.has("budget")).toBe(false);
    expect(countChargedAttempts(db, "run", "T1")).toBe(0);
    const resumed: string[] = [];
    const services = { activeWriterTasks: new Set<string>(),
      enqueueResumedWriter: async (_projectId: string, attempt: { task_id: string }) => { resumed.push(attempt.task_id); return true; } };
    const { stability } = createStability({ bb, db, log: () => undefined } as never, services as never);
    expect(await stability.onTaskFailed({
      projectId: "proj", runId: "run", taskId: "T1", pmThreadId: "pm",
      state: "blocked", reason: "run_budget_exceeded:tokens",
    })).toBe(false);
    expect(await stability.sweep(Date.now() + 3600_000)).toEqual([]);
    expect(resumed).toEqual([]);
  });
});

describe("lane_pilot_run_health", () => {
  it("shows child threads used against the limit", () => {
    const budget = createRunBudget({ maxChildren: 3 });
    budget.noteChild();
    budget.noteChild();
    const health = runHealth({
      runBudgets: new Map([["run", budget]]),
      providerBreaker: { snapshot: () => [] },
    } as never, "run");
    expect(health.budget).toMatchObject({
      children: 2,
      childThreads: { used: 2, limit: 3 },
      limits: { maxChildren: 3 },
    });
  });
});

describe("running writer budget stop", () => {
  async function finishWithBudget(budget: ReturnType<typeof createRunBudget>) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "writer-1" });
    const stopped: string[] = [];
    const ctx = {
      state: { disposed: false },
      bb: {
        storage: bb.storage,
        log: { warn() {}, error() {} },
        sdk: {
          threads: {
            stop: async ({ threadId }: { threadId: string }) => { stopped.push(threadId); },
            events: { list: async () => [{ type: "thread/tokenUsage/updated", data: { threadId: "writer-1", tokenUsage: { total: { totalTokens: 50 } } } }] },
            get: async () => ({ id: "writer-1", status: "active" }),
          },
        },
      },
      db,
      getThreadBounded: async () => ({ status: "active" }),
      host: { call: async () => ({}) },
    };
    const finish = createWriterFinish(ctx as never, {
      runBudgetFor: () => budget,
      validateWriterResult: async () => ({ status: "accepted" }),
    } as never);
    const result = await finish.finishWriterAttempt({
      projectId: "P", config, task, runId: "run", taskId: "t1", attemptId: "a1",
      pmThreadId: "pm", writerThreadId: "writer-1", dirtBefore: [],
    });
    return { result, stopped, attempt: getAttempt(db, "a1") };
  }

  it("stops a running writer when wall-clock is over", async () => {
    const { result, stopped, attempt } = await finishWithBudget(createRunBudget({ maxWallMs: 10 }, 0));
    expect(result).toMatchObject({ status: "blocked", reason: "run_budget_exceeded:wall-clock ms" });
    expect(stopped).toEqual(["writer-1"]);
    expect(attempt).toMatchObject({ state: "blocked", reason: "run_budget_exceeded:wall-clock ms" });
  });

  it("stops a running writer when tokens are over", async () => {
    const budget = createRunBudget({ maxTokens: 10 });
    const { result, attempt } = await finishWithBudget(budget);
    expect(result).toMatchObject({ status: "blocked", reason: "run_budget_exceeded:tokens" });
    expect(attempt).toMatchObject({ state: "blocked", reason: "run_budget_exceeded:tokens" });
  });
});

describe("timeout attempt state", () => {
  it("stays unused: a budget overrun is blocked, not moved to timeout", () => {
    expect(failureClass("blocked", "run_budget_exceeded:wall-clock ms")).toBe("budget");
    expect(failureClass("timeout", "wait_timeout")).toBe("provider");
    expect(runningWriterBudgetStop(createRunBudget({ maxWallMs: 1 }, 0).check(2))).toBe("run_budget_exceeded:wall-clock ms");
  });
});

describe("no run.* settings", () => {
  it("leaves spawn and check unchanged", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: {
      spawn: async () => ({ id: "child" }),
    } } as never });
    const budget = createRunBudget({});
    bindRunChildBudget(bb, () => budget);
    await expect(fullAccessSpawn(bb, { projectId: "P", prompt: "x", pluginMetadata: { role: "writer", lanePilotRunId: "run" } } as never))
      .resolves.toMatchObject({ id: "child" });
    expect(budget.check().ok).toBe(true);
    expect(new RunBudgetExceeded({ ok: false, exceeded: "maxChildren", used: 2, limit: 1, reason: "x" }).message)
      .toBe("run_budget_exceeded:child threads");
  });
});
