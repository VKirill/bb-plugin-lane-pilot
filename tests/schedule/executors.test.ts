import { beforeEach, describe, expect, it, vi } from "vitest";

const observe = vi.hoisted(() => ({ result: { kind: "observing", detail: "" } as { kind: string; detail?: string; via?: string } }));
vi.mock("@lane-pilot/thread-observe", () => ({ observeStageChild: async () => observe.result }));

import Database from "better-sqlite3";
import { createScheduleExecutors } from "../../src/server/schedule-executors";
import type { ExecutorInput } from "../../src/schedule/scheduler";
import type { RunRow, ScheduleRow } from "../../src/schedule/store";

const schedule = { id: "sch_1", project_id: "p1", name: "Nightly check", timeout_sec: 600 } as ScheduleRow;
const run = (extra: Partial<RunRow> = {}) => ({ id: "srun_1", schedule_id: "sch_1", run_key: "sch_1:1790000000000", scheduled_at: 1_790_000_000_000, ref_id: null, ...extra }) as RunRow;
const input = (task: ExecutorInput["task"], extra: Partial<RunRow> = {}): ExecutorInput => ({ schedule, task, run: run(extra) });

function settingsDb(rows: Record<string, unknown> = {}) {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE lane_pilot_project_settings (project_id TEXT, binding_id TEXT, key TEXT, value TEXT, version INTEGER, updated_at INTEGER)");
  for (const [key, value] of Object.entries(rows)) db.prepare("INSERT INTO lane_pilot_project_settings VALUES (?,?,?,?,1,0)").run(key.startsWith("*:") ? "*" : "p1", "", key.replace(/^\*:/, ""), JSON.stringify(value));
  return db;
}

function world(options: { settings?: Record<string, unknown>; pm?: { providerId: string; model: string } | null } = {}) {
  const calls = { workflowStart: [] as Array<Record<string, any>>, errandStart: [] as Array<Record<string, any>>, resolve: [] as Array<Record<string, any>>, cancel: [] as string[], stopped: [] as string[] };
  const summaries = new Map<string, Record<string, any>>();
  let pm: { pmThreadId: string; runId: string } | null = { pmThreadId: "thr_pm", runId: "lprun_1" };
  const ctx = {
    bb: { sdk: { threads: { stop: async ({ threadId }: { threadId: string }) => { calls.stopped.push(threadId); }, defaultExecutionOptions: async () => (options.pm ? options.pm : {}) } }, log: { warn: () => undefined } },
    db: settingsDb(options.settings), host: {}, secrets: {},
  } as never;
  const services = {
    workflowTriggers: {
      pmOf: () => pm,
      start: async (args: Record<string, any>) => { calls.workflowStart.push(args); return args.workflowId === "missing" ? { ok: false, reason: "unknown_workflow", message: "There is no workflow \"missing\"." } : { ok: true, runId: "wfrun_1", created: true, status: "running", notChecked: [] }; },
    },
    workflowEngine: { get: (id: string) => summaries.get(id) ?? null, cancel: (id: string) => { calls.cancel.push(id); return true; } },
    errands: {
      resolveAccounts: async (args: Record<string, any>) => { calls.resolve.push(args); return args.names.includes("BAD") ? { ok: false, blocked: { reason: "waiting_secret:BAD", fix: ["BAD: not allowed"] } } : { ok: true, accounts: args.names.map((name: string) => ({ name, kind: "login" })) }; },
      startErrand: async (args: Record<string, any>) => { calls.errandStart.push(args); return { threadId: "thr_errand", browserMachine: "mini" }; },
      completedReport: async () => ({ state: "done" as const, output: "Checked.\nERRAND: done" }),
    },
  } as never;
  return { calls, summaries, executors: createScheduleExecutors(ctx, services), setPm: (value: typeof pm) => { pm = value; } };
}

beforeEach(() => { observe.result = { kind: "observing", detail: "" }; });

describe("the workflow executor", () => {
  const task = { kind: "workflow" as const, workflowId: "weekly-digest", inputs: { query: "cats" } };

  it("starts the run keyed by the schedule's run key and follows its status", async () => {
    const { executors, calls, summaries } = world();
    const ref = await executors.workflow.start(input(task));
    expect(ref).toEqual({ refKind: "workflow_run", refId: "wfrun_1" });
    expect(calls.workflowStart[0]).toMatchObject({ projectId: "p1", workflowId: "weekly-digest", inputs: { query: "cats" }, source: "manual", key: "sch_1:1790000000000", origin: "schedule" });
    const polled = (summary: Record<string, any> | null) => { if (summary) summaries.set("wfrun_1", summary); else summaries.delete("wfrun_1"); return executors.workflow.poll(input(task, { ref_id: "wfrun_1" })); };
    expect(await polled({ status: "running", waiting: [] })).toEqual({ state: "running" });
    expect(await polled({ status: "interrupted", waiting: [] })).toEqual({ state: "running" });
    expect(await polled({ status: "waiting", waiting: [{ nodeId: "approve" }] })).toEqual({ state: "waiting", note: "approve" });
    expect(await polled({ status: "succeeded", output: { sent: true }, waiting: [] })).toMatchObject({ state: "done", status: "succeeded", output: expect.stringContaining('"sent": true') });
    expect(await polled({ status: "failed", error: "send failed", failedNode: "send", waiting: [] })).toMatchObject({ state: "done", status: "failed", error: "send failed", reason: "failed at send" });
    expect(await polled({ status: "canceled", reason: "canceled", error: null, waiting: [] })).toMatchObject({ state: "done", status: "failed" });
    expect(await polled(null)).toMatchObject({ state: "done", status: "failed", error: expect.stringContaining("gone") });
  });

  it("a refused start throws with the reason, so the run fails with it", async () => {
    const { executors } = world();
    await expect(executors.workflow.start(input({ ...task, workflowId: "missing" }))).rejects.toThrow(/unknown_workflow: There is no workflow/);
  });

  it("cancel stops the workflow run", async () => {
    const { executors, calls } = world();
    await executors.workflow.cancel(input(task, { ref_id: "wfrun_1" }));
    expect(calls.cancel).toEqual(["wfrun_1"]);
  });
});

describe("the errand executor", () => {
  const task = { kind: "errand" as const, task: "Check the open invoices in Elba and report the total.", authorized: false, accounts: ["ELBA_LOGIN"], model: "claude-opus-5-5", reasoning: "high" as const };

  it("starts a helper thread under the project's PM chat, marked as started by a schedule, with an idempotent spawn id", async () => {
    const { executors, calls } = world();
    const ref = await executors.errand.start(input(task));
    expect(ref).toEqual({ refKind: "thread", refId: "thr_errand", hostId: "mini" });
    expect(calls.resolve[0]).toMatchObject({ projectId: "p1", runId: "lprun_1", pmThreadId: "thr_pm", names: ["ELBA_LOGIN"] });
    const started = calls.errandStart[0]!;
    expect(started).toMatchObject({ projectId: "p1", runId: "lprun_1", pmThreadId: "thr_pm", authorized: false, providerId: "claude-code", model: "claude-opus-5-5", reasoning: "high",
      spawnId: "schedule:sch_1:1790000000000", metadata: { origin: "schedule", scheduleId: "sch_1", scheduleRunKey: "sch_1:1790000000000" } });
    expect(started.task).toContain("This is a scheduled run of «Nightly check»");
    expect(started.task).toContain("ERRAND: blocked");
    expect(started.task).toContain("Check the open invoices in Elba");
  });

  const bare = { kind: "errand" as const, task: "Check the open invoices in Elba and report the total.", authorized: false, accounts: [] as string[] };

  it("starts on the built-in errand model when nothing names one", async () => {
    const { executors, calls } = world();
    await executors.errand.start(input(bare));
    expect(calls.errandStart[0]).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", reasoning: "high" });
    expect(calls.errandStart[0]!.serviceTier).toBeUndefined();
  });

  it("passes the provider, model, effort and fast mode of the task's own pair to the errand start", async () => {
    const { executors, calls } = world();
    await executors.errand.start(input({ ...bare, providerId: "codex", model: "gpt-6-luna", reasoning: "medium", serviceTier: "fast" }));
    expect(calls.errandStart[0]).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoning: "medium", serviceTier: "fast" });
  });

  it("starts on the Automation default of the project, over the global one, and on a preset of the task over both", async () => {
    const { executors, calls } = world({ settings: { "schedule.errand_default": { provider: "codex", model: "gpt-6-luna", reasoning_effort: "low" }, "*:schedule.errand_default": { preset: "strong" } } });
    await executors.errand.start(input(bare));
    expect(calls.errandStart[0]).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoning: "low" });
    await executors.errand.start(input({ ...bare, preset: "cheap-fast" }));
    expect(calls.errandStart[1]).toMatchObject({ providerId: "claude-code", model: "claude-haiku-5-5", reasoning: "low" });
  });

  it("uses the global Automation default when the project has none", async () => {
    const { executors, calls } = world({ settings: { "*:schedule.errand_default": { preset: "ins-psychology" } } });
    await executors.errand.start(input(bare));
    expect(calls.errandStart[0]).toMatchObject({ providerId: "codex", model: "gpt-5.6-luna", reasoning: "max" });
  });

  it("fails with the reason when there is no PM chat or an account is not allowed", async () => {
    const { executors, setPm } = world();
    setPm(null);
    await expect(executors.errand.start(input(task))).rejects.toThrow(/no_pm_chat/);
    setPm({ pmThreadId: "thr_pm", runId: "lprun_1" });
    await expect(executors.errand.start(input({ ...task, accounts: ["BAD"] }))).rejects.toThrow(/waiting_secret:BAD: BAD: not allowed/);
  });

  it("follows the thread: running, done with the report, failed on a product failure", async () => {
    const { executors } = world();
    expect(await executors.errand.poll(input(task, { ref_id: "thr_errand" }))).toEqual({ state: "running" });
    observe.result = { kind: "completed" };
    expect(await executors.errand.poll(input(task, { ref_id: "thr_errand" }))).toMatchObject({ state: "done", status: "succeeded", output: expect.stringContaining("ERRAND: done") });
    observe.result = { kind: "product_failure", via: "error", detail: "provider limit" };
    expect(await executors.errand.poll(input(task, { ref_id: "thr_errand" }))).toMatchObject({ state: "done", status: "failed", error: expect.stringContaining("provider limit") });
  });

  it("a helper that ended blocked fails the run with its reason", async () => {
    const { executors } = world();
    const services = { errands: { completedReport: async () => ({ state: "blocked", reason: "page asks for a password", output: "ERRAND: blocked: page asks for a password" }) } };
    const blocked = createScheduleExecutors({ bb: { sdk: {} }, db: {} } as never, services as never);
    observe.result = { kind: "completed" };
    expect(await blocked.errand.poll(input(task, { ref_id: "thr_errand" }))).toMatchObject({ state: "done", status: "failed", error: "page asks for a password", reason: "blocked" });
    void executors;
  });

  it("cancel stops the thread", async () => {
    const { executors, calls } = world();
    await executors.errand.cancel(input(task, { ref_id: "thr_errand" }));
    expect(calls.stopped).toEqual(["thr_errand"]);
  });
});
