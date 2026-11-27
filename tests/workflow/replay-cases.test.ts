import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  computeEnvironmentFingerprint,
  draftTestCaseFromReplay,
  parseWorkflow,
  replayCasesFromRuns,
  runDraftTest,
  testCasesOf,
  workflowMigrations,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { migrations, openDatabase } from "../../src/rooms/plugin-db";
import { createWorkflowArchitect, setRunVerdict } from "../../src/rooms/workflow/server";
import { workflow } from "./fixtures";

let dispose: (() => Promise<void> | void) | null = null;
const tempDirs: string[] = [];

afterEach(async () => {
  await dispose?.();
  dispose = null;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeFlow(extraNodes: Array<Record<string, unknown>> = []) {
  return parseWorkflow(
    workflow({
      id: "digest-send",
      inputs: [
        { name: "query", type: "string" },
        { name: "task_class", type: "string", required: false },
        { name: "process_key", type: "string", required: false },
      ],
      outputs: [
        { name: "result", type: "string" },
        { name: "decision", type: "string" },
      ],
      nodes: [
        {
          id: "fetch",
          type: "agent",
          role: "analyst",
          effect: "R",
          prompt: "Fetch",
          out: [{ name: "summary", type: "string" }],
        },
        {
          id: "approve",
          type: "human",
          question: "Send digest?",
          options: ["send", "abort"],
          out: [
            { name: "answer", type: "string" },
            { name: "answer_kind", type: "enum", values: ["send", "abort", "timeout"] },
          ],
        },
        {
          id: "send",
          type: "action",
          action: "telegram.send_rich",
          effect: "L",
          out: [{ name: "message_id", type: "string" }],
        },
        ...extraNodes,
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { result: "send.message_id", decision: "approve.answer_kind" },
        },
      ],
      edges: [
        { from: "start", to: "fetch" },
        { from: "fetch", to: "approve" },
        { from: "approve", to: "send" },
        ...(extraNodes.length
          ? [
              { from: "send", to: String(extraNodes[0]!.id) },
              { from: String(extraNodes[0]!.id), to: "done" },
            ]
          : [{ from: "send", to: "done" }]),
      ],
    }),
  );
}

function insertRun(
  db: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    workflowId?: string;
    version?: number;
    status?: string;
    parentRunId?: string | null;
    definition: unknown;
    inputs?: Record<string, unknown>;
    createdAt?: number;
  },
) {
  db.prepare(
    `INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, parent_run_id, status, inputs_json, created_at, updated_at)
     VALUES (?, ?, ?, 'sha', ?, 'proj-1', ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.workflowId ?? "digest-send",
    input.version ?? 1,
    JSON.stringify(input.definition),
    input.parentRunId ?? null,
    input.status ?? "succeeded",
    JSON.stringify(input.inputs ?? {}),
    input.createdAt ?? 1000,
    (input.createdAt ?? 1000) + 10,
  );
}

function insertStep(
  db: ReturnType<typeof openDatabase>,
  input: {
    runId: string;
    nodeId: string;
    state?: string;
    output?: unknown;
    startedAt?: number;
  },
) {
  db.prepare(
    `INSERT INTO lane_pilot_wf_step
      (run_id, step_key, origin, node_id, visit, state, output_json, started_at, updated_at)
     VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?)`,
  ).run(
    input.runId,
    `${input.nodeId}#1`,
    `origin:${input.nodeId}#1`,
    input.nodeId,
    input.state ?? "succeeded",
    input.output === undefined ? null : JSON.stringify(input.output),
    input.startedAt ?? 100,
    (input.startedAt ?? 100) + 1,
  );
}

describe("replay cases from finished runs (Task 14)", () => {
  it("extracts human answers, recorded outputs, verdicts and taskClass from a two-run fixture and skips renamed graphs", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const current = makeFlow();

    insertRun(db, {
      id: "run_1",
      version: 1,
      definition: current,
      inputs: { query: "ai news", task_class: "digest" },
      createdAt: 1000,
    });
    insertStep(db, { runId: "run_1", nodeId: "fetch", output: { summary: "Top 3 stories" }, startedAt: 1010 });
    insertStep(db, { runId: "run_1", nodeId: "approve", output: { answer: "send", answer_kind: "send" }, startedAt: 1020 });
    insertStep(db, { runId: "run_1", nodeId: "send", output: { message_id: "msg-101" }, startedAt: 1030 });
    insertStep(db, { runId: "run_1", nodeId: "done", output: { result: "msg-101", decision: "send" }, startedAt: 1040 });
    setRunVerdict(db, { runId: "run_1", workflowId: "digest-send", graphVersion: 1, verdict: "accept", source: "owner" });

    insertRun(db, {
      id: "run_2",
      version: 2,
      definition: current,
      inputs: { query: "weekly", process_key: "newsletter" },
      createdAt: 2000,
    });
    insertStep(db, { runId: "run_2", nodeId: "fetch", output: { summary: "Weekly notes" }, startedAt: 2010 });
    insertStep(db, { runId: "run_2", nodeId: "approve", output: { answer: "abort", answer_kind: "abort" }, startedAt: 2020 });
    insertStep(db, { runId: "run_2", nodeId: "send", output: { message_id: "msg-202" }, startedAt: 2030 });
    setRunVerdict(db, { runId: "run_2", workflowId: "digest-send", graphVersion: 2, verdict: "reject", source: "human_node" });

    // Child runs and unfinished runs are ignored.
    insertRun(db, { id: "run_child", parentRunId: "run_1", definition: current, createdAt: 2500 });
    insertRun(db, { id: "run_live", status: "running", definition: current, createdAt: 2600 });

    // Run from a renamed graph whose node ids have zero overlap with the current graph.
    const renamedDef = {
      nodes: [
        { id: "legacy_collect", type: "action" },
        { id: "legacy_publish", type: "action" },
      ],
    };
    insertRun(db, {
      id: "run_renamed",
      version: 1,
      definition: renamedDef,
      inputs: { query: "old" },
      createdAt: 500,
    });
    insertStep(db, { runId: "run_renamed", nodeId: "legacy_collect", output: { x: 1 }, startedAt: 510 });

    const logs: string[] = [];
    const res = replayCasesFromRuns(db, "digest-send", {
      workflow: current,
      log: (m) => logs.push(m),
    });

    expect(res.skipped).toEqual([{ runId: "run_renamed", reason: "no_common_nodes" }]);
    expect(res.cases).toHaveLength(2);
    expect(res.cases[0]).toEqual({
      runId: "run_2",
      graphVersion: 2,
      inputs: { query: "weekly", process_key: "newsletter" },
      humanAnswers: { approve: { answer: "abort", answer_kind: "abort" } },
      recorded: {
        fetch: { summary: "Weekly notes" },
        approve: { answer: "abort", answer_kind: "abort" },
        send: { message_id: "msg-202" },
      },
      verdict: "reject",
      taskClass: "newsletter",
    });
    expect(res.cases[1]).toEqual({
      runId: "run_1",
      graphVersion: 1,
      inputs: { query: "ai news", task_class: "digest" },
      humanAnswers: { approve: { answer: "send", answer_kind: "send" } },
      recorded: {
        fetch: { summary: "Top 3 stories" },
        approve: { answer: "send", answer_kind: "send" },
        send: { message_id: "msg-101" },
        done: { result: "msg-101", decision: "send" },
      },
      verdict: "accept",
      taskClass: "digest",
    });
    expect(logs).toContain("DEBUG replay cases graph=digest-send n=2 skipped=1");

    // Passing runIds that includes a run from another workflow id skips it cleanly.
    insertRun(db, { id: "run_other_wf", workflowId: "other-graph", definition: current, createdAt: 400 });
    const filtered = replayCasesFromRuns(db, "digest-send", {
      workflow: current,
      runIds: ["run_1", "run_other_wf"],
    });
    expect(filtered.cases.map((c) => c.runId)).toEqual(["run_1"]);
    expect(filtered.skipped).toEqual([{ runId: "run_other_wf", reason: "workflow_mismatch" }]);
  });

  it("returns verdict: null when lane_pilot_wf_run_verdict does not exist yet", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = bb.storage.database();
    bb.storage.migrate(db, workflowMigrations);

    const current = makeFlow();
    insertRun(db as never, { id: "run_no_verdict", definition: current, inputs: { query: "x" }, createdAt: 1000 });
    insertStep(db as never, { runId: "run_no_verdict", nodeId: "send", output: { message_id: "m1" }, startedAt: 1010 });

    const res = replayCasesFromRuns(db, "digest-send", { workflow: current });
    expect(res.cases).toHaveLength(1);
    expect(res.cases[0]!.verdict).toBeNull();
  });

  it("passes runDraftTest on replay cases with L/S nodes stubbed by recorded and marks missing stubs as replay_needs_stub", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const dir = mkdtempSync(join(tmpdir(), "lp-replay-case-"));
    tempDirs.push(dir);
    const marker = join(dir, "should-not-run.txt");
    const fingerprint = computeEnvironmentFingerprint();

    const wfWithS = makeFlow([
      {
        id: "audit_s",
        type: "agent",
        role: "errand",
        effect: "S",
        form: "script",
        script: { cmd: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`], fingerprint },
        verify: "audit_s.ok == true",
        prompt: "Irreversible step",
        out: [{ name: "ok", type: "boolean" }],
      },
    ]);

    insertRun(db, {
      id: "run_ok",
      definition: wfWithS,
      inputs: { query: "q" },
      createdAt: 1000,
    });
    insertStep(db, { runId: "run_ok", nodeId: "fetch", output: { summary: "ok" }, startedAt: 1010 });
    insertStep(db, { runId: "run_ok", nodeId: "approve", output: { answer: "send", answer_kind: "send" }, startedAt: 1020 });
    insertStep(db, { runId: "run_ok", nodeId: "send", output: { message_id: "msg-recorded-9" }, startedAt: 1030 });
    insertStep(db, { runId: "run_ok", nodeId: "audit_s", output: { ok: true }, startedAt: 1040 });
    // Even if recorded has a stale value on emit, pure emit runs for real on the current graph.
    insertStep(db, { runId: "run_ok", nodeId: "done", output: { result: "stale-emit", decision: "old" }, startedAt: 1050 });

    insertRun(db, {
      id: "run_missing_l",
      definition: wfWithS,
      inputs: { query: "q2" },
      createdAt: 2000,
    });
    insertStep(db, { runId: "run_missing_l", nodeId: "fetch", output: { summary: "ok" }, startedAt: 2010 });
    insertStep(db, { runId: "run_missing_l", nodeId: "approve", output: { answer: "send", answer_kind: "send" }, startedAt: 2020 });

    const { cases } = replayCasesFromRuns(db, "digest-send", { workflow: wfWithS });
    expect(cases).toHaveLength(2);

    const okCase = cases.find((c) => c.runId === "run_ok")!;
    const missingCase = cases.find((c) => c.runId === "run_missing_l")!;

    const okRes = await runDraftTest({ db, harnessVersion: "t" }, wfWithS, draftTestCaseFromReplay(okCase));
    expect(okRes).toMatchObject({
      caseId: "replay:run_ok",
      green: true,
      status: "succeeded",
      output: { result: "msg-recorded-9", decision: "send" },
    });
    expect(existsSync(marker)).toBe(false);

    const missingRes = await runDraftTest({ db, harnessVersion: "t" }, wfWithS, missingCase);
    expect(missingRes).toMatchObject({
      caseId: "replay:run_missing_l",
      green: false,
      status: "skipped",
      reason: "replay_needs_stub",
      failedNode: "send",
      nodeId: "send",
    });

    const replayTc = draftTestCaseFromReplay(okCase);
    const replayResult = await runDraftTest({ db, harnessVersion: "t" }, wfWithS, replayTc);
    expect(replayResult.green).toBe(true);
    expect(testCasesOf(wfWithS, { cases: [okCase] }).map((c) => c.id)).toEqual(["smoke", "replay:run_ok"]);
  });

  it("runs past-run replay cases through the architect workflow_draft_test RPC with fromRuns", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    dispose = () => harness.lifecycle.dispose();
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    const architect = createWorkflowArchitect(ctx, { workflowEngine: { hasExecutor: () => false } } as never);

    const def = {
      id: "digest-rpc",
      name: { en: "Digest RPC", ru: "Дайджест" },
      description: { en: "Test", ru: "Тест" },
      inputs: [{ name: "query", type: "string" }],
      outputs: [{ name: "result", type: "string" }],
      nodes: [
        {
          id: "approve",
          type: "human",
          question: "Go?",
          options: ["send", "abort"],
          out: [{ name: "answer_kind", type: "enum", values: ["send", "abort"] }],
        },
        {
          id: "send",
          type: "action",
          action: "telegram.send_rich",
          effect: "L",
          out: [{ name: "message_id", type: "string" }],
        },
        {
          id: "done",
          type: "action",
          action: "emit",
          map: { result: "send.message_id" },
        },
      ],
      edges: [
        { from: "start", to: "approve" },
        { from: "approve", to: "send" },
        { from: "send", to: "done" },
      ],
      test: {
        id: "sim",
        sim: {
          input: { query: "base" },
          human_answers: { approve: "send" },
          stubs: { send: { message_id: "sim-1" } },
          expect_output: { result: "sim-1" },
        },
      },
    };

    const created = architect.create({
      projectId: "proj-1",
      threadId: "thr-1",
      name: "Digest RPC",
      description: "Test",
      scope: "global",
      workflowId: "digest-rpc",
      definition: def,
    });

    insertRun(db, { id: "run_rpc_1", workflowId: "digest-rpc", definition: def, inputs: { query: "real" }, createdAt: 1000 });
    insertStep(db, { runId: "run_rpc_1", nodeId: "approve", output: { answer_kind: "send" }, startedAt: 1010 });
    insertStep(db, { runId: "run_rpc_1", nodeId: "send", output: { message_id: "live-99" }, startedAt: 1020 });

    const tested = await architect.rpc.workflow_draft_test({
      draftId: created.draftId,
      fromRuns: { limit: 10, runIds: ["run_rpc_1"] },
    }) as { ran: boolean; green: boolean; cases: Array<{ caseId: string; green: boolean; output: unknown }> };

    expect(tested.ran).toBe(true);
    expect(tested.green).toBe(true);
    expect(tested.cases.map((c) => c.caseId)).toEqual(["sim", "replay:run_rpc_1"]);
    expect(tested.cases.find((c) => c.caseId === "replay:run_rpc_1")?.output).toEqual({ result: "live-99" });

    // Ensure migrations list stays valid with openDatabase
    expect(migrations.length).toBeGreaterThan(workflowMigrations.length);
  });
});
