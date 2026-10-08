import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createRun, openDatabase, setRunThread } from "../../src/database";
import type { LanePilotDatabase } from "../../src/database";
import type { ServerCore } from "../../src/server/core";
import type { Services } from "../../src/server/services";
import { automationsOverRpc, createWorkflowTriggers, desiredSchedules, triggerScript } from "../../src/server/workflow-triggers";
import type { AutomationsPort, TriggerDeps } from "../../src/server/workflow-triggers";
import { cronProblem, timezoneProblem } from "../../src/workflow/cron";
import { WorkflowEngine } from "../../src/workflow/engine";
import { checkRequires } from "../../src/workflow/preflight";
import type { Workflow } from "../../src/workflow/schema";
import type { StoredWorkflow, WorkflowStore } from "../../src/workflow/store";
import { definitionSha256 } from "../../src/workflow/store";
import { loadWorkflow, parseWorkflow, validateWorkflow } from "../../src/workflow/validate";
import { workflow } from "./fixtures";

const PROJECT = "proj_a", PM = "pm_1", RUN = "lprun_1";

/** A workflow that needs no executor but the engine's own: it ends with its input. */
const digest = (extra: Record<string, unknown> = {}) => workflow({
  id: "daily-digest", name: "Daily digest", status: "published",
  inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
  nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.query" } }],
  edges: [{ from: "start", to: "done" }],
  triggers: [{ type: "schedule", cron: "0 9 * * *", timezone: "Europe/Moscow", projectId: PROJECT, inputs: { query: "cats" } }, { type: "manual" }],
  ...extra,
});

const stored = (definition: Record<string, unknown>, origin: StoredWorkflow["origin"] = "global"): StoredWorkflow => {
  const parsed = parseWorkflow(definition);
  return { workflow: parsed, origin, source: `${parsed.id}.json`, sha256: definitionSha256(parsed), warnings: [] };
};
const storeOf = (...items: StoredWorkflow[]): WorkflowStore => ({
  list: () => items, get: (id) => items.find((item) => item.workflow.id === id) ?? null, resolve: (id) => items.find((item) => item.workflow.id === id)?.workflow ?? null, problems: [],
});

describe("a schedule in a workflow", () => {
  it("checks the five cron fields and the time zone", () => {
    expect(cronProblem("0 9 * * *")).toBeNull();
    expect(cronProblem("*/15 8-18 1,15 * 1-5")).toBeNull();
    expect(cronProblem("0 9 * *")).toContain("5 fields");
    expect(cronProblem("0 25 * * *")).toContain("between 0 and 23");
    expect(cronProblem("0 9 * * mon")).toContain("not valid");
    expect(cronProblem("*/0 * * * *")).toContain("at least 1");
    expect(timezoneProblem("Europe/Moscow")).toBeNull();
    expect(timezoneProblem("Mars/Base")).toContain("not a time zone");
  });

  it("is a warning, not an error, when its time cannot become an automation; `schedule` with no time at all (the shipped chains) is fine", () => {
    const problems = (triggers: unknown[]) => validateWorkflow(parseWorkflow(digest({ triggers }))).filter((problem) => problem.code === "trigger_schedule");
    expect(problems([{ type: "schedule", cron: "0 9 * * *" }])).toEqual([]);
    expect(problems(["schedule"])).toEqual([]);
    expect(problems([{ type: "schedule", cron: "nonsense" }])[0]!.message).toContain("5 fields");
    expect(problems([{ type: "schedule", cron: "0 9 * * *", timezone: "Nowhere" }])[0]!.message).toContain("time zone");
    expect(loadWorkflow(digest({ triggers: [{ type: "schedule", cron: "0 9 * * *", extra: 1 }] })).ok).toBe(false);
  });

  it("is wanted only for an own, published workflow, in the project it names", () => {
    const own = stored(digest());
    expect(desiredSchedules([own], PROJECT).map((item) => [item.workflow.id, item.slot, item.cron, item.timezone, item.inputs])).toEqual([["daily-digest", 0, "0 9 * * *", "Europe/Moscow", { query: "cats" }]]);
    expect(desiredSchedules([own], "proj_b")).toEqual([]);
    expect(desiredSchedules([stored(digest(), "builtin")], PROJECT)).toEqual([]);
    expect(desiredSchedules([stored(digest({ status: "tested" }))], PROJECT)).toEqual([]);
    expect(desiredSchedules([stored(digest({ status: "deprecated" }))], PROJECT)).toEqual([]);
    expect(desiredSchedules([stored(digest({ triggers: [{ type: "schedule", cron: "bad" }, { type: "chat" }] }))], PROJECT)).toEqual([]);
    // A project workflow runs in its own project when the trigger names none.
    const project = stored(digest({ scope: { level: "project", projectId: "proj_b" }, triggers: [{ type: "schedule", cron: "30 7 * * 1" }] }), "project");
    expect(desiredSchedules([project], "proj_b")[0]).toMatchObject({ cron: "30 7 * * 1", inputs: {} });
  });

  it("the automation's script calls the plugin's CLI with the project, the inputs and the tick, and survives a quote in the inputs", () => {
    const script = triggerScript("daily-digest", { query: "it's cats" });
    expect(script).toContain("bb lane-pilot workflow-trigger \"$BB_PROJECT_ID\" 'daily-digest' '{\"query\":\"it'\\''s cats\"}' \"${BB_AUTOMATION_RUN_ID:-}\"");
    expect(script.startsWith("#!/usr/bin/env bash\nset -euo pipefail\n")).toBe(true);
  });
});

function fakeAutomations(failures: { update?: Error; remove?: Error } = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  let next = 0;
  const port: AutomationsPort = {
    create: async (input) => { calls.push(["create", input]); next += 1; return { id: `auto_${next}` }; },
    update: async (input) => { calls.push(["update", input]); if (failures.update) throw failures.update; },
    remove: async (input) => { calls.push(["remove", input]); if (failures.remove) throw failures.remove; },
  };
  return { port, calls };
}

function world(options: { items?: StoredWorkflow[]; project?: "ok" | "no_machine"; pm?: boolean; preflight?: TriggerDeps["preflight"]; automations?: AutomationsPort } = {}) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db: LanePilotDatabase = openDatabase(bb);
  if (options.pm !== false) { createRun(db, RUN, PROJECT, "cli"); setRunThread(db, RUN, PM); }
  const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0" });
  let items = options.items ?? [stored(digest())];
  let project = options.project ?? "ok";
  const logs: string[] = [];
  const ctx = { db, log: (message: string) => logs.push(message) } as unknown as ServerCore;
  const triggers = createWorkflowTriggers(ctx, { workflowEngine: engine } as unknown as Services, {
    loadStore: async () => ({ store: storeOf(...items), project }),
    ...(options.preflight ? { preflight: options.preflight } : {}),
    ...(options.automations ? { automations: options.automations } : {}),
  });
  return { db, engine, triggers, logs, setItems: (next: StoredWorkflow[]) => { items = next; }, setProject: (next: "ok" | "no_machine") => { project = next; } };
}

describe("the automations of schedules", () => {
  it("creates one when a workflow is published, leaves it when nothing changed, updates it when the schedule changes, removes it when the workflow is unpublished", async () => {
    const automations = fakeAutomations();
    const { triggers, db, setItems } = world({ automations: automations.port });
    expect(await triggers.sync(PROJECT)).toMatchObject({ created: 1, updated: 0, removed: 0, failed: [] });
    expect(automations.calls).toHaveLength(1);
    expect(automations.calls[0]![1]).toMatchObject({ projectId: PROJECT, name: "Lane Pilot: Daily digest", cron: "0 9 * * *", timezone: "Europe/Moscow" });
    expect(String(automations.calls[0]![1].script)).toContain("'daily-digest'");
    expect(db.prepare("SELECT workflow_id, slot, automation_id FROM lane_pilot_wf_trigger").all()).toEqual([{ workflow_id: "daily-digest", slot: 0, automation_id: "auto_1" }]);

    expect(await triggers.sync(PROJECT)).toMatchObject({ created: 0, updated: 0, removed: 0 });
    expect(automations.calls).toHaveLength(1);

    setItems([stored(digest({ triggers: [{ type: "schedule", cron: "0 10 * * *", timezone: "Europe/Moscow", projectId: PROJECT, inputs: { query: "cats" } }] }))]);
    expect(await triggers.sync(PROJECT)).toMatchObject({ updated: 1 });
    expect(automations.calls.at(-1)).toEqual(["update", expect.objectContaining({ automationId: "auto_1", cron: "0 10 * * *" })]);

    setItems([stored(digest({ status: "deprecated" }))]);
    expect(await triggers.sync(PROJECT)).toMatchObject({ removed: 1 });
    expect(automations.calls.at(-1)).toEqual(["remove", { projectId: PROJECT, automationId: "auto_1" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_trigger").get()).toEqual({ n: 0 });
  });

  it("an unpublished workflow loses its automation, and so does one whose tests went red (it then counts as a draft)", async () => {
    const automations = fakeAutomations();
    const { triggers, setItems } = world({ automations: automations.port });
    await triggers.sync(PROJECT);
    setItems([stored(digest({ status: "draft" }))]);
    expect(await triggers.sync(PROJECT)).toMatchObject({ removed: 1 });
    expect(automations.calls.map(([kind]) => kind)).toEqual(["create", "remove"]);
  });

  it("removes nothing that merely went missing while the project's files cannot be read, but still creates and removes what is known to be unpublished", async () => {
    const automations = fakeAutomations();
    const { triggers, setItems, setProject } = world({ automations: automations.port });
    await triggers.sync(PROJECT);
    setProject("no_machine");
    setItems([]);
    expect(await triggers.sync(PROJECT)).toMatchObject({ removed: 0, complete: false });
    expect(automations.calls.map(([kind]) => kind)).toEqual(["create"]);
    setItems([stored(digest({ id: "other-digest" }))]);
    expect(await triggers.sync(PROJECT)).toMatchObject({ created: 1 });
    setItems([stored(digest({ id: "other-digest", status: "deprecated" }))]);
    expect(await triggers.sync(PROJECT)).toMatchObject({ removed: 1 });
  });

  it("makes the automation again when the owner deleted it, and does not fail on removing one that is gone", async () => {
    const gone = new Error("automation not found");
    const automations = fakeAutomations({ update: gone, remove: gone });
    const { triggers, setItems, db } = world({ automations: automations.port });
    await triggers.sync(PROJECT);
    setItems([stored(digest({ triggers: [{ type: "schedule", cron: "5 9 * * *", projectId: PROJECT }] }))]);
    expect(await triggers.sync(PROJECT)).toMatchObject({ updated: 1, failed: [] });
    expect(automations.calls.map(([kind]) => kind)).toEqual(["create", "update", "create"]);
    expect(db.prepare("SELECT automation_id FROM lane_pilot_wf_trigger").all()).toEqual([{ automation_id: "auto_2" }]);
    setItems([]);
    expect(await triggers.sync(PROJECT)).toMatchObject({ removed: 1, failed: [] });
  });

  it("keeps the row and reports a refusal, to try again at the next sync", async () => {
    const down: AutomationsPort = { create: async () => { throw new Error("automations offline"); }, update: async () => undefined, remove: async () => undefined };
    const { triggers, db, logs } = world({ automations: down });
    expect(await triggers.sync(PROJECT)).toMatchObject({ created: 0, failed: [expect.stringContaining("automations offline")] });
    expect(db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_trigger").get()).toEqual({ n: 0 });
    expect(logs[0]).toContain("not fully synced");
  });

  it("talks to BB's automations plugin as a script automation made by the app", async () => {
    const calls: Array<{ pluginId: string; method: string; input: Record<string, unknown> }> = [];
    const ctx = { bb: { sdk: { plugins: { callRpc: async (args: { pluginId: string; method: string; input: Record<string, unknown> }) => { calls.push(args); return { id: "auto_77" }; } } } } } as unknown as ServerCore;
    const port = automationsOverRpc(ctx);
    expect(await port.create({ projectId: PROJECT, name: "n", cron: "0 9 * * *", timezone: "UTC", script: "echo" })).toEqual({ id: "auto_77" });
    await port.update({ projectId: PROJECT, automationId: "auto_77", name: "n", cron: "0 8 * * *", timezone: "UTC", script: "echo" });
    await port.remove({ projectId: PROJECT, automationId: "auto_77" });
    expect(calls.map((call) => `${call.pluginId}.${call.method}`)).toEqual(["automations.automations_create", "automations.automations_update", "automations.automations_delete"]);
    expect(calls[0]!.input).toMatchObject({ projectId: PROJECT, enabled: true, origin: "app", trigger: { triggerType: "schedule", cron: "0 9 * * *", timezone: "UTC" },
      execution: { mode: "script", interpreter: "bash", script: "echo" } });
    expect(calls[2]!.input).toEqual({ projectId: PROJECT, automationId: "auto_77" });
  });
});

describe("starting a workflow from the tab, a schedule or Telegram", () => {
  it("starts a published workflow in the project's PM chat and finishes it; the same tick is the same run", async () => {
    const { triggers, engine } = world();
    const first = await triggers.start({ projectId: PROJECT, workflowId: "daily-digest", inputs: { query: "dogs" }, source: "schedule", key: "tick-1" });
    expect(first).toMatchObject({ ok: true, created: true });
    await engine.idle();
    const runId = (first as { runId: string }).runId;
    expect(engine.get(runId)).toMatchObject({ status: "succeeded", output: { result: "dogs" } });
    expect(engine.snapshot(runId)!.run).toMatchObject({ project_id: PROJECT, link_run_id: RUN });
    const again = await triggers.start({ projectId: PROJECT, workflowId: "daily-digest", inputs: { query: "dogs" }, source: "schedule", key: "tick-1" });
    expect(again).toMatchObject({ ok: true, created: false, runId });
    const manual = await triggers.start({ projectId: PROJECT, workflowId: "daily-digest", inputs: { query: "dogs" }, source: "manual" });
    expect(manual).toMatchObject({ ok: true, created: true });
    expect((manual as { runId: string }).runId).not.toBe(runId);
    await engine.idle();
  });

  it("refuses with a reason: unknown workflow, draft, missing input, no PM chat, no telegram trigger", async () => {
    const { triggers } = world({ items: [stored(digest()), stored(digest({ id: "wip", status: "draft" })), stored(digest({ id: "no-schedule", triggers: [{ type: "manual" }] }))] });
    const start = (workflowId: string, extra: Partial<Parameters<typeof triggers.start>[0]> = {}) => triggers.start({ projectId: PROJECT, workflowId, inputs: { query: "q" }, source: "manual", ...extra });
    expect(await start("nope")).toMatchObject({ ok: false, reason: "unknown_workflow" });
    expect(await start("wip")).toMatchObject({ ok: false, reason: "not_runnable" });
    expect(await start("daily-digest", { inputs: {} })).toMatchObject({ ok: false, reason: "missing_inputs", missing: ["query"] });
    expect(await start("daily-digest", { source: "telegram" })).toMatchObject({ ok: false, reason: "no_trigger" });
    expect(await start("no-schedule", { source: "schedule" })).toMatchObject({ ok: false, reason: "no_trigger" });
    expect(await triggers.start({ projectId: "proj_other", workflowId: "daily-digest", inputs: { query: "q" }, source: "manual" })).toMatchObject({ ok: false, reason: "no_pm_chat" });
  });

  it("a telegram start needs the workflow's telegram trigger", async () => {
    const { triggers, engine } = world({ items: [stored(digest({ triggers: [{ type: "telegram" }] }))] });
    const started = await triggers.start({ projectId: PROJECT, workflowId: "daily-digest", inputs: { query: "q" }, source: "telegram" });
    expect(started).toMatchObject({ ok: true });
    await engine.idle();
  });

  it("stops at the requirements check with what is missing, and passes on what could not be checked", async () => {
    const missing = world({ preflight: async () => checkRequires(parseWorkflow(digest({ requires: { secrets: ["TAVILY_API_KEY"] } })).requires, { secrets: async () => [] }) });
    const refused = await missing.triggers.start({ projectId: PROJECT, workflowId: "daily-digest", inputs: { query: "q" }, source: "manual" });
    expect(refused).toMatchObject({ ok: false, reason: "requirements_missing", envRequests: [{ name: "TAVILY_API_KEY" }] });
    expect((refused as { message: string }).message).toContain("env_request");
    const soft = world({ preflight: async () => checkRequires(parseWorkflow(digest({ requires: { platforms: ["x"] } })).requires, {}) });
    const started = await soft.triggers.start({ projectId: PROJECT, workflowId: "daily-digest", inputs: { query: "q" }, source: "manual" });
    expect(started).toMatchObject({ ok: true, notChecked: [expect.stringContaining("x")] });
    await soft.engine.idle();
  });

  it("starts a tested workflow only as a live trial", async () => {
    const { triggers, engine } = world({ items: [stored(digest({ status: "tested" }))] });
    const input = { projectId: PROJECT, workflowId: "daily-digest", inputs: { query: "q" }, source: "manual" as const };
    expect(await triggers.start(input)).toMatchObject({ ok: false, reason: "not_runnable" });
    expect(await triggers.start({ ...input, liveTrial: true })).toMatchObject({ ok: true });
    await engine.idle();
  });
});
