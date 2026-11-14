// The worktree cleanup end to end, the way the hub runs it (0.1.562 live defect: both system schedules ended `start_failed`, «"lp.worktree-cleanup"
// is not a workflow to start by hand», and no janitor pass ran at all; the unit tests had called runDailyWorktreePass directly). Here the rows are
// made by ensureSystemSchedules through the real schedule service, fired by the real scheduler (cron tick and run-now), started by the real
// executor through the real workflowTriggers.start on the real library (`loadStore("*")`, built-in graphs), run by the real engine and the real
// lp.worktree_cleanup step, and judged by the real end-of-run notice. Only the hub → machine host call is a stub, validated against a contract.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, isOffered, wfRunRow } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../src/rooms/plugin-db";
import { hostContract } from "../src/rooms/contracts/host";
import { createScheduleService } from "../src/rooms/schedule/server/schedule-service";
import { ensureSystemSchedules, systemStarterOf } from "../src/rooms/schedule/server/system-schedules";
import { createWorkflowLibrary } from "../src/rooms/workflow/server/workflow-library";
import { createWorkflowPreflight } from "../src/rooms/workflow/server/workflow-preflight";
import { createWorkflowTriggers } from "../src/rooms/workflow/server/workflow-triggers";
import { notifyWorkflowIfEnded } from "../src/rooms/workflow/server/pm-notice";
import { CLEANUP_ITEM_PREFIX, registerWorktreeCleanupActions, runWorktreeCleanupCli } from "../src/rooms/stability/server/worktree-janitor";
import { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees } from "../src/rooms/runs/server";

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => { vi.useRealTimers(); });

/** The worktreeJanitor input of a machine on a build before 0.1.562 (git show 0a6fa63f:src/rooms/contracts/host/git.ts): strict, no `deep`. */
const OLD_JANITOR_INPUT = z.object({ requestedHostId: z.string().min(1), protectedPaths: z.array(z.string().startsWith("/")).max(20000), graceMs: z.number().int().min(0).optional() }).strict();

const emptyDeep = (over: Record<string, unknown> = {}) => ({ removed: [], freedBytes: 0, kept: [], branchesKept: [], pruned: 0, registryGone: [], repos: 1, errors: [], dryRun: false, ...over });

/** A hub with one connected machine. `machine` answers worktreeJanitor after its input passed the given contract (the current one by default). */
function hub(options: { oldHost?: boolean; deep?: Record<string, unknown> } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("hosts.list", async () => [{ id: "h1", name: "Machine", status: "connected" }]);
  harness.sdk.stub("projects.list", async () => [{ id: "proj_a", sources: [{ hostId: "h1", path: "/w/app" }] }]);
  const sent: unknown[] = [];
  harness.sdk.stub("threads.send", async (request: unknown) => { sent.push(request); return {}; });
  const db = openDatabase(bb);
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  const call = async (method: string, input: Record<string, unknown>) => {
    calls.push({ method, input });
    if (method !== "worktreeJanitor") throw new Error(`no ${method} in this test`);
    const schema = options.oldHost ? OLD_JANITOR_INPUT : hostContract.worktreeJanitor.input;
    const parsed = schema.safeParse(input);
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join("; "));
    const hourly = { hostId: "h1", removed: [], freedBytes: 0, kept: [], tmpRemoved: [], tmpFreedBytes: 0, errors: [] };
    return input.deep ? { ...hourly, deep: emptyDeep({ dryRun: (input.deep as { dryRun?: boolean }).dryRun === true, ...options.deep }) } : hourly;
  };
  const logs: string[] = [];
  const ctx = {
    bb, db, log: (line: string) => logs.push(line), isDisposed: () => false, host: { call }, realtime: { notify: () => undefined },
    secrets: {}, knownCustomAgentIds: () => null,
  } as never;
  // The engine as workflow.ts builds it for this purpose: the end of every run goes through the real notice.
  const engine: WorkflowEngine = new WorkflowEngine({
    db, harnessVersion: "1.0.0",
    onEvent: (runId) => { const run = wfRunRow(db, runId); if (run) void notifyWorkflowIfEnded({ bb, db, log: (line) => logs.push(line), run }); },
  });
  const sweeps = { cleanupStickyLaneWorktrees, cleanupFinishedAttemptEnvironments };
  registerWorktreeCleanupActions(engine, ctx, sweeps);
  const library = createWorkflowLibrary(ctx, { docsPlaces: async () => [], workflowEngine: engine } as never, { globalDir: mkdtempSync(join(tmpdir(), "lp-wt-e2e-lib-")) });
  const preflight = createWorkflowPreflight(ctx, { capabilityPorts: () => ({}), projectPlace: async () => null, projectPlaceOf: async () => null } as never);
  const workflowTriggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as never, { loadStore: (projectId) => library.loadStore(projectId), preflight: (workflow, input) => preflight.check(workflow, input) });
  const { schedules } = createScheduleService(ctx, { workflowEngine: engine, workflowLibrary: library, workflowTriggers, docsPlaces: async () => [], listedAgentProfiles: async () => [], errands: {}, startWriterTask: async () => undefined } as never);
  const ensure = () => ensureSystemSchedules({ list: () => schedules.store.list(), save: (raw, by) => schedules.save(raw, by), kv: bb.storage.kv as never, log: (line) => logs.push(line) });
  const byKey = (key: string) => schedules.store.list().find((row) => row.created_by === `system:worktree-cleanup-${key}`)!;
  const lastRun = (id: string) => schedules.store.runsOf(id, 5, 0).find((run) => run.status !== "skipped");
  const ownerItems = () => db.prepare("SELECT key, kind, state FROM lane_pilot_owner_item").all() as Array<{ key: string; kind: string; state: string }>;
  const output = (runId: string) => JSON.parse(String(wfRunRow(db, runId)!.output_json)) as { status: string; report: string };
  /** Waits until the schedule's newest run has ended (run-now kicks the scheduler in the background). */
  const settled = async (id: string) => {
    for (let i = 0; i < 400; i += 1) { const run = lastRun(id); if (run && !["queued", "running", "waiting"].includes(run.status)) return run; await new Promise((wake) => setTimeout(wake, 25)); }
    throw new Error(`the run of ${id} did not end`);
  };
  /** The cron path: the clock moves 30 s past the row's next fire time and the scheduler ticks once. */
  const fire = async (id: string) => {
    const at = schedules.scheduler.nextFires(schedules.store.get(id)!, 1)[0]!;
    vi.setSystemTime(at + 30_000);
    await schedules.tick();
    return await settled(id);
  };
  return { db, schedules, workflowTriggers, ensure, byKey, lastRun, ownerItems, output, settled, fire, calls, sent, logs, ctx, sweeps };
}

describe("the worktree-cleanup system schedules run their graph", () => {
  it("[sma:m_boot_wt_sweep] the hourly schedule on its cron: started detached in project *, the graph succeeds, one host call without deep, nobody is told", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const w = hub();
    expect(await w.ensure()).toEqual(["worktree-cleanup-hourly", "worktree-cleanup-daily"]);
    const hourly = w.byKey("hourly");
    expect(hourly.project_id).toBe("*");
    const run = await w.fire(hourly.id);
    expect({ status: run.status, reason: run.reason, error: run.error }).toEqual({ status: "succeeded", reason: null, error: null });
    expect(run.ref_kind).toBe("workflow_run");
    const wf = wfRunRow(w.db, run.ref_id!)!;
    expect(wf).toMatchObject({ workflow_id: "lp.worktree-cleanup", status: "succeeded", project_id: "*", link_run_id: null });
    expect(w.output(run.ref_id!).status).toBe("ok");
    const janitor = w.calls.filter((item) => item.method === "worktreeJanitor");
    expect(janitor).toHaveLength(1);
    expect(janitor[0]!.input.deep).toBeUndefined();
    // A successful hourly pass tells no one: no owner line (its output has a `report`, which a scheduled run would otherwise deliver), no chat.
    await new Promise((wake) => setTimeout(wake, 50));
    expect(w.ownerItems()).toEqual([]);
    expect(w.sent).toEqual([]);
  });

  it("[sma:dt_wt_sweep] the daily schedule on its cron runs the deep pass; its one owner line is the kept list, not the run's end", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const kept = [{ path: "/w/app/lpattempt_u1", cls: "lane", reason: "unmerged", detail: "1 commit(s) merged nowhere", bytes: 10, ageMs: 9e8, branch: "lane/lpattempt_u1" }];
    const w = hub({ deep: { kept } });
    await w.ensure();
    const daily = w.byKey("daily");
    const run = await w.fire(daily.id);
    expect({ status: run.status, reason: run.reason, error: run.error }).toEqual({ status: "succeeded", reason: null, error: null });
    const janitor = w.calls.filter((item) => item.method === "worktreeJanitor");
    expect(janitor).toHaveLength(1);
    expect(janitor[0]!.input.deep).toMatchObject({ maxAgeMs: 7 * 86_400_000 });
    expect(w.output(run.ref_id!).report).toContain("/w/app/lpattempt_u1");
    expect((w.db.prepare("SELECT pass, kept_unmerged FROM lane_pilot_janitor").all())).toEqual([{ pass: "daily", kept_unmerged: 1 }]);
    await new Promise((wake) => setTimeout(wake, 50));
    const items = w.ownerItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.key.startsWith(CLEANUP_ITEM_PREFIX)).toBe(true);
    expect(w.sent).toEqual([]);
  });

  it("[sma:m_boot_wt_sweep] «Запустить сейчас» (schedule run-now) on both rows starts and finishes the graph", async () => {
    const w = hub();
    await w.ensure();
    for (const key of ["hourly", "daily"]) {
      const row = w.byKey(key);
      expect(w.schedules.runNow(row.id, `press-${key}`)?.created).toBe(true);
      const run = await w.settled(row.id);
      expect({ key, status: run.status, reason: run.reason, error: run.error }).toEqual({ key, status: "succeeded", reason: null, error: null });
      expect(run.trigger).toBe("manual");
      expect(wfRunRow(w.db, run.ref_id!)!.status).toBe("succeeded");
    }
    expect(w.calls.filter((item) => item.method === "worktreeJanitor").map((item) => item.input.deep !== undefined)).toEqual([false, true]);
  });
});

describe("the graph stays Lane Pilot's own", () => {
  it("no hand trigger, PM-made schedule or router offer starts it: only the row whose created_by is the system schedule passes a starter", async () => {
    const w = hub();
    await w.ensure();
    // `bb lane-pilot workflow-trigger` and the board's own start: no starter, refused as before.
    expect(await w.workflowTriggers.start({ projectId: "*", workflowId: "lp.worktree-cleanup", inputs: { pass: "daily", dry_run: true }, source: "schedule" })).toMatchObject({ ok: false, reason: "not_runnable" });
    expect(await w.workflowTriggers.start({ projectId: "*", workflowId: "lp.worktree-cleanup", inputs: {}, source: "manual", starter: "docs-nightly" })).toMatchObject({ ok: false, reason: "not_runnable" });
    // A schedule the owner or a chat made naming the same graph: its run fails start_failed, the graph is not run.
    for (const by of ["owner", "agent:pm_thread_1"]) {
      const saved = await w.schedules.save({ projectId: "*", name: `copy by ${by}`, task: { kind: "workflow", workflowId: "lp.worktree-cleanup", inputs: { pass: "daily" } }, when: { type: "cron", cron: "0 3 * * *" } }, by);
      expect(saved.ok).toBe(true);
      const id = (saved as { schedule: { id: string } }).schedule.id;
      expect(systemStarterOf(w.schedules.store.get(id)!.created_by)).toBeNull();
      w.schedules.runNow(id, "press");
      const run = await w.settled(id);
      expect({ status: run.status, reason: run.reason }).toEqual({ status: "failed", reason: "start_failed" });
      expect(run.error).toContain("is not a workflow to start by hand");
    }
    expect(w.calls.filter((item) => item.method === "worktreeJanitor")).toEqual([]);
    const { store } = await (createWorkflowLibrary(w.ctx, { docsPlaces: async () => [] } as never, { globalDir: mkdtempSync(join(tmpdir(), "lp-wt-e2e-lib-")) })).loadStore("*");
    expect(isOffered(store.get("lp.worktree-cleanup")!.workflow)).toBe(false);
  });
});

describe("the other live edges of the batch", () => {
  it("a machine on an older build (strict contract, no deep) fails the daily run with a reason that says to update it, and removes nothing", async () => {
    const w = hub({ oldHost: true });
    await w.ensure();
    const daily = w.byKey("daily");
    w.schedules.runNow(daily.id, "press");
    const run = await w.settled(daily.id);
    expect(run.status).toBe("failed");
    const out = w.output(run.ref_id!);
    expect(out.status).toBe("error");
    expect(out.report).toContain("is older and has no daily pass (update the plugin there); nothing was removed on it");
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_janitor").get()).toEqual({ n: 0 });
    // The failure is the board's line, once; the hourly row keeps working on that machine (its input is the old shape).
    await new Promise((wake) => setTimeout(wake, 50));
    expect(w.ownerItems().map((item) => item.kind)).toEqual(["schedule_failed"]);
    const hourly = w.byKey("hourly");
    w.schedules.runNow(hourly.id, "press");
    expect((await w.settled(hourly.id)).status).toBe("succeeded");
  });

  it("a schedule the owner deleted is not made again at the next start; the other keeps running", async () => {
    const w = hub();
    await w.ensure();
    expect(w.schedules.remove(w.byKey("hourly").id)).toBe(true);
    expect(await w.ensure()).toEqual([]);
    expect(w.schedules.store.list().map((row) => row.created_by)).toEqual(["system:worktree-cleanup-daily"]);
    const daily = w.byKey("daily");
    w.schedules.runNow(daily.id, "press");
    expect((await w.settled(daily.id)).status).toBe("succeeded");
  });

  it("bb lane-pilot worktree-cleanup --dry-run runs the daily pass deciding only, without touching the schedules", async () => {
    const w = hub({ deep: { removed: [{ path: "/w/app/lpattempt_m1", cls: "lane", bytes: 2048, branch: "lane/lpattempt_m1", branchDeleted: true, why: "merged", how: "squash" }] } });
    const dry = await runWorktreeCleanupCli(w.ctx, w.sweeps, ["--dry-run"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.stdout).toContain("daily (dry run): ok");
    expect(dry.stdout).toContain("Пробный проход");
    const janitor = w.calls.filter((item) => item.method === "worktreeJanitor");
    expect(janitor[0]!.input.deep).toMatchObject({ dryRun: true });
    expect(janitor[0]!.input.graceMs).toBe(Number.MAX_SAFE_INTEGER);
    expect(w.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_janitor").get()).toEqual({ n: 0 });
    expect(w.ownerItems()).toEqual([]);
    expect((await runWorktreeCleanupCli(w.ctx, w.sweeps, ["--bogus"])).exitCode).toBe(2);
    const hourly = await runWorktreeCleanupCli(w.ctx, w.sweeps, ["--json"]);
    expect(JSON.parse(hourly.stdout!)).toMatchObject({ pass: "hourly", dry_run: false, status: "ok" });
  });
});
