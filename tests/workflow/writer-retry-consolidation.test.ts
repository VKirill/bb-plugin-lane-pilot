import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { WorkflowEngine } from "@lane-pilot/workflow-engine";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, transitionAttempt } from "../../src/rooms/plugin-db";
import { registerDispatchExecutors } from "../../src/rooms/writer/server/handlers/dispatch-workflow";
import { startDispatchRun } from "../../src/rooms/writer/server/services/dispatch-workflow-ops";
import { topicLoopGuard } from "../../src/rooms/writer/server/services/dispatch-guards";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import type { TaskV2 } from "../../src/rooms/contracts";

function setupPipeline(outcomeForCall: (callIndex: number, input: Record<string, unknown>) => { state: "accepted" | "blocked"; reason?: string }) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const projectId = "proj-retry";
  const runId = "run-retry";
  const taskId = "task-retry";
  createRun(db, runId, projectId, "bb", "/tmp/ws");
  const task: TaskV2 = {
    schema_version: 2, id: taskId, title: "Fix issue", display_title: "Fix issue", kind: "fix", area: "a",
    risk: "low", lane: "writer", project_cwd: "/tmp/ws", read_first: [], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["a.ts"], owns_paths: ["a.ts"], never_touch: [], depends_on: [],
    objective: "Fix a.ts", acceptance: ["a.ts fixed"], verify: "tests",
    verification: [{ command: "npm test", cwd: "/tmp/ws", timeout_sec: 30 }],
  };
  createTask(db, { id: taskId, runId, kind: "bb", contract: task });
  createAttempt(db, { id: "att-init", runId, taskId });
  saveProjectSetting(db, projectId, "writer.provider", "codex");
  saveProjectSetting(db, projectId, "writer.model", "gpt-6-luna");
  saveProjectSetting(db, projectId, "writer.rotation_share", 0);
  saveProjectSetting(db, projectId, "writer.fallback1.provider", "claude-code");
  saveProjectSetting(db, projectId, "writer.fallback1.model", "claude-sonnet-4-6");

  const engine = new WorkflowEngine({ db, harnessVersion: "test", resolveWorkflow: builtinWorkflow });
  const ctx = { bb, db, host: { call: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, log: () => undefined, refreshRun: () => undefined, isDisposed: () => false } as never;
  const calls: Array<Record<string, unknown>> = [];
  const startWriterTask = (input: Record<string, unknown>) => {
    const idx = calls.length;
    calls.push(input);
    const attemptId = String(input.firstAttemptId);
    const outcome = outcomeForCall(idx, input);
    transitionAttempt(db, attemptId, "spawn_requested");
    transitionAttempt(db, attemptId, "running", { threadId: `thr_${idx}` });
    if (outcome.state === "accepted") {
      transitionAttempt(db, attemptId, "accepted");
    } else {
      transitionAttempt(db, attemptId, "blocked", { reason: outcome.reason ?? "verification failed (npm test): boom" });
    }
  };
  const services = {
    stageHelperSettings: async () => ({}),
    baseline: { preflight: async () => null },
    isLiveFolder: async () => false,
    startWriterTask,
  } as never;

  registerDispatchExecutors(engine, bb);
  engine.register("lp.execution-packet", { run: async () => ({ output: { ok: true, packetSha256: "a".repeat(64), selectedLines: 1 } }) });
  engine.register("lp.pm-read", { run: async () => ({ output: { state: "skipped", summary: "ok", handoff: "pm-read skipped" } }) });
  engine.register("lp.plan-critique", { run: async () => ({ output: { allowed: true, handoff: "plan-critique allowed" } }) });
  engine.register("lp.specialist-review", { run: async () => ({ output: { allowed: true, handoff: "specialist-review allowed" } }) });
  engine.register("lp.ownership-base", { run: async () => ({ output: { ok: true, live: false } }) });
  engine.register("lp.task-folder", { run: async () => ({ output: { ok: true } }) });
  engine.register("lp.baseline", { run: async () => ({ output: { state: "skipped" } }) });
  engine.register("lp.qa-gate", { reentrant: true, run: async () => ({ output: { run: false } }) });

  const config = { projectId, hostId: "h1", pmWorkspacePath: "/tmp/ws", writerWorkspacePath: "/tmp/ws", pmProviderId: "anthropic", pmModel: "claude-opus-4-6", writerProviderId: "codex", writerModel: "gpt-6-luna" };
  const run = startDispatchRun(engine, {
    ctx, services, threadId: "thr-pm", projectId, runId, taskId, attemptId: "att-init",
    config, runConfig: config, workspacePath: "/tmp/ws", task, plan: "Fix a.ts", lintWarnings: [],
  });
  return { bb, db, projectId, runId, taskId, engine, calls, run, harness };
}

async function finishPipeline(engine: WorkflowEngine, run: { runId: string; done: Promise<{ status: string }> }) {
  await run.done;
  for (let i = 0; i < 12; i++) {
    const row = engine.get(run.runId);
    if (!row || row.status !== "waiting") return row?.status;
    await engine.poll();
    await engine.idle();
  }
  return engine.get(run.runId)?.status;
}

describe("consolidated writer retry rule (3 visits -> fallback model -> owner inbox)", () => {
  it("retries writer 3 visits, reruns once on role fallback worker without prior thread, then posts owner inbox item with failureClass", async () => {
    const w = setupPipeline(() => ({ state: "blocked", reason: "verification failed (npm test): assertion error" }));
    try {
      const status = await finishPipeline(w.engine, w.run);
      expect(status).toBe("succeeded");
      // 3 visits on primary writer + 1 rerun on fallback model = 4 singleAttempt calls.
      expect(w.calls).toHaveLength(4);
      expect(w.calls.slice(0, 3).every((call) => call.fallbackSelection === undefined)).toBe(true);
      expect(w.calls[3]).toMatchObject({
        singleAttempt: true,
        fallbackSelection: { providerId: "claude-code", model: "claude-sonnet-4-6" },
      });
      expect(w.calls[3]!.writerThreadId).toBeUndefined();

      const steps = w.engine.snapshot(w.run.runId)!.steps.filter((s) => s.scope === "");
      expect(steps.filter((s) => s.node_id === "writer")).toHaveLength(3);
      expect(steps.filter((s) => s.node_id === "writer-fallback")).toHaveLength(1);
      expect(steps.filter((s) => s.node_id === "writer-owner-backlog")).toHaveLength(1);

      const items = listOpenOwnerItems(w.db, { projectId: w.projectId });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "writer_exhausted", projectId: w.projectId });
      expect(items[0]!.what).toContain("3 попыток");
      expect(items[0]!.why).toContain("task");
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("stops at qa-gate-fallback without owner inbox escalation if fallback rerun succeeds", async () => {
    const w = setupPipeline((idx) => idx === 3 ? { state: "accepted" } : { state: "blocked", reason: "verification failed (npm test): flaky" });
    try {
      const status = await finishPipeline(w.engine, w.run);
      expect(status).toBe("succeeded");
      expect(w.calls).toHaveLength(4);
      const steps = w.engine.snapshot(w.run.runId)!.steps.filter((s) => s.scope === "");
      expect(steps.filter((s) => s.node_id === "writer")).toHaveLength(3);
      expect(steps.some((s) => s.node_id === "qa-gate-fallback")).toBe(true);
      expect(steps.some((s) => s.node_id === "writer-owner-backlog")).toBe(false);
      expect(listOpenOwnerItems(w.db, { projectId: w.projectId })).toEqual([]);
    } finally {
      await w.harness.lifecycle.dispose();
    }
  });

  it("escalates topicLoopGuard to owner backlog after 3 failed tries on one topic", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    try {
      const db = openDatabase(bb);
      createRun(db, "r-loop", "proj-loop", "bb", "/tmp/ws");
      const now = Date.now();
      for (const n of [1, 2, 3]) {
        const id = `t${n}`;
        const contract: TaskV2 = {
          schema_version: 2, id, title: "fix runner", display_title: "fix runner", kind: "fix", area: "runner",
          risk: "low", lane: "writer", project_cwd: "/tmp/ws", read_first: [], interfaces: [], invariants: [],
          out_of_scope: [], expected_outputs: ["src/runner.ts"], owns_paths: ["src/runner.ts"], never_touch: [],
          depends_on: [], objective: "fix src/runner.ts", acceptance: ["green"], verify: "tests",
          verification: [{ command: "npm test", cwd: "/tmp/ws", timeout_sec: 30 }],
        };
        createTask(db, { id, runId: "r-loop", kind: "bb", contract });
        createAttempt(db, { id: `att-${n}`, runId: "r-loop", taskId: id });
        transitionAttempt(db, `att-${n}`, "spawn_requested");
        transitionAttempt(db, `att-${n}`, "running", { threadId: `thr-${n}` });
        transitionAttempt(db, `att-${n}`, "validation_failed", { reason: "verification failed (npm test): boom", failureCode: "verification_failed" });
      }
      const fourth: TaskV2 = {
        schema_version: 2, id: "t4", title: "fix runner again", display_title: "fix runner again", kind: "fix", area: "runner",
        risk: "low", lane: "writer", project_cwd: "/tmp/ws", read_first: [], interfaces: [], invariants: [],
        out_of_scope: [], expected_outputs: ["src/runner.ts"], owns_paths: ["src/runner.ts"], never_touch: [],
        depends_on: [], objective: "fix src/runner.ts", acceptance: ["green"], verify: "tests",
        verification: [{ command: "npm test", cwd: "/tmp/ws", timeout_sec: 30 }],
      };
      const stopped = await topicLoopGuard(db, "r-loop", fourth, { projectId: "proj-loop", now: now + 10_000 });
      expect(stopped).toMatch(/^topic_loop:/);
      expect(stopped).toContain("owner backlog");
      const items = listOpenOwnerItems(db, { projectId: "proj-loop" });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: "topic_loop", projectId: "proj-loop" });
      expect(items[0]!.why).toContain("task");
    } finally {
      await harness.lifecycle.dispose();
    }
  });
});
