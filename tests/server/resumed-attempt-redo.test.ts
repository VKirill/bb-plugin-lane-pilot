// A writer's own failure goes back to it with the reason, also across a reload and a fallback writer. Vampirism Fire
// vf-s4-items (2026-10-24): the writer's turn ended during a reload (12:42), the start-up recovery checked it itself and
// got «owns_paths rejected game/src/server/Items/Use/Buffs.luau, game/src/server/Items/Use/init.luau»
// (lpattempt_432e338655f84804b82e63c7a896b623), then retried with a fresh writer from main, in a new thread and without
// the reason (lpattempt_0d5cb505f8a744ae93983cd049a90de0). Its provider cut it off, the fallback writer got only that cut
// in its handoff (lpattempt_7504451cf9004fa8941d36ba83352fd3), rewrote Buffs.luau, and the task ended «retry limit 2
// exhausted: owns_paths rejected game/src/server/Items/Use/Buffs.luau».
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { createReconcile } from "../../src/rooms/stability/server/reconcile";
import { createWriterStart } from "../../src/rooms/writer/server/start";

const WORKSPACE = "/ws";
const WORKTREE = "/wt/lpattempt_432e3386";
const REJECTED = "owns_paths rejected game/src/server/Items/Use/Buffs.luau, game/src/server/Items/Use/init.luau";
const CUT = "writer_stream_error: Error: RetriableError: [internal] Stream closed with error code NGHTTP2_REFUSED_STREAM";
const CUT_AGAIN = "writer_stream_error: Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)";

// The real contract's ownership: Items/Use/Move.luau is the task's, Buffs.luau and Use/init.luau are not.
const contract: TaskV2 = {
  schema_version:2, id:"vf-s4-items", title:"PAR-044 VU7 recompute", risk:"high", lane:"default", project_cwd:WORKSPACE, read_first:[],
  interfaces:[], invariants:[], out_of_scope:[], expected_outputs:["game/src/server/Tests/Par044.luau"],
  owns_paths:["game/src/server/Items/Inventory.luau", "game/src/server/Items/Core.luau", "game/src/server/Items/init.luau", "game/src/server/Items/Passive/",
    "game/src/server/Items/Use/Move.luau", "game/src/server/Tests/Par044.luau"],
  never_touch:["docs/", "scripts/studio_test.py"], depends_on:[], objective:"Stage 4 of the 1:1 port", acceptance:["done"], verify:"tests",
  verification:[{ command:"cd game && scripts/check.sh", cwd:WORKSPACE }],
};

const config: PrototypeConfig = { projectId:"proj1", hostId:"h1", pmWorkspacePath:WORKSPACE, writerWorkspacePath:WORKSPACE,
  pmProviderId:"p", pmModel:"pm", writerProviderId:"p", writerModel:"wm" };

type Send = { threadId:string; input:Array<{ text:string }> };
type SpawnInput = { attemptId:string; previousAttempt?:string; emergency?:unknown };
type Step = { accept?:true; reason?:string; providerError?:string };

function setup(script:Step[]) {
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
  const sends: Send[] = [];
  harness.sdk.stub("threads.get", async (args:{ threadId:string }) => ({ id:args.threadId, status:"idle" }));
  harness.sdk.stub("threads.send", async (args:unknown) => { sends.push(args as Send); return undefined; });
  harness.sdk.stub("threads.context", async () => ({ usage:null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role:"pm", lanePilotRunId:"run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  createTask(db, { id:contract.id, runId:"run1", kind:"bb", contract });
  saveTaskPlan(db, contract.id, "Plan");
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId:"run1", taskId:contract.id, stageId, state:"pending", input:"Plan" });
  let turn = 0;
  const spawns: SpawnInput[] = [];
  const services = {
    activeWriterTasks:new Set<string>(),
    providerBreaker:{ record:() => undefined },
    ...noOptionalPlugins,
    runBudgetFor:() => ({ check:() => ({ ok:true }), noteAttempt:() => undefined, noteTokens:() => undefined, snapshot:() => ({ limits:{} }) }),
    runWriterPool:{ acquire:async () => () => undefined },
    stability:{ breakerHolds:() => null, diskHolds:async () => null, onTaskFailed:async () => false, loadParked:async () => [] },
    startAfterAcceptance: () => undefined,
    workspaceDirt:async () => ({ ok:true, paths:[], snapshots:[] }),
    isLiveFolder:async () => false,
    spawnWriterAttempt:async (input:SpawnInput) => {
      spawns.push(input);
      const threadId = `thr_new${spawns.length}`;
      setAttemptWorkspace(db, input.attemptId, { path:`/wt/${input.attemptId}`, environmentId:null, decision:{} });
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId });
      return { ok:true, threadId, providerId:"p", model:"wm", dirtBefore:[], workspacePath:`/wt/${input.attemptId}` };
    },
    finishWriterAttempt:async (input:{ attemptId:string; writerThreadId:string }) => {
      const step = script[turn++] ?? { accept:true };
      if (step.accept) { transitionAttempt(db, input.attemptId, "accepted"); return { status:"accepted", produced:["game/src/server/Tests/Par044.luau"], verification:[] }; }
      if (step.providerError) {
        transitionAttempt(db, input.attemptId, "provider_error", { reason:step.providerError });
        return { status:"provider_error", reason:step.providerError, attemptId:input.attemptId, writerThreadId:input.writerThreadId };
      }
      transitionAttempt(db, input.attemptId, "validation_failed", { reason:step.reason });
      return { status:"validation_failed", reason:step.reason, produced:["game/src/server/Items/Use/Buffs.luau", "game/src/server/Items/Use/init.luau"],
        attemptId:input.attemptId, writerThreadId:input.writerThreadId, verification:[], diffKey:`d${turn}` };
    },
  } as unknown as Services;
  Object.assign(services, createWriterStart(ctx, services));
  return { bb, harness, db, ctx, sends, spawns, services };
}

const writerStage = (db:ReturnType<typeof openDatabase>) => listStageReceipts(db, "run1", contract.id).find((row) => row.stageId === "writer-agent")!;

afterEach(() => { vi.restoreAllMocks(); });

it("a writer turn that ended during a reload is redone in its own thread with the rejected files named, not by a fresh writer", async () => {
  const env = setup([{ reason:REJECTED }, { accept:true }]);
  // The attempt as the reload left it: its writer thread idle, the turn over, nothing checked yet.
  createAttempt(env.db, { id:"lpattempt_432e3386", runId:"run1", taskId:contract.id });
  setAttemptWorkspace(env.db, "lpattempt_432e3386", { path:WORKTREE, environmentId:null, decision:{} });
  transitionAttempt(env.db, "lpattempt_432e3386", "spawn_requested");
  transitionAttempt(env.db, "lpattempt_432e3386", "running", { threadId:"thr_574xukin82" });
  const reconcile = createReconcile(env.ctx, env.services);
  const attempt = getAttempt(env.db, "lpattempt_432e3386")!;
  expect(await reconcile.maybeFinishResumedAttempt({ projectId:"proj1", attempt, writerThreadId:"thr_574xukin82" })).toBe(true);
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(env.spawns).toEqual([]);
  expect(env.sends.map((send) => send.threadId)).toEqual(["thr_574xukin82"]);
  const turn = env.sends[0]!.input[0]!.text;
  expect(turn).toContain(`Result: validation_failed: ${REJECTED}`);
  expect(turn).toContain("files outside owns_paths (game/src/server/Items/Use/Buffs.luau, game/src/server/Items/Use/init.luau)");
  await env.harness.lifecycle.dispose();
});

it("a fallback writer that takes over after provider cuts is told the task's own earlier rejection", async () => {
  // Rejected, then cut off twice in the same thread: the writer chain takes the task in a new thread.
  const env = setup([{ reason:REJECTED }, { providerError:CUT }, { providerError:CUT_AGAIN }, { accept:true }]);
  createAttempt(env.db, { id:"a1", runId:"run1", taskId:contract.id });
  env.services.startWriterTask({ projectId:"proj1", runId:"run1", taskId:contract.id, firstAttemptId:"a1", pmThreadId:"thr_pm", config, task:contract, plan:"Plan" });
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(env.spawns).toHaveLength(2);
  const fallback = env.spawns[1]!;
  expect(fallback.emergency).toBeTruthy();
  expect(fallback.previousAttempt ?? "").toContain(`Result: validation_failed: ${REJECTED}`);
  expect(fallback.previousAttempt ?? "").toContain("files outside owns_paths (game/src/server/Items/Use/Buffs.luau, game/src/server/Items/Use/init.luau)");
  await env.harness.lifecycle.dispose();
});

it("a new start of the task (a retry from the board, a parked restart) tells its fresh writer the task's last own rejection", async () => {
  const env = setup([{ accept:true }]);
  // vf-s4-items as it ended: blocked on the rejection, then retried from the task board (rpc retry_attempt queues a new attempt).
  createAttempt(env.db, { id:"lpattempt_7504451c", runId:"run1", taskId:contract.id });
  transitionAttempt(env.db, "lpattempt_7504451c", "spawn_requested");
  transitionAttempt(env.db, "lpattempt_7504451c", "running", { threadId:"thr_gzpfyy5iv2" });
  transitionAttempt(env.db, "lpattempt_7504451c", "blocked", { reason:"retry limit 2 exhausted: owns_paths rejected game/src/server/Items/Use/Buffs.luau" });
  createAttempt(env.db, { id:"retry1", runId:"run1", taskId:contract.id });
  env.services.startWriterTask({ projectId:"proj1", runId:"run1", taskId:contract.id, firstAttemptId:"retry1", pmThreadId:"thr_pm", config, task:contract, plan:"Plan" });
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(env.spawns).toHaveLength(1);
  expect(env.spawns[0]!.previousAttempt ?? "").toContain("files outside owns_paths (game/src/server/Items/Use/Buffs.luau)");
  await env.harness.lifecycle.dispose();
});

it("a failure that was not the task's own (a provider cut) gives a fresh writer no record", async () => {
  const env = setup([{ accept:true }]);
  createAttempt(env.db, { id:"old", runId:"run1", taskId:contract.id });
  transitionAttempt(env.db, "old", "spawn_requested");
  transitionAttempt(env.db, "old", "running", { threadId:"thr_x" });
  transitionAttempt(env.db, "old", "provider_error", { reason:CUT });
  createAttempt(env.db, { id:"next", runId:"run1", taskId:contract.id });
  env.services.startWriterTask({ projectId:"proj1", runId:"run1", taskId:contract.id, firstAttemptId:"next", pmThreadId:"thr_pm", config, task:contract, plan:"Plan" });
  await vi.waitFor(() => expect(writerStage(env.db).state).toBe("passed"));
  expect(env.spawns[0]!.previousAttempt ?? "").toBe("");
  await env.harness.lifecycle.dispose();
});
