/** @vitest-environment jsdom */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { installTestPluginRuntime, loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { definitionWithTask, modelFieldsOf, placeText, withModelFields } from "../src/rooms/schedule/ui/schedule-model";
import type { CostView, ErrandDefaultView, ModelView, RunView, ScheduleView, WhereView } from "../src/rooms/schedule/views";

/**
 * The detail view of a scheduled task, the «Default executor» block, the model/cost/machine of each run and the where-line of a card.
 * The board is mounted directly; BB's own model window stands in as a node that records its value and answers as the owner would.
 */
configure({ asyncUtilTimeout: 5_000 });
vi.setConfig({ testTimeout: 20_000 });
beforeAll(() => { setLocaleOverride("en"); });
afterEach(() => { cleanup(); setLocaleOverride("en"); });

const NOW = new Date(2026, 9, 8, 12, 0).getTime();
const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute).getTime();

const run = (id: string, scheduleId: string, extra: Partial<RunView> = {}): RunView => ({
  id, scheduleId, scheduledAt: at(7, 9), trigger: "tick", status: "succeeded", reason: null, queuedAt: at(7, 9), startedAt: at(7, 9), finishedAt: at(7, 9, 1), durationMs: 60_000,
  refKind: null, refId: null, hostId: null, exitCode: null, output: null, error: null, truncated: false,
  providerId: null, model: null, tokens: null, costUsd: null, usageKnown: false, hostName: null, ...extra,
});
const modelView = (extra: Partial<ModelView> = {}): ModelView => ({ providerId: "claude-code", model: "claude-opus-5-5", reasoningEffort: "high", serviceTier: null, source: "errand-role", sourceKey: null, issues: [], ...extra });
const where = (extra: Partial<WhereView> = {}): WhereView => ({ projectName: "SelfyStudio", sectionId: "sec_1", sectionName: "Marketing", sectionPath: "/work/marketing", hostId: "mini", hostName: "Mac mini", cwd: "/work/marketing/site", ...extra });
const FULL_TEXT = "Open the CRM at https://crm.example.com.\nCollect every new lead of the last 24 hours.\nReport name, source and phone for each lead.\nERRAND: report only, change nothing.";

function schedule(id: string, extra: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id, projectId: "proj_a", name: `Task ${id}`, description: "", task: { kind: "errand", task: FULL_TEXT, authorized: false, accounts: [] } as ScheduleView["task"],
    when: { type: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Madrid" }, missed: "run_once", missedLimit: 5, overlap: "skip", timeoutSec: 3600, maxFailures: 3,
    state: "active", pauseReason: null, consecutiveFailures: 0, createdBy: "owner", createdAt: at(1, 9), updatedAt: at(7, 9),
    nextFires: [at(9, 9)], machine: null, lastRun: null, active: [], column: "scheduled",
    model: modelView(), cost: { perRunUsd: null, samples: 0, priceInPer1M: 4, priceOutPer1M: 20 }, where: where(), ...extra,
  };
}
const scriptSchedule = (id = "sc") => schedule(id, {
  task: { kind: "script", hostId: "mini", command: "cd /srv && ./sync.sh\necho done", cwd: "/srv", env: [] } as ScheduleView["task"], model: null, cost: null, where: where({ cwd: "/srv" }),
});
const workflowSchedule = (id = "wf") => schedule(id, { task: { kind: "workflow", workflowId: "lead-digest", inputs: { topic: "leads" } } as ScheduleView["task"], model: null, cost: null });

const catalog = {
  hosts: [{ id: "mini", name: "Mac mini", connected: true }],
  providers: [
    { id: "claude-code", displayName: "Claude Code", logoUrl: null, family: null, supportsServiceTier: false, serviceTiers: [], hostIds: ["mini"], models: [
      { id: "claude-opus-5-5", model: "claude-opus-5-5", displayName: "Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "high", isDefault: true, hostIds: ["mini"] },
      { id: "claude-sonnet-5-5", model: "claude-sonnet-5-5", displayName: "Sonnet 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: false, hostIds: ["mini"] }] },
    { id: "codex", displayName: "Codex", logoUrl: null, family: null, supportsServiceTier: true, serviceTiers: ["fast"], hostIds: ["mini"], models: [
      { id: "gpt-6-luna", model: "gpt-6-luna", displayName: "GPT 6 Luna", efforts: ["low", "medium", "high"], defaultEffort: "medium", isDefault: true, hostIds: ["mini"] }] },
  ],
  runHostId: "mini",
};
const emptyDefault: ErrandDefaultView = { effective: null, source: null, project: null, global: null, projectVersion: 0, globalVersion: 0 };

type PickerValue = { providerId: string; model: string; reasoningLevel: string; serviceTier?: "default" | "fast" };
type PickerNode = HTMLElement & { __value?: PickerValue; __onChange?: (next: PickerValue) => void };
type Handlers = Record<string, (input: any) => unknown>;
type Slot = Awaited<ReturnType<typeof mount>>;

async function mount(handlers: Handlers = {}, props: { projectId?: string | null; schedules?: ScheduleView[]; errandDefault?: ErrandDefaultView; locale?: "en" | "ru" } = {}) {
  installTestPluginRuntime();
  const host = globalThis as typeof globalThis & { __bbPluginRuntime?: { pluginSdkApp: Record<string, unknown> } };
  const sdk = host.__bbPluginRuntime!.pluginSdkApp;
  host.__bbPluginRuntime!.pluginSdkApp = {
    ...sdk,
    experimental_ProviderModelPicker: (p: { value: PickerValue; onChange: (next: PickerValue) => void }) => React.createElement("div", {
      "data-testid": "bb-provider-model-picker", "data-provider": p.value.providerId, "data-model": p.value.model, "data-effort": p.value.reasoningLevel, "data-tier": p.value.serviceTier ?? "none",
      ref: (node: PickerNode | null) => { if (node) { node.__value = p.value; node.__onChange = p.onChange; } },
    }),
  };
  await loadPluginApp(await import("../app"));
  const { ScheduleBoard } = await import("../src/rooms/schedule/ui/schedule-board");
  const projectId = props.projectId === undefined ? "proj_a" : props.projectId;
  const list = props.schedules ?? [schedule("s1")];
  const locale = props.locale ?? "en";
  return renderSlot({ component: () => <ScheduleBoard projectId={projectId} projects={[{ id: "proj_a", name: "Alpha" }]} locale={locale} /> }, {}, {
    context: { projectId, threadId: null },
    rpc: {
      schedule_list: () => ({ schedules: list, hosts: [{ id: "mini", name: "Mac mini", connected: true }, { id: "mac", name: "MacBook", connected: false }], now: NOW, errandDefault: props.errandDefault ?? emptyDefault }),
      schedule_runs: () => ({ runs: [], total: 0 }),
      schedule_calendar: () => ({ planned: [], past: [], truncated: [] }),
      schedule_preview: () => ({ ok: true, problems: [], warnings: [], conflicts: [], nextFires: [at(9, 9)], timeoutSec: 3600 }),
      workflow_model_catalog: () => catalog,
      workflow_list: () => ({ workflows: [], problems: [], project: "ok" }),
      activation_context: () => ({ liveRun: null }),
      ...handlers,
    } as never,
  });
}
const calls = (slot: Slot, method: string) => slot.rpcCalls.filter((item) => item.method === method);
const nativeOf = (slot: Slot, testId: string) => slot.getByTestId(testId).querySelector("[data-testid='bb-provider-model-picker']") as PickerNode;
const choose = (slot: Slot, testId: string, next: Partial<PickerValue>) => { const node = nativeOf(slot, testId); node.__onChange!({ ...node.__value!, ...next }); };
const openDetail = async (slot: Slot, id = "s1") => { fireEvent.click(await slot.findByTestId(`sch-title-${id}`)); await slot.findByTestId("schedule-detail"); };
const upsertDefinition = (slot: Slot) => (calls(slot, "schedule_upsert")[0]!.input as { definition: Record<string, any> }).definition;
const ok = { ok: true, schedule: null, problems: [], warnings: [], conflicts: [] };

describe("pure helpers of the detail view", () => {
  it("model fields are read from and written to an errand task, absent ones removed", () => {
    const task = { kind: "errand", task: FULL_TEXT, authorized: true, accounts: ["A"], providerId: "codex", model: "gpt-6-luna", reasoning: "low", serviceTier: "fast" } as ScheduleView["task"];
    expect(modelFieldsOf(task)).toEqual({ providerId: "codex", model: "gpt-6-luna", reasoning: "low", serviceTier: "fast" });
    expect(modelFieldsOf({ kind: "script", hostId: "h", command: "x", cwd: "/", env: [] } as ScheduleView["task"])).toEqual({});
    const cleared = withModelFields(task as never, { preset: "strong" });
    expect(cleared).toEqual({ kind: "errand", task: FULL_TEXT, authorized: true, accounts: ["A"], preset: "strong" });
    expect(withModelFields(task as never, {})).toEqual({ kind: "errand", task: FULL_TEXT, authorized: true, accounts: ["A"] });
  });

  it("the definition keeps the id, the policies and the time of the schedule", () => {
    const one = schedule("s9", { when: { type: "once", runAt: at(12, 10) }, description: "why" });
    expect(definitionWithTask(one, one.task)).toEqual({
      id: "s9", projectId: "proj_a", name: "Task s9", description: "why", task: one.task, when: { type: "once", runAt: at(12, 10) },
      missed: "run_once", missedLimit: 5, overlap: "skip", timeoutSec: 3600, maxFailures: 3,
    });
    expect(placeText(where())).toBe("SelfyStudio › Marketing");
    expect(placeText(where({ sectionName: null }))).toBe("SelfyStudio");
    expect(placeText(undefined)).toBe("");
  });
});

describe("the detail view: what the agent will receive", () => {
  it("opens from the title and from «Details», showing the whole errand text", async () => {
    const slot = await mount();
    await openDetail(slot);
    expect((slot.getByTestId("sch-what-text") as HTMLTextAreaElement).value).toBe(FULL_TEXT);
    expect(slot.getByTestId("sch-what").querySelector("h3")!.textContent).toBe("What the agent will receive");
    fireEvent.click(slot.getByTestId("sch-detail-back"));
    fireEvent.click(await slot.findByTestId("sch-detail-s1"));
    await slot.findByTestId("schedule-detail");
    expect((slot.getByTestId("sch-detail-save") as HTMLButtonElement).disabled).toBe(true);
  });

  it("saves an edited text through schedule_upsert with the same id and the policies, and Revert goes back", async () => {
    const slot = await mount({ schedule_upsert: () => ok });
    await openDetail(slot);
    const area = slot.getByTestId("sch-what-text") as HTMLTextAreaElement;
    fireEvent.change(area, { target: { value: `${FULL_TEXT}\nAlso list the lead's city.` } });
    expect(slot.getByTestId("sch-detail-dirty")).toBeTruthy();
    fireEvent.click(slot.getByTestId("sch-detail-revert"));
    expect((slot.getByTestId("sch-what-text") as HTMLTextAreaElement).value).toBe(FULL_TEXT);
    expect((slot.getByTestId("sch-detail-save") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(slot.getByTestId("sch-what-text"), { target: { value: `${FULL_TEXT}\nAlso list the lead's city.` } });
    fireEvent.click(slot.getByTestId("sch-detail-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    const definition = upsertDefinition(slot);
    expect(definition).toMatchObject({ id: "s1", projectId: "proj_a", name: "Task s1", missed: "run_once", overlap: "skip", timeoutSec: 3600, maxFailures: 3, when: { type: "cron", cron: "0 9 * * 1-5", timezone: "Europe/Madrid" } });
    expect(definition.task).toEqual({ kind: "errand", task: `${FULL_TEXT}\nAlso list the lead's city.`, authorized: false, accounts: [] });
    await slot.findByTestId("sch-detail-saved");
    await waitFor(() => expect(calls(slot, "schedule_list").length).toBeGreaterThan(1));
  });

  it("shows the problems of a refused save and keeps the edit", async () => {
    const slot = await mount({ schedule_upsert: () => ({ ok: false, schedule: null, problems: ["task.task: too short"], warnings: [], conflicts: [] }) });
    await openDetail(slot);
    fireEvent.change(slot.getByTestId("sch-what-text"), { target: { value: "short" } });
    fireEvent.click(slot.getByTestId("sch-detail-save"));
    expect((await slot.findByTestId("sch-detail-error")).textContent).toContain("too short");
    expect((slot.getByTestId("sch-what-text") as HTMLTextAreaElement).value).toBe("short");
  });

  it("a script shows its command, machine and folder, and saves them with the id", async () => {
    const slot = await mount({ schedule_upsert: () => ok }, { schedules: [scriptSchedule()] });
    await openDetail(slot, "sc");
    expect(slot.getByTestId("sch-what").querySelector("h3")!.textContent).toBe("What the machine will run");
    expect((slot.getByTestId("sch-what-command") as HTMLTextAreaElement).value).toBe("cd /srv && ./sync.sh\necho done");
    expect((slot.getByTestId("sch-what-cwd") as HTMLInputElement).value).toBe("/srv");
    expect(slot.getByTestId("sch-what-host").textContent).toContain("Mac mini");
    fireEvent.change(slot.getByTestId("sch-what-command"), { target: { value: "./sync.sh --full" } });
    fireEvent.change(slot.getByTestId("sch-what-cwd"), { target: { value: "/srv/app" } });
    fireEvent.click(slot.getByTestId("sch-detail-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    expect(upsertDefinition(slot)).toMatchObject({ id: "sc", task: { kind: "script", hostId: "mini", command: "./sync.sh --full", cwd: "/srv/app", env: [] } });
  });
});

describe("the detail view: who runs it", () => {
  it("says who runs the errand and where that comes from, for every source", async () => {
    const cases: Array<[Partial<ModelView>, string]> = [
      [{ source: "task", providerId: "codex", model: "gpt-6-luna", reasoningEffort: "medium", serviceTier: "fast" }, "Will run: codex · gpt-6-luna · medium · fast — from: this task"],
      [{ source: "preset", sourceKey: "cheap-fast", model: "claude-haiku-5-5", reasoningEffort: "low" }, "Will run: claude-code · claude-haiku-5-5 · low — from: model preset cheap-fast"],
      [{ source: "schedule-default", sourceKey: "schedule.errand_default" }, "Will run: claude-code · claude-opus-5-5 · high — from: the default for scheduled tasks"],
      [{ source: "errand-role" }, "Will run: claude-code · claude-opus-5-5 · high — from: the errand role default"],
      [{ source: "pm" }, "Will run: claude-code · claude-opus-5-5 · high — from: the project manager's model"],
    ];
    for (const [extra, line] of cases) {
      const slot = await mount({}, { schedules: [schedule("s1", { model: modelView(extra) })] });
      expect((await slot.findByTestId("sch-who-s1")).textContent).toBe(line);
      await openDetail(slot);
      expect(slot.getByTestId("sch-who-now-line").textContent).toBe(line);
      cleanup();
    }
  });

  it("in Russian: «Выполнит: … — откуда: …»", async () => {
    setLocaleOverride("ru");
    const slot = await mount({}, { locale: "ru", schedules: [schedule("s1", { model: modelView({ source: "schedule-default", sourceKey: "schedule.errand_default" }) })] });
    expect((await slot.findByTestId("sch-who-s1")).textContent).toBe("Выполнит: claude-code · claude-opus-5-5 · high — откуда: умолчание для задач по расписанию");
    await openDetail(slot);
    expect(slot.getByTestId("sch-what").querySelector("h3")!.textContent).toBe("Что уйдёт агенту");
    expect(slot.getByTestId("sch-who-section").querySelector("h3")!.textContent).toBe("Кто выполнит");
  });

  it("names a problem the resolution found", async () => {
    const slot = await mount({}, { schedules: [schedule("s1", { model: modelView({ issues: ["unknown_preset", "no_model"] }) })] });
    await openDetail(slot);
    expect(slot.getByTestId("sch-who-now").textContent).toContain("That preset does not exist.");
  });

  it("BB's own picker opens on the model that runs now; a choice is saved with the provider, model, effort and fast mode", async () => {
    const slot = await mount({ schedule_upsert: () => ok });
    await openDetail(slot);
    const native = await waitFor(() => { const node = nativeOf(slot, "sch-who-picker"); expect(node).toBeTruthy(); return node; });
    expect([native.getAttribute("data-provider"), native.getAttribute("data-model"), native.getAttribute("data-effort")]).toEqual(["claude-code", "claude-opus-5-5", "high"]);
    choose(slot, "sch-who-picker", { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "low", serviceTier: "fast" });
    await waitFor(() => expect(nativeOf(slot, "sch-who-picker").getAttribute("data-model")).toBe("gpt-6-luna"));
    fireEvent.click(slot.getByTestId("sch-detail-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    expect(upsertDefinition(slot).task).toEqual({ kind: "errand", task: FULL_TEXT, authorized: false, accounts: [], providerId: "codex", model: "gpt-6-luna", reasoning: "low", serviceTier: "fast" });
  });

  it("«Use the default» clears the task's own choice", async () => {
    const own = schedule("s1", { task: { kind: "errand", task: FULL_TEXT, authorized: false, accounts: [], providerId: "codex", model: "gpt-6-luna", reasoning: "low" } as ScheduleView["task"], model: modelView({ source: "task", providerId: "codex", model: "gpt-6-luna", reasoningEffort: "low" }) });
    const slot = await mount({ schedule_upsert: () => ok }, { schedules: [own] });
    await openDetail(slot);
    await waitFor(() => expect(nativeOf(slot, "sch-who-picker").getAttribute("data-model")).toBe("gpt-6-luna"));
    fireEvent.click(slot.getByTestId("sch-who-default"));
    fireEvent.click(slot.getByTestId("sch-detail-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    expect(upsertDefinition(slot).task).toEqual({ kind: "errand", task: FULL_TEXT, authorized: false, accounts: [] });
  });

  it("a script has no model", async () => {
    const slot = await mount({}, { schedules: [scriptSchedule()] });
    await slot.findByTestId("sch-card-sc");
    expect(slot.queryByTestId("sch-who-sc")).toBeNull();
    await openDetail(slot, "sc");
    expect(slot.getByTestId("sch-who-script").textContent).toBe("A script has no model: it runs the command as it is.");
    expect(slot.queryByTestId("sch-who-picker")).toBeNull();
    expect(slot.queryByTestId("sch-cost")).toBeNull();
  });

  it("a chain lists the models of its steps with where each comes from, read-only, from workflow_step_executors", async () => {
    const executors = [
      { nodeId: "collect", kind: "agent", uses: null, mode: "model", providerId: "claude-code", model: "claude-haiku-5-5", reasoningEffort: "low", serviceTier: null, source: "preset", sourceKey: "cheap-fast" },
      { nodeId: "write", kind: "agent", uses: null, mode: "model", providerId: "codex", model: "gpt-6-luna", reasoningEffort: "high", serviceTier: "fast", source: "node", sourceKey: null },
      { nodeId: "send", kind: "action", uses: null, mode: "none", providerId: null, model: null, reasoningEffort: null, serviceTier: null, source: "none", sourceKey: null },
    ];
    const slot = await mount({ workflow_step_executors: () => ({ found: true, executors, pm: null }) }, { schedules: [workflowSchedule()] });
    await openDetail(slot, "wf");
    expect(slot.getByTestId("sch-who-workflow").textContent).toContain("each step has one, set in the chain");
    expect((await slot.findByTestId("sch-step-model-collect")).textContent).toBe("claude-code · claude-haiku-5-5 · low");
    expect(slot.getByTestId("sch-step-source-collect").textContent).toContain("cheap-fast");
    expect(slot.getByTestId("sch-step-model-write").textContent).toContain("gpt-6-luna");
    expect(slot.queryByTestId("sch-step-send")).toBeNull();
    expect(calls(slot, "workflow_step_executors")[0]!.input).toEqual({ workflowId: "lead-digest", projectId: "proj_a" });
    expect(slot.getByTestId("sch-what-workflow").textContent).toContain('"topic": "leads"');
    expect(slot.queryByTestId("sch-what-text")).toBeNull();
  });
});

describe("the cost line", () => {
  const costOf = async (cost: CostView | null, locale: "en" | "ru" = "en") => {
    if (locale === "ru") setLocaleOverride("ru");
    const slot = await mount({}, { locale, schedules: [schedule("s1", { cost })] });
    await openDetail(slot);
    const text = slot.queryByTestId("sch-cost")?.textContent ?? null;
    cleanup();
    return text;
  };

  it("the average of the runs with known usage, with how many", async () => {
    expect(await costOf({ perRunUsd: 0.12, samples: 5, priceInPer1M: 4, priceOutPer1M: 20 })).toBe("≈ $0.12 per run (average of 5)");
    expect(await costOf({ perRunUsd: 1.5, samples: 2, priceInPer1M: 4, priceOutPer1M: 20 })).toBe("≈ $1.50 per run (average of 2)");
    expect(await costOf({ perRunUsd: 0.12, samples: 5, priceInPer1M: 4, priceOutPer1M: 20 }, "ru")).toBe("≈ $0.12 за запуск (среднее по 5)");
  });

  it("with no history: the model's price per 1M tokens", async () => {
    expect(await costOf({ perRunUsd: null, samples: 0, priceInPer1M: 4, priceOutPer1M: 20 })).toBe("No cost recorded yet. Price: $4 in / $20 out per 1M tokens.");
    expect(await costOf({ perRunUsd: null, samples: 0, priceInPer1M: 0.2, priceOutPer1M: 1.2 })).toContain("$0.2 in / $1.2 out");
  });

  it("a model with no price: the cost is unknown", async () => {
    expect(await costOf({ perRunUsd: null, samples: 0, priceInPer1M: null, priceOutPer1M: null })).toBe("Cost unknown: this model has no price in the table.");
    expect(await costOf({ perRunUsd: null, samples: 0, priceInPer1M: null, priceOutPer1M: null }, "ru")).toBe("Стоимость неизвестна: у этой модели нет цены в таблице.");
  });
});

describe("where it runs", () => {
  it("the card line is «project › section · machine», and the detail lists project, folder section, machine and working folder", async () => {
    const slot = await mount();
    expect((await slot.findByTestId("sch-where-s1")).textContent).toBe("SelfyStudio › Marketing · Mac mini");
    await openDetail(slot);
    expect(slot.getByTestId("sch-where-project").textContent).toBe("Project: SelfyStudio");
    expect(slot.getByTestId("sch-where-section").textContent).toBe("Project folder: Marketing (/work/marketing)");
    expect(slot.getByTestId("sch-where-host").textContent).toBe("Machine: Mac mini");
    expect(slot.getByTestId("sch-where-cwd").textContent).toBe("Working folder: /work/marketing/site");
    expect(slot.getByTestId("sch-where").textContent).toContain("create the task in that project");
  });

  it("without a section or machine only what is known is printed; a script's folder is its own", async () => {
    const slot = await mount({}, { schedules: [schedule("a", { where: where({ sectionId: null, sectionName: null, sectionPath: null, hostId: null, hostName: null, cwd: null }) }), scriptSchedule("b")] });
    expect((await slot.findByTestId("sch-where-a")).textContent).toBe("SelfyStudio");
    expect(slot.getByTestId("sch-where-b").textContent).toBe("SelfyStudio › Marketing · Mac mini");
    await openDetail(slot, "a");
    expect(slot.getByTestId("sch-where-section").textContent).toBe("Project folder: none");
    expect(slot.getByTestId("sch-where-host").textContent).toBe("Machine: not known");
    expect(slot.queryByTestId("sch-where-cwd")).toBeNull();
    fireEvent.click(slot.getByTestId("sch-detail-back"));
    await openDetail(slot, "b");
    expect(slot.getByTestId("sch-where-cwd").textContent).toBe("Working folder: /srv");
    expect(slot.getByTestId("sch-where").textContent).not.toContain("create the task in that project");
  });
});

describe("the history of runs", () => {
  const history = [
    run("r1", "s1", { refKind: "thread", refId: "thr_1", providerId: "claude-code", model: "claude-opus-5-5", tokens: 1_100_000, costUsd: 6, usageKnown: true, hostName: "Mac mini" }),
    run("r2", "s1", { refKind: "thread", refId: "thr_2", usageKnown: false, hostName: "Hub" }),
    run("r3", "s1", { refKind: "thread", refId: "thr_3", providerId: "acp-opencode", model: "router9/ag/gemini-3.8-flash-high", tokens: 5000, costUsd: null, usageKnown: true }),
    run("r4", "s1", { refKind: "workflow_run", refId: "wfrun_1" }),
  ];

  it("each run shows its model, its cost («unknown» without usage or price) and the machine it ran on", async () => {
    const slot = await mount({ schedule_runs: () => ({ runs: history, total: 4 }) });
    fireEvent.click(await slot.findByTestId("sch-history-s1"));
    await slot.findByTestId("sch-history-list");
    expect(slot.getByTestId("sch-run-model-r1").textContent).toBe("Model: claude-code · claude-opus-5-5");
    expect(slot.getByTestId("sch-run-cost-r1").textContent).toBe("Cost: ≈ $6.00");
    expect(slot.getByTestId("sch-run-cost-r1").getAttribute("data-known")).toBe("1");
    expect(slot.getByTestId("sch-run-host-r1").textContent).toBe("Machine: Mac mini");
    expect(slot.queryByTestId("sch-run-model-r2")).toBeNull();
    expect(slot.getByTestId("sch-run-cost-r2").textContent).toBe("Cost: unknown");
    expect(slot.getByTestId("sch-run-cost-r2").getAttribute("data-known")).toBe("0");
    expect(slot.getByTestId("sch-run-host-r2").textContent).toBe("Machine: Hub");
    expect(slot.getByTestId("sch-run-model-r3").textContent).toBe("Model: opencode · gemini-3.8-flash-high");
    expect(slot.getByTestId("sch-run-cost-r3").textContent).toBe("Cost: unknown (no price for the model)");
    // A run that is not a thread has no token cost to print.
    expect(slot.queryByTestId("sch-run-meta-r4")).toBeNull();
  });

  it("in Russian the unknown cost reads «неизвестно»", async () => {
    setLocaleOverride("ru");
    const slot = await mount({ schedule_runs: () => ({ runs: history, total: 4 }) }, { locale: "ru" });
    fireEvent.click(await slot.findByTestId("sch-history-s1"));
    await slot.findByTestId("sch-history-list");
    expect(slot.getByTestId("sch-run-cost-r2").textContent).toBe("Стоимость: неизвестно");
    expect(slot.getByTestId("sch-run-cost-r1").textContent).toBe("Стоимость: ≈ $6.00");
    expect(slot.getByTestId("sch-run-host-r1").textContent).toBe("Машина: Mac mini");
  });
});

describe("the Default executor block", () => {
  const projectDefault: ErrandDefaultView = { effective: { provider: "codex", model: "gpt-6-luna", reasoning_effort: "low" }, source: "project", project: { provider: "codex", model: "gpt-6-luna", reasoning_effort: "low" }, global: { preset: "strong" }, projectVersion: 3, globalVersion: 7 };

  it("is collapsed with a summary; at project level a choice is saved for the project with the project's version", async () => {
    const slot = await mount({ save_setting: () => ({ ok: true, conflict: false, version: 4, value: null }) }, { errandDefault: projectDefault });
    const summary = await slot.findByTestId("sch-default-summary");
    expect(summary.textContent).toBe("In force: codex · gpt-6-luna · low — set for this project");
    expect(slot.queryByTestId("sch-default-body")).toBeNull();
    fireEvent.click(slot.getByTestId("sch-default-toggle"));
    expect(slot.getByTestId("sch-default-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(slot.getByTestId("sch-default-body").textContent).toContain("Default model for scheduled errands");
    expect(slot.getByTestId("sch-default-body").textContent).toContain("Editing the default of this project.");
    const native = await waitFor(() => { const node = nativeOf(slot, "sch-default-picker"); expect(node).toBeTruthy(); return node; });
    expect(native.getAttribute("data-model")).toBe("gpt-6-luna");
    choose(slot, "sch-default-picker", { providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: "medium" });
    await waitFor(() => expect(calls(slot, "save_setting")).toHaveLength(1));
    expect(calls(slot, "save_setting")[0]!.input).toEqual({ projectId: "proj_a", key: "schedule.errand_default", value: { provider: "claude-code", model: "claude-sonnet-5-5", reasoning_effort: "medium" }, expectedVersion: 3 });
    expect((await slot.findByTestId("sch-default-message")).textContent).toBe("Default saved.");
    await waitFor(() => expect(calls(slot, "schedule_list").length).toBeGreaterThan(1));
  });

  it("«Inherit» drops the project's own value with reset_project_settings", async () => {
    const slot = await mount({ reset_project_settings: () => ({ ok: true, conflict: false, values: {}, versions: {} }) }, { errandDefault: projectDefault });
    fireEvent.click(await slot.findByTestId("sch-default-toggle"));
    fireEvent.click(slot.getByTestId("sch-default-drop"));
    expect(slot.getByTestId("sch-default-drop").textContent).toBe("Inherit");
    await waitFor(() => expect(calls(slot, "reset_project_settings")).toHaveLength(1));
    expect(calls(slot, "reset_project_settings")[0]!.input).toEqual({ projectId: "proj_a", keys: ["schedule.errand_default"], expectedVersions: { "schedule.errand_default": 3 } });
  });

  it("with no value of its own the project block offers no «Inherit», and says the global one is in force", async () => {
    const inherited: ErrandDefaultView = { effective: { preset: "strong" }, source: "global", project: null, global: { preset: "strong" }, projectVersion: 0, globalVersion: 7 };
    const slot = await mount({}, { errandDefault: inherited });
    expect((await slot.findByTestId("sch-default-summary")).textContent).toBe("In force: strong — set for all projects");
    fireEvent.click(slot.getByTestId("sch-default-toggle"));
    expect(slot.queryByTestId("sch-default-drop")).toBeNull();
  });

  it("with no default at all the summary names the errand role default", async () => {
    const slot = await mount();
    expect((await slot.findByTestId("sch-default-summary")).textContent).toBe("no default set: claude-code · claude-opus-5-5 · high");
  });

  it("on the global page a choice is saved at the global level (project «*») with the global version, and «Clear» empties it", async () => {
    const globalDefault: ErrandDefaultView = { effective: { preset: "strong" }, source: "global", project: null, global: { preset: "strong" }, projectVersion: 0, globalVersion: 7 };
    const slot = await mount({ save_setting: () => ({ ok: true, conflict: false, version: 8, value: null }) }, { projectId: null, errandDefault: globalDefault });
    fireEvent.click(await slot.findByTestId("sch-default-toggle"));
    expect(slot.getByTestId("sch-default-body").textContent).toContain("Editing the default of all projects.");
    await waitFor(() => expect(nativeOf(slot, "sch-default-picker")).toBeTruthy());
    choose(slot, "sch-default-picker", { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", serviceTier: "fast" });
    await waitFor(() => expect(calls(slot, "save_setting")).toHaveLength(1));
    expect(calls(slot, "save_setting")[0]!.input).toEqual({ projectId: "*", key: "schedule.errand_default", value: { provider: "codex", model: "gpt-6-luna", reasoning_effort: "high", service_tier: "fast" }, expectedVersion: 7 });
    expect(calls(slot, "schedule_list")[0]!.input).toEqual({ next: 5 });

    expect(slot.getByTestId("sch-default-drop").textContent).toBe("Clear");
    fireEvent.click(slot.getByTestId("sch-default-drop"));
    await waitFor(() => expect(calls(slot, "save_setting")).toHaveLength(2));
    expect(calls(slot, "save_setting")[1]!.input).toEqual({ projectId: "*", key: "schedule.errand_default", value: null, expectedVersion: 7 });
  });

  it("a version conflict says so and reloads; a refusal shows the reason", async () => {
    const slot = await mount({ save_setting: () => ({ ok: false, conflict: true, version: 9, value: null }) }, { errandDefault: projectDefault });
    fireEvent.click(await slot.findByTestId("sch-default-toggle"));
    await waitFor(() => expect(nativeOf(slot, "sch-default-picker")).toBeTruthy());
    choose(slot, "sch-default-picker", { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high" });
    expect((await slot.findByTestId("sch-default-message")).textContent).toContain("changed in the meantime");
    cleanup();
    const refused = await mount({ save_setting: () => ({ ok: false, conflict: false, version: 3, value: null, validation: { code: "invalid_choice", key: "schedule.errand_default", params: ["schedule.errand_default", "bad value"] } }) }, { errandDefault: projectDefault });
    fireEvent.click(await refused.findByTestId("sch-default-toggle"));
    await waitFor(() => expect(nativeOf(refused, "sch-default-picker")).toBeTruthy());
    choose(refused, "sch-default-picker", { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high" });
    expect((await refused.findByTestId("sch-default-message")).textContent).toContain("bad value");
  });

  it("is in Russian and not shown while the form, the detail or the history is open", async () => {
    setLocaleOverride("ru");
    const slot = await mount({}, { locale: "ru", errandDefault: projectDefault });
    expect((await slot.findByTestId("sch-default")).textContent).toContain("Исполнитель по умолчанию");
    expect(slot.getByTestId("sch-default-summary").textContent).toBe("Действует: codex · gpt-6-luna · low — задано для этого проекта");
    await openDetail(slot);
    expect(slot.queryByTestId("sch-default")).toBeNull();
  });
});

describe("the edit form", () => {
  it("shows the model that runs now with its source and the picker, and saves the choice with the task", async () => {
    const slot = await mount({ schedule_upsert: () => ok });
    fireEvent.click(await slot.findByTestId("sch-edit-s1"));
    await slot.findByTestId("schedule-form");
    expect(slot.getByTestId("sch-form-who-now-line").textContent).toBe("Will run: claude-code · claude-opus-5-5 · high — from: the errand role default");
    await waitFor(() => expect(nativeOf(slot, "sch-form-who-picker")).toBeTruthy());
    choose(slot, "sch-form-who-picker", { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "medium" });
    await waitFor(() => expect((slot.getByTestId("sch-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByTestId("sch-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    expect(upsertDefinition(slot)).toMatchObject({ id: "s1", task: { kind: "errand", providerId: "codex", model: "gpt-6-luna", reasoning: "medium" } });
  });

  it("a new errand keeps no model unless one is chosen", async () => {
    const slot = await mount({ schedule_upsert: () => ok });
    fireEvent.click(await slot.findByTestId("sch-create-form"));
    await slot.findByTestId("schedule-form");
    fireEvent.change(slot.getByTestId("sch-name"), { target: { value: "Leads" } });
    fireEvent.change(slot.getByTestId("sch-errand"), { target: { value: "Open the CRM and report the new leads." } });
    await waitFor(() => expect((slot.getByTestId("sch-save") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(slot.getByTestId("sch-save"));
    await waitFor(() => expect(calls(slot, "schedule_upsert")).toHaveLength(1));
    expect(upsertDefinition(slot).task).toEqual({ kind: "errand", task: "Open the CRM and report the new leads.", authorized: false, accounts: [] });
  });
});
