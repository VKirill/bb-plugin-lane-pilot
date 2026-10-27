// An attempt whose writer is at work holds its files across a reload, and is not queued again. Vampirism Fire 2026-10-25
// (run lprun_18aa9a163f6d4824aa8c5572b9dec21f): vf-s7-minion-aura's merge turn went into thr_u6mqqyran7 at 14:33:54
// (lpattempt_463b187750454d1eb0e32f60c574e660); the plugin reloaded at 14:38:53 with the writer still in its turn, and the
// start-up recovery started the task loop again without the turn, so it waited «for vf-s7-restock: their owns_paths
// overlap» until the next reload at 15:51 (the watcher reported it «running» 51 minutes with an idle writer). vf-s7-restock,
// whose queued row was older, was let in beside it at 14:44 on the same economy.luau, and both ended merge_conflict.
// vf-s7-restock's own turns (lpattempt_c4558c4b…, lpattempt_2f2a60dd…) later waited the same way, 47 and 54 minutes.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, expect, it, vi } from "vitest";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt } from "../../src/rooms/storage/database";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";
import { createReconcile } from "../../src/rooms/stability/server/reconcile";
import { createWriterStart } from "../../src/rooms/writer/server/start";

const WORKSPACE = "/ws";
const RUN = "lprun_18aa9a16";
const AURA_THREAD = "thr_u6mqqyran7";

const task = (id:string, owns:string[]): TaskV2 => ({
  schema_version:2, id, title:id, risk:"low", lane:"default", project_cwd:WORKSPACE, read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:[owns[0]!], owns_paths:owns, never_touch:[], depends_on:[], objective:"Stage 7", acceptance:["done"], verify:"tests",
  verification:[{ command:"cd game && scripts/check.sh", cwd:WORKSPACE }],
});
const aura = task("vf-s7-minion-aura", ["game/src/shared/Data/GameData/economy.luau", "game/src/server/Tests/Par072.luau"]);
const restock = task("vf-s7-restock", ["game/src/shared/Data/GameData/economy.luau", "scripts/gamedata/economy.py", "game/src/server/Tests/Par074.luau"]);

const config: PrototypeConfig = { projectId:"proj_9tzjyzsumb", hostId:"h1", pmWorkspacePath:WORKSPACE, writerWorkspacePath:WORKSPACE,
  pmProviderId:"p", pmModel:"pm", writerProviderId:"p", writerModel:"wm" };

function setup() {
  const { bb, harness } = createFakePluginHost({ pluginId:"lane-pilot" });
  // The writer of vf-s7-minion-aura is still in its turn when the plugin comes back.
  const status = new Map<string, string>([[AURA_THREAD, "active"]]);
  harness.sdk.stub("threads.get", async (args:{ threadId:string }) => ({ id:args.threadId, status:status.get(args.threadId) ?? "idle" }));
  harness.sdk.stub("threads.list", async () => [{ id:AURA_THREAD }]);
  harness.sdk.stub("threads.getPluginMetadata", async (args:{ threadId:string }) => args.threadId === AURA_THREAD
    ? { lanePilotRunId:RUN, lanePilotTaskId:aura.id, attemptId:"lpattempt_463b1877" } : { role:"pm", lanePilotRunId:RUN });
  harness.sdk.stub("threads.send", async () => undefined);
  harness.sdk.stub("threads.context", async () => ({ usage:null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, RUN, config.projectId, "bb", WORKSPACE);
  setRunThread(db, RUN, "thr_q9y4f6jyfw");
  savePrototypeConfig(db, config);
  for (const contract of [aura, restock]) {
    createTask(db, { id:contract.id, runId:RUN, kind:"bb", contract });
    saveTaskPlan(db, contract.id, "Plan");
  }
  const finished: string[] = [];
  const spawned: string[] = [];
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
    spawnWriterAttempt:async (input:{ attemptId:string }) => {
      spawned.push(input.attemptId);
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId:"thr_5xh6hen5gc" });
      return { ok:true, threadId:"thr_5xh6hen5gc", providerId:"p", model:"wm", dirtBefore:[], workspacePath:`/wt/${input.attemptId}` };
    },
    // The merge turn's writer finishes: the attempt is checked and accepted.
    finishWriterAttempt:async (input:{ attemptId:string }) => {
      finished.push(input.attemptId);
      transitionAttempt(db, input.attemptId, "accepted");
      return { status:"accepted", produced:[], verification:[] };
    },
  } as unknown as Services;
  Object.assign(services, createWriterStart(ctx, services));
  return { harness, db, ctx, services, status, finished, spawned };
}

afterEach(() => { vi.restoreAllMocks(); });

it("a reload during a writer's turn does not queue the attempt again behind a task that waited for it", async () => {
  const env = setup();
  // Row order as on the hub: vf-s7-restock's queued attempt is older than vf-s7-minion-aura's merge-turn row.
  createAttempt(env.db, { id:"lpattempt_59d0c3e0", runId:RUN, taskId:restock.id });
  createAttempt(env.db, { id:"lpattempt_463b1877", runId:RUN, taskId:aura.id });
  setAttemptWorkspace(env.db, "lpattempt_463b1877", { path:"/wt/lpattempt_463b1877", environmentId:null, decision:{} });
  transitionAttempt(env.db, "lpattempt_463b1877", "spawn_requested");
  transitionAttempt(env.db, "lpattempt_463b1877", "running", { threadId:AURA_THREAD });
  // Only the running attempt is resumed here; the queued one is the PM's dispatch, started on its own below.
  const reconcile = createReconcile(env.ctx, env.services);
  const resumed = await reconcile.resumeOrphans(config.projectId);
  expect(resumed.resumed).toContain("lpattempt_463b1877");
  // The writer ends its turn: the attempt goes on to its checks at once, not after vf-s7-restock.
  env.status.set(AURA_THREAD, "idle");
  await vi.waitFor(() => expect(env.finished).toContain("lpattempt_463b1877"), { timeout:5_000 });
  expect(getAttempt(env.db, "lpattempt_463b1877")?.state).toBe("accepted");
  await env.harness.lifecycle.dispose();
}, 15_000);

it("a queued task waits for a running attempt on the same files even when the running row is newer (the in-memory admissions are gone after a reload)", async () => {
  const env = setup();
  createAttempt(env.db, { id:"lpattempt_59d0c3e0", runId:RUN, taskId:restock.id });
  createAttempt(env.db, { id:"lpattempt_463b1877", runId:RUN, taskId:aura.id });
  transitionAttempt(env.db, "lpattempt_463b1877", "spawn_requested");
  transitionAttempt(env.db, "lpattempt_463b1877", "running", { threadId:AURA_THREAD });
  env.services.startWriterTask({ projectId:config.projectId, runId:RUN, taskId:restock.id, firstAttemptId:"lpattempt_59d0c3e0", pmThreadId:"thr_q9y4f6jyfw",
    config, task:restock, plan:"Plan" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  expect(env.spawned).toEqual([]);
  // vf-s7-minion-aura is accepted: vf-s7-restock starts on the merged economy.luau.
  transitionAttempt(env.db, "lpattempt_463b1877", "accepted");
  await vi.waitFor(() => expect(env.spawned).toEqual(["lpattempt_59d0c3e0"]), { timeout:15_000 });
  await env.harness.lifecycle.dispose();
}, 30_000);
