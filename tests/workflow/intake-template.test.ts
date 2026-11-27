import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import {
  MIN_CONFIDENCE,
  WorkflowEngine,
  loadWorkflowStore,
  parseWorkflow,
  registerPureActions,
  wfRunRow,
  type Workflow,
} from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { createRun, openDatabase } from "../../src/rooms/plugin-db";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import {
  createIntakeTrain,
  createPhaseIntake,
} from "../../src/rooms/workflow/server";
import { ok } from "./engine-helpers";

let dispose: (() => Promise<void> | void) | null = null;

afterEach(async () => {
  await dispose?.();
  dispose = null;
});

function cafeTemplate(opts: {
  id?: string;
  status?: "published" | "tested" | "draft";
  requiredInputs?: Array<{ name: string; type: "string" | "number" | "boolean"; required: boolean; description?: string }>;
} = {}): Workflow {
  return parseWorkflow({
    schemaVersion: 1,
    id: opts.id ?? "cafe-site-tpl",
    name: { en: "Cafe website from Google card", ru: "Сайт кафе по карточке Google" },
    description: {
      en: "Make a website for a cafe using its Google card, menu, opening hours, and map.",
      ru: "Сделать сайт для кафе по карточке Google, с меню, часами работы и картой.",
    },
    examples: {
      en: ["Make a site for a cafe, here is the Google card"],
      ru: ["Сделай сайт для кафе, вот карточка Google"],
    },
    tags: ["project-template", "cafe", "website", "google-card"],
    kind: "project",
    status: opts.status ?? "published",
    version: 1,
    inputs: opts.requiredInputs ?? [
      { name: "goal", type: "string", required: true },
      { name: "url", type: "string", required: true, description: "Google card link" },
    ],
    outputs: [{ name: "status", type: "enum", values: ["done"], required: true }],
    nodes: [
      { id: "build_site", type: "agent", role: "analyst", prompt: "Build cafe site", out: [] },
      { id: "done", type: "action", action: "emit", map: { status: "done" } },
    ],
    edges: [
      { from: "start", to: "build_site", pass: "artifact" },
      { from: "build_site", to: "done", pass: "artifact" },
    ],
  });
}

async function setupIntakeWorld(extraWorkflows: Workflow[] = []) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  dispose = () => harness.lifecycle.dispose();
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj-1");

  const baseStore = await loadWorkflowStore({ builtin: BUILTIN_SOURCES, db });
  const customMap = new Map(extraWorkflows.map((wf) => [wf.id, {
    workflow: wf,
    origin: "project" as const,
    source: `${wf.id}.json`,
    sha256: "custom-sha",
    warnings: [],
  }]));
  const combinedList = [
    ...baseStore.list().filter((item) => !customMap.has(item.workflow.id)),
    ...customMap.values(),
  ];
  const store = {
    list: () => combinedList,
    get: (id: string) => customMap.get(id) ?? baseStore.get(id),
    resolve: (id: string, version?: number) => {
      const custom = customMap.get(id)?.workflow;
      if (custom && (version === undefined || custom.version === version)) return custom;
      return baseStore.resolve(id, version);
    },
    problems: baseStore.problems,
  };

  const engine = new WorkflowEngine({
    db,
    harnessVersion: "1.0.0",
    resolveWorkflow: (id, version) => store.resolve(id, version),
  });
  registerPureActions(engine);
  engine.register("agent", ok(() => ({ status: "done" })));
  engine.register("builtin:human", ok(() => ({ answer_kind: "approve" })));
  engine.register("builtin:subworkflow", ok(() => ({ status: "done" })));

  const sent: string[] = [];
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  harness.sdk.stub("threads.send", async (args: unknown) => {
    sent.push(JSON.stringify(args));
    return {};
  });

  const train = createIntakeTrain(ctx, {
    architect: { startOrder: async () => ({ threadId: "thr_arch" }) },
    workflowCatalog: {
      store: async () => store,
      peek: () => store,
      invalidate: () => undefined,
      builtin: () => null,
      builtins: () => [],
    },
    workflowEngine: engine,
    workflowLibrary: {
      issueQuickWorkflowId: () => "issue-quick",
      prepareWorkflow: async (_projectId, wf) => ({ workflow: wf, resolve: store.resolve, composed: false }),
      loadStore: async () => ({ store, project: "ok", files: { list: async () => [], read: async () => "" }, loopHooks: { manifest: null, sha256: null } }),
    },
    workflowTriggers: {
      preflight: async () => ({ ok: true, issues: [], envRequests: [], notChecked: [], checked: [] }),
    },
  });

  return { bb, harness, db, ctx, engine, train, sent };
}

describe("intake project template routing (Task 43)", () => {
  it("chooses a matching published kind='project' template with goals and records intakeTemplate/intakeConfidence", async () => {
    const template = cafeTemplate({ status: "published" });
    const { harness, db, train } = await setupIntakeWorld([template]);

    const wfRunId = await train.start({
      projectId: "proj-1",
      pmThreadId: "thr_pm",
      runId: "run1",
      requestId: "req_1",
      text: "Make a site for a cafe, here is the Google card https://maps.google.com/cafe-1",
      kind: "heavy",
    });

    expect(wfRunId).toMatch(/^wfrun_/);
    const row = wfRunRow(db, wfRunId!);
    expect(row).not.toBeNull();
    expect(row!.workflow_id).toBe("cafe-site-tpl");
    const inputs = JSON.parse(row!.inputs_json) as Record<string, unknown>;
    expect(inputs).toMatchObject({
      url: "https://maps.google.com/cafe-1",
      intakeTemplate: "cafe-site-tpl",
    });
    expect(Number(inputs.intakeConfidence)).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    const goals = JSON.parse(row!.goals_json!) as Array<{ id: string; done_when: string }>;
    expect(goals[0]).toMatchObject({ id: "request" });

    const infoLogs = harness.logEntries.filter((e) => e.level === "info").map((e) => e.message);
    expect(infoLogs.some((m) => /^intake template chosen=cafe-site-tpl conf=\d+ missing=0$/.test(m))).toBe(true);
  });

  it("also matches a >700-char heavy request through createPhaseIntake without hitting the ruleless long-brief gate", async () => {
    const template = cafeTemplate({ status: "published" });
    const { bb, harness, db, ctx, train } = await setupIntakeWorld([template]);
    const longText = `Make a site for a cafe, here is the Google card https://maps.google.com/cafe-long. ${"Include the cafe menu, coffee list, bakery hours, table booking and directions from the Google card on the website. ".repeat(7)}`;
    expect(longText.length).toBeGreaterThan(700);

    harness.sdk.stub("threads.events.list", async () => [
      { type: "client/turn/requested", data: { requestId: "creq_long", initiator: "user", input: [{ type: "text", text: longText }] } },
    ]);

    const phaseIntake = createPhaseIntake({
      bb,
      db,
      log: ctx.log,
      effectiveProjectSettings: async () => ({ values: { "phase.rails": "on" }, inherited: [], explicitKeys: [] }),
      cancelQueuedAttempt: ctx.cancelQueuedAttempt,
    }, train);

    const record = await phaseIntake.take("thr_pm");
    expect(record).toMatchObject({
      kind: "heavy",
      intakeTemplate: "cafe-site-tpl",
    });
    expect(record!.wfRunId).toMatch(/^wfrun_/);
    expect(record!.intakeConfidence).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(wfRunRow(db, record!.wfRunId!)?.workflow_id).toBe("cafe-site-tpl");
  });

  it("falls back to full-lifecycle when confidence is low, and ignores tested/generic project workflows", async () => {
    const testedOnly = cafeTemplate({ id: "cafe-site-tested", status: "tested" });
    const { harness, db, train } = await setupIntakeWorld([testedOnly]);

    // First: request matching a `tested` (unpublished) template must fall back to full-lifecycle.
    const runTested = await train.start({
      projectId: "proj-1",
      pmThreadId: "thr_pm",
      runId: "run1",
      requestId: "req_tested",
      text: "Make a site for a cafe, here is the Google card https://maps.google.com/cafe-2",
      kind: "heavy",
    });
    expect(wfRunRow(db, runTested!)?.workflow_id).toBe("full-lifecycle");
    expect(JSON.parse(wfRunRow(db, runTested!)!.inputs_json)).toMatchObject({ intakeTemplate: null });

    // Second: unrelated request with a published template yields low confidence -> full-lifecycle.
    const published = cafeTemplate({ id: "cafe-site-pub", status: "published" });
    const world2 = await setupIntakeWorld([published]);
    const runLow = await world2.train.start({
      projectId: "proj-1",
      pmThreadId: "thr_pm",
      runId: "run1",
      requestId: "req_low",
      text: "Migrate the Postgres billing database from v14 to v17 with zero downtime and verify WAL replication",
      kind: "heavy",
    });
    expect(runLow).toMatch(/^wfrun_/);
    const lowRow = wfRunRow(world2.db, runLow!);
    expect(lowRow?.workflow_id).toBe("full-lifecycle");
    const lowInputs = JSON.parse(lowRow!.inputs_json) as Record<string, unknown>;
    expect(lowInputs.intakeTemplate).toBeNull();
    expect(Number(lowInputs.intakeConfidence)).toBeLessThan(MIN_CONFIDENCE);
    expect(
      world2.harness.logEntries
        .filter((e) => e.level === "info")
        .some((e) => /^intake template chosen=none conf=\d+ missing=0$/.test(e.message)),
    ).toBe(true);

    // Third: generic project workflows (`roadmap-driven`) must not be chosen as a template.
    const world3 = await setupIntakeWorld([published]);
    const runGeneric = await world3.train.start({
      projectId: "proj-1",
      pmThreadId: "thr_pm",
      runId: "run1",
      requestId: "req_generic",
      text: "Draft a roadmap from these requirements and split it into releases MVP and polish",
      kind: "heavy",
    });
    expect(wfRunRow(world3.db, runGeneric!)?.workflow_id).toBe("full-lifecycle");
    void harness;
  });

  it("asks the owner once with all missing required input names in one lane_pilot_ask_owner form, then starts on answer", async () => {
    const template = cafeTemplate({
      status: "published",
      requiredInputs: [
        { name: "goal", type: "string", required: true },
        { name: "google_card_url", type: "string", required: true, description: "Google Maps card URL" },
        { name: "city", type: "string", required: true, description: "Cafe city" },
      ],
    });
    const { bb, harness, db, ctx, train, sent } = await setupIntakeWorld([template]);
    const longRequest = `Make a site for a cafe, here is the Google card for our new coffee shop. ${"We need menu, gallery, opening hours and directions from the card. ".repeat(12)}`;

    harness.sdk.stub("threads.events.list", async () => [
      { type: "client/turn/requested", data: { requestId: "creq_missing", initiator: "user", input: [{ type: "text", text: longRequest }] } },
    ]);

    const phaseIntake = createPhaseIntake({
      bb,
      db,
      log: ctx.log,
      ownerAsk: ctx.ownerAsk,
      effectiveProjectSettings: async () => ({ values: { "phase.rails": "on" }, inherited: [], explicitKeys: [] }),
      cancelQueuedAttempt: ctx.cancelQueuedAttempt,
    } as never, train);

    const takePromise = phaseIntake.take("thr_pm");
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));

    // Only one form is opened, and it names both missing inputs at once.
    const form = harness.pendingInteractions[0]!;
    expect(form.rendererId).toBe("lane-pilot-ask");
    const serialized = JSON.stringify(form.payload);
    expect(serialized).toContain("google_card_url");
    expect(serialized).toContain("city");

    // Submit both missing inputs in the single answer.
    harness.behavior.submitInteraction(form.id, {
      text: "google_card_url: https://maps.google.com/cafe-moscow\ncity: Moscow",
    });

    const record = await takePromise;
    expect(record).toMatchObject({ kind: "heavy" });
    await vi.waitFor(() => {
      const runs = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE workflow_id='cafe-site-tpl'").all();
      expect(runs).toHaveLength(1);
    });
    // Heavy-unavailable notice must NOT have been sent while waiting for owner inputs.
    expect(sent.some((m) => m.includes("Тяжёлая задача не запущена"))).toBe(false);

    const startedRow = db.prepare("SELECT * FROM lane_pilot_wf_run WHERE workflow_id='cafe-site-tpl'").get() as {
      id: string;
      inputs_json: string;
    };
    const startedInputs = JSON.parse(startedRow.inputs_json) as Record<string, unknown>;
    expect(startedInputs).toMatchObject({
      google_card_url: "https://maps.google.com/cafe-moscow",
      city: "Moscow",
      intakeTemplate: "cafe-site-tpl",
    });
    expect(Number(startedInputs.intakeConfidence)).toBeGreaterThanOrEqual(MIN_CONFIDENCE);
    expect(
      harness.logEntries
        .filter((e) => e.level === "info")
        .some((e) => /^intake template chosen=cafe-site-tpl conf=\d+ missing=2$/.test(e.message)),
    ).toBe(true);
  });

  it("opens only one form and returns null without blocking if the owner has not answered yet", async () => {
    const template = cafeTemplate({
      status: "published",
      requiredInputs: [
        { name: "goal", type: "string", required: true },
        { name: "google_card_url", type: "string", required: true },
        { name: "brand_name", type: "string", required: true },
      ],
    });
    const { harness, train } = await setupIntakeWorld([template]);

    const wfRunId = await train.start({
      projectId: "proj-1",
      pmThreadId: "thr_pm",
      runId: "run1",
      requestId: "req_wait",
      text: "Make a site for a cafe, here is the Google card",
      kind: "heavy",
    });

    expect(wfRunId).toBeNull();
    expect(harness.pendingInteractions).toHaveLength(1);
    const payloadText = JSON.stringify(harness.pendingInteractions[0]!.payload);
    expect(payloadText).toContain("google_card_url");
    expect(payloadText).toContain("brand_name");
    harness.behavior.cancelInteraction(harness.pendingInteractions[0]!.id);
  });
});
