import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { runPlanCritique } from "../src/rooms/critique/server";
import { createRun, createTask, listStageReceipts, openDatabase, setRunThread } from "../src/rooms/plugin-db";

// EXT-04b: an exhausted critic pool used to record failed_infra and still return allowed:true — under a gate that let an
// unreviewed plan reach the writer. Gate now blocks; advisory keeps the honest failed receipt and proceeds. A failed
// receipt must also never be mistaken for a pass, and a retry must be able to run the stage again (failed -> pending
// needs reopen, not just restart).

const task = { schema_version:2, id:"t1", title:"Fix", risk:"high", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:["a.ts"], owns_paths:["a.ts"], never_touch:[], depends_on:[], objective:"fix", acceptance:["done"], verify:"npm test",
  verification:[{ command:"npm test", cwd:"/repo" }] } as never;

function rig(extraSettings: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const spawns: unknown[] = [];
  // The critic's packet materializes big inputs under .agents/runs/<run>/inputs/ before the spawn: an in-memory fs.
  const files = new Map<string, string>();
  harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    if (!files.has(path)) throw Object.assign(new Error("not found"), { code: "not_found", status: 404 });
    return { content: files.get(path), contentEncoding: "utf8" };
  });
  harness.sdk.stub("files.write", async ({ path, content }: { path: string; content: string }) => { files.set(path, content); return { outcome: "written" }; });
  harness.sdk.stub("providers.list", async () => [{ id: "p1", available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] }]);
  harness.sdk.stub("providers.models", async () => ({ models: [{ id: "m1", model: "m1", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }));
  harness.sdk.stub("threads.spawn", async (args: unknown) => { spawns.push(args); return { id: `thr_c${spawns.length}` }; });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_c1", status: "idle", projectId: "P" }));
  harness.sdk.stub("threads.output", async () => ({ output: "" })); // empty -> critique_output_empty, the retryable failure
  const db = openDatabase(bb);
  createRun(db, "r", "P", "cli", "/repo");
  setRunThread(db, "r", "pm-thread");
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
  const input = {
    bb, db, projectId: "P", runId: "r",
    stageHelperSettings: async () => ({ "plan_critique.provider": "p1", "plan_critique.model": "m1", ...extraSettings }),
    taskId: "t1", config: { hostId: "h" } as never, task, plan: "plan\nwith lines",
  };
  return { db, spawns, input };
}

const receipt = (db: ReturnType<typeof openDatabase>) =>
  listStageReceipts(db, "r", "t1").find((row) => row.stageId === "plan-critique");

it("gate mode: an exhausted critic pool blocks the plan instead of passing it", async () => {
  const { db, input } = rig();
  const out = await runPlanCritique(input as never);
  expect(out.allowed).toBe(false);
  expect(out.reason).toMatch(/^failed_infra:/);
  expect(receipt(db)?.state).toBe("failed");
  expect(String(receipt(db)?.reason)).toMatch(/^failed_infra:/);
});

it("advisory mode: the same exhaustion stays nonblocking with an honest failed receipt", async () => {
  const { db, input } = rig({ "plan_critique.mode": "advisory" });
  const out = await runPlanCritique(input as never);
  expect(out.allowed).toBe(true);
  expect(out.reason).toMatch(/^failed_infra:/);
  expect(receipt(db)?.state).toBe("failed");
});

it("a failed critique receipt is not reused as a pass: the retry runs the critic again", async () => {
  const { db, spawns, input } = rig();
  await runPlanCritique(input as never);
  expect(spawns).toHaveLength(1);
  const again = await runPlanCritique(input as never);
  expect(again.allowed).toBe(false);
  expect(spawns).toHaveLength(2); // the failed receipt reopened the stage instead of crashing on failed -> pending
  expect(receipt(db)?.state).toBe("failed");
});
