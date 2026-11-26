import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { WorkflowEngine, registerPureActions } from "@lane-pilot/workflow-engine";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { registerDispatchExecutors } from "../src/rooms/writer/server/handlers/dispatch-workflow";
import { getAttempt, listStageReceipts, openDatabase, createAttempt, createRun, createTask } from "../src/rooms/plugin-db";

// Live defect: a task whose read_first named 8 CSVs of 10–158 MB burned the paid plan critic and pm-read on every
// attempt before the writer spawn finally failed execution_packet_failed. The lp-task-pipeline graph now builds the
// deterministic packet BEFORE pm-read (node execution-packet) and hands its outcome to the scout — these tests run the
// real engine, not executor mirrors. Oversize sources became deferred required-on-site reads (EXT-04a); what still
// stops the attempt here is a packet the gate itself cannot build deterministically — a malformed line window.

const task = { schema_version:2, id:"t1", title:"Fix", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[], out_of_scope:[],
  expected_outputs:["a.ts"], owns_paths:["a.ts"], never_touch:[], depends_on:[], objective:"fix", acceptance:["done"], verify:"npm test", quality_mode:"quick",
  verification:[{ command:"npm test", cwd:"/repo" }] };

function rig(readFirst: string[], file: { content: string; sizeBytes?: number } | null) {
  const fileReads: string[] = [];
  const hostCalls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const spawns: Array<Record<string, unknown>> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: async (call) => {
      hostCalls.push({ method: call.method, input: call.input as Record<string, unknown> });
      if (call.method !== "readBoundedFile") throw new Error(`unexpected host method ${call.method}`);
      // Mirrors host-worker readBoundedFile: whole-file sha256/sizeBytes/totalLines plus the requested line slice.
      const input = call.input as { relativePath: string; offset: number; maxLines: number };
      const body = typeof file?.content === "string" ? file.content : "";
      const lines = body.replace(/\r\n?/g, "\n").split("\n");
      const selected = lines.slice(input.offset, input.offset + input.maxLines);
      const content = selected.join("\n");
      return {
        schemaVersion: 1, hostId: "h", path: input.relativePath, content, contentEncoding: "utf8",
        sha256: createHash("sha256").update(body).digest("hex"),
        sizeBytes: Buffer.byteLength(body), totalLines: lines.length,
        offset: input.offset, maxLines: input.maxLines,
        lineStart: input.offset + 1,
        lineEnd: selected.length === 0 ? input.offset : input.offset + selected.length,
        truncated: input.offset + selected.length < lines.length,
        returnedBytes: Buffer.byteLength(content),
      };
    },
  });
  harness.sdk.stub("files.read", async (args: { path?: string }) => { fileReads.push(String(args?.path ?? "")); return file; });
  harness.sdk.stub("threads.spawn", async (args: Record<string, unknown>) => { spawns.push(args); return { id: "thr_spawn" }; });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_spawn", status: "idle" }));
  harness.sdk.stub("threads.output", async () => ({ output: "not json" }));
  // A spawned helper's wait ends on a completed turn in the event stream; "not json" output then fails the parse fast.
  harness.sdk.stub("threads.events.list", async (args: { threadId?: string }) => [
    { type: "turn/started", threadId: args?.threadId, seq: 1 },
    { type: "turn/completed", threadId: args?.threadId, seq: 2, data: { status: "completed" } },
  ]);
  harness.sdk.stub("providers.list", async () => []);
  harness.sdk.stub("providers.models", async () => ({ models: [] }));
  const db = openDatabase(bb);
  createRun(db, "r", "P", "cli", "/repo");
  createTask(db, { id:"t1", runId:"r", kind:"bb", contract:{ ...task, read_first: readFirst } });
  createAttempt(db, { id:"a", runId:"r", taskId:"t1" });
  const engine = new WorkflowEngine({ db, harnessVersion: "test", resolveWorkflow: (id: string) => builtinWorkflow(id) });
  registerPureActions(engine);
  registerDispatchExecutors(engine as never, bb);
  // lp.qa-gate lives in the qa room's executor set; the pipeline's preflight needs it registered even though these
  // fixtures never reach it (the run ends at the packet gate or the advisory scout).
  engine.register("lp.qa-gate", { reentrant: true, run: async () => ({ output: { run: false } }) });
  const runtime = { ctx:{ db, bb, refreshRun:() => undefined }, services:{ stageHelperSettings: async () => ({}) },
    threadId:"pm", projectId:"P", runId:"r", taskId:"t1", attemptId:"a",
    config:{}, runConfig:{ hostId:"h" }, workspacePath:"/repo", task:{ ...task, read_first: readFirst }, plan:"plan", lintWarnings:[] };
  const started = engine.start({ workflow: builtinWorkflow("lp-task-pipeline")!, inputs: { taskId:"t1", attemptId:"a" }, runtime: runtime as never });
  return { db, done: started.done, fileReads, hostCalls, spawns, runId: started.runId };
}

const receipts = (db: ReturnType<typeof openDatabase>) =>
  Object.fromEntries(listStageReceipts(db, "r", "t1").map((row) => [row.stageId, row.state]));

it("a malformed read_first window blocks the attempt before pm-read or any paid stage spawns", async () => {
  const { db, done, fileReads, hostCalls, spawns } = rig(["notes.txt:9999-10000"], { content: "alpha\nbeta\ngamma\n" });
  await done;
  expect(getAttempt(db, "a")?.state).toBe("blocked");
  expect(spawns).toEqual([]);
  // Explicit windows use the bounded host read only — the whole-file SDK read never runs for them.
  expect(fileReads).toEqual([]);
  expect(hostCalls.map((call) => call.method)).toEqual(["readBoundedFile"]);
  const states = receipts(db);
  expect(states["execution-packet"]).toBe("blocked");
  expect(states["pm-read"]).toBeUndefined();
  expect(states["plan-critique"]).toBeUndefined();
  expect(states["specialist-review"]).toBeUndefined();
});

it("a valid packet reaches pm-read, which reuses the gate outcome instead of reading the sources again", async () => {
  const { db, done, fileReads, hostCalls } = rig(["notes.txt"], { content: "alpha\nbeta\ngamma\n" });
  await done;
  // Windowless: one bounded probe proved the source small, then files.read ran for the gate only — pm-read consumed
  // packetSha256/selectedLines through the edge.
  expect(hostCalls[0]?.method).toBe("readBoundedFile");
  expect(fileReads).toEqual(["/repo/notes.txt"]);
  const states = receipts(db);
  expect(states["pm-read"]).toBeDefined();
  // The scout is advisory: whatever it returned, the pipeline moved past it (quality-mode decided quick). Both graph
  // nodes record the canonical stage id "plan-critique" — the node id is not the receipt key.
  expect(states["plan-critique"]).toBeDefined();
  // No paid helper spawned on this fixture's stubs — the run ended at a later deterministic step, not at the gate.
  expect(getAttempt(db, "a")?.state).not.toBe("spawn_unknown");
});
