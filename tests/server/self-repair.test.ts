import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/database";
import { createSelfRepair, reasonSignature, repairPrompt } from "../../src/server/self-repair";
import type { ServerCore } from "../../src/server/core";

function setup(threadStatus: Record<string, string> = {}) {
  const spawns: Array<Record<string, unknown>> = [];
  let next = 0;
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      threads: {
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
  return { ctx, db, spawns, attempt, triage, now };
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
    const { ctx, spawns, attempt, triage } = setup();
    attempt("lpattempt_1", "lprun_a", "validation_failed", "cannot read writer-workspace git diff: host plugin calls are unavailable");
    triage("lpattempt_1", "proj_real", "lprun_a", "cannot read writer-workspace git diff: host plugin calls are unavailable");
    triage("lpattempt_2", "proj_real", "lprun_a", "tests failed in apps/web", "writer");
    attempt("lpattempt_3", "lprun_a", "blocked", "acceptance unmet: button missing");
    triage("lpattempt_4", "proj_3tb652jpsi", "lprun_s", "internal_error: sandbox drill");
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

  it("the prompt tells the agent to verify live, ship only on green and report to the PM", () => {
    const text = repairPrompt([{ signature: "s", kind: "blocked", projectId: "p", runId: "r", taskId: "t", attemptId: "a", pmThreadId: "thr_pm", writerThreadId: null, reason: "x", at: 0 }], "blocked:abc:x");
    expect(text).toMatch(/Verify live/);
    expect(text).toMatch(/continue only when it is green/);
    expect(text).toMatch(/<incidents>[\s\S]*1970-01-01T00:00:00.000Z[\s\S]*<\/incidents>/);
    expect(text).toMatch(/never git add -A/);
    expect(text).toMatch(/already fixed/);
    expect(text).toContain("bb thread tell");
  });
});
