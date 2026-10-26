import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import type { TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../src/rooms/storage/database";

const projectId = "project-test";
const pmThreadId = "pm-thread";
const runId = "run-topic";
const config = {
  projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer",
  pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test",
};
const base: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "fix", area: "feature:runner", id: "runner-x", title: "Fix the runner", risk: "low", lane: "writer", project_cwd: config.writerWorkspacePath,
  read_first: ["README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["tools/runner.py"],
  owns_paths: ["tools/runner.py"], never_touch: [".git/**"], depends_on: [], objective: "fix the runner", acceptance: ["never"],
  verify: "none", verification: [],
};
const HOUR = 3_600_000;

async function setup() {
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { threads: {
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : { role: "writer" },
      spawn: async () => ({ id: "writer-topic" }),
      wait: async () => new Promise(() => undefined),
      get: async ({ threadId }) => threadId === pmThreadId ? { id: pmThreadId, status: "idle", projectId } as never : { id: threadId, status: "active" } as never,
      output: async () => ({ text: "" }),
      list: async () => [] as never,
      stop: async () => ({} as never),
    }, providers: {
      list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
      models: async () => ({ models: [{ id: "codex-test", model: "codex-test",
        supportedReasoningEfforts: ["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
    }, files: { read: async () => ({ content: "fixture\n" }), write: async () => ({ ok: true }) } },
    experimental_callHostRpc: async (call) => {
      // The git base is never answered: the dispatch stays in its stages and answers «queued» early.
      if (call.method === "gitOwnershipBase") return new Promise(() => undefined);
      if (call.method === "classifyPlan") return { hostId: "host-test", status: "ok", effort: "xhigh", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
      if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
      return { hostId: "host-test", exitCode: 0, stdout: String((call.input as { command?: string }).command ?? "").includes("porcelain") ? "[]" : "", stderr: "" };
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  saveProjectSetting(db, projectId, "memory.enabled", false);
  createRun(db, runId, projectId, "bb", config.writerWorkspacePath);
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  /** A task of the run as it was left: sent `hoursAgo` hours ago, its attempts in the given states. */
  const seed = (next: Partial<TaskV2>, hoursAgo: number, states: string[]) => {
    const id = next.id!;
    createTask(db, { id, runId, kind: "bb", contract: { ...base, ...next } });
    db.prepare("UPDATE lane_pilot_task SET created_at=? WHERE id=?").run(Date.now() - hoursAgo * HOUR, id);
    states.forEach((state, index) => {
      createAttempt(db, { id: `attempt-${id}-${index}`, runId, taskId: id });
      db.prepare("UPDATE lane_pilot_attempt SET state=? WHERE id=?").run(state, `attempt-${id}-${index}`);
    });
  };
  const dispatch = async (next: Partial<TaskV2>) => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка диспетча", plan: "Plan", task: { ...base, ...next } }, { threadId: pmThreadId, projectId },
  ))) as Record<string, unknown>;
  const taskCount = () => (db.prepare("SELECT COUNT(*) count FROM lane_pilot_task WHERE run_id=?").get(runId) as { count: number }).count;
  const loopWalls = () => db.prepare("SELECT wall_key, state, subject FROM lane_pilot_wall WHERE wall_key LIKE 'loop:topic:%'").all().map((row) => ({ key: (row as { wall_key: string }).wall_key, state: (row as { state: string }).state, subject: (row as { subject: string }).subject }));
  return { seed, dispatch, taskCount, loopWalls, db };
}

describe("dispatch: loop stopper and batch advice", () => {
  beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "50"; });
  afterEach(() => { delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS; });

  it("refuses the fourth fix of one file under a new id, creating nothing, and lets one research task through", async () => {
    const { seed, dispatch, taskCount, loopWalls } = await setup();
    for (const [index, id] of ["runner-a", "runner-b", "runner-c"].entries()) seed({ id, title: `Fix the runner: ${id}` }, 10 - index, ["accepted"]);
    const refused = await dispatch({ id: "runner-d", title: "Fix the runner again" });
    expect(refused).toMatchObject({ ok: false, error: { code: "topic_loop", retryable: false, sideEffects: "none" } });
    expect(String(refused.hint)).toMatch(/runner-a, runner-b, runner-c.*tools\/runner\.py.*Lane Pilot took the big picture itself.*three read-only hunters/s);
    expect(String(refused.hint)).not.toMatch(/dispatch ONE research task|PM's|waits for a person/);
    expect(taskCount()).toBe(3);
    // The machine started the hunt itself: one wall of the topic, waiting for the hunters.
    expect(loopWalls()).toEqual([expect.objectContaining({ state: "stopped", subject: expect.stringContaining("tools/runner.py") })]);
    // The redo of a family the run has is not a new try; the research task on the whole picture is the allowed move.
    expect(await dispatch({ id: "runner-c.2" })).toMatchObject({ taskId: "runner-c.2", state: "queued" });
    const research = await dispatch({ id: "why-runner", kind: "research", area: "research:runner", title: "Why tools/runner.py keeps breaking", expected_outputs: ["docs/runner-why.md"], owns_paths: ["docs/runner-why.md"] });
    expect(research.error).toBeUndefined();
    expect(research).toMatchObject({ taskId: "why-runner", state: "queued" });
    // While that analysis is open the topic stays shut, and the message says to wait for it.
    const held = await dispatch({ id: "runner-e", title: "Fix the runner once more" });
    expect(held).toMatchObject({ ok: false, error: { code: "topic_loop" } });
    expect(String(held.hint)).toMatch(/why-runner is still open: wait for its receipt/);
  });

  it("the machine's hunt stands for the research: other tries wait while it runs, one hunt per topic, and the topic reopens when it is done", async () => {
    const { seed, dispatch, taskCount, loopWalls, db } = await setup();
    for (const [index, id] of ["runner-a", "runner-b", "runner-c"].entries()) seed({ id, title: `Fix the runner: ${id}` }, 10 - index, ["accepted"]);
    expect(await dispatch({ id: "runner-d", title: "Fix the runner again" })).toMatchObject({ ok: false, error: { code: "topic_loop" } });
    const held = await dispatch({ id: "runner-e", title: "Fix the runner once more" });
    expect(held).toMatchObject({ ok: false, error: { code: "topic_loop" } });
    expect(String(held.hint)).toMatch(/hunt loop:topic:[0-9a-f]+.*Tasks on the file tools\/runner\.py go out again once the hunt is done/s);
    expect(loopWalls()).toHaveLength(1);
    expect(taskCount()).toBe(3);
    // The hunters finished (the backlog item stands): the topic counts from there, and the next task goes out and follows the finding.
    db.prepare("UPDATE lane_pilot_wall SET state='backlog', updated_at=? WHERE wall_key LIKE 'loop:topic:%'").run(Date.now());
    expect(await dispatch({ id: "runner-f", title: "Fix the runner per the finding" })).toMatchObject({ taskId: "runner-f", state: "queued" });
    expect(loopWalls()).toHaveLength(1);
  });

  it("answers a task that joins a queue with the open tasks that hold it and, from three, how to cut the batch", async () => {
    const { seed, dispatch } = await setup();
    for (const id of ["gen-a", "gen-b"]) seed({ id, kind: "feature", area: `feature:${id}`, owns_paths: ["scripts/gamedata/", `src/${id}.luau`], expected_outputs: [`src/${id}.luau`] }, 1, ["running"]);
    const answer = await dispatch({ id: "gen-c", kind: "feature", area: "feature:gen-c", owns_paths: ["scripts/gamedata/", "src/gen-c.luau"], expected_outputs: ["src/gen-c.luau"] });
    expect(answer).toMatchObject({ taskId: "gen-c", state: "queued" });
    const advice = answer.batchAdvice as string[];
    expect(advice).toHaveLength(2);
    expect(advice[0]).toMatch(/^queue: gen-c waits for 2 open tasks ahead because their owns_paths overlap \(gen-a: scripts\/gamedata\/, gen-b: scripts\/gamedata\/\)/);
    expect(advice[1]).toMatch(/^shape: 3 open tasks \(gen-a, gen-b, gen-c\) own scripts\/gamedata\/.*Narrow owns_paths.*depend on.*merge tiny tasks/);
    // A task that owns other files gets no advice.
    expect((await dispatch({ id: "elsewhere", kind: "feature", area: "feature:else", owns_paths: ["src/else.luau"], expected_outputs: ["src/else.luau"] })).batchAdvice).toBeUndefined();
  });
});
