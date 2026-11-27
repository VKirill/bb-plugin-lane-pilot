import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDraftStore, type Workflow } from "@lane-pilot/workflow-engine";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { recordTrajectoryDelta } from "../../src/rooms/errands/server";
import {
  DEFAULT_PATHS_BRANCH_DRAFT_REPEATS,
  DEFAULT_PATHS_BRANCH_WINDOW_DAYS,
  PATHS_BRANCH_DRAFT_REPEATS_KEY,
  PATHS_BRANCH_WINDOW_DAYS_KEY,
  attachNearest,
  listPathCandidates,
  listRoad,
  nearestUnits,
  parseLeadSettings,
  registerLeadTickActions,
} from "../../src/rooms/lead/server";
import { hubSnapshot } from "../../src/rooms/lead/server/services/tick-service";
import { LEAD_DEFAULTS, leadSettingProblem } from "../../src/rooms/lead/settings";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { recordRouteMiss } from "../../src/rooms/workflow/server";

const NOW = Date.now();
const DAY_MS = 86_400_000;

let leadDir = "";
beforeEach(() => {
  leadDir = mkdtempSync(join(tmpdir(), "lead-path-cand-"));
  process.env.LANE_PILOT_LEAD_DIR = leadDir;
});
afterEach(() => {
  rmSync(leadDir, { recursive: true, force: true });
  delete process.env.LANE_PILOT_LEAD_DIR;
});

function createWorld(projects: Array<{ id: string; name: string }> = [{ id: "p_a", name: "Alpha" }]) {
  const { bb } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: {
      projects: { list: async () => projects },
      skills: { list: async () => ({ skills: [] }) },
    } as never,
  });
  const db = openDatabase(bb);
  return { bb, db };
}

function seedRun(
  db: ReturnType<typeof openDatabase>,
  input: {
    id: string;
    workflowId?: string;
    projectId?: string | null;
    inputs?: Record<string, unknown>;
    createdAt?: number;
    steps?: Array<{ key: string; costMicroUsd: number | null; sessionId?: string | null }>;
  },
) {
  const at = input.createdAt ?? NOW - 60_000;
  db.prepare(
    `INSERT INTO lane_pilot_wf_run
      (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
     VALUES (?, ?, 1, 'sha', '{}', ?, 'succeeded', ?, '{}', 0, 0, ?, ?)`,
  ).run(
    input.id,
    input.workflowId ?? "errand",
    input.projectId === undefined ? "p_a" : input.projectId,
    JSON.stringify(input.inputs ?? {}),
    at,
    at + 10_000,
  );
  for (const step of input.steps ?? []) {
    db.prepare(
      `INSERT INTO lane_pilot_wf_step
        (run_id, step_key, origin, node_id, visit, state, cost_micro_usd, session_id, updated_at)
       VALUES (?, ?, ?, ?, 1, 'succeeded', ?, ?, ?)`,
    ).run(
      input.id,
      step.key,
      step.key,
      step.key,
      step.costMicroUsd,
      step.sessionId ?? null,
      at + 5_000,
    );
  }
}

function seedEpisode(
  db: ReturnType<typeof openDatabase>,
  input: {
    runId: string;
    workflowId?: string;
    projectId?: string | null;
    processKey?: string | null;
    traceJson?: string | null;
    createdAt?: number;
    updatedAt?: number;
  },
) {
  const createdAt = input.createdAt ?? NOW - 60_000;
  const updatedAt = input.updatedAt ?? createdAt;
  db.prepare(
    `INSERT INTO lane_pilot_errand_episode
      (run_id, extractor_version, project_id, workflow_id, status, outcome, trace_json, process_key, created_at, updated_at)
     VALUES (?, 1, ?, ?, 'succeeded', 'done', ?, ?, ?, ?)`,
  ).run(
    input.runId,
    input.projectId === undefined ? "p_a" : input.projectId,
    input.workflowId ?? "errand",
    input.traceJson ?? null,
    input.processKey ?? null,
    createdAt,
    updatedAt,
  );
}

describe("paths.branch_draft_repeats and paths.branch_window_days settings", () => {
  it("parses defaults and validates bounds", () => {
    expect(PATHS_BRANCH_DRAFT_REPEATS_KEY).toBe("paths.branch_draft_repeats");
    expect(PATHS_BRANCH_WINDOW_DAYS_KEY).toBe("paths.branch_window_days");
    expect(DEFAULT_PATHS_BRANCH_DRAFT_REPEATS).toBe(3);
    expect(DEFAULT_PATHS_BRANCH_WINDOW_DAYS).toBe(30);

    expect(parseLeadSettings({})).toMatchObject({
      branchDraftRepeats: 3,
      branchWindowDays: 30,
    });
    expect(
      parseLeadSettings({
        [PATHS_BRANCH_DRAFT_REPEATS_KEY]: 5,
        [PATHS_BRANCH_WINDOW_DAYS_KEY]: 14,
      }),
    ).toMatchObject({
      branchDraftRepeats: 5,
      branchWindowDays: 14,
    });

    expect(leadSettingProblem(PATHS_BRANCH_DRAFT_REPEATS_KEY, 0)).not.toBeNull();
    expect(leadSettingProblem(PATHS_BRANCH_DRAFT_REPEATS_KEY, 21)).not.toBeNull();
    expect(leadSettingProblem(PATHS_BRANCH_DRAFT_REPEATS_KEY, 3)).toBeNull();
    expect(leadSettingProblem(PATHS_BRANCH_WINDOW_DAYS_KEY, 6)).not.toBeNull();
    expect(leadSettingProblem(PATHS_BRANCH_WINDOW_DAYS_KEY, 181)).not.toBeNull();
    expect(leadSettingProblem(PATHS_BRANCH_WINDOW_DAYS_KEY, 30)).toBeNull();
  });
});

describe("listPathCandidates", () => {
  it("ranks by count * max(costMicroUsd, 1), handles null step costs, and lists single-occurrence groups", () => {
    const { db } = createWorld();
    // High-cost 2-run group via process_key (2 * 500_000 = 1_000_000)
    seedRun(db, {
      id: "run_expensive_1",
      inputs: { title: "Sync billing ledger" },
      steps: [
        { key: "s1", costMicroUsd: 300_000 },
        { key: "s2", costMicroUsd: null },
      ],
    });
    seedRun(db, {
      id: "run_expensive_2",
      inputs: { title: "Sync billing ledger" },
      steps: [{ key: "s1", costMicroUsd: 200_000 }],
    });
    seedEpisode(db, { runId: "run_expensive_1", processKey: "billing|sync" });
    seedEpisode(db, { runId: "run_expensive_2", processKey: "billing|sync" });

    // 4-run cheap group via identical trace_json (4 * 10_000 = 40_000)
    const trace = JSON.stringify(["agent:errand", "action:bb"]);
    for (let i = 1; i <= 4; i += 1) {
      const id = `run_cheap_${i}`;
      seedRun(db, {
        id,
        inputs: { title: `Check status ${i}` },
        steps: [{ key: "s1", costMicroUsd: i === 1 ? 10_000 : null }],
      });
      seedEpisode(db, { runId: id, traceJson: trace });
    }

    // Single-occurrence group (no minimum count) and confidence < 90 non-errand episode
    seedRun(db, {
      id: "run_single",
      workflowId: "deploy",
      inputs: { title: "One-off deploy check", routeTop: "deploy:75" },
      steps: [{ key: "s1", costMicroUsd: null }],
    });
    seedEpisode(db, { runId: "run_single", workflowId: "deploy", processKey: "deploy|single" });

    // Confident graph match (>= 90) must be excluded
    seedRun(db, {
      id: "run_matched",
      workflowId: "invoice-send",
      inputs: { title: "Matched invoice", routeTop: "invoice-send:95" },
      steps: [{ key: "s1", costMicroUsd: 9_999_999 }],
    });
    seedEpisode(db, { runId: "run_matched", workflowId: "invoice-send", processKey: "invoice|matched" });

    const debugLogs: string[] = [];
    const { free, branch } = listPathCandidates(db, {
      now: NOW,
      windowDays: 30,
      repeats: 3,
      log: { debug: (m) => debugLogs.push(m) },
    });

    expect(branch).toEqual([]);
    expect(free).toHaveLength(3);
    expect(free.map((c) => c.key)).toEqual([
      "free:process:billing|sync",
      free[1]!.key,
      "free:process:deploy|single",
    ]);
    expect(free[0]).toMatchObject({
      key: "free:process:billing|sync",
      kind: "free",
      count: 2,
      costMicroUsd: 500_000,
      ready: false,
    });
    expect(free[0]!.runIds).toHaveLength(2);
    expect(free[1]).toMatchObject({
      kind: "free",
      count: 4,
      costMicroUsd: 10_000,
      ready: false,
    });
    expect(free[1]!.key.startsWith("free:trace:")).toBe(true);
    expect(free[2]).toMatchObject({
      key: "free:process:deploy|single",
      kind: "free",
      count: 1,
      costMicroUsd: 0,
      ready: false,
    });
    expect(debugLogs).toEqual(["path candidates free=3 branch=0 ready=0"]);
  });

  it("groups route misses by brief_hash inside the window", () => {
    const { db } = createWorld();
    recordRouteMiss(db, {
      projectId: "p_a",
      source: "errand_route",
      kind: "no_candidate",
      brief: "Export quarterly VAT report",
      now: NOW - 2 * DAY_MS,
    });
    recordRouteMiss(db, {
      projectId: "p_a",
      source: "pm_route",
      kind: "weak_match",
      brief: "Export quarterly VAT report",
      now: NOW - 1 * DAY_MS,
    });
    recordRouteMiss(db, {
      projectId: "p_a",
      source: "errand_route",
      kind: "no_candidate",
      brief: "Clean staging buckets",
      now: NOW - 1 * DAY_MS,
    });
    // Out of window
    recordRouteMiss(db, {
      projectId: "p_a",
      source: "errand_route",
      kind: "no_candidate",
      brief: "Export quarterly VAT report",
      now: NOW - 45 * DAY_MS,
    });

    const { free } = listPathCandidates(db, { now: NOW, windowDays: 30, repeats: 3 });
    expect(free).toHaveLength(2);
    expect(free[0]).toMatchObject({
      kind: "free",
      count: 2,
      costMicroUsd: 0,
      label: "Export quarterly VAT report",
      ready: false,
    });
    expect(free[0]!.key.startsWith("free:miss:")).toBe(true);
    expect(free[1]).toMatchObject({
      kind: "free",
      count: 1,
      label: "Clean staging buckets",
      ready: false,
    });
  });

  it("groups trajectory deltas by (graph_id, kind, normalized detail) and marks ready at repeats", () => {
    const { db } = createWorld();
    seedRun(db, {
      id: "run_g1",
      workflowId: "deploy-flow",
      steps: [{ key: "s1", costMicroUsd: 120_000, sessionId: "thr_b1" }],
    });

    recordTrajectoryDelta(db, {
      id: "td_1",
      projectId: "p_a",
      threadId: "thr_b1",
      workflowId: "deploy-flow",
      stageArchetype: "verify",
      interventionKind: "step_inserted",
      rawSummary: "Add smoke test before deploy!",
      now: NOW - 3 * DAY_MS,
    });
    recordTrajectoryDelta(db, {
      id: "td_2",
      projectId: "p_a",
      threadId: "thr_b2",
      workflowId: "deploy-flow",
      stageArchetype: "verify",
      interventionKind: "step_inserted",
      rawSummary: "  add   smoke test before deploy ",
      now: NOW - 2 * DAY_MS,
    });
    recordTrajectoryDelta(db, {
      id: "td_3",
      projectId: "p_a",
      threadId: "thr_b3",
      workflowId: "deploy-flow",
      stageArchetype: "verify",
      interventionKind: "step_inserted",
      rawSummary: "ADD SMOKE TEST BEFORE DEPLOY?",
      now: NOW - 1 * DAY_MS,
    });
    // Below threshold (count = 1)
    recordTrajectoryDelta(db, {
      id: "td_4",
      projectId: "p_a",
      threadId: "thr_b4",
      workflowId: "deploy-flow",
      stageArchetype: "review",
      interventionKind: "rule_added",
      rawSummary: "Skip lint on docs",
      now: NOW - 1 * DAY_MS,
    });
    // Out of window
    recordTrajectoryDelta(db, {
      id: "td_old",
      projectId: "p_a",
      threadId: "thr_old",
      workflowId: "deploy-flow",
      stageArchetype: "verify",
      interventionKind: "step_inserted",
      rawSummary: "Add smoke test before deploy!",
      now: NOW - 35 * DAY_MS,
    });

    const at3 = listPathCandidates(db, { now: NOW, windowDays: 30, repeats: 3 });
    expect(at3.branch).toHaveLength(2);
    expect(at3.branch[0]).toMatchObject({
      kind: "branch",
      graphId: "deploy-flow",
      count: 3,
      costMicroUsd: 120_000,
      runIds: ["run_g1"],
      ready: true,
    });
    expect(at3.branch[1]).toMatchObject({
      kind: "branch",
      graphId: "deploy-flow",
      count: 1,
      ready: false,
    });

    const at4 = listPathCandidates(db, { now: NOW, windowDays: 30, repeats: 4 });
    expect(at4.branch[0]!.ready).toBe(false);
  });

  it("logs a warning and skips a failing source without dropping other sources", () => {
    const { db } = createWorld();
    recordTrajectoryDelta(db, {
      id: "td_keep",
      projectId: "p_a",
      workflowId: "deploy-flow",
      stageArchetype: "verify",
      interventionKind: "rule_added",
      rawSummary: "Keep running",
      now: NOW - 1_000,
    });
    db.exec("DROP TABLE lane_pilot_route_miss");

    const warns: string[] = [];
    const debugs: string[] = [];
    const res = listPathCandidates(db, {
      now: NOW,
      windowDays: 30,
      repeats: 1,
      log: {
        warn: (m) => warns.push(m),
        debug: (m) => debugs.push(m),
      },
    });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/^path candidates source failed source=misses:/);
    expect(res.branch).toHaveLength(1);
    expect(debugs).toEqual(["path candidates free=0 branch=1 ready=1"]);
  });
});

describe("nearestUnits and attachNearest with drafts and internal graphs", () => {
  it("surfaces pending drafts as draft:<id> and internal: true graphs as nearest candidates", async () => {
    const { bb, db } = createWorld();
    const drafts = createDraftStore(db);
    const created = drafts.create({
      projectId: "p_a",
      threadId: null,
      scope: "project",
      workflowId: "vat-export-draft",
      name: { en: "Export quarterly VAT report", ru: "Экспорт квартального отчёта НДС" },
      description: { en: "Exports quarterly VAT report from accounting", ru: "Экспорт отчёта НДС" },
    });

    const internalWf = {
      id: "internal-audit-sync",
      version: 1,
      name: { en: "Internal audit sync", ru: "Внутренняя синхронизация аудита" },
      description: { en: "Synchronize audit records internally", ru: "Синхронизация записей аудита" },
      examples: { en: ["synchronize audit records"], ru: [] },
      not_for: [],
      tags: ["audit", "sync"],
      scope: { level: "global" },
      status: "published",
      internal: true,
      inputs: [],
      outputs: [],
      requires: { plugins: [], skills: [], mcpServers: [], secrets: [], machines: [], project: {} },
      nodes: [],
      edges: [],
    } as unknown as Workflow;

    const draftUnits = await nearestUnits("Export quarterly VAT report", {
      workflows: [internalWf],
      skills: [],
      tree: null,
      drafts: [created],
    });
    expect(draftUnits.some((u) => u.id === `draft:${created.id}`)).toBe(true);

    const internalUnits = await nearestUnits("Synchronize audit records", {
      workflows: [internalWf],
      skills: [],
      tree: null,
      drafts: [],
    });
    expect(internalUnits.some((u) => u.id === "internal-audit-sync")).toBe(true);

    const row = {
      kind: "free",
      samples: ["Export quarterly VAT report"],
      projects: ["p_a"],
      signals: { repeatedTrace: null, providers: 0 },
      nearest: [] as Array<{ kind: "graph" | "skill"; id: string; score: number }>,
      hint: null,
    };
    await attachNearest({
      bb: bb as never,
      db,
      workflowCatalog: { store: async () => ({ list: () => [{ workflow: internalWf }] }) } as never,
      fallbackProjectId: "p_a",
      rows: [row],
      log: () => undefined,
      readTree: async () => null,
    });
    expect(row.nearest.some((u) => u.id === `draft:${created.id}`)).toBe(true);
  });
});

describe("lead tick road sync for discovery candidates", () => {
  it("writes ranked free and ready branch candidates to the road and stays idempotent across two ticks", async () => {
    const { bb, db } = createWorld();
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, PATHS_BRANCH_DRAFT_REPEATS_KEY, 2);
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, PATHS_BRANCH_WINDOW_DAYS_KEY, 30);

    const drafts = createDraftStore(db);
    const vatDraft = drafts.create({
      projectId: "p_a",
      threadId: null,
      scope: "project",
      workflowId: "vat-export",
      name: { en: "Export quarterly VAT report", ru: "Экспорт НДС" },
      description: { en: "Quarterly VAT report export", ru: "Квартальный отчёт НДС" },
    });

    seedRun(db, {
      id: "run_1",
      inputs: { title: "Export quarterly VAT report" },
      steps: [{ key: "s1", costMicroUsd: 250_000 }],
    });
    seedEpisode(db, { runId: "run_1", processKey: "vat|export", createdAt: NOW - 60_000 });

    recordRouteMiss(db, {
      projectId: "p_a",
      source: "errand_route",
      kind: "no_candidate",
      brief: "Archive old invoices",
      now: NOW - 50_000,
    });

    // Ready branch (2 >= 2)
    recordTrajectoryDelta(db, {
      id: "td_ready_1",
      projectId: "p_a",
      workflowId: "invoice-send",
      stageArchetype: "send",
      interventionKind: "rule_added",
      rawSummary: "Wait for confirmation before send",
      now: NOW - 40_000,
    });
    recordTrajectoryDelta(db, {
      id: "td_ready_2",
      projectId: "p_a",
      workflowId: "invoice-send",
      stageArchetype: "send",
      interventionKind: "rule_added",
      rawSummary: "wait for confirmation before send",
      now: NOW - 30_000,
    });

    // Unready branch (1 < 2) must NOT be written to road
    recordTrajectoryDelta(db, {
      id: "td_unready_1",
      projectId: "p_a",
      workflowId: "deploy-flow",
      stageArchetype: "check",
      interventionKind: "step_inserted",
      rawSummary: "Run extra smoke test",
      now: NOW - 20_000,
    });

    const settings = parseLeadSettings({
      [PATHS_BRANCH_DRAFT_REPEATS_KEY]: 2,
      [PATHS_BRANCH_WINDOW_DAYS_KEY]: 30,
    });
    const services = {
      workflowCatalog: {
        store: async () => ({ list: () => [] }),
        builtins: () => [],
      },
    } as never;

    await hubSnapshot({ db, bb } as never, settings, { tickId: "tick_1", trigger: "manual" }, NOW, services);

    const optionsTick1 = listRoad(db, { kind: "option" });
    expect(optionsTick1).toHaveLength(3);

    const vatRow = optionsTick1.find((r) => JSON.parse(r.payload_json!).key === "free:process:vat|export")!;
    expect(vatRow).toMatchObject({ class: "process", source: "lead", state: "proposed", project_id: "p_a" });
    const vatPayload = JSON.parse(vatRow.payload_json!) as { key: string; nearest?: Array<{ id: string }> };
    expect(vatPayload.nearest?.some((u) => u.id === `draft:${vatDraft.id}`)).toBe(true);

    const missRow = optionsTick1.find((r) => String(JSON.parse(r.payload_json!).key).startsWith("free:miss:"))!;
    expect(missRow).toMatchObject({ class: "process", source: "lead", state: "proposed" });

    const branchRow = optionsTick1.find((r) => r.class === "branch")!;
    expect(branchRow).toMatchObject({ class: "branch", source: "lead", state: "proposed", project_id: "p_a" });
    expect(JSON.parse(branchRow.payload_json!)).toMatchObject({
      graphId: "invoice-send",
      count: 2,
    });

    // Second tick via lp.lead_state with an additional occurrence updates existing rows without duplicating
    seedRun(db, {
      id: "run_2",
      inputs: { title: "Export quarterly VAT report" },
      steps: [{ key: "s1", costMicroUsd: 150_000 }],
      createdAt: NOW + 1_000,
    });
    seedEpisode(db, { runId: "run_2", processKey: "vat|export", createdAt: NOW + 1_000 });

    const executors = new Map<string, { run(c: unknown): Promise<{ output: Record<string, unknown> }> }>();
    registerLeadTickActions(
      { register: (name: string, executor: never) => { executors.set(name, executor); } } as never,
      { db, bb } as never,
      services,
    );
    await executors.get("lp.lead_state")!.run({
      runId: "lprun_tick_2",
      stepKey: "state",
      nodeId: "state",
      resolve: (ref: string) => (ref === "$inputs.tickId" ? "tick_2" : ref === "$inputs.trigger" ? "manual" : ""),
    });

    const optionsTick2 = listRoad(db, { kind: "option" });
    expect(optionsTick2).toHaveLength(3);
    const vatRow2 = optionsTick2.find((r) => r.id === vatRow.id)!;
    expect(JSON.parse(vatRow2.payload_json!)).toMatchObject({
      key: "free:process:vat|export",
      count: 2,
      costMicroUsd: 400_000,
    });
    expect(LEAD_DEFAULTS.branchDraftRepeats).toBe(3);
  });
});
