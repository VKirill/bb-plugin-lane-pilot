import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, saveProjectSetting, setRunThread } from "../../src/database";

/**
 * The schedule board through the whole plugin: the RPCs the board uses, the tick of the isolated schedule, a script that runs as a
 * host job with an Env Catalog secret, the PM tool with the owner's yes, the origin rule and the CLI.
 */
const projectId = "proj_board";
const SECRET = "s3cr3t-value-xyz";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

type HostCall = { method: string; input: Record<string, any> };

async function setup(options: { answer?: "1" | "2"; metadata?: Record<string, Record<string, unknown>>; failJob?: boolean } = {}) {
  const hostCalls: HostCall[] = [];
  const sent: Array<{ threadId: string; text: string }> = [];
  const registered = new Map<string, (context: { signal: AbortSignal }) => unknown>();
  let polls = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      hosts: { list: async () => [{ id: "h1", name: "Mac mini", status: "connected" }, { id: "h2", name: "Hub", status: "connected" }] },
      plugins: { list: async () => [], callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: { name?: string } }) => {
        if (pluginId !== "env-catalog") throw new Error(`unexpected rpc ${pluginId}.${method}`);
        if (method === "env_list") return { variables: [{ name: "MY_TOKEN", kind: "secret" }] };
        if (method === "env_get_value") return { name: input.name, kind: "secret", value: SECRET, access: null };
        throw new Error(`unexpected env-catalog ${method}`);
      } },
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => options.metadata?.[threadId] ?? {},
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId }),
        send: async (args: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, text: args.input[0]!.text }); return {}; },
      },
    } as never,
    experimental_callHostRpc: async (call) => {
      hostCalls.push({ method: call.method, input: call.input as Record<string, any> });
      if (call.method === "jobStart") return { hostId: "h1", jobId: "job_abcdefghij1" };
      if (call.method === "jobStatus") {
        polls += 1;
        const progress = { startedAt: 1, updatedAt: Date.now(), elapsedSec: 1, lastLine: "" };
        if (polls === 1) return { hostId: "h1", jobId: "job_abcdefghij1", state: "running", progress, error: null };
        return { hostId: "h1", jobId: "job_abcdefghij1", state: "succeeded", progress, error: null,
          result: { hostId: "h1", exitCode: options.failJob ? 1 : 0, stdout: `token=${SECRET}\ndone\n`, stderr: "", truncated: false, timedOut: false, durationMs: 5 } };
      }
      if (call.method === "jobCancel") return { hostId: "h1", jobId: "job_abcdefghij1", cancelled: true };
      throw new Error(`unexpected host call ${call.method}`);
    },
  });
  (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, _cron: string, fn: (context: { signal: AbortSignal }) => unknown) => { registered.set(name, fn); };
  Object.assign(bb.ui, { requestInput: async () => ({ outcome: "submitted", value: { choice: options.answer ?? "1" } }) });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  createRun(db, "lprun_b", projectId, "cli");
  setRunThread(db, "lprun_b", "thr_pm");
  saveProjectSetting(db, projectId, "secrets.allow", "MY_TOKEN");
  const rpc = async (name: string, params: Record<string, unknown>) => await harness.behavior.callRpc(name, params) as Record<string, any>;
  const tool = async (params: Record<string, unknown>, threadId = "thr_pm") => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_schedule", params, { threadId, projectId }))) as Record<string, any>;
  const tick = async () => { await registered.get("schedule-board-tick")!({ signal: new AbortController().signal }); };
  return { harness, rpc, tool, tick, db, hostCalls, registered, sent };
}

const script = (extra: Record<string, unknown> = {}) => ({
  projectId, name: "Sync keys", task: { kind: "script", hostId: "h1", command: "echo token=$MY_TOKEN", cwd: "/tmp", env: ["MY_TOKEN"] },
  when: { type: "cron", cron: "*/5 * * * *", timezone: "Europe/Madrid" }, ...extra,
});

describe("the RPCs of the board", () => {
  it("registers the tick as an isolated schedule and previews, creates and lists with the next fire times", async () => {
    const { rpc, registered } = await setup();
    expect(registered.has("schedule-board-tick")).toBe(true);
    const preview = await rpc("schedule_preview", { definition: script(), next: 4 });
    expect(preview).toMatchObject({ ok: true, problems: [] });
    expect(preview.nextFires).toHaveLength(4);
    expect(preview.nextFires[1] - preview.nextFires[0]).toBe(5 * 60_000);

    const bad = await rpc("schedule_upsert", { definition: script({ when: { type: "cron", cron: "61 * * * *", timezone: "Mars/Base" } }) });
    expect(bad.ok).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/minute|time zone/);
    const unknownHost = await rpc("schedule_upsert", { definition: { ...script(), task: { ...script().task, hostId: "nowhere" } } });
    expect(unknownHost.problems[0]).toMatch(/no machine "nowhere"/);

    const made = await rpc("schedule_upsert", { definition: script() });
    expect(made).toMatchObject({ ok: true });
    expect(made.schedule).toMatchObject({ name: "Sync keys", state: "active", column: "scheduled", machine: "h1", missed: "run_once", overlap: "skip", maxFailures: 3 });
    const listed = await rpc("schedule_list", { projectId, next: 3 });
    expect(listed.schedules).toHaveLength(1);
    expect(listed.schedules[0].nextFires).toHaveLength(3);
    expect(listed.hosts.map((host: { id: string }) => host.id)).toEqual(["h1", "h2"]);
  });

  it("warns when two tasks start together on one machine, and does not stop the save", async () => {
    const { rpc } = await setup();
    await rpc("schedule_upsert", { definition: script({ name: "First" }) });
    const second = await rpc("schedule_upsert", { definition: script({ name: "Second" }) });
    expect(second.ok).toBe(true);
    expect(second.conflicts).toHaveLength(1);
    expect(second.conflicts[0]).toMatchObject({ name: "First", machine: "h1", windowMinutes: 10 });
    expect(second.warnings.join(" ")).toMatch(/on h1: «First» starts within 10 min/);
    const elsewhere = await rpc("schedule_upsert", { definition: script({ name: "Third", task: { ...script().task, hostId: "h2" } }) });
    expect(elsewhere.conflicts).toEqual([]);
  });

  it("changes, pauses and resumes, and the calendar lists the planned times", async () => {
    const { rpc } = await setup();
    const made = (await rpc("schedule_upsert", { definition: script() })).schedule;
    const changed = await rpc("schedule_upsert", { definition: { ...script(), id: made.id, name: "Sync keys v2", when: { type: "cron", cron: "0 * * * *", timezone: "UTC" } } });
    expect(changed.schedule).toMatchObject({ id: made.id, name: "Sync keys v2" });
    const paused = await rpc("schedule_pause", { id: made.id, reason: "for the weekend" });
    expect(paused.schedule).toMatchObject({ state: "paused", column: "paused", pauseReason: "for the weekend", nextFires: [] });
    expect((await rpc("schedule_resume", { id: made.id })).schedule).toMatchObject({ state: "active", column: "scheduled" });
    const calendar = await rpc("schedule_calendar", { projectId, from: Date.now(), to: Date.now() + 3 * 3_600_000 });
    expect(calendar.planned.length).toBeGreaterThanOrEqual(2);
    expect(calendar.planned.every((row: { scheduleId: string }) => row.scheduleId === made.id)).toBe(true);
    expect((await rpc("schedule_delete", { id: made.id })).ok).toBe(true);
    expect((await rpc("schedule_get", { id: made.id })).schedule).toBeNull();
  });
});

describe("a failed scheduled run", () => {
  it("tells the PM chat once per failed run, before the schedule is paused, and the pause message names the pause (audit r4 item 16)", async () => {
    const { rpc, tick, sent } = await setup({ failJob: true });
    const made = (await rpc("schedule_upsert", { definition: script({ maxFailures: 2 }) })).schedule;
    await rpc("schedule_run_now", { id: made.id, key: "one" });
    await tick();
    await tick();
    expect(sent.filter((row) => row.threadId === "thr_pm")).toHaveLength(1);
    expect(sent[0]!.text).toContain("«Sync keys» failed");
    expect(sent[0]!.text).toContain("1 time in a row");
    expect(sent[0]!.text).not.toContain("is paused");
    await rpc("schedule_run_now", { id: made.id, key: "two" });
    await tick();
    await tick();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("2 times in a row and is paused");
  });
});

describe("a script on a machine", () => {
  it("runs as a host job keyed by the run, with the secret in its environment only, and the output comes back masked", async () => {
    const { rpc, tick, hostCalls } = await setup();
    const made = (await rpc("schedule_upsert", { definition: script() })).schedule;
    const queued = await rpc("schedule_run_now", { id: made.id, key: "first" });
    expect(queued).toMatchObject({ ok: true, created: true });
    expect((await rpc("schedule_run_now", { id: made.id, key: "first" })).created).toBe(false);
    await tick();
    const start = hostCalls.find((call) => call.method === "jobStart")!;
    expect(start.input).toMatchObject({ kind: "runScript", key: `${made.id}:manual:first`, input: { command: "echo token=$MY_TOKEN", cwd: "/tmp", env: { MY_TOKEN: SECRET } } });
    expect(hostCalls.filter((call) => call.method === "jobStart")).toHaveLength(1);
    const { runs } = await rpc("schedule_runs", { id: made.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "succeeded", trigger: "manual", exitCode: 0, refKind: "host_job", refId: "job_abcdefghij1", hostId: "h1" });
    expect(runs[0].output).toContain("token=***");
    expect(JSON.stringify(runs)).not.toContain(SECRET);
    const card = (await rpc("schedule_get", { id: made.id })).schedule;
    expect(card.lastRun.status).toBe("succeeded");
    await tick();
    expect(hostCalls.filter((call) => call.method === "jobStart")).toHaveLength(1);
  });

  it("a due cron tick becomes one run, however many times the tick looks", async () => {
    const { rpc, tick, db, hostCalls } = await setup();
    const made = (await rpc("schedule_upsert", { definition: script({ task: { kind: "script", hostId: "h1", command: "true", cwd: "/tmp", env: [] }, when: { type: "cron", cron: "* * * * *", timezone: "UTC" } }) })).schedule;
    // The schedule was created a moment ago; let two minutes pass for it.
    db.prepare("UPDATE lane_pilot_schedule SET cursor_at=cursor_at-120000 WHERE id=?").run(made.id);
    await tick();
    await tick();
    const { runs } = await rpc("schedule_runs", { id: made.id });
    expect(runs.filter((run: { trigger: string }) => run.trigger !== "manual").length).toBeGreaterThanOrEqual(1);
    expect(new Set(runs.map((run: { scheduledAt: number }) => run.scheduledAt)).size).toBe(runs.length);
    expect(hostCalls.filter((call) => call.method === "jobStart").length).toBe(runs.filter((run: { status: string }) => run.status !== "skipped").length);
  });

  it("fails the run with the reason when the secret was not allowed for the project", async () => {
    const { rpc, tick, db } = await setup();
    saveProjectSetting(db, projectId, "secrets.allow", "");
    const made = (await rpc("schedule_upsert", { definition: script() })).schedule;
    await rpc("schedule_run_now", { id: made.id });
    await tick();
    const run = (await rpc("schedule_runs", { id: made.id })).runs[0];
    expect(run).toMatchObject({ status: "failed", reason: "start_failed" });
    expect(run.error).toMatch(/MY_TOKEN/);
  });
});

describe("agents and the schedule", () => {
  it("creating asks the owner first and goes through on the second call after their yes", async () => {
    const { tool, rpc } = await setup();
    const definition = { name: "Morning check", task: { kind: "script", hostId: "h2", command: "uptime", cwd: "/tmp" }, when: { type: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Madrid" } };
    const first = await tool({ action: "create", definition });
    expect(first.state).toBe("waiting_owner");
    expect((await rpc("schedule_list", { projectId })).schedules).toHaveLength(0);
    await new Promise((wake) => setTimeout(wake, 30));
    const second = await tool({ action: "create", definition });
    expect(second.state).toBe("created");
    expect(second.schedule).toMatchObject({ name: "Morning check", kind: "script" });
    const saved = (await rpc("schedule_list", { projectId })).schedules[0];
    expect(saved.createdBy).toBe("agent:thr_pm");
    // The yes was for that one change: the same call again is a new question.
    expect((await tool({ action: "create", definition })).state).toBe("waiting_owner");
  });

  it("an owner's no leaves nothing behind, and the agent is told not to work around it", async () => {
    const { tool, rpc } = await setup({ answer: "2" });
    const definition = { name: "Nope", task: { kind: "script", hostId: "h2", command: "uptime", cwd: "/tmp" }, when: { type: "once", delay: "2h" } };
    await tool({ action: "create", definition });
    await new Promise((wake) => setTimeout(wake, 30));
    const again = await tool({ action: "create", definition });
    expect(again.state).toBe("waiting_owner");
    expect(again.message).toMatch(/declined/);
    expect((await rpc("schedule_list", { projectId })).schedules).toHaveLength(0);
  });

  it("an invalid definition is refused before the owner is asked", async () => {
    const { tool } = await setup();
    const result = await tool({ action: "create", definition: { name: "Bad", task: { kind: "script", hostId: "h1", command: "x", cwd: "/tmp" }, when: { type: "cron", cron: "61 * * * *", timezone: "UTC" } } });
    expect(result.state).toBe("invalid");
    expect(result.problems.join(" ")).toMatch(/minute/);
  });

  it("pause, resume and run now need no form; show gives the runs; update and delete ask", async () => {
    const { tool, rpc } = await setup();
    const made = (await rpc("schedule_upsert", { definition: script() })).schedule;
    expect((await tool({ action: "list" })).schedules.map((row: { id: string }) => row.id)).toEqual([made.id]);
    expect((await tool({ action: "pause", id: made.id, reason: "audit" })).schedule).toMatchObject({ state: "paused" });
    expect((await tool({ action: "resume", id: made.id })).schedule).toMatchObject({ state: "active" });
    expect((await tool({ action: "run_now", id: made.id })).status).toBe("queued");
    expect((await tool({ action: "show", id: made.id, runs: 3 })).runs).toHaveLength(1);
    expect((await tool({ action: "update", id: made.id, changes: { name: "Renamed" } })).state).toBe("waiting_owner");
    expect((await tool({ action: "delete", id: made.id })).state).toBe("waiting_owner");
    expect((await rpc("schedule_get", { id: made.id })).schedule.name).toBe("Sync keys");
  });

  it("a thread that a schedule started cannot create, change, pause, resume or run schedules, but may read", async () => {
    const { tool, rpc } = await setup({ metadata: { thr_sched: { role: "errand", origin: "schedule", scheduleId: "sch_x" } } });
    const made = (await rpc("schedule_upsert", { definition: script() })).schedule;
    for (const params of [
      { action: "create", definition: { name: "Child", task: { kind: "script", hostId: "h1", command: "x", cwd: "/tmp" }, when: { type: "once", delay: "1h" } } },
      { action: "update", id: made.id, changes: { name: "x" } }, { action: "delete", id: made.id },
      { action: "pause", id: made.id }, { action: "resume", id: made.id }, { action: "run_now", id: made.id },
    ]) {
      const result = await tool(params, "thr_sched");
      expect(result, JSON.stringify(params)).toMatchObject({ ok: false, error: { code: "schedule_origin" } });
    }
    expect((await rpc("schedule_get", { id: made.id })).schedule).toMatchObject({ state: "active", name: "Sync keys" });
    expect((await rpc("schedule_get", { id: made.id })).runTotal).toBe(0);
    expect((await tool({ action: "list" }, "thr_sched")).schedules).toHaveLength(1);
  });

  it("the origin rule follows the parent chain", async () => {
    const { tool, rpc } = await setup({ metadata: { thr_parent: { origin: "schedule" } } });
    const made = (await rpc("schedule_upsert", { definition: script() })).schedule;
    expect(await tool({ action: "pause", id: made.id }, "thr_parent")).toMatchObject({ error: { code: "schedule_origin" } });
  });
});

describe("bb lane-pilot schedule", () => {
  it("creates, lists, shows, pauses, runs, and deletes from the command line", async () => {
    const { harness } = await setup();
    const cli = async (...args: string[]) => await harness.behavior.runCli(["schedule", ...args]);
    const created = await cli("create", JSON.stringify(script()));
    expect(created.exitCode).toBe(0);
    const id = JSON.parse(String(created.stdout)).schedule.id as string;
    expect(String((await cli("list")).stdout)).toContain(id);
    expect(JSON.parse(String((await cli("list", "--json")).stdout)).schedules[0].name).toBe("Sync keys");
    expect(JSON.parse(String((await cli("show", id)).stdout)).schedule.task.kind).toBe("script");
    expect(JSON.parse(String((await cli("update", id, JSON.stringify({ name: "Renamed" }))).stdout)).schedule.name).toBe("Renamed");
    expect(JSON.parse(String((await cli("pause", id, "for", "now")).stdout)).schedule).toMatchObject({ state: "paused", pauseReason: "for now" });
    expect(JSON.parse(String((await cli("resume", id)).stdout)).schedule.state).toBe("active");
    expect(JSON.parse(String((await cli("run-now", id)).stdout))).toMatchObject({ ok: true, created: true });
    expect(String((await cli("history", id)).stdout)).toMatch(/queued|running|succeeded/);
    expect(JSON.parse(String((await cli("preview", JSON.stringify(script()))).stdout))).toMatchObject({ ok: true });
    const refused = await cli("create", JSON.stringify(script({ when: { type: "cron", cron: "x", timezone: "UTC" } })));
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(String(refused.stdout)).problems.join(" ")).toMatch(/cron/);
    expect(JSON.parse(String((await cli("delete", id)).stdout))).toEqual({ ok: true });
    expect((await cli("show", id)).exitCode).toBe(1);
  });
});
