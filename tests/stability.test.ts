import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { failureClass, failureFingerprint } from "../src/failure-class";
import { countAttempts, countChargedAttempts, createAttempt, createRun, openDatabase, transitionAttempt } from "../src/database";
import { createStability } from "../src/server/stability";

// Reasons copied from SelfyStudio attempts of 2026-10-03/04: each must land on the side that caused it.
describe("failure class of real reasons", () => {
  it.each([
    ["blocked", "attempt_worktree_holder_ambiguous:page_cap", "harness"],
    ["blocked", "reconcile_page_cap", "harness"],
    ["validation_failed", "merge_conflict: main changed since this attempt started: apps/a.vue", "merge"],
    ["blocked", "internal_error: Cannot read properties of undefined", "harness"],
    ["blocked", "ENOSPC: no space left on device, mkdir '/home/ubuntu/x'", "infra"],
    ["validation_failed", "missing expected_outputs: Manrope-ExtraBold.woff2", "contract"],
    ["blocked", "depends_on gc-section-shell-native: that task ended blocked", "contract"],
    ["blocked", "needs_human: which price applies?", "judgment"],
    ["blocked", "retry limit 2 exhausted: merge_conflict: main changed since this attempt started: ", "harness"],
    ["blocked", "merge_failed: git merge failed: fatal: Unable to create '/repo/.git/index.lock': File exists.", "infra"],
    ["empty_output", "writer returned no output", "provider"],
    ["validation_failed", "verification failed: npx vitest run greeting-card exited 1", "task"],
    ["validation_failed", "changed paths outside owns_paths: apps/api/x.ts", "task"],
  ])("%s %s → %s", (state, reason, klass) => {
    expect(failureClass(state, reason)).toBe(klass);
  });

  it("reads the same fault on different tasks the same", () => {
    expect(failureFingerprint("internal_error: lpattempt_7d5f2de7815747c9 thr_rg3ee4ifab /home/ubuntu/a/b.ts line 12"))
      .toBe(failureFingerprint("internal_error: lpattempt_aa11bb22cc33dd44 thr_zzzzzzzzzz /tmp/c.ts line 7"));
  });
});

function setup() {
  const sent:string[] = [];
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot", sdk:{ threads:{
    send:async (args:{ threadId:string }) => { sent.push(args.threadId); return {}; },
  } } as never });
  const db = openDatabase(bb);
  createRun(db, "run", "proj", "cli", "/repo");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='pm', writer_workspace_path='/repo' WHERE id='run'").run();
  for (const task of ["T1", "T2", "T3", "T4", "T1.2"]) db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,'run','bb','{}',1)").run(task);
  const resumed:string[] = [];
  const services = { activeWriterTasks:new Set<string>(),
    enqueueResumedWriter:async (_projectId:string, attempt:{ task_id:string }) => { resumed.push(attempt.task_id); return true; } };
  const { stability } = createStability({ bb, db, log:() => undefined } as never, services as never);
  return { bb, db, stability, resumed, sent };
}

describe("free retries", () => {
  it("does not charge a merge conflict, Lane Pilot's fault or the machine's", () => {
    const { db } = setup();
    for (const [id, reason] of [["a1", "merge_conflict: main changed since this attempt started: x"], ["a2", "reconcile_page_cap"], ["a3", "verification failed: exit 1"]] as const) {
      createAttempt(db, { id, runId:"run", taskId:"T1" });
      transitionAttempt(db, id, "spawn_requested");
      transitionAttempt(db, id, "running", { threadId:`thr_${id}` });
      transitionAttempt(db, id, "validation_failed", { reason });
    }
    expect(countAttempts(db, "run", "T1")).toBe(3);
    expect(countChargedAttempts(db, "run", "T1")).toBe(1);
  });
});

describe("parked tasks", () => {
  it("parks a task blocked by Lane Pilot's fault and restarts it once a newer Lane Pilot runs", async () => {
    const { bb, stability, resumed } = setup();
    expect(await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T1", pmThreadId:"pm", state:"blocked", reason:"reconcile_page_cap" }, 1000)).toBe(true);
    expect(await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T2", pmThreadId:"pm", state:"blocked", reason:"verification failed: exit 1" })).toBe(false);
    expect(await stability.sweep(2000)).toEqual([]); // same version: the fault is not fixed yet
    const parked = await stability.loadParked();
    await bb.storage.kv.set("stability:parked", parked.map((row) => ({ ...row, version:"0.0.1" })));
    expect(await stability.sweep(3000)).toEqual(["T1"]);
    expect(resumed).toEqual(["T1"]);
    expect(await stability.loadParked()).toEqual([]);
  });

  it("leaves a parked task alone once the PM sent it again", async () => {
    const { bb, db, stability, resumed } = setup();
    await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T1", pmThreadId:"pm", state:"blocked", reason:"internal_error: boom" }, 1000);
    await bb.storage.kv.set("stability:parked", (await stability.loadParked()).map((row) => ({ ...row, version:"0.0.1" })));
    createAttempt(db, { id:"redo", runId:"run", taskId:"T1.2" });
    db.prepare("UPDATE lane_pilot_attempt SET created_at=5000 WHERE id='redo'").run();
    expect(await stability.sweep(6000)).toEqual([]);
    expect(resumed).toEqual([]);
  });

  it("retries a machine fault after a backoff, at most three times", async () => {
    const { stability, resumed } = setup();
    await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T3", pmThreadId:"pm", state:"blocked", reason:"ENOSPC: no space left on device" }, 0);
    expect(await stability.sweep(60_000)).toEqual([]);
    expect(await stability.sweep(11 * 60_000)).toEqual(["T3"]);
    expect(resumed).toEqual(["T3"]);
  });
});

describe("breaker", () => {
  it("holds new writers after three tasks fail on the same fault, lets one probe through later", async () => {
    const { stability } = setup();
    for (const [task, n] of [["T1", 1], ["T2", 2]] as const) {
      await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:task, pmThreadId:"pm", state:"blocked", reason:`attempt_worktree_holder_ambiguous:page_cap lpattempt_${n}aaaaaaaaaaaa` }, n * 1000);
    }
    expect(stability.breakerHolds("proj", 3000)).toBeNull();
    await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T4", pmThreadId:"pm", state:"blocked", reason:"attempt_worktree_holder_ambiguous:page_cap lpattempt_3bbbbbbbbbbbb" }, 3000);
    expect(stability.breakerHolds("proj", 4000)).toContain("page_cap");
    expect(stability.breakerHolds("other", 4000)).toBeNull();
    expect(stability.breakerHolds("proj", 3000 + 31 * 60_000)).toBeNull(); // half-open: one task may try
    expect(stability.breakerHolds("proj", 3000 + 32 * 60_000)).toContain("page_cap");
  });
});

describe("adoption at start-up", () => {
  it("parks a task blocked by a Lane Pilot fault before parking existed, not one the PM sent again or a task's own failure", async () => {
    const { db, stability } = setup();
    const block = (id:string, task:string, reason:string, at:number) => {
      createAttempt(db, { id, runId:"run", taskId:task });
      transitionAttempt(db, id, "spawn_requested");
      transitionAttempt(db, id, "blocked", { reason });
      db.prepare("UPDATE lane_pilot_attempt SET created_at=?, updated_at=? WHERE id=?").run(at, at, id);
    };
    const now = Date.now();
    block("x1", "T1", "retry limit 2 exhausted: merge_conflict: main changed since this attempt started: ", now - 60_000);
    block("x2", "T2", "retry limit 2 exhausted: verification failed: exit 1", now - 60_000);
    block("x3", "T3", "attempt_worktree_holder_ambiguous:page_cap", now - 60_000);
    createAttempt(db, { id:"x4", runId:"run", taskId:"T1.2" }); // the PM already sent T1 again
    db.prepare("UPDATE lane_pilot_attempt SET created_at=? WHERE id='x4'").run(now - 1000);
    expect(await stability.adoptBlockedByFaults(now)).toEqual(["T3"]);
    expect((await stability.loadParked()).map((row) => row.taskId)).toEqual(["T3"]);
    expect(await stability.adoptBlockedByFaults(now)).toEqual([]);
  });
});

describe("restart reopens the writer stages", () => {
  // Live 2026-10-04: three restarted SelfyStudio tasks died on «illegal stage transition writer-agent: failed -> running».
  it("sets failed writer stages back to pending so the writer can run again", async () => {
    const { recordStage } = await import("../src/server/stage-records");
    const { listStageReceipts } = await import("../src/database");
    const { bb, db, stability } = setup();
    for (const state of ["pending", "running", "failed"] as const) recordStage(db, { runId:"run", taskId:"T1", stageId:"writer-agent", state, input:"plan" });
    await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T1", pmThreadId:"pm", state:"blocked", reason:"internal_error: x" }, 1000);
    await bb.storage.kv.set("stability:parked", (await stability.loadParked()).map((row) => ({ ...row, version:"0.0.1" })));
    expect(await stability.sweep(2000)).toEqual(["T1"]);
    expect(listStageReceipts(db, "run", "T1").find((row) => row.stageId === "writer-agent")?.state).toBe("pending");
    expect(() => recordStage(db, { runId:"run", taskId:"T1", stageId:"writer-agent", state:"running", input:"plan" })).not.toThrow();
  });
});

describe("superseded work is never restarted", () => {
  // Live 2026-10-04: «bot-preset-catalog-style-fallback-r3» (2 days old, replaced by an accepted «-r4») was adopted because
  // a cleanup had touched it the day before, and a restart would have redone work already in main.
  it("skips an old attempt and a task whose -rN or .N sibling was accepted or sent later", async () => {
    const { db, stability } = setup();
    const now = Date.now();
    for (const task of ["fix-r3", "fix-r4", "G1", "G1.2"]) db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,'run','bb','{}',1)").run(task);
    const attempt = (id:string, task:string, state:"blocked"|"accepted", reason:string, created:number, updated = created) => {
      createAttempt(db, { id, runId:"run", taskId:task });
      db.prepare("UPDATE lane_pilot_attempt SET state=?, reason=?, created_at=?, updated_at=? WHERE id=?").run(state, reason, created, updated, id);
    };
    attempt("o1", "fix-r3", "blocked", "internal_error: x", now - 2 * 86400_000, now - 3600_000); // old, touched recently
    attempt("o2", "fix-r4", "accepted", "", now - 86400_000 - 1);
    attempt("o3", "G1", "blocked", "internal_error: y", now - 3600_000);
    attempt("o4", "G1.2", "accepted", "", now - 7200_000); // accepted sibling, even earlier
    expect(await stability.adoptBlockedByFaults(now)).toEqual([]);
    const { taskStem } = await import("../src/server/stability");
    expect([taskStem("fix-r4"), taskStem("G1.12"), taskStem("plain")]).toEqual(["fix", "G1", "plain"]);
  });
});

describe("an owner's stop of a run", () => {
  it("keeps a halted run out of parking and restarts", async () => {
    const { setRunHalted } = await import("../src/server/runs-halt");
    const { bb, stability, resumed } = setup();
    await setRunHalted(bb.storage.kv as never, "run", true);
    expect(await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T1", pmThreadId:"pm", state:"blocked", reason:"internal_error: x" }, 1000)).toBe(false);
    await bb.storage.kv.set("stability:parked", [{ projectId:"proj", runId:"run", taskId:"T2", pmThreadId:"pm", klass:"harness", reason:"internal_error: y", fingerprint:"f", version:"0.0.1", at:1000, redrives:0 }]);
    expect(await stability.sweep(2000)).toEqual([]);
    expect(resumed).toEqual([]);
    // The stop dropped the run's parked tasks: sending work again starts only what the PM sends.
    expect(await stability.loadParked()).toEqual([]);
    await setRunHalted(bb.storage.kv as never, "run", false);
    expect(await stability.onTaskFailed({ projectId:"proj", runId:"run", taskId:"T1", pmThreadId:"pm", state:"blocked", reason:"internal_error: x" }, 4000)).toBe(true);
  });
});
