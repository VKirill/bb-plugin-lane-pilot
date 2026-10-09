import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { IntegrationGateRunner } from "../../src/rooms/verification/server/integration-gate";
import { createAttempt, createTask, openDatabase, transitionAttempt } from "../../src/rooms/storage/database";
import * as hostHandlers from "../../src/rooms/host-worker/host-handlers";
import type { ServerCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";

/**
 * Owner rule: a red gate is one question to the owner per episode (the same gate command, the same failing test files, until a
 * gate run is green). Live 2026-10-09 (SelfyStudio PM): the same «no single task is to blame» form reached the owner 3 times and
 * his answer reached the PM twice.
 */
describe("a red gate asks the owner once per episode", () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;
  let sent: Array<{ threadId: string; text: string }>;
  let asks: Array<{ question: string }>;
  let settle: Array<(answer: unknown) => unknown>;
  let runner: IntegrationGateRunner;
  let failing: string[];

  const writePackage = () => writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {
    test: failing.length ? `node -e "${failing.map((file) => `console.error('FAIL ${file}')`).join(";")};process.exit(1)"` : `node -e "process.exit(0)"`,
  } }));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lp-gate-episode-"));
    failing = ["tests/a.test.ts"];
    writePackage();
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    db = openDatabase(bb);
    db.prepare(`INSERT INTO lane_pilot_run (id, project_id, pm_thread_id, state, created_at, updated_at) VALUES ('run-1', 'proj-1', 'pm-1', 'running', 0, 0)`).run();
    sent = []; asks = []; settle = [];
    const ownerAsk = {
      askInBackground: async (_thread: string, request: { question: string }, onSettled: (answer: unknown) => unknown) => { asks.push(request); settle.push(onSettled); return true; },
      answerMessage: (question: string, answer: { line?: string }) => `Lane Pilot: the owner answered «${question}»: ${answer.line}`,
      sendToThread: async (threadId: string, text: string) => { sent.push({ threadId, text }); },
    };
    const core = {
      db,
      bb: { sdk: { threads: { send: async (input: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, text: input.input[0]?.text ?? "" }); } }, files: { write: async () => ({ ok: true }) } }, storage: { kv: { get: async () => null, set: async () => null } } },
      log: () => {},
      ownerAsk,
      host: { call: async (method: string, input: unknown) => (hostHandlers as unknown as Record<string, (input: unknown) => Promise<unknown>>)[method]!(input) },
    } as unknown as ServerCore;
    runner = new IntegrationGateRunner(core, {} as unknown as Services);
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const redGate = async () => {
    writePackage();
    runner.noteMergedTask({ taskId: "t1", commitSha: "sha-1", threadId: "thr-t1", attemptId: "att-1", produced: ["src/one.ts"] });
    runner.noteMergedTask({ taskId: "t2", commitSha: "sha-2", threadId: "thr-t2", attemptId: "att-2", produced: ["src/two.ts"] });
    return runner.maybeRunGate({ runId: "run-1", projectId: "proj-1", pmThreadId: "pm-1", basePath: dir, configHostId: "host-1", trigger: "drain" });
  };
  const toPm = () => sent.filter((m) => m.threadId === "pm-1");
  const taskInFlight = (id: string, contract: Record<string, unknown>) => {
    createTask(db, { id, runId: "run-1", kind: "bb", contract });
    createAttempt(db, { id: `att-${id}`, runId: "run-1", taskId: id });
    transitionAttempt(db, `att-${id}`, "spawn_requested");
    transitionAttempt(db, `att-${id}`, "running");
  };
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

  it("asks on the first red run and gives the PM the failing tests; the same red gate again does not ask", async () => {
    expect(await redGate()).toMatchObject({ ran: true, passed: false, culpritTaskId: null });
    expect(asks).toHaveLength(1);
    expect(toPm()[0]!.text).toContain("tests/a.test.ts");

    await redGate();
    await redGate();

    expect(asks).toHaveLength(1);
    // The PM is told it is the same red gate, without a second form.
    expect(toPm()).toHaveLength(3);
    expect(toPm()[1]!.text).toContain("still red");
    expect(toPm()[1]!.text).toContain("tests/a.test.ts");
    expect(toPm()[1]!.text).not.toContain("The owner was asked what to do");
  });

  it("stays quiet while a PM fix task that owns the failing test is in flight", async () => {
    await redGate();
    const before = sent.length;
    taskInFlight("fix-a", { owns_paths: ["tests/"], expected_outputs: ["tests/a.test.ts"] });

    await redGate();

    expect(sent.length).toBe(before);
    expect(asks).toHaveLength(1);
  });

  it("a task dispatched after the episode began is a fix in flight even if its paths are unrelated", async () => {
    await redGate();
    const before = sent.length;
    await tick();
    taskInFlight("fix-b", { owns_paths: ["src/other/"], expected_outputs: ["src/other/x.ts"] });

    await redGate();

    expect(sent.length).toBe(before);
  });

  it("a task in flight from before the episode and unrelated to the failing test does not silence the PM", async () => {
    taskInFlight("older", { owns_paths: ["docs/"], expected_outputs: ["docs/x.md"] });
    await tick();
    await redGate();
    await redGate();
    expect(toPm()).toHaveLength(2);
    expect(toPm()[1]!.text).toContain("still red");
  });

  it("a green run ends the episode: the next red gate asks again", async () => {
    await redGate();
    failing = [];
    writePackage();
    runner.noteMergedTask({ taskId: "t3", commitSha: "sha-3", threadId: "thr-t3", attemptId: "att-3", produced: ["src/three.ts"] });
    expect(await runner.maybeRunGate({ runId: "run-1", projectId: "proj-1", pmThreadId: "pm-1", basePath: dir, configHostId: "host-1", trigger: "drain" })).toMatchObject({ passed: true });
    failing = ["tests/a.test.ts"];
    await redGate();
    expect(asks).toHaveLength(2);
  });

  it("other failing test files are another episode; fewer of the same files stay in this one", async () => {
    failing = ["tests/a.test.ts", "tests/b.test.ts"];
    await redGate();
    failing = ["tests/a.test.ts"];
    await redGate();
    expect(asks).toHaveLength(1);
    failing = ["tests/c.test.ts"];
    await redGate();
    expect(asks).toHaveLength(2);
  });

  it("delivers the owner's answer to the PM once", async () => {
    await redGate();
    const answer = { outcome: "answered", line: "Investigate and fix it" };
    await settle[0]!(answer);
    await settle[0]!(answer);
    expect(sent.filter((m) => m.text.includes("the owner answered"))).toHaveLength(1);
  });
});
