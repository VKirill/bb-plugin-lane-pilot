import { describe, expect, it } from "vitest";
import { classifyFailure } from "../../src/rooms/contracts/failure-class";

const UNKNOWN = "ssh: connect to host 10.8.0.1 port 22: Operation timed out while syncing the worktree";

describe("failureClass: which reasons the rules are sure of", () => {
  it("is confident for every reason Lane Pilot writes and for a red check, and not for a message nobody has seen", () => {
    expect(classifyFailure("blocked", "internal_error: boom")).toEqual({ cls: "harness", confident: true });
    expect(classifyFailure("validation_failed", "verification failed (npm test): 2 failed")).toEqual({ cls: "task", confident: true });
    expect(classifyFailure("validation_failed", "writer changed paths outside owns_paths: src/a.ts")).toEqual({ cls: "task", confident: true });
    expect(classifyFailure("timeout", "wait timeout")).toEqual({ cls: "provider", confident: true });
    expect(classifyFailure("validation_failed", UNKNOWN)).toEqual({ cls: "task", confident: false });
  });
});

describe("invoice.check outcome labels", () => {
  it("the owner's decision labels the receipt: a sent match agrees, a stopped run denies a match", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../../src/rooms/plugin-db");
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
    const { openDatabase } = await import("../../src/rooms/plugin-db");
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
