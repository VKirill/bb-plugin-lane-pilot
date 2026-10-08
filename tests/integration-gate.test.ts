import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  parseIntegrationGateSettings,
  extractFailingFiles,
  extractStaticImports,
  isFileRelatedToTask,
  findCulpritByFiles,
  formatFixTurnPrompt,
  IntegrationGateRunner,
} from "../src/rooms/verification/server/integration-gate";
import { openDatabase, createTask, saveStageReceipt, saveProjectSetting } from "../src/rooms/storage/database";
import * as hostHandlers from "../src/rooms/host-worker/host-handlers";
import type { ServerCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";

describe("integration-gate settings parsing", () => {
  it("defaults to null command, queue_drained, every 5", () => {
    const parsed = parseIntegrationGateSettings({});
    expect(parsed.gateCommand).toBeNull();
    expect(parsed.gateOff).toBe(false);
    expect(parsed.gateWhen).toBe("queue_drained");
    expect(parsed.gateEvery).toBe(5);
  });

  it("parses valid settings", () => {
    const parsed = parseIntegrationGateSettings({
      "integration.gate_command": "npm test",
      "integration.gate_when": "every_n",
      "integration.gate_every": 3,
    });
    expect(parsed.gateCommand).toBe("npm test");
    expect(parsed.gateWhen).toBe("every_n");
    expect(parsed.gateEvery).toBe(3);
  });
});

describe("integration.gate_command off", () => {
  it("is no command and a switch", () => {
    expect(parseIntegrationGateSettings({ "integration.gate_command": "off" })).toMatchObject({ gateCommand: null, gateOff: true });
    expect(parseIntegrationGateSettings({ "integration.gate_command": " Off " })).toMatchObject({ gateCommand: null, gateOff: true });
  });
});

describe("failing files extraction", () => {
  it("extracts failing test files from vitest output", () => {
    const output = `
 ❯ tests/foo.test.ts:24:5
 FAIL tests/bar.spec.ts
 Some generic error
    `;
    const files = extractFailingFiles(output);
    expect(files).toContain("tests/foo.test.ts");
    expect(files).toContain("tests/bar.spec.ts");
  });

  it("extracts failing files from tsc output", () => {
    const output = `
src/rooms/verification/server/integration-gate.ts:42:10 - error TS2304: Cannot find name 'foo'.
src/rooms/contracts/index.ts:10:5 - error TS2322: Type 'string' is not assignable to type 'number'.
    `;
    const files = extractFailingFiles(output);
    expect(files).toContain("src/rooms/verification/server/integration-gate.ts");
    expect(files).toContain("src/rooms/contracts/index.ts");
  });
});

describe("static import extraction", () => {
  it("extracts static imports and requires", () => {
    const code = `
import { foo } from "./foo";
import bar from "../bar";
export * from "./baz";
const qux = require("./qux");
`;
    const imports = extractStaticImports(code);
    expect(imports).toContain("./foo");
    expect(imports).toContain("../bar");
    expect(imports).toContain("./baz");
    expect(imports).toContain("./qux");
  });
});

describe("culprit mapping by files", () => {
  it("finds culprit when task produced the failing file directly", async () => {
    const mergedTasks = [
      {
        taskId: "task-1",
        commitSha: "sha1",
        threadId: "thr-1",
        attemptId: "att-1",
        produced: ["src/feature-a.ts"],
      },
      {
        taskId: "task-2",
        commitSha: "sha2",
        threadId: "thr-2",
        attemptId: "att-2",
        produced: ["src/feature-b.ts"],
      },
    ];

    const culprit = await findCulpritByFiles(["src/feature-b.ts"], mergedTasks, async () => null);
    expect(culprit).toBe(mergedTasks[1]);
  });

  it("returns null if ambiguous (multiple tasks touched related files)", async () => {
    const mergedTasks = [
      {
        taskId: "task-1",
        commitSha: "sha1",
        threadId: "thr-1",
        attemptId: "att-1",
        produced: ["src/shared.ts"],
      },
      {
        taskId: "task-2",
        commitSha: "sha2",
        threadId: "thr-2",
        attemptId: "att-2",
        produced: ["src/shared.ts"],
      },
    ];

    const culprit = await findCulpritByFiles(["src/shared.ts"], mergedTasks, async () => null);
    expect(culprit).toBeNull();
  });
});

describe("prompt formatting for fix turn", () => {
  it("formats prompt with tail and log path", () => {
    const prompt = formatFixTurnPrompt({
      taskId: "task-1",
      gateCommand: "npm test",
      exitCode: 1,
      stdout: "Tests failed",
      stderr: "Error details",
      logPath: ".agents/plans/items/task-1/logs/integration-gate.log",
    });
    expect(prompt).toContain("Result: integration gate failed after merging your task task-1");
    expect(prompt).toContain(".agents/plans/items/task-1/logs/integration-gate.log");
    expect(prompt).toContain("`npm test` exited with code 1");
    expect(prompt).toContain("Make this pass on main");
  });
});

describe("IntegrationGateRunner with mock core & services", () => {
  let db: ReturnType<typeof openDatabase>;
  let sentMessages: Array<{ threadId: string; text: string }>;
  let mockCore: ServerCore;
  let mockServices: Services;

  beforeEach(() => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    db = openDatabase(bb);
    db.prepare(`INSERT INTO lane_pilot_run (id, project_id, pm_thread_id, state, created_at, updated_at) VALUES ('run-1', 'proj-1', 'pm-1', 'running', 0, 0)`).run();
    sentMessages = [];

    mockCore = {
      db,
      bb: {
        sdk: {
          threads: {
            send: async (input: { threadId: string; input: Array<{ text: string }> }) => {
              sentMessages.push({ threadId: input.threadId, text: input.input[0]?.text ?? "" });
              return { id: "msg-1" };
            },
          },
          files: {
            write: async () => ({ ok: true }),
          },
        },
        storage: {
          kv: {
            get: async () => null,
            set: async () => null,
          },
        },
      },
      log: () => {},
      // The project's host: here it is this machine, so its handlers run in-process.
      host: { call: async (method: string, input: unknown) => (hostHandlers as unknown as Record<string, (input: unknown) => Promise<unknown>>)[method]!(input) },
    } as unknown as ServerCore;

    mockServices = {} as unknown as Services;
  });

  it("does nothing when the gate is off", async () => {
    // process.cwd() holds a package.json with a test script: only «off» keeps the gate from being detected there.
    saveProjectSetting(db, "proj-1", "integration.gate_command", "off");
    const runner = new IntegrationGateRunner(mockCore, mockServices);
    runner.noteMergedTask({
      taskId: "task-1",
      commitSha: "sha-1",
      threadId: "thr-1",
      attemptId: "att-1",
      produced: ["src/foo.ts"],
    });

    const res = await runner.maybeRunGate({
      runId: "run-1",
      projectId: "proj-1",
      pmThreadId: "pm-1",
      basePath: process.cwd(),
      configHostId: "host-1",
      trigger: "drain",
    });

    expect(res.ran).toBe(false);
  });

  it("respects every_n trigger configuration", async () => {
    saveProjectSetting(db, "proj-1", "integration.gate_command", 'node -e "process.exit(0)"');
    saveProjectSetting(db, "proj-1", "integration.gate_when", "every_n");
    saveProjectSetting(db, "proj-1", "integration.gate_every", 2);

    const runner = new IntegrationGateRunner(mockCore, mockServices);
    runner.noteMergedTask({
      taskId: "task-1",
      commitSha: "sha-1",
      threadId: "thr-1",
      attemptId: "att-1",
      produced: ["src/foo.ts"],
    });

    // 1st merge: should not run because every_n = 2
    let res = await runner.maybeRunGate({
      runId: "run-1",
      projectId: "proj-1",
      pmThreadId: "pm-1",
      basePath: process.cwd(),
      configHostId: "host-1",
      trigger: "merge",
    });
    expect(res.ran).toBe(false);

    // 2nd merge
    runner.noteMergedTask({
      taskId: "task-2",
      commitSha: "sha-2",
      threadId: "thr-2",
      attemptId: "att-2",
      produced: ["src/bar.ts"],
    });

    res = await runner.maybeRunGate({
      runId: "run-1",
      projectId: "proj-1",
      pmThreadId: "pm-1",
      basePath: process.cwd(),
      configHostId: "host-1",
      trigger: "merge",
    });
    expect(res.ran).toBe(true);
    expect(res.passed).toBe(true);
  });

  it("runs on queue_drained trigger and records integration-gate stage receipt", async () => {
    db.prepare(`INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('task-1', 'run-1', 'bb', '{}', 0)`).run();
    saveProjectSetting(db, "proj-1", "integration.gate_command", 'node -e "process.exit(0)"');

    const runner = new IntegrationGateRunner(mockCore, mockServices);
    runner.noteMergedTask({
      taskId: "task-1",
      commitSha: "sha-1",
      threadId: "thr-1",
      attemptId: "att-1",
      produced: ["src/foo.ts"],
    });

    const res = await runner.maybeRunGate({
      runId: "run-1",
      projectId: "proj-1",
      pmThreadId: "pm-1",
      basePath: process.cwd(),
      configHostId: "host-1",
      trigger: "drain",
    });

    expect(res.ran).toBe(true);
    expect(res.passed).toBe(true);

    const receipts = db.prepare(`SELECT * FROM lane_pilot_stage_receipt WHERE run_id='run-1' AND stage_id='verification'`).all() as Array<any>;
    expect(receipts.length).toBeGreaterThan(0);
    expect(receipts[0].state).toBe("passed");
  });

  it("routes failing gate to the culprit writer thread without creating a new task id", async () => {
    // A merged task already exists in the run before the gate runs
    db.prepare(`INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('culprit-task', 'run-1', 'bb', '{}', 0)`).run();
    const tasksBefore = db.prepare(`SELECT * FROM lane_pilot_task WHERE run_id='run-1'`).all().length;

    // Failing command
    saveProjectSetting(db, "proj-1", "integration.gate_command", 'node -e "console.error(\'FAIL tests/culprit.test.ts\'); process.exit(1)"');

    const runner = new IntegrationGateRunner(mockCore, mockServices);
    runner.noteMergedTask({
      taskId: "culprit-task",
      commitSha: "sha-culprit",
      threadId: "culprit-thread-123",
      attemptId: "att-1",
      produced: ["tests/culprit.test.ts"],
    });

    const res = await runner.maybeRunGate({
      runId: "run-1",
      projectId: "proj-1",
      pmThreadId: "pm-thread-999",
      basePath: process.cwd(),
      configHostId: "host-1",
      trigger: "drain",
    });

    expect(res.ran).toBe(true);
    expect(res.passed).toBe(false);
    expect(res.culpritTaskId).toBe("culprit-task");

    // Check sent message to culprit thread
    const culpritMsg = sentMessages.find((m) => m.threadId === "culprit-thread-123");
    expect(culpritMsg).toBeDefined();
    expect(culpritMsg?.text).toContain("Result: integration gate failed after merging your task culprit-task");

    // Check PM notification
    const pmMsg = sentMessages.find((m) => m.threadId === "pm-thread-999");
    expect(pmMsg).toBeDefined();
    expect(pmMsg?.text).toContain("Traced to culprit-task");
    expect(pmMsg?.text).toContain("@thread:culprit-thread-123");

    // Check no new task ids created in db
    const tasksAfter = db.prepare(`SELECT * FROM lane_pilot_task WHERE run_id='run-1'`).all().length;
    expect(tasksAfter).toBe(tasksBefore);
  });

  describe("with no gate_command: the command is detected on the project's host", () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lp-gate-auto-")); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
    // A test script that counts its own runs and fails when told to, naming a test file the way vitest does.
    const writePackage = (failing: string | null) => writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {
      test: `node -e "require('fs').appendFileSync('runs.txt','x');${failing ? `console.error('FAIL ${failing}');process.exit(1)` : ""}"`,
    } }));
    const runs = () => (existsSync(join(dir, "runs.txt")) ? readFileSync(join(dir, "runs.txt"), "utf8").length : 0);
    const gate = (runner: IntegrationGateRunner, trigger: "merge" | "drain", extra: { live?: boolean } = {}) =>
      runner.maybeRunGate({ runId: "run-1", projectId: "proj-1", pmThreadId: "pm-thread-999", basePath: dir, configHostId: "host-1", trigger, ...extra });
    const merged = (taskId: string, produced: string[]) => ({ taskId, commitSha: `sha-${taskId}`, threadId: `thr-${taskId}`, attemptId: `att-${taskId}`, produced });

    it("runs the whole suite once after the batch, not per merge, and records the detected command in the receipt", async () => {
      writePackage(null);
      db.prepare(`INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('t2', 'run-1', 'bb', '{}', 0)`).run();
      const runner = new IntegrationGateRunner(mockCore, mockServices);
      runner.noteMergedTask(merged("t1", ["src/a.ts"]));
      expect(await gate(runner, "merge")).toEqual({ ran: false });
      runner.noteMergedTask(merged("t2", ["src/b.ts"]));
      expect(await gate(runner, "merge")).toEqual({ ran: false });
      expect(runs()).toBe(0);

      const res = await gate(runner, "drain");

      expect(res).toMatchObject({ ran: true, passed: true });
      expect(runs()).toBe(1);
      const receipt = db.prepare(`SELECT result_json FROM lane_pilot_stage_receipt WHERE run_id='run-1' AND stage_id='verification'`).get() as { result_json: string };
      expect(JSON.parse(receipt.result_json)).toMatchObject({ command: "npm test", source: "detected", passed: true, mergesChecked: 2 });
    });

    it("a red gate goes to the culprit writer's thread and tells the PM which command was detected", async () => {
      writePackage("tests/b.test.ts");
      const runner = new IntegrationGateRunner(mockCore, mockServices);
      runner.noteMergedTask(merged("t1", ["src/a.ts"]));
      runner.noteMergedTask(merged("t2", ["tests/b.test.ts"]));

      const res = await gate(runner, "drain");

      expect(res).toMatchObject({ ran: true, passed: false, culpritTaskId: "t2" });
      expect(runs()).toBe(1);
      expect(sentMessages.find((m) => m.threadId === "thr-t2")?.text).toContain("integration gate failed after merging your task t2");
      const pm = sentMessages.find((m) => m.threadId === "pm-thread-999")?.text ?? "";
      expect(pm).toContain("`npm test` (detected: package.json script «test»)");
      expect(pm).toContain("Traced to t2");
      expect(sentMessages.find((m) => m.threadId === "thr-t1")).toBeUndefined();
    });

    it("an explicit command overrides the detected one", async () => {
      writePackage("tests/b.test.ts");
      saveProjectSetting(db, "proj-1", "integration.gate_command", 'node -e "process.exit(0)"');
      const runner = new IntegrationGateRunner(mockCore, mockServices);
      runner.noteMergedTask(merged("t1", ["tests/b.test.ts"]));
      expect(await gate(runner, "drain")).toMatchObject({ ran: true, passed: true });
      expect(runs()).toBe(0);
    });

    it("off runs nothing even where a test script exists", async () => {
      writePackage(null);
      saveProjectSetting(db, "proj-1", "integration.gate_command", "off");
      const runner = new IntegrationGateRunner(mockCore, mockServices);
      runner.noteMergedTask(merged("t1", ["src/a.ts"]));
      expect(await gate(runner, "drain")).toEqual({ ran: false });
      expect(runs()).toBe(0);
    });

    it("a folder with no test runner has no gate", async () => {
      const runner = new IntegrationGateRunner(mockCore, mockServices);
      runner.noteMergedTask(merged("t1", ["src/a.ts"]));
      expect(await gate(runner, "drain")).toEqual({ ran: false });
    });

    it("a folder without git runs the gate in place and reports a red one to the PM instead of bisecting", async () => {
      writePackage("tests/b.test.ts");
      const hostCalls: string[] = [];
      const inPlace = { ...mockCore, host: { call: async (method: string, input: unknown) => { hostCalls.push(method); return (hostHandlers as unknown as Record<string, (input: unknown) => Promise<unknown>>)[method]!(input); } } } as unknown as ServerCore;
      const runner = new IntegrationGateRunner(inPlace, mockServices);
      runner.noteMergedTask(merged("t1", ["tests/b.test.ts"]));
      runner.noteMergedTask(merged("t2", ["src/c.ts"]));

      const res = await gate(runner, "drain", { live: true });

      expect(res).toMatchObject({ ran: true, passed: false, culpritTaskId: null });
      expect(hostCalls).not.toContain("gateBisect");
      expect(sentMessages.some((m) => m.threadId.startsWith("thr-"))).toBe(false);
      const pm = sentMessages.find((m) => m.threadId === "pm-thread-999")?.text ?? "";
      expect(pm).toContain("no git");
      expect(pm).toContain("t1, t2");
    });
  });
});
