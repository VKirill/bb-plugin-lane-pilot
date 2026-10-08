import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { acceptanceStats, failureCause } from "../src/rooms/runs/acceptance-stats";
import { createRun, openDatabase } from "../src/rooms/storage/database";

it("maps a failed attempt to the plan's coarse cause buckets", () => {
  expect(failureCause("validation_failed", "missing expected_outputs: src/x.ts")).toBe("outputs_empty");
  expect(failureCause("task", "output_unowned: src/x.ts")).toBe("outputs_empty");
  expect(failureCause("task", "dirt: pre-existing dirty files in src/")).toBe("ownership_dirt");
  expect(failureCause("blocked", "needs_human: PM must decide")).toBe("needs_human");
  expect(failureCause("task", "merge_conflict: main changed since this attempt started")).toBe("merge");
  expect(failureCause("provider_error", "writer_provider_limit: no credits")).toBe("provider_limit");
  expect(failureCause("task", "spawn failed: no host available")).toBe("harness");
  expect(failureCause("validation_failed", "verification failed: tests/red")).toBe("verification");
  expect(failureCause("blocked", "plan critique: the plan misses a boundary")).toBe("other");
});

it("aggregates first-try acceptance, redispatches and causes per project and ISO week from a seeded DB", () => {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  const now = Date.now();
  createRun(db, "run", "proj", "cli", "/repo");
  createRun(db, "run2", "proj2", "cli", "/repo2");
  let id = 0;
  const task = (runId:string, taskId:string, at:number) =>
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,?,'bb','{}',?)").run(taskId, runId, at);
  const attempt = (runId:string, taskId:string, state:string, reason:string | null, at:number) =>
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,attempt_no,reason,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?)")
      .run(`a${id++}`, runId, taskId, state, reason, at, at);
  const at = now - 3_600_000; // inside the window, same ISO week for every seeded task
  // A: accepted on the first try.
  attempt("run", "A", "accepted", null, at);
  // B: failed once on outputs, accepted on the second attempt.
  attempt("run", "B", "validation_failed", "missing expected_outputs: src/x.ts", at);
  attempt("run", "B", "accepted", null, at + 1000);
  // B.2: a redispatch of the B family, accepted first try.
  attempt("run", "B.2", "accepted", null, at);
  // C: never accepted; died on ownership/dirt.
  attempt("run", "C", "blocked", "dirt: pre-existing dirty files in src/", at);
  // D: provider/limit then needs_human, never accepted.
  attempt("run", "D", "provider_error", "writer_provider_limit: no credits", at);
  attempt("run", "D", "blocked", "needs_human: PM must decide", at + 1000);
  // A queued attempt is neither a failure nor an outcome.
  attempt("run", "A", "queued", null, at + 2000);
  // E is outside the 28-day window.
  attempt("run", "E", "accepted", null, now - 40 * 86_400_000);
  // Another project shows up only in the all-projects call.
  attempt("run2", "F", "accepted", null, at);

  const stats = acceptanceStats(db as never, 28, "proj");
  expect(stats.days).toBe(28);
  expect(stats.projects.map((row) => row.projectId)).toEqual(["proj"]);
  expect(stats.totals).toEqual({
    dispatched:5, firstTryAccepted:2, eventuallyAccepted:3,
    attempts:7, attemptsPerAccepted:1.3,
    redispatched:1, families:1,
    causes:{ outputs_empty:1, ownership_dirt:1, provider_limit:1, needs_human:1 },
  });
  expect(stats.projects[0]!.weeks).toHaveLength(1);
  const week = stats.projects[0]!.weeks[0]!;
  expect(week.week).toMatch(/^\d{4}-W\d{2}$/);
  expect(week).toMatchObject({ dispatched:5, firstTryAccepted:2, eventuallyAccepted:3, attempts:7, redispatched:1, families:1 });
  expect(week).toEqual({ week:week.week, ...stats.totals });

  const all = acceptanceStats(db as never, 28);
  expect(all.projects.map((row) => row.projectId)).toEqual(["proj", "proj2"]);
  expect(all.totals.dispatched).toBe(6);
  expect(all.totals.firstTryAccepted).toBe(3);
  expect(all.totals.causes).toEqual({ outputs_empty:1, ownership_dirt:1, provider_limit:1, needs_human:1 });
});
