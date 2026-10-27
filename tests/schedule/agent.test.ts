import { beforeEach, describe, expect, it, vi } from "vitest";

const observe = vi.hoisted(() => ({ result: { kind: "completed" } as { kind: string; detail?: string; via?: string } }));
vi.mock("@lane-pilot/thread-observe", () => ({ observeStageChild: async () => observe.result }));
vi.mock("../../src/rooms/memory/server", () => ({ taskMemoryContext: (_db: unknown, _project: string, _run: string | null, query: string) => `NOTE for «${query.slice(0, 20)}»: the site is on Yandex Webmaster` }));

import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/storage/database";
import { createScheduleExecutors } from "../../src/rooms/schedule/server/schedule-executors";
import { normalizeSchedule } from "../../src/rooms/schedule/model";
import { AGENT_OUTCOME_FORMAT, agentHistoryBlock, alreadyHandedOver, handOverTrailer, parseAgentOutcome, parseHandOver } from "../../src/rooms/schedule/outcome";
import { createScheduleStore, scheduleAgentMigrations, scheduleMigrations, type RunRow, type ScheduleRow } from "../../src/rooms/schedule/store";
import { ownerWaitingMigrations } from "../../src/rooms/owner-waiting/migrations";
import { createPhaseIntake } from "../../src/rooms/phase/server/intake";
import { addSchedule, createClock, createDb } from "./harness";

const task = { kind: "agent" as const, agentId: "seo-specialist", task: "Check the positions of the main queries and decide what to improve.", authorized: false, accounts: [] as string[], historyRuns: 5 };
const input = (overrides: Record<string, unknown> = {}) => ({ projectId: "p1", name: "Positions", task, when: { type: "cron", cron: "0 9 * * 1", timezone: "Europe/Moscow" }, ...overrides });

describe("the agent task model", () => {
  it("takes an agent id, a standing task of 10..20000 characters, history 0..20 (default 5), accounts up to 8", () => {
    const made = normalizeSchedule(input({ task: { kind: "agent", agentId: "seo-specialist", task: "Check the positions every week." } }), 1_790_000_000_000);
    expect(made.ok && made.value.task).toEqual({ kind: "agent", agentId: "seo-specialist", task: "Check the positions every week.", authorized: false, accounts: [], historyRuns: 5 });
    expect(made.ok && made.value.timeoutSec).toBe(3600);
    const problems = (raw: Record<string, unknown>) => { const result = normalizeSchedule(input({ task: { ...task, ...raw } }), 1_790_000_000_000); return result.ok ? [] : result.problems.join(" | "); };
    expect(problems({ task: "short" })).toMatch(/task\.task/);
    expect(problems({ task: "x".repeat(20_001) })).toMatch(/task\.task/);
    expect(problems({ agentId: "SEO Specialist" })).toMatch(/task\.agentId/);
    expect(problems({ agentId: undefined })).toMatch(/task\.agentId/);
    expect(problems({ historyRuns: 21 })).toMatch(/historyRuns/);
    expect(problems({ historyRuns: -1 })).toMatch(/historyRuns/);
    expect(problems({ accounts: Array.from({ length: 9 }, (_, i) => `ACC_${i}`) })).toMatch(/accounts/);
    expect(problems({ reasoning: "enormous" })).toMatch(/reasoning/);
    expect(problems({ unknownField: 1 })).toMatch(/unrecognized/i);
    expect(problems({ historyRuns: 0, model: "claude-opus-5-5", reasoning: "high", serviceTier: "default", authorized: true, accounts: ["MY_LOGIN"] })).toEqual([]);
  });
});

describe("the migration that adds the agent kind", () => {
  it("rebuilds both tables keeping every row and id, the cascade and the indexes", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    for (const statement of scheduleMigrations) db.exec(statement);
    const insertSchedule = db.prepare(`INSERT INTO lane_pilot_schedule(id,project_id,name,description,kind,task_json,trigger_type,cron,timezone,run_at,missed_policy,missed_limit,overlap,timeout_sec,max_failures,state,pause_reason,consecutive_failures,cursor_at,created_by,created_at,updated_at)
      VALUES (?,?,?,?,?,?,'cron','0 9 * * *','UTC',NULL,'skip',7,'queue',900,4,?,?,2,1700000000000,'owner',1690000000000,1695000000000)`);
    insertSchedule.run("sch_wf", "p1", "Workflow", "d1", "workflow", '{"kind":"workflow","workflowId":"w","inputs":{}}', "active", null);
    insertSchedule.run("sch_er", "p1", "Errand", "", "errand", '{"kind":"errand","task":"read the mailbox"}', "paused", "by hand");
    insertSchedule.run("sch_sc", "p2", "Script", "", "script", '{"kind":"script"}', "done", null);
    const insertRun = db.prepare(`INSERT INTO lane_pilot_schedule_run(id,schedule_id,run_key,scheduled_at,trigger,status,reason,queued_at,started_at,finished_at,deadline_at,ref_kind,ref_id,host_id,exit_code,output,error,truncated)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    insertRun.run("srun_1", "sch_er", "sch_er:1", 1_700_000_000_000, "tick", "failed", "r", 1, 2, 3, 4, "thread", "thr_1", "h1", 1, "out", "err", 1);
    insertRun.run("srun_2", "sch_er", "sch_er:2", 1_700_000_100_000, "manual", "succeeded", null, 5, 6, 7, null, null, null, null, null, null, null, 0);
    insertRun.run("srun_3", "sch_sc", "sch_sc:1", 1_700_000_200_000, "catchup", "queued", null, 8, null, null, null, null, null, null, null, null, null, 0);
    const schedulesBefore = db.prepare("SELECT * FROM lane_pilot_schedule ORDER BY id").all();
    const runsBefore = db.prepare("SELECT * FROM lane_pilot_schedule_run ORDER BY id").all();

    expect(() => db.prepare("INSERT INTO lane_pilot_schedule(id,project_id,name,kind,task_json,trigger_type,timeout_sec,state,cursor_at,created_by,created_at,updated_at) VALUES ('x','p','n','agent','{}','once',1,'active',0,'t',0,0)").run()).toThrow(/CHECK/);
    for (const statement of scheduleAgentMigrations) db.exec(statement);

    expect(db.prepare("SELECT * FROM lane_pilot_schedule ORDER BY id").all()).toEqual(schedulesBefore);
    expect(db.prepare("SELECT * FROM lane_pilot_schedule_run ORDER BY id").all()).toEqual(runsBefore);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lane_pilot_schedule%' ORDER BY name").all()).toEqual([{ name: "lane_pilot_schedule" }, { name: "lane_pilot_schedule_run" }]);
    expect((db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'lane_pilot_schedule%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name)).toEqual(["lane_pilot_schedule_project", "lane_pilot_schedule_run_schedule", "lane_pilot_schedule_run_status"]);
    expect(db.prepare("PRAGMA foreign_key_list(lane_pilot_schedule_run)").all()).toMatchObject([{ table: "lane_pilot_schedule", from: "schedule_id", to: "id", on_delete: "CASCADE" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    // The new kind is allowed, an unknown one is not, and deleting a schedule still takes its runs with it.
    insertSchedule.run("sch_ag", "p1", "Agent", "", "agent", '{"kind":"agent"}', "active", null);
    expect(() => insertSchedule.run("sch_bad", "p1", "Bad", "", "other", "{}", "active", null)).toThrow(/CHECK/);
    db.prepare("DELETE FROM lane_pilot_schedule WHERE id='sch_er'").run();
    expect(db.prepare("SELECT id FROM lane_pilot_schedule_run ORDER BY id").all()).toEqual([{ id: "srun_3" }]);
  });
});

describe("the outcome block", () => {
  const report = ["Looked at 12 queries.", "", "OUTCOME", "summary: 3 queries fell out of the top 10", "decision: rewrote nothing, queued a title test", "follow-ups: re-check the 3 queries on Monday", "code-change: add the canonical tag to /pricing, the template omits it", "urgent: no", "status: done"].join("\n");

  it("is read from the end of a report, with continuation lines, none-values and a blocked status", () => {
    expect(parseAgentOutcome(report)).toEqual({ summary: "3 queries fell out of the top 10", decision: "rewrote nothing, queued a title test", followUps: "re-check the 3 queries on Monday", codeChange: "add the canonical tag to /pricing, the template omits it", urgent: false, status: "done", blockedReason: "" });
    expect(parseAgentOutcome("OUTCOME\nsummary: all fine\ndecision: none\nfollow-ups: nothing\ncode-change: none\nurgent: yes\nstatus: blocked: Webmaster login expired")).toMatchObject({ summary: "all fine", decision: "", followUps: "", codeChange: "", urgent: true, status: "blocked", blockedReason: "Webmaster login expired" });
    expect(parseAgentOutcome("**OUTCOME**\n- summary: wrapped\n  into two lines\n- status: done")).toMatchObject({ summary: "wrapped into two lines" });
    expect(parseAgentOutcome("no block here")).toBeNull();
    expect(parseAgentOutcome("OUTCOME\ndecision: no summary given")).toBeNull();
    expect(AGENT_OUTCOME_FORMAT[0]).toBe("OUTCOME");
  });

  it("keeps the hand-over trailer out of the status and reads it back", () => {
    const stored = `${report}\n\n${handOverTrailer("issue-quick", "wfrun_9")}`;
    expect(parseAgentOutcome(stored)).toMatchObject({ status: "done", blockedReason: "" });
    expect(parseHandOver(stored)).toEqual({ via: "issue-quick", id: "wfrun_9" });
    expect(parseHandOver(report)).toBeNull();
    expect(alreadyHandedOver({ output: stored }, "Add the canonical tag to /pricing,  the template omits it.")).toBe(true);
    expect(alreadyHandedOver({ output: stored }, "Fix the sitemap")).toBe(false);
    expect(alreadyHandedOver({ output: report }, "add the canonical tag to /pricing, the template omits it")).toBe(false);
    expect(alreadyHandedOver(undefined, "anything")).toBe(false);
  });

  it("makes the history block newest first with the outcome, the hand-over and the failures", () => {
    const block = agentHistoryBlock([
      { scheduled_at: Date.UTC(2026, 9, 26, 6), status: "succeeded", output: `${report}\n\n${handOverTrailer("phase", "ph_1")}`, error: null, reason: null },
      { scheduled_at: Date.UTC(2026, 9, 19, 6), status: "failed", output: null, error: "could not start: agent_unknown", reason: "start_failed" },
    ]);
    expect(block.indexOf("2026-10-26")).toBeLessThan(block.indexOf("2026-10-19"));
    expect(block).toContain("summary: 3 queries fell out of the top 10");
    expect(block).toContain("handed over to Lane Pilot: phase ph_1");
    expect(block).toContain("failed");
    expect(block).toContain("no structured outcome: could not start: agent_unknown");
  });
});

/** A world with the real executors on an in-memory database and fake services. */
function world(options: { pm?: boolean; report?: string; start?: (args: Record<string, any>) => Promise<{ threadId: string }>; handOver?: (args: Record<string, any>) => Promise<any> } = {}) {
  const db = createDb();
  for (const statement of ownerWaitingMigrations) db.exec(statement);
  const calls = { agentStart: [] as Array<Record<string, any>>, handOver: [] as Array<Record<string, any>> };
  let report = options.report ?? "";
  const pm = options.pm === false ? null : { pmThreadId: "thr_pm", runId: "lprun_1" };
  const services = {
    workflowTriggers: { pmOf: async () => pm },
    errands: { resolveAccounts: async () => ({ ok: true, accounts: [] }) },
    agentRuns: {
      start: options.start ?? (async (args: Record<string, any>) => { calls.agentStart.push(args); return { threadId: `thr_agent_${calls.agentStart.length}` }; }),
      completedReport: async () => ({ state: "done" as const, output: report }),
    },
    phaseIntake: { handOver: async (args: Record<string, any>) => { calls.handOver.push(args); return options.handOver ? options.handOver(args) : { started: true, via: "issue-quick", id: `wfrun_${calls.handOver.length}` }; } },
  } as never;
  const ctx = { bb: { sdk: { threads: { stop: async () => undefined } }, log: { warn: () => undefined } }, db, host: {}, secrets: {} } as never;
  const executors = createScheduleExecutors(ctx, services);
  const clock = createClock(Date.UTC(2026, 9, 26, 5));
  const schedule = addSchedule(db, clock, { task, name: "Positions", when: { type: "cron", cron: "0 9 * * 1", timezone: "UTC" } });
  const store = createScheduleStore(db, clock.now);
  let n = 0;
  /** A run of the schedule: queued, claimed, started, polled once; returns the poll result and finishes the row like the scheduler does. */
  async function runOnce(at: number, text?: string) {
    if (text !== undefined) report = text;
    n += 1;
    const row = store.addRun({ scheduleId: schedule.id, runKey: `${schedule.id}:${at}`, scheduledAt: at, trigger: "tick" }).run;
    store.claim(row.id, at + 3_600_000);
    const fresh = store.getRun(row.id) as RunRow;
    const current = store.get(schedule.id) as ScheduleRow;
    const started = await executors.agent.start({ schedule: current, task, run: fresh });
    db.prepare("UPDATE lane_pilot_schedule_run SET ref_kind=?,ref_id=? WHERE id=?").run(started.refKind, started.refId, row.id);
    const polled = await executors.agent.poll({ schedule: current, task, run: store.getRun(row.id) as RunRow });
    if (polled.state === "done") store.finish(row.id, polled.status, { output: polled.output, error: polled.error, reason: polled.reason });
    return { polled, runId: row.id, n };
  }
  const ownerItems = () => db.prepare("SELECT key,source,kind,project_id,what,why,wake FROM lane_pilot_owner_item ORDER BY created_at, key").all() as Array<Record<string, any>>;
  return { db, calls, executors, schedule, store, runOnce, ownerItems };
}

const report = (extra: Record<string, string> = {}) => ["Looked at the positions.", "OUTCOME", `summary: ${extra.summary ?? "3 queries fell out of the top 10"}`, `decision: ${extra.decision ?? "queued a title test"}`, `follow-ups: ${extra.followUps ?? "re-check on Monday"}`,
  `code-change: ${extra.codeChange ?? "none"}`, `urgent: ${extra.urgent ?? "no"}`, `status: ${extra.status ?? "done"}`].join("\n");

beforeEach(() => { observe.result = { kind: "completed" }; });

describe("a run of kind agent", () => {
  const T1 = Date.UTC(2026, 9, 19, 6), T2 = Date.UTC(2026, 9, 26, 6), T3 = Date.UTC(2026, 10, 2, 6);

  it("starts the agent's own profile in a thread a schedule marks, with the standing task, the memory and the outcome format in the first message", async () => {
    const w = world({ report: report() });
    const { polled } = await w.runOnce(T1);
    expect(polled).toMatchObject({ state: "done", status: "succeeded" });
    const start = w.calls.agentStart[0]!;
    expect(start).toMatchObject({ projectId: "p1", runId: "lprun_1", pmThreadId: "thr_pm", agentId: "seo-specialist", title: "Positions", spawnId: expect.stringMatching(/^schedule:sch_.*:\d+$/),
      metadata: { origin: "schedule", scheduleId: w.schedule.id } });
    expect(start.brief).toContain("This is a scheduled run of «Positions»");
    expect(start.brief).toContain("<standing_task>\nCheck the positions of the main queries and decide what to improve.\n</standing_task>");
    expect(start.brief).toContain("<project_memory>\nNOTE for «Check the positions »: the site is on Yandex Webmaster\n</project_memory>");
    expect(start.brief).toContain("no previous runs to read");
    expect(start.brief).toContain("OUTCOME\nsummary:");
    expect(start.brief).toContain("Read and report only");
  });

  it("stores the outcome as the run's output, so the next run's first message lists it, and the owner line is one row, quiet unless urgent", async () => {
    const w = world();
    await w.runOnce(T1, report({ summary: "positions dropped for three queries", decision: "queued a title test", followUps: "re-check on Monday" }));
    expect(w.store.runsOf(w.schedule.id)[0]).toMatchObject({ status: "succeeded", output: expect.stringContaining("summary: positions dropped for three queries") });
    expect(w.ownerItems()).toHaveLength(1);
    expect(w.ownerItems()[0]).toMatchObject({ source: "schedule", kind: "agent_outcome", project_id: "p1", wake: 0 });
    expect(w.ownerItems()[0]!.what).toBe("«Positions» (seo-specialist): positions dropped for three queries");
    expect(w.ownerItems()[0]!.why).toContain("Решение: queued a title test");
    expect(w.ownerItems()[0]!.why).toContain("Дальше: re-check on Monday");

    await w.runOnce(T2, report({ summary: "two of the three recovered", urgent: "yes" }));
    const second = w.calls.agentStart[1]!.brief as string;
    expect(second).toContain("<previous_runs>");
    expect(second).toContain("2026-10-19T06:00Z · succeeded");
    expect(second).toContain("summary: positions dropped for three queries");
    expect(second).toContain("decision: queued a title test");
    expect(second).toContain("follow-ups: re-check on Monday");
    expect(w.ownerItems()).toHaveLength(2);
    expect(w.ownerItems()[1]).toMatchObject({ wake: 1 });
  });

  it("reads only the last historyRuns runs", async () => {
    const w = world();
    for (const [index, at] of [T1, T2, T3].entries()) await w.runOnce(at, report({ summary: `run number ${index + 1}` }));
    const withOne = { ...task, historyRuns: 1 };
    const fresh = w.store.addRun({ scheduleId: w.schedule.id, runKey: "k4", scheduledAt: T3 + 7 * 86_400_000, trigger: "tick" }).run;
    w.store.claim(fresh.id, T3 + 8 * 86_400_000);
    await w.executors.agent.start({ schedule: w.store.get(w.schedule.id)!, task: withOne, run: w.store.getRun(fresh.id)! });
    const brief = w.calls.agentStart.at(-1)!.brief as string;
    expect(brief).toContain("run number 3");
    expect(brief).not.toContain("run number 2");
  });

  it("fails with the reason when the agent is gone, there is no PM chat, or the agent skipped its outcome", async () => {
    const gone = world({ start: async () => { throw new Error('agent_unknown: there is no agent "seo-specialist" any more'); } });
    await expect(gone.runOnce(T1)).rejects.toThrow(/agent_unknown/);
    const noPm = world({ pm: false });
    await expect(noPm.runOnce(T1)).rejects.toThrow(/no_pm_chat/);
    const bare = world({ report: "I did a thing and forgot the block." });
    expect((await bare.runOnce(T1)).polled).toMatchObject({ state: "done", status: "failed", reason: "no_outcome" });
    expect(bare.ownerItems()).toEqual([]);
    const stuck = world({ report: report({ status: "blocked: Webmaster login expired" }) });
    expect((await stuck.runOnce(T1)).polled).toMatchObject({ status: "failed", reason: "blocked", error: "Webmaster login expired" });
    expect(stuck.ownerItems()[0]).toMatchObject({ kind: "agent_blocked" });
  });
});

describe("the hand-over of a code change", () => {
  const T1 = Date.UTC(2026, 9, 19, 6), T2 = Date.UTC(2026, 9, 26, 6), T3 = Date.UTC(2026, 10, 2, 6);
  const change = "Add the canonical tag to the /pricing template: it omits it, so two URLs compete.";

  it("starts the road once with the agent's text marked as the schedule's, records it in the output and tells the owner", async () => {
    const w = world();
    const { polled } = await w.runOnce(T1, report({ codeChange: change }));
    expect(w.calls.handOver).toHaveLength(1);
    expect(w.calls.handOver[0]).toMatchObject({ projectId: "p1", pmThreadId: "thr_pm", runId: "lprun_1", text: change, key: expect.stringMatching(/^schedule:sch_/) });
    expect(w.calls.handOver[0]!.origin).toMatch(/seo-specialist.*«Positions».*source: schedule/);
    expect(polled).toMatchObject({ status: "succeeded", output: expect.stringContaining("HAND-OVER: issue-quick wfrun_1") });
    expect(w.ownerItems()[0]!.why).toContain("Передано Lane Pilot (issue-quick wfrun_1)");
  });

  it("does not start the same change again at the next run, and says so in the history and on the list", async () => {
    const w = world();
    await w.runOnce(T1, report({ codeChange: change }));
    await w.runOnce(T2, report({ codeChange: change.toLowerCase().replace(".", "") }));
    expect(w.calls.handOver).toHaveLength(1);
    expect(w.calls.agentStart[1]!.brief).toContain("handed over to Lane Pilot: issue-quick wfrun_1");
    expect(w.ownerItems()[1]!.why).toContain("та же правка");
    await w.runOnce(T3, report({ codeChange: "Fix the sitemap generator: it lists redirected URLs." }));
    expect(w.calls.handOver).toHaveLength(2);
  });

  it("starts nothing without Lane Pilot in the project, and the owner's line still names the change", async () => {
    // start() needs the PM chat for the thread, so a run cannot begin without one; the hand-over path alone is checked on the poll of a thread started while the project still had one.
    const world2 = world({ pm: false, report: report({ codeChange: change }) });
    const row2 = world2.store.addRun({ scheduleId: world2.schedule.id, runKey: "k1", scheduledAt: T1, trigger: "tick" }).run;
    world2.store.claim(row2.id, T1 + 1);
    world2.db.prepare("UPDATE lane_pilot_schedule_run SET ref_kind='thread',ref_id='thr_x' WHERE id=?").run(row2.id);
    const polled = await world2.executors.agent.poll({ schedule: world2.store.get(world2.schedule.id)!, task, run: world2.store.getRun(row2.id)! });
    expect(polled).toMatchObject({ state: "done", status: "succeeded" });
    expect((polled as { output: string }).output).not.toContain("HAND-OVER");
    expect(world2.calls.handOver).toEqual([]);
    expect(world2.ownerItems()).toHaveLength(1);
    expect(world2.ownerItems()[0]!.why).toContain("Нужна правка кода");
    expect(world2.ownerItems()[0]!.why).toContain(change);
    expect(world2.ownerItems()[0]!.why).toContain("нет Lane Pilot");
  });

  it("keeps the line when the road refuses or fails, and tries again at the next run because nothing was handed over", async () => {
    const refused = world({ handOver: async () => ({ started: false, kind: "question", reason: "the text reads as question, not as work to build" }) });
    const first = await refused.runOnce(T1, report({ codeChange: change }));
    expect((first.polled as { output: string }).output).not.toContain("HAND-OVER");
    expect(refused.ownerItems()[0]!.why).toContain("Lane Pilot её не взял: the text reads as question");
    await refused.runOnce(T2, report({ codeChange: change }));
    expect(refused.calls.handOver).toHaveLength(2);
    const broken = world({ handOver: async () => { throw new Error("boom"); } });
    expect((await broken.runOnce(T1, report({ codeChange: change }))).polled).toMatchObject({ status: "succeeded" });
    expect(broken.ownerItems()[0]!.why).toContain("передача не удалась: boom");
  });

  it("hands over nothing when the agent names no code change", async () => {
    const w = world();
    await w.runOnce(T1, report());
    expect(w.calls.handOver).toEqual([]);
  });
});

describe("PhaseIntake.handOver", () => {
  function intake(options: { text?: string; live?: boolean; settings?: Record<string, unknown> } = {}) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "lprun_1", "p1", "cli");
    setRunThread(db, "lprun_1", "thr_pm");
    const opened: Array<Record<string, any>> = [], started: Array<Record<string, any>> = [];
    const phases = {
      open: async (args: Record<string, any>) => { opened.push(args); return { id: "ph_1" } as never; },
      tick: async () => 0,
      list: () => (options.live ? [{ id: "ph_live" }] as never : []),
      status: () => ({ next: { text: "" } }),
    };
    const train = { start: (args: Record<string, any>) => { started.push(args); return `wfrun_${started.length}`; }, status: () => null };
    const kv = new Map<string, unknown>();
    const ctx = {
      bb: { storage: { kv: { get: async (key: string) => kv.get(key) ?? null, set: async (key: string, value: unknown) => { kv.set(key, value); } } }, sdk: { threads: { events: { list: async () => [] } } } },
      db, effectiveProjectSettings: async () => ({ values: options.settings ?? {} }), log: () => undefined,
    } as never;
    return { handOver: createPhaseIntake(ctx, phases as never, train as never).handOver, opened, started };
  }
  const base = { projectId: "p1", pmThreadId: "thr_pm", runId: "lprun_1", key: "schedule:k1", origin: "Work found by the scheduled agent x; source: schedule." };

  it("sends a small change down issue-quick with the origin in the text, and the key makes the start the request id", async () => {
    const world1 = intake();
    const result = await world1.handOver({ ...base, text: "Add the canonical tag to /pricing." });
    expect(result).toEqual({ started: true, via: "issue-quick", id: "wfrun_1" });
    expect(world1.started[0]).toMatchObject({ projectId: "p1", pmThreadId: "thr_pm", runId: "lprun_1", requestId: "schedule:k1", kind: "small" });
    expect(world1.started[0]!.text).toMatch(/^Work found by the scheduled agent x; source: schedule\.\n\nAdd the canonical tag/);
  });

  it("opens a phase for a heavy goal, unless one is already live, and refuses what is no work", async () => {
    const heavy = "Redesign the whole pricing section with a new plan comparison, a calculator and a migration of the old plans. ".repeat(12);
    const open = intake();
    expect(await open.handOver({ ...base, text: heavy })).toEqual({ started: true, via: "phase", id: "ph_1" });
    expect(open.opened[0]).toMatchObject({ projectId: "p1", pmThreadId: "thr_pm", rails: true });
    expect(open.opened[0]!.goal).toContain("source: schedule");
    const busy = intake({ live: true });
    expect(await busy.handOver({ ...base, text: heavy })).toMatchObject({ started: false, reason: expect.stringContaining("ph_live") });
    expect(busy.opened).toEqual([]);
    expect(await intake().handOver({ ...base, text: "Is the canonical tag on /pricing?" })).toMatchObject({ started: false, kind: "question" });
    expect(await intake({ settings: { "phase.train": "off" } }).handOver({ ...base, text: "Add the canonical tag." })).toMatchObject({ started: false, reason: expect.stringContaining("off") });
    expect(await intake().handOver({ ...base, runId: "gone", text: "Add the canonical tag." })).toMatchObject({ started: false });
  });
});

describe("create by text", () => {
  it("teaches the project manager (tool instructions) and the owner (examples) that «the SEO specialist checks positions every Monday at 9» is an agent task", async () => {
    const { readFileSync } = await import("node:fs");
    const tool = readFileSync("src/rooms/schedule/server/schedule-tools.ts", "utf8");
    expect(tool).toContain("{kind:'agent', agentId, task, authorized, accounts, historyRuns?");
    const { en, ru } = await import("@lane-pilot/i18n");
    expect(en.schTextExamples).toContain("SEO specialist checks positions every Monday at 9:00");
    expect(ru.schTextExamples).toContain("SEO-специалист каждый понедельник в 9:00 проверяет позиции и решает, что улучшить");
  });
});
