import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptDirtBefore, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createWriterStart } from "../../src/rooms/writer/server/start";
import { createStageReturn, type ReturnResult } from "../../src/rooms/stage-return/server";
import { renderReturnNotes } from "../../src/rooms/stage-return";

// The real writer loop (start.ts) with a task returned to its writer while the writer works: the loop stops it, starts the next writer in the same
// worktree, the stale stages are pending, and the note is what every later brief carries. Spawn and finish are stubs, as in reassign-task.test.ts.
const WORKSPACE = "/ws";
const WORKTREE = "/wt/T1-a1";
const BASELINE = [{ path: "stray.txt", sha256: "baseline" }];
const config: PrototypeConfig = { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [], depends_on: [],
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }],
});

describe("a task returned to its writer while the writer works", () => {
  it("restarts the writer in the same worktree with no attempt spent, resets what judges the work, and records the note for the next brief", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const stops: string[] = [];
    const sent: Array<{ threadId: string; text: string }> = [];
    harness.sdk.stub("threads.stop", async (args: { threadId: string }) => { stops.push(args.threadId); return {}; });
    harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
    harness.sdk.stub("threads.send", async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return undefined; });
    harness.sdk.stub("threads.context", async () => ({ usage: null }));
    harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
    harness.sdk.stub("threads.events.list", async (query: { types?: unknown }) => query.types ? [] : [{ data: { item: { type: "agentMessage", text: "Parser half done" } } }]);
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    const callHost = ctx.host.call.bind(ctx.host);
    (ctx.host as { call: unknown }).call = async (method: string, args: unknown, options: unknown) => {
      if (method === "runCommand") return { exitCode: 0, stdout: " M parser.ts\n", stderr: "" };
      if (method === "gitRemoveWorktree") return { status: "removed" };
      return callHost(method as never, args as never, options as never);
    };
    createRun(db, "run1", "proj1", "bb", WORKSPACE);
    setRunThread(db, "run1", "thr_pm");
    savePrototypeConfig(db, config);

    const spawns: Array<{ attemptId: string; continuation?: { workspacePath: string; brief: string } }> = [];
    let returned: Promise<ReturnResult> | null = null;
    let turn = 0;
    const services = {
      activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
      runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
      runWriterPool: { acquire: async () => () => undefined },
      stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
      startAfterAcceptance: () => undefined,
      isLiveFolder: async () => false, workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }),
      rollback: { noteStopped: async () => undefined },
      spawnWriterAttempt: async (input: { attemptId: string; continuation?: { workspacePath: string; dirtBefore: unknown[]; brief: string } }) => {
        spawns.push({ attemptId: input.attemptId, continuation: input.continuation });
        const threadId = spawns.length === 1 ? "thr_w" : "thr_w2";
        const dirtBefore = input.continuation ? input.continuation.dirtBefore : BASELINE;
        const workspacePath = input.continuation ? input.continuation.workspacePath : WORKTREE;
        setAttemptWorkspace(db, input.attemptId, { path: workspacePath, environmentId: null, decision: { strategy: "provision_attempt_worktree", reason: "explicit_worktree" } });
        setAttemptDirtBefore(db, input.attemptId, dirtBefore as never);
        transitionAttempt(db, input.attemptId, "spawn_requested");
        transitionAttempt(db, input.attemptId, "running", { threadId });
        return { ok: true, threadId, providerId: "p", model: "wm", dirtBefore, workspacePath };
      },
      finishWriterAttempt: async (input: { attemptId: string; writerThreadId: string }) => {
        const step = turn++;
        if (step === 0) {
          // The person returns the task to the writer while it works; the loop sees the stop end the attempt and starts the next writer.
          returned = stageReturn.returnTask({ ref: "T1", to: "writer", note: "Use the existing csv helper in lib/csv.ts.", by: "owner" });
          await vi.waitFor(() => expect(stops).toEqual(["thr_w"]));
          transitionAttempt(db, input.attemptId, "canceled", { threadId: input.writerThreadId, reason: "writer stop observed after: stopped" });
          return { status: "canceled", attemptId: input.attemptId, writerThreadId: input.writerThreadId };
        }
        transitionAttempt(db, input.attemptId, "accepted");
        return { status: "accepted", produced: ["a.txt"], verification: [], attemptId: input.attemptId };
      },
    } as unknown as Services;
    const stageReturn = createStageReturn(ctx, services).stageReturn;

    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: contract("T1") });
    saveTaskPlan(db, "T1", "Plan for T1");
    for (const stageId of ["pm-read", "plan-critique", "specialist-review"] as const) {
      recordStage(db, { runId: "run1", taskId: "T1", stageId, state: "pending", input: "Plan for T1" });
      recordStage(db, { runId: "run1", taskId: "T1", stageId, state: "running", input: "Plan for T1" });
      recordStage(db, { runId: "run1", taskId: "T1", stageId, state: "passed", input: "Plan for T1" });
    }
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId: "T1", stageId, state: "pending", input: "Plan for T1" });
    createAttempt(db, { id: "T1-a1", runId: "run1", taskId: "T1" });
    Object.assign(services, createWriterStart(ctx, services));
    services.startWriterTask({ projectId: "proj1", runId: "run1", taskId: "T1", firstAttemptId: "T1-a1", pmThreadId: "thr_pm", config, task: contract("T1"), plan: "Plan for T1" });

    await vi.waitFor(() => expect(listStageReceipts(db, "run1", "T1").find((row) => row.stageId === "writer-agent")?.state).toBe("passed"), { timeout: 15_000 });
    const result = await returned!;
    expect(result).toMatchObject({ ok: true, state: "restarted", from: "writer-agent", reused: ["pm-read", "plan-critique", "specialist-review"] });
    expect(result.restarted).toMatchObject({ by: "writer", threadId: "thr_w2" });
    // the same worktree, a handoff that names the note, and the stopped attempt did not spend one
    expect(spawns).toHaveLength(2);
    expect(spawns[1]!.continuation).toMatchObject({ workspacePath: WORKTREE });
    expect(spawns[1]!.continuation!.brief).toContain("returned to the writer by owner: Use the existing csv helper in lib/csv.ts.");
    expect(getAttempt(db, "T1-a1")?.reason).toMatch(/^reassigned: returned to the writer by owner/);
    // the PM was told, and the note is on record for every later brief
    expect(sent.some((message) => message.threadId === "thr_pm" && message.text.includes("returned task T1 to the writer"))).toBe(true);
    expect(renderReturnNotes(stageReturn.status("T1").returns)).toContain("Use the existing csv helper in lib/csv.ts.");
    expect(stageReturn.status("T1").returns).toMatchObject([{ to: "writer", state: "restarted", paused: expect.stringContaining("worktree carried over") }]);
    await harness.lifecycle.dispose();
  });
});
