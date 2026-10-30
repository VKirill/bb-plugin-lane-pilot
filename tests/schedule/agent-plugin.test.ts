import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { normalizeSchedule } from "../../src/rooms/schedule/model";
import { createScheduleStore, scheduleAgentMigrations } from "../../src/rooms/schedule/store";
import { createRun, migrations, openDatabase, setRunThread } from "../../src/rooms/storage/database";

/**
 * A scheduled agent through the whole plugin: the schedule is made through the PM tool, the tick starts the agent's own profile in a
 * hidden thread with the history in its first message, the outcome is stored for the next run, and the thread cannot touch schedules.
 */
const projectId = "proj_agent";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

/** The agent's answer: findings, then the typed fields of the routine graph's agent step as the engine reads them (one fenced JSON block). */
const OUTCOME = (summary: string, extra: Record<string, unknown> = {}) => `Checked the positions.\n\n\`\`\`json\n${JSON.stringify({ report: "Looked at the positions.", summary, decision: "queued a title test", follow_ups: "re-check next Monday", code_change: "", urgent: false, status: "done", blocked_reason: "", handoff: "done", ...extra })}\n\`\`\``;

async function setup(options: { pm?: boolean } = {}) {
  const spawned: Array<Record<string, any>> = [];
  const registered = new Map<string, (context: { signal: AbortSignal }) => unknown>();
  const state = { report: OUTCOME("first look") };
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: { requestedHostId: string; cwd: string } }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host call ${call.method}`);
    }) as never,
    sdk: {
      hosts: { list: async () => [{ id: "local-host", name: "Local", status: "connected" }] },
      plugins: { list: async () => [], callRpc: async () => { throw new Error("no catalog"); } },
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => threadId === "thr_pm" ? { role: "pm", lanePilotRunId: "lprun_a" }
          : threadId.startsWith("thr_agent_") ? { origin: "schedule", role: "specialist" } : {},
        spawn: async (args: Record<string, any>) => { spawned.push(args); return { id: `thr_agent_${spawned.length}` }; },
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId, environmentId: "env-pm", sectionId: "sec_1", sourceThreadId: "thr_pm", lifecycleOwnerThreadId: "thr_pm" }),
        events: { list: async ({ threadId }: { threadId: string }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
        output: async () => ({ output: state.report }),
        stop: async () => ({}),
        send: async () => ({}),
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local-host", path: process.cwd(), status: "ready" }) },
      projects: { get: async () => ({ id: projectId, name: "Site", sources: [{ hostId: "local-host", path: process.cwd() }] }) },
    } as never,
  });
  (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, _cron: string, fn: (context: { signal: AbortSignal }) => unknown) => { registered.set(name, fn); };
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  if (options.pm !== false) {
    createRun(db, "lprun_a", projectId, "cli");
    setRunThread(db, "lprun_a", "thr_pm");
  }
  const rpc = async (name: string, params: Record<string, unknown>) => await harness.behavior.callRpc(name, params) as Record<string, any>;
  const tool = async (params: Record<string, unknown>, threadId = "thr_pm") => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_schedule", params, { threadId, projectId }))) as Record<string, any>;
  const tick = async () => { await registered.get("schedule-board-tick")!({ signal: new AbortController().signal }); };
  const kv = async (key: string) => await bb.storage.kv.get<Record<string, any>>(key);
  return { rpc, tool, tick, db, spawned, state, kv, bb };
}

const definition = (extra: Record<string, unknown> = {}) => ({
  name: "SEO positions", description: "weekly",
  task: { kind: "agent", agentId: "seo-specialist", task: "Check the positions of the main queries in Yandex and decide what to improve this week.", accounts: [] },
  when: { type: "cron", cron: "0 9 * * 1", timezone: "Europe/Moscow" }, ...extra,
});

describe("a scheduled agent", () => {
  it("is created through the PM tool and the CLI, and listed with the agent's name for the picker", async () => {
    const { tool, rpc } = await setup();
    const made = await tool({ action: "create", definition: definition() });
    expect(made).toMatchObject({ state: "created", schedule: { name: "SEO positions", kind: "agent", model: null } });
    expect(await tool({ action: "create", definition: definition({ name: "Ghost", task: { kind: "agent", agentId: "ghost-agent", task: "Do something regularly and report." } }) })).toMatchObject({ state: "invalid", problems: [expect.stringMatching(/task\.agentId: there is no agent "ghost-agent"/)] });
    const shown = await tool({ action: "show", id: made.schedule.id });
    expect(shown.schedule.task).toMatchObject({ kind: "agent", agentId: "seo-specialist", authorized: false, historyRuns: 5 });
    const agents = (await rpc("schedule_agents", {})).agents as Array<{ id: string; displayName: string }>;
    expect(agents.find((agent) => agent.id === "seo-specialist")).toMatchObject({ displayName: "SEO specialist" });
    expect(agents.map((agent) => agent.id)).toContain("copy-lead");
  });

  it("starts the agent's own profile in a hidden parentless thread marked by the schedule, with the history of its earlier runs", async () => {
    const { tool, rpc, tick, spawned, state, db, kv } = await setup();
    const made = await tool({ action: "create", definition: definition() });
    const id = made.schedule.id as string;

    expect((await rpc("schedule_run_now", { id, key: "one" })).ok).toBe(true);
    await tick();
    expect(spawned).toHaveLength(1);
    const first = spawned[0]!;
    expect(first.visibility).toBe("hidden");
    expect(first.parentThreadId).toBeUndefined();
    expect(first.pluginMetadata).toMatchObject({ role: "specialist", specialist: "seo-specialist", origin: "schedule", lanePilotRunId: "lprun_a", lanePilotWorkflowNode: "work", lanePilotWorkflowRunId: expect.stringMatching(/^wfrun_/) });
    expect(first.prompt).toMatch(/^.*lane-pilot.*\nNative Lane profile seo-specialist/s);
    expect(first.prompt).toContain("Check the positions of the main queries in Yandex");
    expect(first.prompt).toContain("no previous runs to read");
    const marker = /native-selection[^\s]*|([0-9a-f]{8}-[0-9a-f-]{27})/u.exec(first.prompt)?.[1] ?? "";
    expect(marker).not.toBe("");
    // The profile is the one a chat started with that agent from the composer gets, and it belongs to the PM's run (it opens none of its own).
    expect(await kv(`native-selection:${marker}`)).toMatchObject({ agentId: "seo-specialist", projectId, parentRunId: "lprun_a" });

    let runs = (await rpc("schedule_runs", { id })).runs as Array<Record<string, any>>;
    expect(runs[0]).toMatchObject({ status: "succeeded", refKind: "workflow_run", refId: expect.stringMatching(/^wfrun_/), output: expect.stringContaining("summary: first look") });
    const items = db.prepare("SELECT source,kind,what,wake FROM lane_pilot_owner_item").all();
    expect(items).toEqual([{ source: "schedule", kind: "agent_outcome", what: "«SEO positions» (seo-specialist): first look", wake: 0 }]);

    state.report = OUTCOME("second look: two queries recovered");
    await rpc("schedule_run_now", { id, key: "two" });
    await tick();
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.prompt).toContain("<previous_runs>");
    expect(spawned[1]!.prompt).toContain("summary: first look");
    expect(spawned[1]!.prompt).toContain("follow-ups: re-check next Monday");
    runs = (await rpc("schedule_runs", { id })).runs;
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_owner_item").get()).toEqual({ n: 2 });
  });

  it("runs in a project without Lane Pilot: a hidden thread of the project in its own folder, no Lane Pilot run behind it, the report kept and one line on the owner's list", async () => {
    const { tool, rpc, tick, spawned, state, db } = await setup({ pm: false });
    state.report = OUTCOME("first look", { code_change: "Add the canonical tag to /pricing: the template omits it." });
    const made = await tool({ action: "create", definition: definition() });
    expect(made.warnings ?? []).not.toContainEqual(expect.stringContaining("PM chat"));
    const id = made.schedule.id as string;
    expect((await rpc("schedule_run_now", { id, key: "one" })).ok).toBe(true);
    await tick();
    expect(spawned).toHaveLength(1);
    const first = spawned[0]!;
    expect(first).toMatchObject({ visibility: "hidden", projectId, environment: { type: "host", hostId: "local-host", workspace: { type: "unmanaged", path: process.cwd() } } });
    expect(first.parentThreadId).toBeUndefined();
    expect(first.pluginMetadata).toMatchObject({ role: "specialist", specialist: "seo-specialist", origin: "schedule" });
    expect(first.pluginMetadata).not.toHaveProperty("lanePilotRunId");
    expect(first.prompt).toContain("This project does not use Lane Pilot");
    const runs = (await rpc("schedule_runs", { id })).runs as Array<Record<string, any>>;
    expect(runs[0]).toMatchObject({ status: "succeeded", output: expect.stringContaining("summary: first look") });
    const items = db.prepare("SELECT source,kind,what,why,wake FROM lane_pilot_owner_item").all() as Array<Record<string, any>>;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ source: "schedule", kind: "agent_outcome", wake: 0 });
    expect(items[0]!.why).toContain("Add the canonical tag to /pricing");
    expect(items[0]!.why).toContain("нет Lane Pilot");
  });

  it("fails the run with a clear reason, not a crash, when the agent no longer exists", async () => {
    const { tick, db, rpc, spawned } = await setup();
    const normalized = normalizeSchedule({ projectId, name: "Orphan", task: { kind: "agent", agentId: "ghost-agent", task: "Do something regularly and report." }, when: { type: "cron", cron: "0 9 * * 1", timezone: "UTC" } }, Date.now());
    if (!normalized.ok) throw new Error(normalized.problems.join(";"));
    const row = createScheduleStore(db).insert(normalized.value, { createdBy: "test", state: "active" });
    await rpc("schedule_run_now", { id: row.id, key: "x" });
    await tick();
    const run = ((await rpc("schedule_runs", { id: row.id })).runs as Array<Record<string, any>>)[0]!;
    expect(run).toMatchObject({ status: "failed" });
    expect(`${run.error} ${run.reason}`).toMatch(/unknown_specialist: there is no agent "ghost-agent"/);
    expect(spawned).toEqual([]);
  });

  it("holds the rule that a thread a schedule started cannot create or change schedules, for an agent's thread too", async () => {
    const { tool, rpc, tick } = await setup();
    const made = await tool({ action: "create", definition: definition() });
    const id = made.schedule.id as string;
    await rpc("schedule_run_now", { id, key: "one" });
    await tick();
    for (const params of [
      { action: "create", definition: definition({ name: "Successor" }) },
      { action: "update", id, changes: { name: "Renamed" } }, { action: "delete", id }, { action: "pause", id }, { action: "resume", id }, { action: "run_now", id },
    ]) {
      expect(await tool(params, "thr_agent_1"), JSON.stringify(params)).toMatchObject({ ok: false, error: { code: "schedule_origin" } });
    }
    expect((await rpc("schedule_get", { id })).schedule).toMatchObject({ state: "active", name: "SEO positions" });
    expect((await tool({ action: "list" }, "thr_agent_1")).schedules).toHaveLength(1);
  });
});

describe("the migration on a populated hub database", () => {
  it("keeps the schedules and their runs when the agent migration is applied on top of the old ones", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    db.pragma("foreign_keys = ON");
    bb.storage.migrate(db, migrations.slice(0, migrations.indexOf(scheduleAgentMigrations[0]!)));
    db.prepare(`INSERT INTO lane_pilot_schedule(id,project_id,name,description,kind,task_json,trigger_type,cron,timezone,timeout_sec,state,cursor_at,created_by,created_at,updated_at)
      VALUES ('sch_old','p','Old errand','','errand','{"kind":"errand","task":"read the mailbox every day"}','cron','0 9 * * *','UTC',3600,'active',5,'owner',1,1)`).run();
    db.prepare("INSERT INTO lane_pilot_schedule_run(id,schedule_id,run_key,scheduled_at,trigger,status,queued_at,output) VALUES ('srun_old','sch_old','sch_old:1',1,'tick','succeeded',1,'report')").run();
    openDatabase(bb);
    expect(db.prepare("SELECT id,kind,name FROM lane_pilot_schedule").all()).toEqual([{ id: "sch_old", kind: "errand", name: "Old errand" }]);
    expect(db.prepare("SELECT id,schedule_id,output FROM lane_pilot_schedule_run").all()).toEqual([{ id: "srun_old", schedule_id: "sch_old", output: "report" }]);
    const normalized = normalizeSchedule({ projectId: "p", name: "New agent", task: { kind: "agent", agentId: "seo-specialist", task: "Check the positions weekly." }, when: { type: "cron", cron: "0 9 * * 1", timezone: "UTC" } }, Date.now());
    if (!normalized.ok) throw new Error(normalized.problems.join(";"));
    expect(createScheduleStore(db).insert(normalized.value, { createdBy: "test", state: "active" }).kind).toBe("agent");
  });
});
