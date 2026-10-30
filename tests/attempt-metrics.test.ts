import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { attemptMetrics, renderAttemptMetrics } from "../src/rooms/usage/server/attempt-metrics";
import { createRun, openDatabase } from "../src/rooms/storage/database";

const NOW = 10 * 86_400_000;

function world() {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "bb", "/repo");
  let seq = 0;
  const task = (id:string) => db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,'run','bb','{}',?)").run(id, NOW - 5000);
  const attempt = (id:string, taskId:string, no:number, state:string, thread:string | null, at:number, end = at + 60_000) =>
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,created_at,updated_at) VALUES(?,'run',?,?,?,?,?,?)").run(id, taskId, thread, state, no, at, end);
  const stage = (taskId:string, stageId:string, state:string, at:number) =>
    db.prepare("INSERT INTO lane_pilot_stage_event(project_id,run_id,task_id,stage_id,state,input_sha256,attempt,occurred_at) VALUES('proj','run',?,?,?,'x',0,?)").run(taskId, stageId, state, at + seq++);
  const gate = (taskId:string, name:string, status:string, at:number) =>
    db.prepare("INSERT INTO lane_pilot_gate_event(project_id,run_id,task_id,gate,status,input_sha256,attempt,occurred_at) VALUES('proj','run',?,?,?,'x',0,?)").run(taskId, name, status, at);
  const cursor = (thread:string, provider:string, model:string, total:object) =>
    db.prepare("INSERT INTO lane_pilot_token_cursor(thread_id,project_id,provider_id,last_model,last_provider,total_json,updated_at) VALUES(?,'proj',?,?,?,?,1)").run(thread, provider, model, provider, JSON.stringify(total));
  return { db, task, attempt, stage, gate, cursor };
}

describe("lp_attempt_metrics", () => {
  it("measures a Codex writer and says «not measured» for a Cursor writer, never 0", () => {
    const w = world();
    const at = NOW - 3_600_000;
    w.task("codex-task"); w.task("cursor-task");
    w.attempt("a1", "codex-task", 1, "accepted", "thr_codex", at, at + 90_000);
    w.attempt("a2", "cursor-task", 1, "accepted", "thr_cursor", at, at + 40_000);
    w.cursor("thr_codex", "codex", "gpt-6-luna", { input:1_000_000, output:100_000, cached:400_000, total:1_100_000, cacheRead:400_000, cacheWrite:0 });
    w.cursor("thr_cursor", "acp-cursor", "composer-2.5", { input:0, output:0, cached:0, total:0, cacheRead:0, cacheWrite:0 });
    w.stage("codex-task", "pm-read", "running", at - 30_000); w.stage("codex-task", "pm-read", "passed", at - 10_000);
    w.stage("codex-task", "writer-agent", "running", at + 1000); w.stage("codex-task", "writer-agent", "passed", at + 61_000);
    w.stage("codex-task", "verification", "running", at + 61_500); w.stage("codex-task", "verification", "failed", at + 70_500);
    w.gate("codex-task", "owns-paths", "passed", at + 2000); w.gate("codex-task", "accept", "rejected", at + 3000);

    const report = attemptMetrics(w.db as never, { projectId:"proj", days:7, now:NOW });
    const codex = report.attempts.find((row) => row.taskId === "codex-task")!;
    const cursor = report.attempts.find((row) => row.taskId === "cursor-task")!;

    expect(codex.costState).toBe("measured");
    expect(codex.tokens).toMatchObject({ output:100_000, total:1_100_000 });
    // gpt-6-luna: 600k uncached * 0.1 + 400k cache read * 0.01 + 100k output * 0.5 per million.
    expect(codex.costUsd).toBeCloseTo(0.114, 6);
    expect(codex.seconds).toBe(90);
    expect(codex.stages.map((row) => `${row.stageId}:${row.state}:${row.seconds}`)).toEqual(["pm-read:passed:20", "writer-agent:passed:60", "verification:failed:9"]);
    expect(codex.stages.find((row) => row.stageId === "pm-read")!.proof).toBe("advisory");
    expect(codex.stages.find((row) => row.stageId === "verification")!.proof).toBe("command");
    expect(codex.stagesPassed).toBe(2);
    expect(codex.stagesFailed).toBe(1);
    expect(codex.gates).toEqual({ passed:1, rejected:1 });

    expect(cursor.costState).toBe("not_measured");
    expect(cursor.tokens).toBeNull();
    expect(cursor.costUsd).toBeNull();
    expect(cursor.costNote).toContain("acp-cursor reports no token usage");

    expect(report.summary).toMatchObject({ attempts:2, measured:1, partial:0, notMeasured:1, notMeasuredByProvider:{ "acp-cursor":1 } });
    expect(report.summary.measuredCostUsd).toBeCloseTo(0.114, 6);
    const text = renderAttemptMetrics(report);
    expect(text).toContain("cost not measured [not_measured]");
    expect(text).toContain("not measured by provider: acp-cursor 1".replace("not", "Not"));
    expect(text).not.toMatch(/cost \$0(\.0+)? \[not_measured\]/);
  });

  it("is not_measured when there is no cursor row or no writer thread, and the total over nothing measured is null", () => {
    const w = world();
    const at = NOW - 1000;
    w.task("t1"); w.task("t2");
    w.attempt("a1", "t1", 1, "spawn_rejected", null, at);
    w.attempt("a2", "t2", 1, "accepted", "thr_unseen", at);
    const report = attemptMetrics(w.db as never, { projectId:"proj", days:1, now:NOW });
    expect(report.attempts.map((row) => row.costState)).toEqual(["not_measured", "not_measured"]);
    expect(report.summary.measuredCostUsd).toBeNull();
    expect(report.summary.measuredTokens).toBeNull();
    expect(report.summary.notMeasuredByProvider).toEqual({ "no writer thread":1, "no usage row":1 });
  });

  it("is partial when the model has no price, and when a later attempt of the task shares the thread (its tokens are counted there)", () => {
    const w = world();
    const at = NOW - 100_000;
    w.task("unpriced"); w.task("sticky");
    w.attempt("u1", "unpriced", 1, "accepted", "thr_u", at);
    w.cursor("thr_u", "opencode", "some-new-model", { input:10, output:5, cached:0, total:15, cacheRead:0, cacheWrite:0 });
    w.attempt("s1", "sticky", 1, "validation_failed", "thr_s", at);
    w.attempt("s2", "sticky", 2, "accepted", "thr_s", at + 10_000);
    w.cursor("thr_s", "claude-code", "claude-sonnet-5-5", { input:100, output:50, cached:0, total:150, cacheRead:0, cacheWrite:0 });
    const rows = new Map(attemptMetrics(w.db as never, { projectId:"proj", days:1, now:NOW }).attempts.map((row) => [row.attemptId, row]));
    expect(rows.get("u1")).toMatchObject({ costState:"partial", costUsd:null, tokens:{ total:15 } });
    expect(rows.get("u1")!.costNote).toContain("not in the price table");
    expect(rows.get("s1")).toMatchObject({ costState:"partial", tokens:null, costUsd:null });
    expect(rows.get("s2")).toMatchObject({ costState:"measured" });
    expect(rows.get("s2")!.costUsd).toBeGreaterThan(0);
  });

  it("gives the helper stages before the first attempt to that attempt, and later stages to the attempt they happened in", () => {
    const w = world();
    const at = NOW - 500_000;
    w.task("t");
    w.attempt("a1", "t", 1, "validation_failed", "thr", at);
    w.attempt("a2", "t", 2, "accepted", "thr", at + 100_000);
    w.stage("t", "plan-critique", "running", at - 5000); w.stage("t", "plan-critique", "passed", at - 1000);
    w.stage("t", "verification", "running", at + 10_000); w.stage("t", "verification", "failed", at + 20_000);
    w.stage("t", "verification", "running", at + 110_000); w.stage("t", "verification", "passed", at + 111_000);
    const rows = new Map(attemptMetrics(w.db as never, { projectId:"proj", days:1, now:NOW }).attempts.map((row) => [row.attemptId, row]));
    expect(rows.get("a1")!.stages.map((row) => `${row.stageId}:${row.state}`)).toEqual(["plan-critique:passed", "verification:failed"]);
    expect(rows.get("a2")!.stages.map((row) => `${row.stageId}:${row.state}:${row.seconds}`)).toEqual(["verification:passed:1"]);
  });

  it("is wired as an RPC and a CLI command", async () => {
    const { rpcContract } = await import("../src/rooms/contracts");
    expect(Object.keys(rpcContract)).toContain("lp_attempt_metrics");
  });
});

  it("records the writer tier and reports first attempts by tier", () => {
    const w = world();
    const at = NOW - 3_600_000;
    w.task("t1"); w.task("t2"); w.task("t3");
    w.attempt("a1", "t1", 1, "accepted", "thr_a", at);
    w.attempt("a2", "t1", 2, "accepted", "thr_a", at + 1);
    w.attempt("a3", "t2", 1, "blocked", "thr_b", at);
    w.attempt("a4", "t3", 1, "accepted", "thr_c", at);
    w.cursor("thr_a", "codex", "gpt-6-astra", { input:0, output:0, cached:0, total:0, cacheRead:0, cacheWrite:0 });
    w.cursor("thr_b", "acp-cursor", "composer-2.5", { input:0, output:0, cached:0, total:0, cacheRead:0, cacheWrite:0 });
    // no cursor for thr_c: model unknown -> tier null
    const report = attemptMetrics(w.db as never, { projectId:"proj", days:1, now:NOW });
    const byId = new Map(report.attempts.map((row) => [row.attemptId, row]));
    expect(byId.get("a1")!.writer.tier).toBe("strong");
    expect(byId.get("a3")!.writer.tier).toBe("standard");
    expect(byId.get("a4")!.writer.tier).toBe(null);
    expect(report.summary.firstByTier).toMatchObject({ strong: { first:1, accepted:1 }, standard: { first:1, accepted:0 }, unknown: { first:1, accepted:1 } });
    expect(renderAttemptMetrics(report)).toContain("strong 1/1 accepted");
  });
