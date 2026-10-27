import { describe, expect, it } from "vitest";
import { collectEntries, graphRecurrence, listClasses, refreshClasses, writeEntries } from "../../src/rooms/wall/journal";
import { buildClassPack } from "../../src/rooms/wall/pack";
import { selectClasses } from "../../src/rooms/wall/select";
import { originOf, wfSignature } from "../../src/rooms/wall/signature";
import { DAY, HOUR, NOW, freshDb, isReal } from "./helpers";

/** A graph run row, the way the engine's journal leaves it. */
function wfRuns() {
  const { db } = freshDb();
  let n = 0;
  const insert = db.prepare(`INSERT INTO lane_pilot_wf_run (id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_task_id,parent_run_id,status,reason,harness_version,created_at,updated_at)
    VALUES (?,?,1,'x','{}',?,?,?,?,?,?,?,?)`);
  const run = (workflowId: string, status: string, reason: string | null, at: number, options: { project?: string; task?: string | null; parent?: string; id?: string } = {}) => {
    const id = options.id ?? `wfrun_${++n}`;
    insert.run(id, workflowId, options.project ?? "proj_real", options.task ?? null, options.parent ?? null, status, reason, "0.1.340", at, at);
    return id;
  };
  return { db, run };
}
const window = { since: NOW - DAY, until: NOW };

describe("the signature of a graph failure", () => {
  it("is the workflow and what stopped it, from the reason's prefix", () => {
    const a = wfSignature("web-research", "blocked", "budget_exceeded:cost");
    const b = wfSignature("web-research", "blocked", "budget_exceeded:cost");
    expect(a.classKey).toBe(b.classKey);
    expect(a.failureClass).toBe("workflow");
    expect(a.reasonNorm).toBe("web-research blocked: budget_exceeded:cost");
    expect(wfSignature("web-research", "blocked", "budget_exceeded:tokens").classKey).not.toBe(a.classKey);
    expect(wfSignature("insights-post", "failed", "output_invalid").reasonNorm).toBe("insights-post failed: output_invalid");
    // The node of a failed step is part of the class; the message after the prefix is not.
    const s1 = wfSignature("insights-post", "failed", "step_failed:fetch (HTTP 502 from the page)");
    const s2 = wfSignature("insights-post", "failed", "step_failed:fetch (timeout)");
    expect(s1.classKey).toBe(s2.classKey);
    expect(s1.reasonNorm).toBe("insights-post failed: step_failed:fetch");
    expect(wfSignature("insights-post", "failed", "step_failed:analyze").classKey).not.toBe(s1.classKey);
    expect(wfSignature("x", "interrupted", null).reasonNorm).toBe("x interrupted: interrupted");
  });

  it("is on Lane Pilot's side", () => {
    expect(originOf("workflow", null)).toBe("harness");
  });
});

describe("the journal reads graph failures", () => {
  it("counts failed, blocked and interrupted runs by class, leaving out sandbox, succeeded, the task pipeline and a run whose child failed", () => {
    const { db, run } = wfRuns();
    for (let i = 0; i < 3; i += 1) run("web-research", "blocked", "budget_exceeded:cost", NOW - (i + 1) * HOUR);
    for (let i = 0; i < 5; i += 1) run("insights-post", "failed", "output_invalid", NOW - (i + 1) * HOUR);
    run("insights-post", "interrupted", null, NOW - 2 * HOUR);
    run("web-research", "blocked", "budget_exceeded:cost", NOW - HOUR, { project: "proj_sand" });
    run("web-research", "succeeded", null, NOW - HOUR);
    run("lp-task-pipeline", "failed", "step_failed:writer", NOW - HOUR);
    // The wall's own machinery: a failed repair or hunt must not open a class whose repair is another repair.
    for (let i = 0; i < 3; i += 1) run("lp.self-repair", "failed", "step_failed:repair", NOW - (i + 1) * HOUR);
    for (let i = 0; i < 3; i += 1) run("lp.wall-hunt", "failed", "step_failed:judge", NOW - (i + 1) * HOUR);
    run("web-research", "blocked", "budget_exceeded:cost", NOW - 2 * DAY);
    // A parent and the child that failed it are one failure, named by the child.
    const parent = run("analyze-plan-execute", "failed", "step_failed:build", NOW - HOUR);
    run("lp.build", "failed", "output_invalid", NOW - HOUR, { parent });

    const entries = collectEntries(db, { ...window, isReal });
    const byReason = Object.fromEntries(entries.filter((entry) => entry.failureClass === "workflow").map((entry) => [entry.reasonNorm, entry]));
    expect(byReason["web-research blocked: budget_exceeded:cost"]).toMatchObject({ n: 3, origin: "harness", projectId: "proj_real", version: "0.1.340" });
    expect(byReason["web-research blocked: budget_exceeded:cost"]!.sources.wf).toBe(3);
    expect(byReason["insights-post failed: output_invalid"]!.n).toBe(5);
    expect(byReason["insights-post interrupted: interrupted"]!.n).toBe(1);
    expect(byReason["lp.build failed: output_invalid"]!.n).toBe(1);
    expect(Object.keys(byReason).some((reason) => reason.startsWith("lp-task-pipeline") || reason.startsWith("analyze-plan-execute") || reason.startsWith("lp.self-repair") || reason.startsWith("lp.wall-hunt"))).toBe(false);
    expect(entries.some((entry) => entry.projectId === "proj_sand")).toBe(false);
    expect(byReason["insights-post failed: output_invalid"]!.samples[0]).toMatch(/^wf:wfrun_/);
  });

  it("a workflow that failed the same way twice in a week is an open class the night picks; one failure is watched", () => {
    const { db, run } = wfRuns();
    run("web-research", "blocked", "budget_exceeded:cost", NOW - 3 * HOUR);
    run("web-research", "blocked", "budget_exceeded:cost", NOW - 2 * HOUR);
    run("insights-post", "failed", "output_invalid", NOW - HOUR);
    writeEntries(db, collectEntries(db, { ...window, isReal }), NOW);
    const classes = refreshClasses(db, { now: NOW, isReal });
    const web = classes.find((row) => row.reasonNorm === "web-research blocked: budget_exceeded:cost")!;
    const once = classes.find((row) => row.reasonNorm === "insights-post failed: output_invalid")!;
    expect(web).toMatchObject({ failureClass: "workflow", state: "open", origin: "harness", recur1: 2, recur7: 2 });
    expect(once).toMatchObject({ state: "closed", recur1: 1 });
    expect(listClasses(db, { state: "open" }).map((row) => row.classKey)).toContain(web.classKey);

    const selection = selectClasses({ classes, max: 3, walks: 3, recurrenceFloor: 3, openRepair: new Set(), roundsTonight: new Map(), roundsPerNight: 1, tokensLeft: 10_000_000, roundCost: 1000 });
    expect(selection.picked.map((row) => row.classKey)).toEqual([web.classKey]);
    expect(selection.morning.map((row) => row.classKey)).toContain(once.classKey);
  });

  it("the evidence pack of a graph class carries the failed runs and their step as facts", () => {
    const { db, run } = wfRuns();
    const id = run("insights-post", "failed", "output_invalid", NOW - HOUR);
    db.prepare("INSERT INTO lane_pilot_wf_step (run_id,step_key,origin,node_id,visit,state,error,updated_at) VALUES (?,?,?,?,1,'failed','the model returned prose',?)").run(id, "post:1", "o", "post", NOW);
    writeEntries(db, collectEntries(db, { ...window, isReal }), NOW);
    const key = refreshClasses(db, { now: NOW, isReal })[0]!.classKey;
    const pack = buildClassPack(db, key);
    expect(pack.attempts).toEqual([]);
    expect(pack.facts.join("\n")).toContain(`graph run ${id}: insights-post failed, reason output_invalid, step post: the model returned prose`);
  });

  it("a repair of a graph class is judged on the runs of that workflow under the shipped version, not on writer attempts", () => {
    const { db, run } = wfRuns();
    run("web-research", "blocked", "budget_exceeded:cost", NOW - 3 * HOUR);
    run("web-research", "blocked", "budget_exceeded:cost", NOW - 2 * HOUR);
    writeEntries(db, collectEntries(db, { ...window, isReal }), NOW);
    const key = refreshClasses(db, { now: NOW, isReal }).find((row) => row.failureClass === "workflow")!.classKey;
    // Runs of the new version: two ended fine, one failed the same way, one failed otherwise; a run of another workflow and a running one are not exposure.
    const later = db.prepare("UPDATE lane_pilot_wf_run SET harness_version='0.1.341' WHERE id=?");
    for (const [status, reason, workflow] of [["succeeded", null, "web-research"], ["succeeded", null, "web-research"], ["blocked", "budget_exceeded:cost", "web-research"], ["failed", "output_invalid", "web-research"], ["failed", "output_invalid", "insights-post"], ["running", null, "web-research"]] as const) {
      later.run(run(workflow, status, reason, NOW + HOUR));
    }
    expect(graphRecurrence(db, key, "0.1.341", NOW)).toEqual({ failures: 1, attempts: 4, exposed: true });
    expect(graphRecurrence(db, key, "0.1.399", NOW)).toBeNull();
    // A class made of writer attempts is not a graph class: the caller measures it on attempts.
    expect(graphRecurrence(db, "harness:abcdef", "0.1.341", NOW)).toBeUndefined();
  });
});
