import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { createRun, openDatabase, setRunThread } from "../../src/database";

/**
 * What the detail view and the cards read from the server: who runs an errand and from where that comes, the cost per run, where the task
 * runs (project, Project Folders section, machine, folder), the Automation default and its settings plumbing, and the history of a run
 * with its model, cost and machine. Whole plugin on the fake host, as tests/schedule/board.test.ts.
 */
const projectId = "proj_detail";
let dispose: (() => Promise<void> | void) | null = null;
afterEach(async () => { await dispose?.(); dispose = null; });

const sections = [
  { id: "sec_root", projectId, parentId: null, name: "Marketing", path: "/work/selfy/marketing", hostId: "h1", kind: "folder" as const },
  { id: "sec_deep", projectId, parentId: "sec_root", name: "Ads", path: "/work/selfy/marketing/ads", hostId: "h1", kind: "folder" as const },
];

async function setup(options: { threadSectionId?: string | null; noSdkProject?: boolean } = {}) {
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      hosts: { list: async () => [{ id: "h1", name: "Mac mini", status: "connected" }, { id: "h2", name: "Hub", status: "connected" }] },
      projects: { get: async () => (options.noSdkProject ? null : { id: projectId, name: "SelfyStudio", sources: [{ hostId: "h2", path: "/srv/selfy" }] }) },
      plugins: { list: async () => [], callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
        if (pluginId === "project-folders" && method === "sections_list") return { sections };
        throw new Error(`unexpected rpc ${pluginId}.${method}`);
      } },
      threads: {
        getPluginMetadata: async () => ({}),
        get: async ({ threadId }: { threadId: string }) => (threadId === "thr_pm"
          ? { id: threadId, status: "idle", projectId, environmentId: "env_pm", sectionId: options.threadSectionId ?? null }
          : { id: threadId, status: "idle", projectId, environmentId: "env_pm" }),
        defaultExecutionOptions: async () => ({ providerId: "claude-code", model: "claude-opus-5-5" }),
      },
      environments: { get: async () => ({ id: "env_pm", hostId: "h1", path: "/work/selfy/marketing/ads/site" }) },
    } as never,
  });
  (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = () => undefined;
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  createRun(db, "lprun_d", projectId, "cli");
  setRunThread(db, "lprun_d", "thr_pm");
  const rpc = async (name: string, params: Record<string, unknown>) => await harness.behavior.callRpc(name, params) as Record<string, any>;
  const tool = async (params: Record<string, unknown>) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_schedule", params, { threadId: "thr_pm", projectId }))) as Record<string, any>;
  return { rpc, tool, db };
}

const when = { type: "cron", cron: "0 9 * * 1-5", timezone: "UTC" };
const errand = (extra: Record<string, unknown> = {}) => ({ projectId, name: "Leads", task: { kind: "errand", task: "Open the CRM and report the new leads.", ...extra }, when });
const script = (extra: Record<string, unknown> = {}) => ({ projectId, name: "Sync", task: { kind: "script", hostId: "h1", command: "echo hi", cwd: "/tmp/sync", env: [], ...extra }, when });
const cursorSql = "INSERT INTO lane_pilot_token_cursor (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)";
const tokens = (input: number, output: number) => JSON.stringify({ input, output, cached: 0, total: input + output, cacheRead: 0, cacheWrite: 0 });

describe("schedule_list: who runs it", () => {
  it("an errand with no model resolves to the built-in errand role; a script and a chain have no model", async () => {
    const { rpc } = await setup();
    const made = (await rpc("schedule_upsert", { definition: errand() })).schedule;
    expect(made.model).toEqual({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", serviceTier: null, source: "errand-role", sourceKey: null, issues: [] });
    expect((await rpc("schedule_upsert", { definition: script() })).schedule.model).toBeNull();
    expect((await rpc("schedule_upsert", { definition: script() })).schedule.cost).toBeNull();
  });

  it("the task's own pair, a preset and the legacy model each show their source", async () => {
    const { rpc } = await setup();
    const pair = (await rpc("schedule_upsert", { definition: errand({ providerId: "codex", model: "gpt-6-luna", reasoning: "low", serviceTier: "fast" }) })).schedule;
    expect(pair.model).toMatchObject({ providerId: "codex", model: "gpt-6-luna", reasoningEffort: "low", serviceTier: "fast", source: "task" });
    const preset = (await rpc("schedule_upsert", { definition: errand({ preset: "cheap-fast" }) })).schedule;
    expect(preset.model).toMatchObject({ model: "claude-haiku-5-5", source: "preset", sourceKey: "cheap-fast" });
    const legacy = (await rpc("schedule_upsert", { definition: errand({ model: "claude-sonnet-5-5", reasoning: "medium" }) })).schedule;
    expect(legacy.model).toMatchObject({ providerId: "claude-code", model: "claude-sonnet-5-5", reasoningEffort: "medium", source: "task" });
  });

  it("refuses a provider without a model and an unknown preset, with the problem named", async () => {
    const { rpc } = await setup();
    expect((await rpc("schedule_upsert", { definition: errand({ providerId: "codex" }) })).problems.join(" ")).toMatch(/provider needs a model/);
    expect((await rpc("schedule_upsert", { definition: errand({ preset: "nope" }) })).problems.join(" ")).toMatch(/no model preset "nope" \(known: cheap-fast/);
  });

  it("follows the Automation default of the project over the global one, and 'inherit' lets the global one show again", async () => {
    const { rpc } = await setup();
    const made = (await rpc("schedule_upsert", { definition: errand() })).schedule;
    let listed = await rpc("schedule_list", { projectId });
    expect(listed.errandDefault).toEqual({ effective: null, source: null, project: null, global: null, projectVersion: 0, globalVersion: 0 });

    const global = await rpc("save_setting", { projectId: "*", key: "schedule.errand_default", value: { preset: "ins-digest" }, expectedVersion: 0 });
    expect(global).toMatchObject({ ok: true, version: 1 });
    listed = await rpc("schedule_list", { projectId });
    expect(listed.errandDefault).toMatchObject({ effective: { preset: "ins-digest" }, source: "global", project: null, global: { preset: "ins-digest" }, projectVersion: 0, globalVersion: 1 });
    expect(listed.schedules[0].model).toMatchObject({ model: "claude-sonnet-5", source: "schedule-default", sourceKey: "schedule.errand_default" });
    // The global page lists with no project: it shows and edits the global level only.
    expect((await rpc("schedule_list", {})).errandDefault).toMatchObject({ effective: { preset: "ins-digest" }, source: "global", project: null, projectVersion: 0 });

    const own = await rpc("save_setting", { projectId, key: "schedule.errand_default", value: { provider: "codex", model: "gpt-6-luna", reasoning_effort: "low" }, expectedVersion: 0 });
    expect(own).toMatchObject({ ok: true, version: 1 });
    listed = await rpc("schedule_list", { projectId });
    expect(listed.errandDefault).toMatchObject({ source: "project", effective: { provider: "codex", model: "gpt-6-luna", reasoning_effort: "low" }, projectVersion: 1, globalVersion: 1 });
    expect(listed.schedules[0].model).toMatchObject({ providerId: "codex", model: "gpt-6-luna", source: "schedule-default" });

    const reset = await rpc("reset_project_settings", { projectId, keys: ["schedule.errand_default"], expectedVersions: { "schedule.errand_default": 1 } });
    expect(reset.ok).toBe(true);
    listed = await rpc("schedule_list", { projectId });
    expect(listed.errandDefault).toMatchObject({ source: "global", project: null, effective: { preset: "ins-digest" } });
    expect((await rpc("schedule_get", { id: made.id })).schedule.model).toMatchObject({ model: "claude-sonnet-5" });
  });

  it("save_setting refuses an invalid default and says why", async () => {
    const { rpc } = await setup();
    const bad = await rpc("save_setting", { projectId, key: "schedule.errand_default", value: { provider: "codex" }, expectedVersion: 0 });
    expect(bad.ok).toBe(false);
    expect(bad.validation).toMatchObject({ code: "invalid_choice", key: "schedule.errand_default" });
    const badPreset = await rpc("save_setting", { projectId, key: "schedule.errand_default", value: { preset: "nope" }, expectedVersion: 0 });
    expect(badPreset.ok).toBe(false);
  });

  it("the PM tool echoes the model a created errand resolves to, and the stored task keeps none", async () => {
    const { tool, rpc } = await setup();
    await rpc("save_setting", { projectId, key: "schedule.errand_default", value: { preset: "ins-digest" }, expectedVersion: 0 });
    const created = await tool({ action: "create", definition: { name: "Leads", task: { kind: "errand", task: "Open the CRM and report the new leads.", authorized: false, accounts: [] }, when } });
    expect(created.state).toBe("created");
    expect(created.schedule.model).toEqual({ provider: "claude-code", model: "claude-sonnet-5", effort: "medium", source: "schedule-default" });
    const shown = await tool({ action: "show", id: created.schedule.id });
    expect(shown.schedule.task.model).toBeUndefined();
    expect(shown.schedule.task.providerId).toBeUndefined();
    const withModel = await tool({ action: "create", definition: { name: "Leads 2", task: { kind: "errand", task: "Open the CRM and report the new leads.", model: "claude-opus-5" }, when } });
    expect(withModel.schedule.model).toMatchObject({ model: "claude-opus-5", source: "task" });
  });
});

describe("schedule_list: cost per run", () => {
  it("the price of the resolved model with no history, the average of the runs with known usage after", async () => {
    const { rpc, db } = await setup();
    const made = (await rpc("schedule_upsert", { definition: errand() })).schedule;
    expect(made.cost).toEqual({ perRunUsd: null, samples: 0, priceInPer1M: 4, priceOutPer1M: 20 });
    const insertRun = db.prepare("INSERT INTO lane_pilot_schedule_run (id, schedule_id, run_key, scheduled_at, trigger, status, queued_at, ref_kind, ref_id) VALUES (?,?,?,?,?,?,?,?,?)");
    insertRun.run("srun_1", made.id, `${made.id}:1`, 1000, "tick", "succeeded", 1000, "thread", "thr_1");
    insertRun.run("srun_2", made.id, `${made.id}:2`, 2000, "tick", "succeeded", 2000, "thread", "thr_2");
    insertRun.run("srun_3", made.id, `${made.id}:3`, 3000, "tick", "succeeded", 3000, "thread", "thr_acp");
    db.prepare(cursorSql).run("thr_1", projectId, "claude-code", 1, "{}", tokens(1_000_000, 0), "claude-opus-5-5", "claude-code", "t", 0);
    db.prepare(cursorSql).run("thr_2", projectId, "claude-code", 1, "{}", tokens(0, 100_000), "claude-opus-5-5", "claude-code", "t", 0);
    const listed = await rpc("schedule_list", { projectId });
    expect(listed.schedules[0].cost).toEqual({ perRunUsd: 3, samples: 2, priceInPer1M: 4, priceOutPer1M: 20 });
  });

  it("a model without a price: no price and no cost", async () => {
    const { rpc } = await setup();
    const made = (await rpc("schedule_upsert", { definition: errand({ providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high" }) })).schedule;
    expect(made.cost).toEqual({ perRunUsd: null, samples: 0, priceInPer1M: null, priceOutPer1M: null });
  });
});

describe("schedule_list: where it runs", () => {
  it("an errand: the project, the section found by the chat's thread or by its folder, the machine's name and the folder", async () => {
    const { rpc } = await setup();
    const made = (await rpc("schedule_upsert", { definition: errand() })).schedule;
    // The thread carries no sectionId here, so the deepest folder holding the chat's environment is the section.
    expect(made.where).toEqual({ projectName: "SelfyStudio", sectionId: "sec_deep", sectionName: "Ads", sectionPath: "/work/selfy/marketing/ads", hostId: "h1", hostName: "Mac mini", cwd: "/work/selfy/marketing/ads/site" });
  });

  it("the thread's own section id wins over the folder match", async () => {
    const { rpc } = await setup({ threadSectionId: "sec_root" });
    const made = (await rpc("schedule_upsert", { definition: errand() })).schedule;
    expect(made.where).toMatchObject({ sectionId: "sec_root", sectionName: "Marketing", sectionPath: "/work/selfy/marketing" });
  });

  it("a script names its own machine and folder; the project and section are the chat's", async () => {
    const { rpc } = await setup();
    const made = (await rpc("schedule_upsert", { definition: script({ hostId: "h2" }) })).schedule;
    expect(made.where).toMatchObject({ projectName: "SelfyStudio", sectionName: "Ads", hostId: "h2", hostName: "Hub", cwd: "/tmp/sync" });
  });

  it("without BB's project record or a PM chat the fields are null, not invented", async () => {
    const { rpc } = await setup({ noSdkProject: true });
    const made = (await rpc("schedule_upsert", { definition: script() })).schedule;
    expect(made.where).toMatchObject({ projectName: null, hostId: "h1", hostName: "Mac mini", cwd: "/tmp/sync" });
  });
});

describe("schedule_runs: model, cost and machine of each run", () => {
  it("fills them from the run thread, says unknown without usage, and names the machine the thread ran on", async () => {
    const { rpc, db } = await setup();
    const made = (await rpc("schedule_upsert", { definition: errand() })).schedule;
    const insertRun = db.prepare("INSERT INTO lane_pilot_schedule_run (id, schedule_id, run_key, scheduled_at, trigger, status, queued_at, ref_kind, ref_id, host_id) VALUES (?,?,?,?,?,?,?,?,?,?)");
    insertRun.run("srun_a", made.id, `${made.id}:1`, 1000, "tick", "succeeded", 1000, "thread", "thr_a", "h2");
    insertRun.run("srun_b", made.id, `${made.id}:2`, 2000, "tick", "succeeded", 2000, "thread", "thr_b", "h2");
    insertRun.run("srun_c", made.id, `${made.id}:3`, 3000, "tick", "succeeded", 3000, "workflow_run", "wfrun_1", null);
    db.prepare(cursorSql).run("thr_a", projectId, "claude-code", 1, "{}", tokens(1_000_000, 100_000), "claude-opus-5-5", "claude-code", "t", 0);
    const { runs } = await rpc("schedule_runs", { id: made.id });
    const byId = Object.fromEntries(runs.map((run: { id: string }) => [run.id, run]));
    expect(byId.srun_a).toMatchObject({ providerId: "claude-code", model: "claude-opus-5-5", tokens: 1_100_000, costUsd: 6, usageKnown: true });
    expect(byId.srun_b).toMatchObject({ model: null, tokens: null, costUsd: null, usageKnown: false });
    // The errand ran in the PM chat's environment (host h1), not on the Browser QA machine stored in `hostId` (h2).
    expect(byId.srun_a.hostName).toBe("Mac mini");
    expect(byId.srun_a.hostId).toBe("h2");
    expect(byId.srun_c).toMatchObject({ usageKnown: false, hostName: null });
    expect((await rpc("schedule_get", { id: made.id })).runs).toHaveLength(3);
  });

  it("a script run shows the machine of its host job", async () => {
    const { rpc, db } = await setup();
    const made = (await rpc("schedule_upsert", { definition: script() })).schedule;
    db.prepare("INSERT INTO lane_pilot_schedule_run (id, schedule_id, run_key, scheduled_at, trigger, status, queued_at, ref_kind, ref_id, host_id) VALUES ('srun_s', ?, ?, 1, 'tick', 'succeeded', 1, 'host_job', 'job_1', 'h1')").run(made.id, `${made.id}:1`);
    const { runs } = await rpc("schedule_runs", { id: made.id });
    expect(runs[0]).toMatchObject({ hostName: "Mac mini", usageKnown: false, model: null });
  });
});
