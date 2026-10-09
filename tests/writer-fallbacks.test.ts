import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { WRITER_FALLBACK_DEFAULTS, writerFallbackChain, writerFallbackSlots, writerFallbacks } from "../src/rooms/writer/writer-fallbacks";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptDirtBefore, setAttemptWorkspace, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { createWriterStart } from "../src/rooms/writer/server/start";

describe("writer fallbacks", () => {
  it("defaults to GLM 5.3 Flash, then Gemini 3.8 high; an emptied slot is off", () => {
    expect(writerFallbacks({}).map((row) => row.model)).toEqual(["zai-coding-plan/glm-5.3-flash", "router9/ag/gemini-3.8-flash-high"]);
    expect(writerFallbacks({ "writer.fallback1.provider":"" })).toEqual([WRITER_FALLBACK_DEFAULTS[1]]);
    expect(writerFallbacks({ "writer.fallback2.provider":"codex", "writer.fallback2.model":"gpt-6", "writer.fallback2.reasoning_effort":"max" })[1])
      .toEqual({ providerId:"codex", model:"gpt-6", reasoningLevel:"max" });
  });

  it("ends with the PM's model and never repeats the writer's or another link", () => {
    const pm = { providerId:"claude-code", model:"claude-opus-5-5" };
    const chain = writerFallbackChain({ providerId:"acp-opencode", model:"zai-coding-plan/glm-5.3-flash" }, writerFallbacks({}), pm);
    expect(chain.map((row) => [row.model, row.pm])).toEqual([["router9/ag/gemini-3.8-flash-high", false], ["claude-opus-5-5", true]]);
    expect(writerFallbackChain(pm, [], pm)).toEqual([]);
  });

  it("fallback 3 is off by default and, once set, sits after fallbacks 1 and 2 and before the PM", () => {
    expect(writerFallbackSlots({})[2]).toBeNull();
    expect(writerFallbacks({})).toHaveLength(2);
    const settings = { "writer.fallback3.provider":"codex", "writer.fallback3.model":"gpt-6", "writer.fallback3.reasoning_effort":"high" };
    expect(writerFallbacks(settings).map((row) => row.model)).toEqual(["zai-coding-plan/glm-5.3-flash", "router9/ag/gemini-3.8-flash-high", "gpt-6"]);
    const pm = { providerId:"claude-code", model:"claude-opus-5-5" };
    const chain = writerFallbackChain({ providerId:"acp-opencode", model:"zai-coding-plan/glm-5.3-flash" }, writerFallbacks(settings), pm);
    expect(chain.map((row) => [row.model, row.pm])).toEqual([["router9/ag/gemini-3.8-flash-high", false], ["gpt-6", false], ["claude-opus-5-5", true]]);
  });

  it("an emptied fallback 3 is skipped and shows as off in the slot list", () => {
    const settings = { "writer.fallback3.provider":"", "writer.fallback2.provider":"codex", "writer.fallback2.model":"gpt-6", "writer.fallback2.reasoning_effort":"max" };
    expect(writerFallbackSlots(settings)).toEqual([WRITER_FALLBACK_DEFAULTS[0], { providerId:"codex", model:"gpt-6", reasoningLevel:"max" }, null]);
    expect(writerFallbacks(settings).map((row) => row.model)).toEqual(["zai-coding-plan/glm-5.3-flash", "gpt-6"]);
  });
});

const WORKSPACE = "/ws";
const WORKTREE = "/wt/T1-a1";
const BASELINE = [{ path: "stray.txt", sha256: "baseline" }];

const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE,
  pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };

const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

type Step = { accept?: true; limit?: true; invalid?: true };
type Spawn = { attemptId: string; emergency?: unknown; continuation?: { workspacePath: string; environmentId: string | null; dirtBefore: unknown; fromThreadId: string; brief: string } };

/** A writer in a folder with git: each attempt works in its own worktree; the host calls are recorded. `script` ends each finished attempt. */
function harness(script: Step[], refuseFallbacks = false) {
  const { bb, harness: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
  fake.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  fake.sdk.stub("threads.send", async () => undefined);
  fake.sdk.stub("threads.context", async () => ({ usage: null }));
  fake.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  // The interrupted writer's events, newest first; the usage query (it names a type) reads nothing.
  fake.sdk.stub("threads.events.list", async (query: { types?: unknown }) => query.types ? [] : [
    { data: { item: { type: "agentMessage", text: "Parser half done" } } },
    { data: { item: { type: "commandExecution", command: "npm test", exitCode: 1, aggregatedOutput: "AssertionError: boom" } } },
  ]);
  fake.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const hostCalls: Array<{ method: string; args: unknown }> = [];
  const callHost = ctx.host.call.bind(ctx.host);
  (ctx.host as { call: unknown }).call = async (method: string, args: unknown, options: unknown) => {
    hostCalls.push({ method, args });
    if (method === "runCommand") return { exitCode: 0, stdout: " M parser.ts\n", stderr: "" };
    if (method === "gitRemoveWorktree") return { status: "removed" };
    return callHost(method as never, args as never, options as never);
  };
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  const spawns: Spawn[] = [];
  let turn = 0;
  const services = {
    activeWriterTasks: new Set<string>(),
    providerBreaker: { record: () => undefined },
    ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    maintainMemoryAfterAcceptance: () => undefined,
    maintainProjectLifeAfterAcceptance: () => undefined,
    isLiveFolder: async () => false,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }),
    spawnWriterAttempt: async (input: Spawn) => {
      spawns.push({ attemptId: input.attemptId, emergency: input.emergency, continuation: input.continuation });
      if (input.emergency && refuseFallbacks) return { ok: false, status: "spawn_rejected", reason: "writer_model_unavailable:p/fallback", attemptId: input.attemptId };
      const threadId = spawns.length === 1 ? "thr_w" : `thr_f${spawns.length - 1}`;
      // The first attempt's worktree starts with the stray file that was already there; a continued one keeps its baseline.
      const dirtBefore = input.continuation ? input.continuation.dirtBefore : spawns.length === 1 ? BASELINE : [];
      const workspacePath = input.continuation ? input.continuation.workspacePath : spawns.length === 1 ? WORKTREE : `/wt/${input.attemptId}`;
      setAttemptWorkspace(db, input.attemptId, { path: workspacePath, environmentId: null,
        decision: { strategy: "provision_attempt_worktree", reason: "explicit_worktree" } });
      setAttemptDirtBefore(db, input.attemptId, dirtBefore as never);
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId });
      return { ok: true, threadId, providerId: "p", model: "wm", dirtBefore, workspacePath };
    },
    finishWriterAttempt: async (input: { attemptId: string; writerThreadId: string }) => {
      const step = script[turn++] ?? { invalid: true };
      if (step.accept) { transitionAttempt(db, input.attemptId, "accepted"); return { status: "accepted", produced: ["a.txt"], verification: [], attemptId: input.attemptId }; }
      if (step.limit) {
        const reason = "writer_provider_limit: plan spent";
        transitionAttempt(db, input.attemptId, "provider_error", { reason });
        return { status: "provider_error", reason, attemptId: input.attemptId, writerThreadId: input.writerThreadId };
      }
      const reason = "verification failed (npm test): boom";
      transitionAttempt(db, input.attemptId, "validation_failed", { reason });
      return { status: "validation_failed", reason, produced: ["a.txt"], attemptId: input.attemptId, writerThreadId: input.writerThreadId,
        verification: [{ command: "npm test", exitCode: 1, stdout: "", stderr: "AssertionError: boom" }], diffKey: `d${turn}` };
    },
  } as unknown as Services;
  return { db, ctx, harness: fake, hostCalls, spawns, services };
}

type Env = ReturnType<typeof harness>;

function start(env: Env, taskId = "T1") {
  const task = contract(taskId);
  createTask(env.db, { id: taskId, runId: "run1", kind: "bb", contract: task });
  saveTaskPlan(env.db, taskId, `Plan for ${taskId}`);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) {
    recordStage(env.db, { runId: "run1", taskId, stageId, state: "pending", input: `Plan for ${taskId}` });
  }
  createAttempt(env.db, { id: `${taskId}-a1`, runId: "run1", taskId });
  Object.assign(env.services, createWriterStart(env.ctx, env.services));
  env.services.startWriterTask({ projectId: "proj1", runId: "run1", taskId, firstAttemptId: `${taskId}-a1`, pmThreadId: "thr_pm", config, task, plan: `Plan for ${taskId}` });
}

const writerStage = (db: Env["db"], taskId = "T1") => listStageReceipts(db, "run1", taskId).find((row) => row.stageId === "writer-agent")!;
const removals = (env: Env) => env.hostCalls.filter((call) => call.method === "gitRemoveWorktree");

describe("fallback writer continues the interrupted session", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("a limit failure hands its worktree, edits and dirt baseline to the fallback, with a handoff brief", async () => {
    const env = harness([{ limit: true }, { accept: true }]);
    start(env);
    await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
    expect(env.spawns).toHaveLength(2);
    expect(env.spawns[0]!.continuation).toBeUndefined();
    expect(env.spawns[1]!.continuation).toMatchObject({ workspacePath: WORKTREE, environmentId: null, fromThreadId: "thr_w", dirtBefore: BASELINE });
    const brief = env.spawns[1]!.continuation!.brief;
    expect(brief).toContain("Do not start over");
    expect(brief).toContain("Stop reason: provider_error: writer_provider_limit: plan spent");
    expect(brief).toContain(" M parser.ts");
    expect(brief).toContain("AssertionError: boom");
    // The interrupted worktree is the fallback's now: nothing removes it.
    expect(removals(env)).toEqual([]);
    await env.harness.lifecycle.dispose();
  });

  it("a second fallback continues from the fallback that started before it", async () => {
    const env = harness([{ limit: true }, { limit: true }, { accept: true }]);
    start(env);
    await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
    expect(env.spawns).toHaveLength(3);
    expect(env.spawns[1]!.continuation).toMatchObject({ workspacePath: WORKTREE, fromThreadId: "thr_w" });
    expect(env.spawns[2]!.continuation).toMatchObject({ workspacePath: WORKTREE, fromThreadId: "thr_f1", dirtBefore: BASELINE });
    await env.harness.lifecycle.dispose();
  });

  it("a worktree no fallback continues is removed once the chain has ended", async () => {
    const env = harness([{ limit: true }], true);
    start(env);
    await vi.waitFor(() => expect(removals(env)).toHaveLength(1));
    expect(removals(env)[0]!.args).toEqual({ requestedHostId: "h1", basePath: WORKSPACE, worktreePath: WORKTREE });
    expect(env.spawns.slice(1).every((spawn) => spawn.continuation?.workspacePath === WORKTREE)).toBe(true);
    await env.harness.lifecycle.dispose();
  });

  it("a task-class failure starts no fallback writer", async () => {
    const env = harness([]);
    start(env);
    await vi.waitFor(() => expect(writerStage(env.db).state).toBe("failed"));
    expect(env.spawns.filter((spawn) => spawn.emergency)).toEqual([]);
    expect(env.spawns.filter((spawn) => spawn.continuation)).toEqual([]);
    await env.harness.lifecycle.dispose();
  });
});
