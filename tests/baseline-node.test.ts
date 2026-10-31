import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { registerDispatchExecutors } from "../src/rooms/writer/server/dispatch-workflow";
import { createAttempt, createRun, createTask, getAttempt, openDatabase } from "../src/rooms/storage";

// Step [1] of Matvey's task path is a node of lp-task-pipeline now: the checks on the base run before the writer step, and a stop ends
// the task there; before, the same preflight ran hidden inside the writer loop (start.ts).
const task = { schema_version:2, id:"t1", title:"Fix", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:["a.ts"], owns_paths:["a.ts"], never_touch:[], depends_on:[], objective:"fix", acceptance:["red goes green"], verify:"npm test",
  verification:[{ command:"npm test", cwd:"/repo" }] } as never;

function world(preflight: () => Promise<{ stop: string | null; record: unknown; alreadyDone?: string }>) {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "r", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"r", kind:"bb", contract:task });
  createAttempt(db, { id:"a", runId:"r", taskId:"t1" });
  const executors = new Map<string, { run: (ctx: unknown) => Promise<{ output?: Record<string, unknown> }> }>();
  registerDispatchExecutors({ register: (key: string, executor: never) => executors.set(key, executor) } as never, bb);
  const asked: unknown[] = [];
  const runtime = { ctx:{ db, bb, refreshRun:() => undefined }, services:{ baseline:{ preflight:async (input: unknown) => { asked.push(input); return preflight(); } } },
    threadId:"pm", projectId:"P", runId:"r", taskId:"t1", attemptId:"a", config:{}, runConfig:{ hostId:"h" }, workspacePath:"/repo", task, plan:"plan", lintWarnings:[] };
  const step = (key: string, input: Record<string, unknown> = {}) => executors.get(key)!.run({ runtime, input:{ with:input }, runId:"wf", stepKey:"s", nodeId:key } as never).then((row) => row.output!);
  return { db, step, asked };
}

describe("the baseline node", () => {
  it("stops the task before any writer when the base says so, and the block node ends the attempt with that verdict", async () => {
    const { db, step } = world(async () => ({ stop:"verdict_block: no_red_on_base: npm test is green on the base", record:{} }));
    const out = await step("lp.baseline");
    expect(out).toMatchObject({ state:"stopped", reason:expect.stringContaining("no_red_on_base") });
    const blocked = await step("lp.block-baseline", { reason:out.reason });
    expect(blocked.reply).toMatchObject({ state:"blocked", reason:expect.stringContaining("no_red_on_base") });
    expect(getAttempt(db, "a")?.state).toBe("blocked");
  });

  it("passes a red base and an already built task on to the writer step, and asks nothing for a live folder", async () => {
    expect(await world(async () => ({ stop:null, record:{ checks:[] } })).step("lp.baseline")).toEqual({ state:"red" });
    expect(await world(async () => ({ stop:null, record:{}, alreadyDone:"already done: npm test" })).step("lp.baseline")).toMatchObject({ state:"already_built" });
    const live = world(async () => ({ stop:"never", record:null }));
    expect(await live.step("lp.baseline", { live:true })).toEqual({ state:"skipped" });
    expect(live.asked).toEqual([]);
  });
});
