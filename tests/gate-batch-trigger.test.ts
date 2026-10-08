import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, setRunThread, transitionAttempt } from "../src/rooms/storage/database";
import * as hostHandlers from "../src/rooms/host-worker/host-handlers";
import { createWriterFinish } from "../src/server/writer/finish";

// The batch gate runs the whole suite once, after the queue drains: a task that merges while another one is still open
// only counts; the last one to land starts the gate, and it names the command it detected.

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lp-gate-batch-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const task = (id: string) => ({ schema_version: 2 as const, id, title: id, risk: "low" as const, lane: "writer" as const, project_cwd: "/x", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: [], owns_paths: [`${id}/`], never_touch: [], depends_on: [], objective: id, acceptance: [id], verify: "x", verification: [] });

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const sent: Array<{ threadId: string; text: string }> = [];
  createRun(db, "run-1", "proj-1", "bb", dir);
  setRunThread(db, "run-1", "pm-1");
  for (const id of ["t1", "t2"]) {
    createTask(db, { id, runId: "run-1", kind: "bb", contract: task(id) });
    createAttempt(db, { id: `att-${id}`, runId: "run-1", taskId: id });
    transitionAttempt(db, `att-${id}`, "queued");
  }
  const ctx = {
    db, log: () => {}, state: { disposed: false },
    bb: { storage: bb.storage, sdk: { threads: { send: async (input: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, text: input.input[0]?.text ?? "" }); } }, files: { write: async () => ({}) } } },
    host: { call: async (method: string, input: unknown) => (hostHandlers as unknown as Record<string, (input: unknown) => Promise<unknown>>)[method]!(input) },
  };
  const finish = createWriterFinish(ctx as never, {} as never);
  const landed = (id: string, produced: string[]) => finish.noteMergedForGate(
    { projectId: "proj-1", runId: "run-1", taskId: id, attemptId: `att-${id}`, writerThreadId: `thr-${id}`, pmThreadId: "pm-1", config: { hostId: "h" } },
    dir, `sha-${id}`, produced, false);
  return { db, sent, landed };
}
const writePackage = (failing: string | null) => writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {
  test: `node -e "require('fs').appendFileSync('runs.txt','x');${failing ? `console.error('FAIL ${failing}');process.exit(1)` : ""}"`,
} }));
const runs = () => (existsSync(join(dir, "runs.txt")) ? readFileSync(join(dir, "runs.txt"), "utf8").length : 0);

it("a merge while another task is still open only counts; the last one to land runs the detected suite once", async () => {
  writePackage(null);
  const { db, landed } = setup();

  expect(await landed("t1", ["t1/a.ts"])).toEqual({ ran: false });
  expect(runs()).toBe(0);
  for (const state of ["spawn_requested", "running", "accepted"] as const) transitionAttempt(db, "att-t1", state);

  expect(await landed("t2", ["t2/b.ts"])).toMatchObject({ ran: true, passed: true });
  expect(runs()).toBe(1);
});

it("a red gate after the batch goes to the writer whose task owns the failing test, with the PM told the detected command", async () => {
  writePackage("t2/b.test.ts");
  const { db, sent, landed } = setup();
  await landed("t1", ["t1/a.ts"]);
  for (const state of ["spawn_requested", "running", "accepted"] as const) transitionAttempt(db, "att-t1", state);

  expect(await landed("t2", ["t2/b.test.ts"])).toMatchObject({ ran: true, passed: false, culpritTaskId: "t2" });

  expect(runs()).toBe(1);
  expect(sent.find((message) => message.threadId === "thr-t2")?.text).toContain("integration gate failed after merging your task t2");
  expect(sent.find((message) => message.threadId === "pm-1")?.text).toContain("`npm test` (detected: package.json script «test»)");
});

it("with the gate off nothing runs", async () => {
  writePackage(null);
  const { db, landed } = setup();
  saveProjectSetting(db, "proj-1", "integration.gate_command", "off");
  expect(await landed("t1", ["t1/a.ts"])).toEqual({ ran: false });
  expect(runs()).toBe(0);
});
