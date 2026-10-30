import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/storage/database";
import { classifyFailure } from "../../src/rooms/runs/failure-class";
import { judgedFailureClass } from "../../src/rooms/runs/failure-class-model";
import { failureClassJudgment } from "../../src/rooms/runs/failure-class-judgment";
import { createJev } from "@lane-pilot/jev";
import type { JevClient } from "@lane-pilot/jev";

// J-4: a reason the regular expressions have no confident match for goes to Jev; `shadow` records, `active` acts, the rules' class is the fallback.
const UNKNOWN = "ssh: connect to host 10.8.0.1 port 22: Operation timed out while syncing the worktree";

function setup(top: string, p: number) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const asked: unknown[] = [];
  const client: JevClient = {
    breaker: () => ({ open: false, failures: 0 }),
    async call(request) {
      asked.push(request.state);
      const rest = (1 - p) / 5;
      const probabilities = Object.fromEntries(["task", "provider", "harness", "infra", "merge", "contract"].map((name) => [name, name === top ? p : rest]));
      return { ok: true, model: "jev-test", usage: { input_tokens: 500, output_tokens: 20 }, latencyMs: 80, attempts: 1,
        answers: { [Object.keys(request.questions)[0]!]: { type: "choice", choice: top, probabilities, confidence: 0.9 } } };
    },
  };
  const jev = createJev({ client, db });
  const deps = (modes: string) => ({ jev: () => jev, settings: async () => ({ "jev.modes": `failure.class=${modes}` }), projectId: "proj", runId: "run" });
  return { db, asked, deps };
}

describe("failureClass: which reasons the rules are sure of", () => {
  it("is confident for every reason Lane Pilot writes and for a red check, and not for a message nobody has seen", () => {
    expect(classifyFailure("blocked", "internal_error: boom")).toEqual({ cls: "harness", confident: true });
    expect(classifyFailure("validation_failed", "verification failed (npm test): 2 failed")).toEqual({ cls: "task", confident: true });
    expect(classifyFailure("validation_failed", "writer changed paths outside owns_paths: src/a.ts")).toEqual({ cls: "task", confident: true });
    expect(classifyFailure("timeout", "wait timeout")).toEqual({ cls: "provider", confident: true });
    expect(classifyFailure("validation_failed", UNKNOWN)).toEqual({ cls: "task", confident: false });
  });
});

describe("J-4 failure.class", () => {
  it("takes a clear class and falls back to task otherwise", () => {
    const answers = (top: string, p: number) => ({ side: { type: "choice" as const, choice: top, confidence: 0.9, probabilities: { [top]: p, task: 1 - p } } });
    const t = { min_p: 0.7, min_margin: 0.3 };
    expect(failureClassJudgment.decide(answers("infra", 0.9), t, { state: "x", reason: "y" })).toEqual({ decision: { cls: "infra", mast: "external:machine" } });
    expect(failureClassJudgment.decide(answers("infra", 0.6), t, { state: "x", reason: "y" })).toEqual({ decision: { cls: "task", mast: "verification:incomplete_work" } });
    expect(failureClassJudgment.fallback({ state: "x", reason: "y" })).toEqual({ cls: "task", mast: "verification:incomplete_work" });
  });

  it("never asks about a reason the rules are sure of", async () => {
    const { asked, deps } = setup("infra", 0.95);
    expect(await judgedFailureClass(deps("active"), "blocked", "internal_error: boom")).toBe("harness");
    expect(await judgedFailureClass(deps("active"), "validation_failed", "verification failed (npm test): 2 failed")).toBe("task");
    expect(asked).toEqual([]);
  });

  it("shadow (the default for a new judgment): asks, records, and the rules' class stays", async () => {
    const { db, asked, deps } = setup("infra", 0.95);
    expect(await judgedFailureClass(deps("shadow"), "validation_failed", UNKNOWN, "T1")).toBe("task");
    expect(asked).toHaveLength(1);
    const receipt = db.prepare("SELECT judgment, mode, decided_by, decision, subject FROM lane_pilot_jev_receipt").get() as Record<string, unknown>;
    expect(receipt).toMatchObject({ judgment: "failure.class", mode: "shadow", decided_by: "fallback", subject: "T1" });
    expect(String(receipt.decision)).toBe("infra");
  });

  it("is shadow when the project sets nothing", async () => {
    const { db, deps } = setup("infra", 0.95);
    const none = { ...deps("shadow"), settings: async () => ({}) };
    expect(await judgedFailureClass(none, "validation_failed", UNKNOWN)).toBe("task");
    expect((db.prepare("SELECT mode FROM lane_pilot_jev_receipt").get() as { mode: string }).mode).toBe("shadow");
  });

  it("active: Jev's clear class is used; an unclear one is the rules' task", async () => {
    const clear = setup("infra", 0.95);
    expect(await judgedFailureClass(clear.deps("active"), "validation_failed", UNKNOWN)).toBe("infra");
    const unclear = setup("infra", 0.45);
    expect(await judgedFailureClass(unclear.deps("active"), "validation_failed", UNKNOWN)).toBe("task");
  });

  it("off, or no Jev at all, is the rules' class and asks nothing", async () => {
    const { asked, deps } = setup("infra", 0.95);
    expect(await judgedFailureClass(deps("off"), "validation_failed", UNKNOWN)).toBe("task");
    expect(await judgedFailureClass({ ...deps("active"), jev: () => null }, "validation_failed", UNKNOWN)).toBe("task");
    expect(asked).toEqual([]);
  });
});

describe("failure.class outcome labels", () => {
  it("the run's terminal state labels the receipt: accepted agrees, a dead run confirms only a task reading", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../../src/rooms/storage/database");
    const { insertReceipt, recordOutcome } = await import("@lane-pilot/jev");
    const { sweepFailureClassOutcomes } = await import("../../src/rooms/runs/failure-class-model");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb), now = Date.now();
    const run = (id: string, state: string) => db.prepare("INSERT INTO lane_pilot_run (id, project_id, pm_thread_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, "p", "pm", state, now, now);
    const receipt = (runId: string, decision: string) => insertReceipt(db, { judgment: "failure.class", version: 1, mode: "shadow", projectId: "p", runId, subject: "T", inputSha256: `h${runId}${decision}`, inputChars: 1, questions: 1, status: "ok", decision, decidedBy: "fallback", at: now });
    run("r_ok", "accepted"); run("r_dead_task", "blocked"); run("r_dead_env", "blocked"); run("r_live", "running");
    const a = receipt("r_ok", "provider"), b = receipt("r_dead_task", "task"), c = receipt("r_dead_env", "infra"), d = receipt("r_live", "provider");
    expect(sweepFailureClassOutcomes(db)).toBe(3);
    const outcome = (id: number) => (db.prepare("SELECT outcome FROM lane_pilot_jev_receipt WHERE id=?").get(id) as { outcome: string | null }).outcome;
    expect([outcome(a), outcome(b), outcome(c), outcome(d)]).toEqual(["agree", "agree", "disagree", null]);
    expect(sweepFailureClassOutcomes(db)).toBe(0);
  });
});

describe("invoice.check outcome labels", () => {
  it("the owner's decision labels the receipt: a sent match agrees, a stopped run denies a match", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../../src/rooms/storage/database");
    const { insertReceipt } = await import("@lane-pilot/jev");
    const { sweepInvoiceCheckOutcomes } = await import("../../src/rooms/runs/failure-class-model");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb), now = Date.now();
    const run = (id: string, state: string) => db.prepare("INSERT INTO lane_pilot_run (id, project_id, pm_thread_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, "p", "pm", state, now, now);
    const receipt = (runId: string, decision: string) => insertReceipt(db, { judgment: "invoice.check", version: 1, mode: "active", projectId: "p", runId, subject: "invoice", inputSha256: `i${runId}${decision}`, inputChars: 1, questions: 2, status: "ok", decision, decidedBy: "jev", at: now });
    run("i_sent", "accepted"); run("i_wrong", "accepted"); run("i_held", "blocked"); run("i_live", "running");
    const a = receipt("i_sent", "match"), b = receipt("i_wrong", "mismatch"), c = receipt("i_held", "unsure"), d = receipt("i_live", "match");
    expect(sweepInvoiceCheckOutcomes(db)).toBe(3);
    const outcome = (id: number) => (db.prepare("SELECT outcome FROM lane_pilot_jev_receipt WHERE id=?").get(id) as { outcome: string | null }).outcome;
    expect([outcome(a), outcome(b), outcome(c), outcome(d)]).toEqual(["agree", "disagree", "agree", null]);
  });
});

describe("route.workflow outcome labels", () => {
  it("a confident pick is labeled by the graph it started: terminal success agrees, failure or a reroute disagrees", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../../src/rooms/storage/database");
    const { insertReceipt } = await import("@lane-pilot/jev");
    const { sweepRouteWorkflowOutcomes } = await import("../../src/rooms/runs/failure-class-model");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb), now = Date.now();
    const receipt = (runId: string, decision: string) => insertReceipt(db, { judgment: "route.workflow", version: 3, mode: "active", projectId: "p", runId, subject: "route", inputSha256: `r${runId}${decision}`, inputChars: 1, questions: 2, status: "ok", decision, decidedBy: "jev", at: now });
    const wfrun = (link: string, wf: string, status: string) => db.prepare("INSERT INTO lane_pilot_wf_run (id, workflow_id, workflow_version, workflow_sha256, definition_json, link_run_id, status, inputs_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(`wf_${link}_${wf}`, wf, 1, "sha", "{}", link, status, "{}", now + 60_000, now + 60_000);
    const escalated = insertReceipt(db, { judgment: "route.workflow", version: 3, mode: "active", projectId: "p", runId: "pm_esc", subject: "route", inputSha256: "esc", inputChars: 1, questions: 2, status: "ok", decision: "x", decidedBy: "escalated", at: now });
    wfrun("pm_ok", "issue-quick", "succeeded"); wfrun("pm_fail", "review-fix", "failed"); wfrun("pm_reroute", "other-graph", "succeeded");
    const a = receipt("pm_ok", "issue-quick (82)"), b = receipt("pm_fail", "review-fix (75)"), c = receipt("pm_reroute", "issue-quick (70)");
    expect(sweepRouteWorkflowOutcomes(db)).toBe(3);
    const outcome = (id: number) => (db.prepare("SELECT outcome FROM lane_pilot_jev_receipt WHERE id=?").get(id) as { outcome: string | null }).outcome;
    expect([outcome(a), outcome(b), outcome(c), outcome(escalated)]).toEqual(["agree", "disagree", "disagree", null]);
  });
});

describe("plan.fact outcome labels", () => {
  it("an accepted task labels the shadow read: matching items agree, a differing item disagrees", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../../src/rooms/storage/database");
    const { insertReceipt } = await import("@lane-pilot/jev");
    const { sweepPlanFactOutcomes } = await import("../../src/rooms/runs/failure-class-model");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb), now = Date.now();
    const run = (id: string) => db.prepare("INSERT INTO lane_pilot_run (id, project_id, pm_thread_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, "p", "pm", "accepted", now, now);
    const task = (id: string, runId: string) => db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES (?,?,?,?,?)").run(id, runId, "bb", "{}", now);
    const attempt = (id: string, runId: string, taskId: string) => db.prepare("INSERT INTO lane_pilot_attempt (id, run_id, task_id, state, created_at, updated_at) VALUES (?,?,?,?,?,?)").run(id, runId, taskId, "accepted", now, now);
    const stage = (runId: string, taskId: string, jev: Record<string, string>) => db.prepare("INSERT INTO lane_pilot_stage_receipt (run_id, task_id, stage_id, contract_version, state, input_sha256, attempt, result_json, updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(runId, taskId, "plan-fact", 1, "passed", "sha", 0, JSON.stringify({ items: [{ item: 1, verdict: "proven" }, { item: 2, verdict: "unproven" }], jev }), now);
    const receipt = (runId: string, subject: string) => insertReceipt(db, { judgment: "plan.fact", version: 1, mode: "shadow", projectId: "p", runId, subject, inputSha256: `pf${runId}${subject}`, inputChars: 1, questions: 2, status: "ok", decision: "done:1", decidedBy: "fallback", at: now });
    run("pr_a"); task("pt_a", "pr_a"); attempt("pa_a", "pr_a", "pt_a"); stage("pr_a", "pt_a", { "1": "done", "2": "not_done" });
    run("pr_b"); task("pt_b", "pr_b"); attempt("pa_b", "pr_b", "pt_b"); stage("pr_b", "pt_b", { "1": "not_done", "2": "unseen" });
    const a = receipt("pr_a", "pt_a"), b = receipt("pr_b", "pt_b");
    expect(sweepPlanFactOutcomes(db)).toBe(2);
    const outcome = (id: number) => (db.prepare("SELECT outcome FROM lane_pilot_jev_receipt WHERE id=?").get(id) as { outcome: string | null }).outcome;
    expect([outcome(a), outcome(b)]).toEqual(["agree", "disagree"]);
  });
});
