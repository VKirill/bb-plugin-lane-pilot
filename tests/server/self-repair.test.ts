import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/database";
import { createSelfRepair, isDue, logIncidents, parseVerdict, reasonSignature, repairPrompt, VERSION } from "../../src/server/self-repair";
import type { ServerCore } from "../../src/server/core";

function setup(threadStatus: Record<string, string> = {}, outputs: Record<string, string> = {}) {
  const spawns: Array<Record<string, unknown>> = [];
  const placed: unknown[] = [];
  let next = 0;
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      plugins: { callRpc: async (args: { method: string; input: unknown }) => { placed.push([args.method, args.input]); return { ok: true }; } },
      threads: {
        output: async ({ threadId }: { threadId: string }) => ({ output: outputs[threadId] ?? "" }) as never,
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: threadStatus[threadId] ?? "idle" }) as never,
        spawn: async (input: unknown) => {
          spawns.push(input as Record<string, unknown>);
          return { id: `thr_repair${++next}` } as never;
        },
      },
    } as never,
  });
  const db = openDatabase(bb);
  const ctx = { bb, db, log: () => undefined, isDisposed: () => false } as unknown as ServerCore;
  const now = Date.now();
  db.prepare("INSERT INTO lane_pilot_run (id,project_id,pm_thread_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("lprun_a", "proj_real", "thr_pm", "running", now, now);
  db.prepare("INSERT INTO lane_pilot_run (id,project_id,pm_thread_id,state,created_at,updated_at) VALUES (?,?,?,?,?,?)").run("lprun_s", "proj_3tb652jpsi", "thr_pm2", "running", now, now);
  const attempt = (id: string, run: string, state: string, reason: string | null, updatedAt = now, thread = `thr_w_${id}`) =>
    db.prepare("INSERT INTO lane_pilot_attempt (id,run_id,task_id,thread_id,state,reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)").run(id, run, `task-${id}`, thread, state, reason, updatedAt, updatedAt);
  const triage = (id: string, project: string, run: string, reason: string, origin = "orchestrator") =>
    db.prepare(`INSERT INTO lane_pilot_failure_triage (project_id,attempt_id,run_id,task_id,reason_sha256,reason,origin,status,failed_at,triaged_at)
      VALUES (?,?,?,?,?,?,?,'ok',?,?)`).run(project, id, run, `task-${id}`, "x", reason, origin, now, now);
  return { ctx, db, spawns, placed, attempt, triage, now };
}

describe("self-repair", () => {
  it("one problem in many tasks is one signature", () => {
    const a = reasonSignature("blocked", "internal_error: another writer integration holds the base checkout lpattempt_1a2b3c at /home/x/repo 12");
    const b = reasonSignature("blocked", "retry limit 3 exhausted: internal_error: another writer integration holds the base checkout lpattempt_9f9f9f at /tmp/other 40");
    expect(a).toBe(b);
    expect(reasonSignature("blocked", "merge_failed: conflict")).not.toBe(a);
    expect(reasonSignature("triage", "writer changed paths outside owns_paths: apps/bot/src/__tests__/a.test.ts"))
      .toBe(reasonSignature("triage", "writer changed paths outside owns_paths: packages/infra/b.test.ts"));
  });

  it("starts one Opus high repair thread in the Lane Pilot section for Lane Pilot's own fault, not for others", async () => {
    const { ctx, spawns, placed, attempt, triage } = setup();
    attempt("lpattempt_1", "lprun_a", "validation_failed", "cannot read writer-workspace git diff: host plugin calls are unavailable");
    triage("lpattempt_1", "proj_real", "lprun_a", "cannot read writer-workspace git diff: host plugin calls are unavailable");
    triage("lpattempt_2", "proj_real", "lprun_a", "tests failed in apps/web", "writer");
    attempt("lpattempt_3", "lprun_a", "blocked", "acceptance unmet: button missing");
    triage("lpattempt_4", "proj_3tb652jpsi", "lprun_s", "internal_error: sandbox drill");
    triage("lpattempt_5", "proj_real", "lprun_a", "depends_on gc-s7-checkout: that task ended blocked");
    const repair = createSelfRepair(ctx);
    const result = await repair.tick({ since: 0 });
    expect(result.incidents).toBe(1);
    expect(result.spawned).toBe("thr_repair1");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({
      projectId: "proj_ejbam66722",
      environment: { type: "reuse", environmentId: "env_bfv6wmb79r" },
      providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "high", serviceTier: "default", permissionMode: "full",
    });
    expect(String(spawns[0]!.prompt)).toContain("@thread:thr_pm");
    expect(placed).toEqual([["thread_place", { threadId: "thr_repair1", projectId: "proj_ejbam66722", folderId: "9b66deb6-0e31-42d3-840f-19fa9601380c" }]]);
    expect(String(spawns[0]!.prompt)).toContain("host plugin calls are unavailable");
  });

  it("does not repeat a known problem, waits while a repair runs, and respects the daily limit", async () => {
    const env = setup({ thr_repair1: "running" });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    expect((await repair.tick({ since: 0 })).reason).toBe("nothing new");
    env.attempt("lpattempt_2", "lprun_a", "blocked", "internal_error: spawn failed for writer");
    expect((await repair.tick({ since: 0 })).reason).toBe("a repair thread is still working");
    await repair.setConfig({ maxPerDay: 1 });
    const idle = setup();
    await idle.ctx.bb.storage.kv.set("self-repair:state", (await repair.state()) as never);
    await idle.ctx.bb.storage.kv.set("self-repair:config", { maxPerDay: 1 } as never);
    idle.attempt("lpattempt_2", "lprun_a", "blocked", "internal_error: spawn failed for writer");
    expect((await createSelfRepair(idle.ctx).tick({ since: 0 })).reason).toBe("daily limit 1 reached");
    expect(idle.spawns).toHaveLength(0);
  });

  it("a problem that waited for a busy repair is taken on a later pass, even after the cursor moved", async () => {
    const busy: Record<string, string> = { thr_repair1: "running" };
    const env = setup(busy);
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    env.attempt("lpattempt_2", "lprun_a", "blocked", "internal_error: spawn failed for writer");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    expect((await repair.tick()).reason).toBe("a repair thread is still working");
    busy.thr_repair1 = "idle";
    const later = await repair.tick();
    expect(later.spawned).toBe("thr_repair2");
    expect(String(env.spawns[1]!.prompt)).toContain("spawn failed for writer");
    expect((await repair.tick()).reason).toBe("nothing new");
  });

  it("dry run says what it would start and changes nothing", async () => {
    const env = setup();
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0, dryRun: true })).reason).toMatch(/^would start a repair for blocked:/);
    expect(env.spawns).toHaveLength(0);
    expect((await repair.state()).signatures).toEqual({});
  });

  it("sees an attempt left «running» after its writer went idle", async () => {
    const { ctx, attempt, now } = setup();
    attempt("lpattempt_s", "lprun_a", "running", null, now - 60 * 60_000);
    attempt("lpattempt_r", "lprun_a", "running", null, now - 5 * 60_000);
    const incidents = await createSelfRepair(ctx).collect(0, { ...(await createSelfRepair(ctx).config()) });
    expect(incidents.map((row) => [row.kind, row.attemptId])).toEqual([["stuck", "lpattempt_s"]]);
  });

  it("reads Lane Pilot's own failures from the plugin log, not machine outages or its own lines", () => {
    const line = (ts: number, message: string) => JSON.stringify({ ts, level: "warn", message });
    const text = [
      line(100, "Lane Pilot docs resume failed for /home/u/a docs: plugin \"lane-pilot\" used a stale API handle"),
      line(200, "Lane Pilot docs resume failed for /home/u/b docs: plugin \"lane-pilot\" used a stale API handle"),
      line(300, "Lane Pilot nightly docs failed for /Users/x: Host is not connected"),
      line(400, "self-repair: started @thread:thr_x for blocked:1:spawn failed"),
      line(500, "writer a waits for b: their owns_paths overlap"),
      line(600, "Lane Pilot writer attempt lpattempt_1 failed: another writer integration holds the base checkout"),
      line(700, "Lane Pilot browser check gc-qa-free-session.5 adopted after a reload: failed"),
      line(50, "Lane Pilot docs resume failed: old"),
      "not json",
    ].join("\n");
    const rows = logIncidents(text, 60);
    expect(rows.map((row) => row.at)).toEqual([100, 200]);
    expect(rows[0]!.signature).toBe(rows[1]!.signature);
    expect(rows[0]!.kind).toBe("log");
  });

  it("a failure from before this release waits to happen again; one under the running version is repaired", () => {
    const sample = (at: number, version: string | null) => ({ signature: "s", kind: "blocked" as const, projectId: "p", runId: "r", taskId: "t", attemptId: `a${at}`, pmThreadId: null, writerThreadId: null, reason: "x", at, version });
    const record = (samples: ReturnType<typeof sample>[], extra = {}) => ({ firstAt: 0, lastAt: 0, count: samples.length, threadId: null, spawnedAt: null, samples, ...extra });
    const now = 10 * 86_400_000;
    expect(isDue(record([sample(100, null)]), now)).toBe(false);
    expect(isDue(record([sample(100, null), sample(200, VERSION)]), now)).toBe(true);
    // After a repair that fixed it: the same version again within a day is the old code, not a failed fix.
    const fixed = { spawnedAt: now - 3_600_000, spawnVersion: "0.0.1", verdict: "fixed" };
    expect(isDue(record([sample(now - 60_000, "0.0.1")], fixed), now, "0.0.1")).toBe(false);
    expect(isDue(record([sample(now - 60_000, "0.0.2")], fixed), now, "0.0.2")).toBe(true);
    // Not Lane Pilot's: quiet for a week even if it keeps happening.
    const notOurs = { spawnedAt: now - 2 * 86_400_000, spawnVersion: VERSION, verdict: "not-lane-pilot" };
    expect(isDue(record([sample(now - 60_000, VERSION)], notOurs), now)).toBe(false);
    expect(isDue(record([sample(now - 60_000, VERSION)], notOurs), now + 7 * 86_400_000)).toBe(true);
  });

  it("reads the repair's verdict from its last line and stops repeating a not-ours kind", async () => {
    expect(parseVerdict("отчёт…\nSELF-REPAIR-VERDICT: not-lane-pilot")).toBe("not-lane-pilot");
    expect(parseVerdict("no verdict")).toBeNull();
    const env = setup({}, { thr_repair1: "Готово.\nSELF-REPAIR-VERDICT: already-fixed" });
    env.attempt("lpattempt_1", "lprun_a", "blocked", "merge_failed: index.lock exists");
    const repair = createSelfRepair(env.ctx);
    expect((await repair.tick({ since: 0 })).spawned).toBe("thr_repair1");
    await repair.tick();
    const record = Object.values((await repair.state()).signatures)[0]!;
    expect(record.verdict).toBe("already-fixed");
    expect(record.spawnVersion).toBe(VERSION);
  });

  it("an unfamiliar reason in three tasks within a day is a pattern", async () => {
    const env = setup();
    for (const n of [1, 2, 3]) env.attempt(`lpattempt_${n}`, "lprun_a", "empty_output", `writer changed no files in apps/x${n}`);
    env.attempt("lpattempt_9", "lprun_a", "blocked", "needs_human: which button?");
    const rows = await createSelfRepair(env.ctx).collect(0, (await createSelfRepair(env.ctx).config()));
    expect(rows.filter((row) => row.kind === "repeat").map((row) => row.attemptId).sort()).toEqual(["lpattempt_1", "lpattempt_2", "lpattempt_3"]);
    const two = setup();
    for (const n of [1, 2]) two.attempt(`lpattempt_${n}`, "lprun_a", "empty_output", "writer changed no files");
    expect((await createSelfRepair(two.ctx).collect(0, await createSelfRepair(two.ctx).config())).filter((row) => row.kind === "repeat")).toEqual([]);
  });

  it("sees a task queued for hours while nothing runs, and a stage nobody will finish", async () => {
    const env = setup();
    const hours = (n: number) => env.now - n * 3_600_000;
    env.attempt("lpattempt_q", "lprun_a", "queued", null, hours(3));
    env.attempt("lpattempt_done", "lprun_a", "blocked", "acceptance unmet", hours(3));
    env.db.prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('task-lpattempt_done','lprun_a','bb','{}',?)").run(hours(4));
    env.db.prepare(`INSERT INTO lane_pilot_stage_receipt (run_id, task_id, stage_id, contract_version, state, input_sha256, attempt, updated_at)
      VALUES ('lprun_a','task-lpattempt_done','acceptance-receipt',1,'pending','x',0,?)`).run(hours(2));
    const rows = await createSelfRepair(env.ctx).collect(0, await createSelfRepair(env.ctx).config());
    expect(rows.filter((row) => row.kind === "queued").map((row) => row.attemptId)).toEqual(["lpattempt_q"]);
    expect(rows.filter((row) => row.kind === "stage").map((row) => row.attemptId)).toEqual(["stage:lprun_a:task-lpattempt_done:acceptance-receipt"]);
    const busy = setup();
    busy.attempt("lpattempt_q", "lprun_a", "queued", null, busy.now - 3 * 3_600_000);
    busy.attempt("lpattempt_r", "lprun_a", "running", null, busy.now - 60_000);
    expect((await createSelfRepair(busy.ctx).collect(0, await createSelfRepair(busy.ctx).config())).filter((row) => row.kind === "queued")).toEqual([]);
  });

  it("the prompt tells the agent to verify live, ship only on green and report to the PM", () => {
    const text = repairPrompt([{ signature: "s", kind: "blocked", projectId: "p", runId: "r", taskId: "t", attemptId: "a", pmThreadId: "thr_pm", writerThreadId: null, reason: "x", at: 0 }], "blocked:abc:x");
    expect(text).toMatch(/Verify live/);
    expect(text).toMatch(/continue only when it is green/);
    expect(text).toMatch(/<incidents>[\s\S]*1970-01-01T00:00:00.000Z[\s\S]*<\/incidents>/);
    expect(text).toMatch(/never git add -A/);
    expect(text).toMatch(/already fixed/);
    expect(text.trim().split("\n").at(-3)).toMatch(/SELF-REPAIR-VERDICT: fixed \| already-fixed \| not-lane-pilot \| needs-owner/);
    expect(text).toContain("bb thread tell");
  });
});
