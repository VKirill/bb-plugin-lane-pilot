import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/storage/database";
import { errandOutcome, errandTitle, kindsOverview, listErrands } from "../../src/rooms/errands/logic";

const NOW = Date.now();
type Seed = { id: string; status: string; reason?: string | null; inputs: Record<string, unknown>; output?: Record<string, unknown> | null; cost?: number; linkRunId?: string | null; ago?: number; thread?: string };

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const seed = (run: Seed) => {
    const at = NOW - (run.ago ?? 60_000);
    db.prepare(`INSERT INTO lane_pilot_wf_run (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, link_run_id, status, reason, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
      VALUES (?, 'errand', 1, 'sha', '{}', 'proj_e', ?, ?, ?, ?, ?, 1000, ?, ?, ?)`)
      .run(run.id, run.linkRunId ?? null, run.status, run.reason ?? null, JSON.stringify(run.inputs), run.output ? JSON.stringify(run.output) : null, Math.round((run.cost ?? 0) * 1e6), at, at + 30_000);
    if (run.thread) db.prepare("INSERT INTO lane_pilot_wf_effect (id, run_id, step_key, effect_key, kind, state, result_json, created_at, updated_at) VALUES (?, ?, 'work', 'spawn', 'errand.spawn', 'done', ?, ?, ?)")
      .run(`eff_${run.id}`, run.id, JSON.stringify({ threadId: run.thread, browserMachine: null }), at, at);
  };
  return { db, seed };
}

describe("the Errands page: the read model over errand runs", () => {
  it("maps a run to the owner's five outcomes; a helper the owner stopped is cancelled, not failed", () => {
    expect(errandOutcome("running", null, null).outcome).toBe("running");
    expect(errandOutcome("succeeded", { state: "done" }, null).outcome).toBe("done");
    expect(errandOutcome("succeeded", { state: "blocked", reason: "needs the owner's login" }, null)).toMatchObject({ outcome: "blocked", reason: "needs the owner's login" });
    expect(errandOutcome("succeeded", { state: "blocked", reason: "canceled by owner" }, null).outcome).toBe("canceled");
    expect(errandOutcome("failed", null, "step_failed:work")).toMatchObject({ outcome: "failed", reason: "step_failed:work" });
    expect(errandOutcome("canceled", null, "stopped").outcome).toBe("canceled");
  });

  it("names an errand by its title, else by the first line of the brief after a schedule's preamble", () => {
    expect(errandTitle({ title: " Record the Studio screen " })).toBe("Record the Studio screen");
    expect(errandTitle({ title: "", task: "This is a scheduled run of «X» (2026-11-01). Nobody is watching it live.\nIf the task needs a decision, finish with ERRAND: blocked.\n\nOwner request (Kirill, PM chat thr_1): \"can we run Blender on a rented machine?\"" }))
      .toBe("can we run Blender on a rented machine?");
    expect(errandTitle({})).toBe("—");
  });

  it("lists the period's errands newest first with kind, model, outcome, source (PM chat or schedule), helper thread and cost, and filters by kind", () => {
    const { db, seed } = world();
    createRun(db, "lprun_pm", "proj_e", "cli");
    setRunThread(db, "lprun_pm", "thr_pm");
    seed({ id: "wf_1", status: "succeeded", inputs: { title: "Record the screen", task: "x", kind: "computer", kindBy: "hint", providerId: "claude-code", model: "claude-opus-5-5" }, output: { state: "done" }, cost: 0.44, linkRunId: "lprun_pm", thread: "thr_helper", ago: 10_000 });
    seed({ id: "wf_2", status: "succeeded", inputs: { title: "", task: "Owner request (K, PM chat thr_x): \"rent a GPU\"", kind: "", scheduleId: "sch_gone" }, output: { state: "blocked", reason: "canceled by owner" }, ago: 20_000 });
    seed({ id: "wf_3", status: "failed", reason: "step_failed:work", inputs: { title: "Answer the ticket", task: "x", kind: "message", kindBy: "pm", model: "glm-5.3-flash" }, ago: 30_000 });
    seed({ id: "wf_old", status: "succeeded", inputs: { title: "Old", task: "x", kind: "computer" }, output: { state: "done" }, ago: 40 * 86_400_000 });
    const rows = listErrands(db, { days: 7 });
    expect(rows.map((row) => row.id)).toEqual(["wf_1", "wf_2", "wf_3"]);
    expect(rows[0]).toMatchObject({ title: "Record the screen", kind: "computer", kindBy: "hint", model: "claude-opus-5-5", outcome: "done", source: { type: "pm", threadId: "thr_pm" }, threadId: "thr_helper", costUsd: 0.44 });
    expect(rows[1]).toMatchObject({ title: "rent a GPU", kind: "none", outcome: "canceled", source: { type: "schedule", name: "" }, threadId: null });
    expect(rows[2]).toMatchObject({ kind: "message", outcome: "failed", reason: "step_failed:work", source: { type: "other" } });
    expect(listErrands(db, { days: 7, kind: "computer" }).map((row) => row.id)).toEqual(["wf_1"]);
    expect(listErrands(db, { days: 7, kind: "none" }).map((row) => row.id)).toEqual(["wf_2"]);
    expect(listErrands(db, { days: 90 })).toHaveLength(4);
  });

  it("summarises every kind with the role row and the model in force (built-in defaults with no owner row) and the period's counts", () => {
    const { db, seed } = world();
    seed({ id: "wf_1", status: "succeeded", inputs: { title: "a", task: "x", kind: "computer" }, output: { state: "done" }, cost: 0.5 });
    seed({ id: "wf_2", status: "succeeded", inputs: { title: "b", task: "x", kind: "computer" }, output: { state: "blocked", reason: "no access" }, cost: 0.25 });
    seed({ id: "wf_3", status: "failed", reason: "boom", inputs: { title: "c", task: "x", kind: "" } });
    const kinds = kindsOverview(db, {}, 7);
    expect(kinds.map((row) => row.kind)).toEqual(["computer", "devops", "browser", "research", "message", "none"]);
    expect(kinds[0]).toMatchObject({ role: "errand-computer", model: "claude-opus-5-5", source: "default", runs: 2, done: 1, blocked: 1, failed: 0, costUsd: 0.75 });
    expect(kinds.find((row) => row.kind === "message")).toMatchObject({ role: "errand", runs: 0 });
    expect(kinds.find((row) => row.kind === "none")).toMatchObject({ role: "errand", runs: 1, failed: 1 });
  });
});
