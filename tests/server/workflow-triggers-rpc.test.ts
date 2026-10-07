import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../server";
import { createRun, openDatabase, setRunThread } from "../../src/database";
import { globalWorkflowDir } from "../../src/workflow/store";

/** The whole path of a schedule: a file in the owner's folder, its tests, the automation, the tick that starts it through the CLI, and the Run button's RPC. */
const projectId = "proj_sched";
const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "lp-sched-")); dirs.push(dir); return dir; };
let dispose: (() => Promise<void> | void) | null = null;
beforeEach(() => { vi.stubEnv("HOME", temp()); });
afterEach(async () => { await dispose?.(); dispose = null; vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const file = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1, id: "daily-digest", name: "Daily digest", description: { en: "A digest every morning", ru: "Сводка каждое утро" }, status: "published",
  inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
  nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.query" } }],
  edges: [{ from: "start", to: "done" }],
  triggers: [{ type: "schedule", cron: "0 9 * * *", timezone: "Europe/Moscow", projectId, inputs: { query: "cats" } }, { type: "manual" }, { type: "telegram" }],
  ...extra,
});
const write = (definition: Record<string, unknown>) => { mkdirSync(globalWorkflowDir(), { recursive: true }); writeFileSync(join(globalWorkflowDir(), "daily-digest.json"), JSON.stringify(definition)); };
const until = async (what: string, read: () => unknown, ms = 3000) => {
  const end = Date.now() + ms;
  while (!read()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((resolve) => setTimeout(resolve, 10)); }
};

async function setup(options: { pm?: boolean } = {}) {
  const automationCalls: Array<{ method: string; input: Record<string, any> }> = [];
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { plugins: { list: async () => [], callRpc: async ({ pluginId, method, input }: { pluginId: string; method: string; input: Record<string, any> }) => {
      if (pluginId === "automations") { automationCalls.push({ method, input }); return { id: "auto_1" }; }
      throw new Error(`unexpected rpc ${pluginId}.${method}`);
    } } } as never,
  });
  await plugin(bb);
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  if (options.pm !== false) { createRun(db, "lprun_s", projectId, "cli"); setRunThread(db, "lprun_s", "thr_pm"); }
  const rpc = async (name: string, params: Record<string, unknown>) => await harness.behavior.callRpc(name, params) as Record<string, any>;
  return { harness, rpc, automationCalls, db };
}

describe("schedule triggers end to end", () => {
  it("a file is a draft until its tests pass; then it gets an automation, and the tick runs it through the CLI", async () => {
    write(file());
    const { harness, rpc, automationCalls } = await setup();
    expect((await rpc("workflow_list", { projectId })).workflows.find((row: { id: string }) => row.id === "daily-digest")).toMatchObject({ status: "draft" });
    expect(automationCalls).toEqual([]);

    expect(await rpc("workflow_run_tests", { id: "daily-digest", projectId })).toMatchObject({ green: true, status: "published" });
    await until("the automation", () => automationCalls.length > 0);
    expect(automationCalls[0]).toMatchObject({ method: "automations_create", input: { projectId, name: "Lane Pilot: Daily digest", origin: "app",
      trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "Europe/Moscow" }, execution: { mode: "script", interpreter: "bash" } } });
    const script = String(automationCalls[0]!.input.execution.script);
    expect(script).toContain("bb lane-pilot workflow-trigger \"$BB_PROJECT_ID\" 'daily-digest' '{\"query\":\"cats\"}'");
    expect((await rpc("workflow_get", { id: "daily-digest", projectId })).workflow.schedules).toEqual([{ projectId, slot: 0, automationId: "auto_1" }]);

    // The tick: BB runs the script, which calls the CLI with the project, the inputs and the run id of the tick.
    const tick = await harness.behavior.runCli(["workflow-trigger", projectId, "daily-digest", '{"query":"cats"}', "autorun_1"]);
    expect(tick.exitCode).toBe(0);
    const started = JSON.parse(String(tick.stdout)) as { ok: boolean; runId: string; created: boolean };
    expect(started).toMatchObject({ ok: true, created: true });
    const done = () => (rpc("workflow_run_snapshot", { runId: started.runId }) as Promise<Record<string, any>>);
    await until("the run", async () => false || (await done()).snapshot?.run.status === "succeeded").catch(() => undefined);
    const again = JSON.parse(String((await harness.behavior.runCli(["workflow-trigger", projectId, "daily-digest", '{"query":"cats"}', "autorun_1"])).stdout));
    expect(again).toMatchObject({ ok: true, created: false, runId: started.runId });
  });

  it("the tick fails loudly when the project has no PM chat, so the automation shows a failed run", async () => {
    write(file());
    const { harness, rpc } = await setup({ pm: false });
    await rpc("workflow_run_tests", { id: "daily-digest", projectId });
    const tick = await harness.behavior.runCli(["workflow-trigger", projectId, "daily-digest", '{"query":"cats"}', "autorun_2"]);
    expect(tick.exitCode).toBe(1);
    expect(JSON.parse(String(tick.stdout))).toMatchObject({ ok: false, reason: "no_pm_chat" });
    expect((await harness.behavior.runCli(["workflow-trigger", projectId, "daily-digest", "[1]"])).exitCode).not.toBe(0);
  });

  it("deprecating the file and running its tests again removes the automation", async () => {
    write(file());
    const { rpc, automationCalls } = await setup();
    await rpc("workflow_run_tests", { id: "daily-digest", projectId });
    await until("created", () => automationCalls.length === 1);
    write(file({ status: "deprecated" }));
    await rpc("workflow_run_tests", { id: "daily-digest", projectId });
    await until("removed", () => automationCalls.length === 2);
    expect(automationCalls[1]).toMatchObject({ method: "automations_delete", input: { projectId, automationId: "auto_1" } });
  });

  it("the Run button's RPC starts the workflow, asks for missing inputs, and refuses a source it has no trigger for", async () => {
    write(file({ triggers: [{ type: "manual" }] }));
    const { rpc } = await setup();
    await rpc("workflow_run_tests", { id: "daily-digest", projectId });
    expect(await rpc("workflow_run", { id: "daily-digest", projectId, inputs: {} })).toMatchObject({ ok: false, reason: "missing_inputs", missing: ["query"] });
    expect(await rpc("workflow_run", { id: "daily-digest", projectId, inputs: { query: "q" }, source: "telegram" })).toMatchObject({ ok: false, reason: "no_trigger" });
    const ran = await rpc("workflow_run", { id: "daily-digest", projectId, inputs: { query: "q" } });
    expect(ran).toMatchObject({ ok: true, created: true });
    await until("the run", async () => ((await rpc("workflow_run_snapshot", { runId: ran.runId })).snapshot?.run.status === "succeeded"));
    expect((await rpc("workflow_runs", { id: "daily-digest" })).runs).toHaveLength(1);
  });

  it("a Telegram message can start a workflow that lists a telegram trigger", async () => {
    write(file());
    const { rpc } = await setup();
    await rpc("workflow_run_tests", { id: "daily-digest", projectId });
    expect(await rpc("workflow_run", { id: "daily-digest", projectId, inputs: { query: "from telegram" }, source: "telegram" })).toMatchObject({ ok: true });
  });
});
