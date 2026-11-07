import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { registerDispatchExecutors } from "../src/rooms/writer/server/dispatch-workflow";
import { recordStage } from "../src/rooms/runs/server";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase } from "../src/rooms/plugin-db";

// MagicSEO replay concert-scheduler (wfrun_c3df9f4b, 2026-10-31): plan critique and specialist review passed, the PM changed the
// plan, the new critique blocked, and the block step threw «illegal stage transition specialist-review: passed -> skipped»:
// the run failed `step_failed:block-plan-critique` instead of blocking the task.
const task = { schema_version:2, id:"t1", title:"Fix", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:["a.ts"], owns_paths:["a.ts"], never_touch:[], depends_on:[], objective:"fix", acceptance:["done"], verify:"npm test",
  verification:[{ command:"npm test", cwd:"/repo" }] } as never;

it("blocks the task when a new plan critique blocks after the specialist review of the old plan passed", async () => {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "r", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"r", kind:"bb", contract:task });
  createAttempt(db, { id:"a", runId:"r", taskId:"t1" });
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId:"r", taskId:"t1", stageId, state:"pending", input:"plan 2" });
  recordStage(db, { runId:"r", taskId:"t1", stageId:"specialist-review", state:"pending", input:"plan 1" });
  recordStage(db, { runId:"r", taskId:"t1", stageId:"specialist-review", state:"running", input:"plan 1" });
  recordStage(db, { runId:"r", taskId:"t1", stageId:"specialist-review", state:"passed", input:"plan 1" });
  const executors = new Map<string, { run: (ctx: unknown) => Promise<{ output?: Record<string, unknown> }> }>();
  registerDispatchExecutors({ register: (key: string, executor: never) => executors.set(key, executor) } as never, bb);
  const runtime = { ctx:{ db, bb, refreshRun:() => undefined }, threadId:"pm", projectId:"P", runId:"r", taskId:"t1", attemptId:"a",
    config:{}, runConfig:{ hostId:"h" }, workspacePath:"/repo", task, plan:"plan 2", lintWarnings:[] };
  const out = (await executors.get("lp.block-plan-critique")!.run({ runtime, input:{ with:{ reason:"plan_critique_blocked" } }, runId:"wf", stepKey:"s", nodeId:"block-plan-critique" } as never)).output!;
  expect(out.reply).toMatchObject({ state:"blocked", reason:"plan_critique_blocked" });
  expect(getAttempt(db, "a")?.state).toBe("blocked");
  const states = Object.fromEntries(listStageReceipts(db, "r", "t1").map((row) => [row.stageId, row.state]));
  expect(states).toMatchObject({ "specialist-review":"passed", "writer-agent":"skipped", verification:"skipped", "acceptance-receipt":"skipped" });
});
