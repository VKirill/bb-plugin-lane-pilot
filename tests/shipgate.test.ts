import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, setRunThread, transitionAttempt } from "../src/rooms/plugin-db";
import { preship } from "../src/rooms/tools/server/receipts";
import { gateRunVerdict } from "../src/rooms/verification/server";
import { finishGateRun, latestGateRunForTask, noteGateRunStart } from "../src/rooms/storage";
import { createWriterDispatch } from "../src/rooms/writer/server/dispatch";
import { createWriterFinish } from "../src/rooms/writer/server/finish";
import * as hostHandlers from "../src/rooms/host-worker/host-handlers";

// Astra F1: «all tasks accepted» used to read as «ship» while the post-merge integration gate still ran, never ran
// (a host error) or ended red. Now its run is a row (lane_pilot_gate_run), wait_writer waits for it and carries its
// verdict, and preship refuses while it is running, red or not run.

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lp-shipgate-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const task = (id: string) => ({ schema_version: 2 as const, id, title: id, risk: "low" as const, lane: "writer" as const, project_cwd: "/x", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: [], owns_paths: [`${id}/`], never_touch: [], depends_on: [], objective: id, acceptance: [id], verify: "x", verification: [] });

function setup() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run-1", "proj-1", "bb", dir);
  setRunThread(db, "run-1", "pm-1");
  createTask(db, { id: "t1", runId: "run-1", kind: "bb", contract: task("t1") });
  createAttempt(db, { id: "att-t1", runId: "run-1", taskId: "t1" });
  const ctx = {
    db, log: () => {}, state: { disposed: false },
    bb: { storage: bb.storage, sdk: {
      threads: {
        send: async () => ({}),
        getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "run-1" }),
      },
      files: { write: async () => ({}) },
    } },
    host: { call: async (method: string, input: unknown) => (hostHandlers as unknown as Record<string, (input: unknown) => Promise<unknown>>)[method]!(input) },
  };
  const finish = createWriterFinish(ctx as never, { dispatchWriter: async () => ({ ok: true }) } as never);
  const dispatch = createWriterDispatch(ctx as never, { activeWriterTasks: new Set() } as never);
  const accepted = () => { for (const state of ["queued", "spawn_requested", "running", "accepted"] as const) transitionAttempt(db, "att-t1", state); };
  const merged = () => finish.noteMergedForGate(
    { projectId: "proj-1", runId: "run-1", taskId: "t1", attemptId: "att-t1", writerThreadId: "thr-t1", pmThreadId: "pm-1", config: { hostId: "h" } },
    dir, "sha-t1", ["t1/a.ts"], false);
  const wait = () => dispatch.waitWriter({ threadId: "pm-1", projectId: "proj-1", runId: "run-1", timeoutSec: 2 });
  return { db, bb, accepted, merged, wait };
}

const writePackage = (failing: string | null) => writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {
  test: `node -e "${failing ? `console.error('FAIL ${failing}');process.exit(1)` : "console.log('ok')"}"`,
} }));
const runsFile = () => join(dir, "runs.txt");
const gateScript = (failing: string | null) => writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {
  test: `node -e "require('fs').appendFileSync('runs.txt','x');${failing ? `console.error('FAIL ${failing}');process.exit(1)` : ""}"`,
} }));
const runs = () => (existsSync(runsFile()) ? readFileSync(runsFile(), "utf8").length : 0);

describe("the gate run is a row the PM reads", () => {
  it("a green gate records the main commit it ran on; preship passes", async () => {
    gateScript(null);
    const { db, accepted, merged } = setup();
    accepted();
    expect(await merged()).toMatchObject({ ran: true, passed: true });
    const row = latestGateRunForTask(db, "proj-1", "t1");
    expect(row?.state).toBe("passed");
    expect(row?.batch[0]).toMatchObject({ taskId: "t1", commitSha: "sha-t1" });
    expect(gateRunVerdict(row).line).toMatch(/^green on /);
    expect(runs()).toBe(1);
    expect(preship(db, "proj-1").clear).toBe(true);
  });

  it("a red gate refuses preship with the failing command", async () => {
    gateScript("t1/a.test.ts");
    const { db, accepted, merged } = setup();
    accepted();
    expect(await merged()).toMatchObject({ ran: true, passed: false });
    const row = latestGateRunForTask(db, "proj-1", "t1");
    expect(row?.state).toBe("failed");
    const result = preship(db, "proj-1");
    expect(result.clear).toBe(false);
    expect(result.items.at(-1)).toMatchObject({ what: expect.stringContaining("integration gate is red") });
    expect(result.items.at(-1)!.what).toContain("npm test");
  });

  it("a host error is a not_run row and refuses preship with the reason", async () => {
    const { db, accepted } = setup();
    accepted();
    const id = noteGateRunStart(db, { projectId: "proj-1", runId: "run-1", scopeKey: "k", command: "npm test", batch: [{ taskId: "t1", commitSha: "sha-t1", threadId: null, attemptId: "att-t1", produced: [] }] });
    finishGateRun(db, id, "not_run", { reason: "host could not run it on h" });
    expect(gateRunVerdict(latestGateRunForTask(db, "proj-1", "t1")).line).toContain("not run:");
    const result = preship(db, "proj-1");
    expect(result.clear).toBe(false);
    expect(result.items.at(-1)!.disposition).toContain("rerun the gate");
  });

  it("a running gate refuses preship with wait", () => {
    const { db } = setup();
    noteGateRunStart(db, { projectId: "proj-1", runId: "run-1", scopeKey: "k", command: "npm test", batch: [{ taskId: "t1", commitSha: "sha-t1", threadId: null, attemptId: "att-t1", produced: [] }] });
    const result = preship(db, "proj-1");
    expect(result.clear).toBe(false);
    expect(result.items.at(-1)!.disposition).toContain("wait");
  });

  it("a project without a gate passes as today; an explicit command that never ran refuses", () => {
    const { db, accepted } = setup();
    accepted();
    expect(preship(db, "proj-1").clear).toBe(true);
    saveProjectSetting(db, "proj-1", "integration.gate_command", "npm test");
    const result = preship(db, "proj-1");
    expect(result.clear).toBe(false);
    expect(result.items.at(-1)!.what).toContain("not run");
    saveProjectSetting(db, "proj-1", "integration.gate_command", "off");
    expect(preship(db, "proj-1").clear).toBe(true);
  });
});

describe("wait_writer carries the gate verdict", () => {
  it("accepted + gate still running: the wait answers running with the gate state", async () => {
    const { db, accepted, wait } = setup();
    accepted();
    noteGateRunStart(db, { projectId: "proj-1", runId: "run-1", scopeKey: "k", command: "npm test", batch: [{ taskId: "t1", commitSha: "sha-t1", threadId: null, attemptId: "att-t1", produced: [] }] });
    const answer = await wait();
    expect(answer.state).toBe("running");
    expect(answer.gate).toEqual([{ taskId: "t1", gate: "running" }]);
    expect(answer.message).toContain("integration gate");
  });

  it("green on the merge sha: the wait answers accepted with the gate line", async () => {
    gateScript(null);
    const { db, accepted, merged, wait } = setup();
    accepted();
    await merged();
    const answer = await wait();
    expect(answer.state).toBe("accepted");
    expect(answer.gate).toEqual([{ taskId: "t1", gate: expect.stringMatching(/^green on /) }]);
  });

  it("no gate configured: the wait answers accepted with none configured", async () => {
    writePackage(null);
    const { db, accepted, wait } = setup();
    accepted();
    saveProjectSetting(db, "proj-1", "integration.gate_command", "off");
    const answer = await wait();
    expect(answer.state).toBe("accepted");
    expect(answer.gate).toEqual([{ taskId: "t1", gate: "none configured" }]);
  });
});
