import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { WorkflowEngine, createDraftStore, parseWorkflow } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCore } from "../../src/rooms/core/server/core";
import { queueHypothesis, setHypothesisState } from "../../src/rooms/evolve/server";
import { addRoad, getRoad, proposeRoad } from "../../src/rooms/lead/server";
import { listOpenOwnerItems, postOwnerItem } from "../../src/rooms/owner-waiting";
import { savePushConfig } from "../../src/rooms/owner-waiting/server";
import { openDatabase, readLoopModes, type LanePilotDatabase } from "../../src/rooms/plugin-db";
import {
  acceptDeskDefaults,
  answerDeskItem,
  composeReviewDesk,
  deskWeekKey,
  mountReports,
  reviewDeskOwnerItemKey,
  runDeskCli,
  runReviewDesk,
} from "../../src/rooms/reports/server";
import { SYSTEM_SCHEDULES, createScheduleService, ensureSystemSchedules } from "../../src/rooms/schedule/server";
import { actionOrderSchema } from "../../src/rooms/specialist";
import {
  linkIntent,
  listAutonomyRows,
  proposeLocalRule,
  proposeSharedRule,
  recomputeAutonomy,
  recordMeasurement,
  settleHypotheses,
  stageIntent,
  upsertHypothesis,
} from "../../src/rooms/specialist/server";
import { draftSha256, peekAuthority } from "../../src/rooms/workflow/server";
import { createWorkflowTriggers } from "../../src/rooms/workflow/server/services/workflow-triggers";

afterEach(() => {
  vi.useRealTimers();
});

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-23T09:30:00Z"); // Monday

function freshEnv() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  return { bb, harness, db };
}

function makeScorecard(hypothesisId: string, nodeId: string, gain: "cost" | "time" | "none" | "unknown") {
  return {
    hypothesisId,
    workflowId: "seo-page",
    nodeId,
    armKind: "model",
    cases: 10,
    k: 1,
    comparison: {
      gain,
      passCi: {
        level: 0.95,
        a: { rate: 0.7, low: 0.4, high: 0.9 },
        b: { rate: gain === "none" ? 0.7 : 0.8, low: 0.5, high: 0.95 },
        diff: { low: -0.1, high: 0.3 },
      },
      seconds: { a: 10, b: 8 },
    },
    costs: {
      baselineUsd: 1.0,
      candidateUsd: gain === "cost" ? 0.5 : 1.0,
      baselinePerAcceptedUsd: 0.2,
      candidatePerAcceptedUsd: gain === "cost" ? 0.1 : 0.2,
    },
  };
}

function makeOrder(actionClass: string, title = "Order", workflowId = "seo-page") {
  return actionOrderSchema.parse({
    kind: "sub_graph",
    title,
    domain: "seo",
    reason_code: actionClass === "analysis_propose" ? "seo_link_fix" : "seo_other",
    action_class: actionClass,
    workflow_id: workflowId,
    is_stop_or_kill: false,
    requires_owner_go: false,
    tariff_known: true,
    estimated_cost_usd: 0.1,
    forecast: {
      metric: "clicks",
      horizon_days: 7,
      lo80: 100,
      point: 120,
      hi80: 150,
      unit: "clicks",
    },
  });
}

function seedEmployeeData(db: LanePilotDatabase, now: number) {
  // 1. Seed 22 matching within outcomes across proj_a/seo so analysis_propose hits promotion gates (n >= 20, wilson >= 0.8, kappa >= 0.6).
  for (let i = 0; i < 22; i += 1) {
    const staged = stageIntent(db, {
      projectId: "proj_a",
      domain: "seo",
      sourceGraph: "sp-tick",
      slotScope: `promo_${i}`,
      order: makeOrder("analysis_propose", `Promo ${i}`, `seo-promo-${i}`),
      ownerDecision: "approve",
      nowMs: now - 3 * DAY_MS + i * 1000,
    });
    expect(staged.status).toBe("staged");
    recordMeasurement(db, {
      intentId: staged.intentId,
      measured: 125,
      source: "gsc",
      now: now - 2 * DAY_MS + i * 1000,
    });
  }
  recomputeAutonomy(db, { projectId: "proj_a", domain: "seo", now });

  // 2. Seed two active local rules across proj_a and proj_b (2 favourable outcomes each) and propose a shared rule.
  const localIds: string[] = [];
  for (const pid of ["proj_a", "proj_b"]) {
    const hyp = upsertHypothesis(db, {
      projectId: pid,
      domain: "seo",
      title: "Check canonical before redirect changes",
      nowMs: now - 6 * DAY_MS,
    });
    for (let k = 0; k < 2; k += 1) {
      const staged = stageIntent(db, {
        projectId: pid,
        domain: "seo",
        sourceGraph: "sp-tick",
        slotScope: `rule_${pid}_${k}`,
        order: makeOrder("analysis_propose", `Rule ${pid} ${k}`, `seo-rule-${pid}-${k}`),
        nowMs: now - 5 * DAY_MS + k * 1000,
      });
      expect(staged.status).toBe("staged");
      linkIntent(db, staged.intentId, hyp.id);
      recordMeasurement(db, {
        intentId: staged.intentId,
        measured: 130,
        source: "gsc",
        now: now - 4 * DAY_MS + k * 1000,
      });
    }
    settleHypotheses(db, { projectId: pid, domain: "seo", nowMs: now - 3 * DAY_MS });
    const local = proposeLocalRule(db, {
      projectId: pid,
      domain: "seo",
      hypothesisId: hyp.id,
      text: "Check canonical before redirect changes",
      nowMs: now - 3 * DAY_MS,
    });
    expect(local.ok).toBe(true);
    if (local.ok) localIds.push(local.id);
  }
  const shared = proposeSharedRule(db, {
    domain: "seo",
    ruleIds: localIds,
    nowMs: now - 2 * DAY_MS,
  });
  expect(shared.ok).toBe(true);
  return { sharedRuleId: shared.ok ? shared.id : "" };
}

function seedFullDesk(db: LanePilotDatabase, now: number) {
  const dir = addRoad(db, {
    id: "dir:proj_a",
    projectId: "proj_a",
    title: "proj_a: directions",
    kind: "direction",
    source: "lead",
    why: "root direction",
  }, now - 5 * DAY_MS);

  const roadProc = addRoad(db, {
    id: "road_proc_1",
    parentId: dir.id,
    projectId: "proj_a",
    title: "Automate weekly billing export",
    kind: "option",
    source: "lead",
    why: "Repeated unrouted path across runs",
    class: "process",
    payload: { key: "free:process:billing", kind: "free", count: 5, costMicroUsd: 200_000, lastSeen: now - 3600_000 },
  }, now - 2 * DAY_MS);
  proposeRoad(db, roadProc.id, "lead:road_proc_1", now - DAY_MS);

  const store = createDraftStore(db, () => now - DAY_MS);
  const awaitingDraft = store.create({
    projectId: "proj_a",
    threadId: null,
    scope: "project",
    name: "Billing Export",
    description: "Captured path draft",
    workflowId: "billing-export",
    metadata: { source: "path-capture", sourceRunIds: ["run_1"] },
  });

  // 3 abandoned branch-capture drafts (>14d old) -> triggers loopHealth failure on `branches`.
  const oldStore = createDraftStore(db, () => now - 20 * DAY_MS);
  for (let i = 0; i < 3; i += 1) {
    oldStore.create({
      projectId: "proj_a",
      threadId: null,
      scope: "project",
      name: `Old branch ${i}`,
      description: "Abandoned branch draft",
      workflowId: `old-branch-${i}`,
      metadata: { source: "branch-capture" },
    });
  }

  // Evolve report-only hypotheses: one with gain="none" (default reject) and one with gain="cost" (default approve).
  const hypNone = queueHypothesis(db, {
    id: "hyp_none",
    workflowId: "seo-page",
    nodeId: "draft",
    armKind: "model",
    variant: { model: "sonnet-next" },
    graphVersion: 1,
    source: "census",
    now: now - 2 * DAY_MS,
  });
  expect(hypNone.ok).toBe(true);
  setHypothesisState(db, {
    id: "hyp_none",
    state: "report_only",
    scorecard: makeScorecard("hyp_none", "draft", "none"),
    now: now - DAY_MS,
  });

  const hypCostDraft = store.create({
    projectId: "*",
    threadId: null,
    scope: "global",
    name: "seo-page",
    description: "Evolve candidate draft",
    workflowId: "seo-page",
    metadata: { source: "evolve" },
  });
  const hypGain = queueHypothesis(db, {
    id: "hyp_gain",
    workflowId: "seo-page",
    nodeId: "plan",
    armKind: "model",
    variant: { model: "haiku-next" },
    graphVersion: 1,
    source: "census",
    draftId: hypCostDraft.id,
    now: now - 2 * DAY_MS,
  });
  expect(hypGain.ok).toBe(true);
  setHypothesisState(db, {
    id: "hyp_gain",
    state: "report_only",
    draftId: hypCostDraft.id,
    scorecard: makeScorecard("hyp_gain", "plan", "cost"),
    now: now - DAY_MS,
  });

  const { sharedRuleId } = seedEmployeeData(db, now);

  // Attention budget cap=1 so the second decision item is deferred (`desk: true`).
  savePushConfig(db, { decision_cap: "1", timezone: "UTC" }, now);
  postOwnerItem(db, {
    key: "dec:first",
    source: "night",
    kind: "decision",
    what: "First decision within cap",
    why: "takes today's 1 slot",
    reason: "decision",
    wake: true,
  }, now - 20_000);
  postOwnerItem(db, {
    key: "dec:deferred",
    source: "night",
    kind: "decision",
    what: "Deferred decision for weekly desk",
    why: "exceeds today's decision cap",
    reason: "decision",
    wake: true,
  }, now - 10_000);

  return { roadProc, awaitingDraft, sharedRuleId, hypCostDraft };
}

describe("weekly review desk (Task 50)", () => {
  it("yields items across seeded sections with defaults, keeps state unchanged on silence, and stays <= 40 lines", () => {
    const { db } = freshEnv();
    const { awaitingDraft, sharedRuleId } = seedFullDesk(db, NOW);
    const logs: string[] = [];

    const desk = composeReviewDesk(
      db,
      {
        log: (m) => logs.push(m),
        durability: () => ({
          items: [
            {
              id: "dur:unexported",
              section: "durability",
              title: "Hub graph not exported to git",
              default: "keep",
              options: ["keep"],
              action: { kind: "noop" },
            },
          ],
        }),
      },
      { now: NOW },
    );

    const sections = new Set(desk.items.map((item) => item.section));
    expect(sections).toEqual(new Set(["candidates", "drafts", "evolve", "employee", "deferred", "loop-health", "durability"]));

    expect(desk.items.find((i) => i.id === "road:road_proc_1")?.default).toBe("later");
    expect(desk.items.find((i) => i.id === `draft:${awaitingDraft.id}`)?.default).toBe("keep draft");
    expect(desk.items.find((i) => i.id === "evolve:hyp_none")?.default).toBe("reject");
    expect(desk.items.find((i) => i.id === "evolve:hyp_gain")?.default).toBe("approve");
    expect(desk.items.find((i) => i.id === "autonomy:proj_a:seo:sub_graph:seo_link_fix")?.default).toBe("keep propose");
    expect(desk.items.find((i) => i.id === `rule:${sharedRuleId}`)?.default).toBe("keep local");
    expect(desk.items.find((i) => i.id === "deferred:dec:deferred")?.default).toBe("keep");
    expect(desk.items.find((i) => i.id === "loop:branches")?.default).toBe("switch to report-only");

    expect(desk.text.split("\n").length).toBeLessThanOrEqual(40);
    expect(logs.some((l) => l.startsWith(`review desk items=${desk.items.length} sections=7 failed=0`))).toBe(true);

    // Silence leaves all DB state untouched.
    expect(getRoad(db, "road_proc_1")?.state).toBe("proposed");
    expect(createDraftStore(db).get(awaitingDraft.id)?.status).toBe("draft");
    expect(readLoopModes(db, GLOBAL_SETTINGS_PROJECT_ID).branches).toBe("on");
  });

  it("isolates a throwing section as 'section unavailable' and renders the remaining sections", () => {
    const { db } = freshEnv();
    seedFullDesk(db, NOW);
    const warns: string[] = [];

    const desk = composeReviewDesk(
      db,
      {
        log: { warn: (m) => warns.push(m), info: () => undefined },
        readLoopHealth: () => {
          throw new Error("health probe crashed");
        },
      },
      { now: NOW },
    );

    expect(desk.failedSections).toEqual(["loop-health"]);
    expect(desk.text).toContain("section unavailable");
    expect(desk.items.some((i) => i.section === "candidates")).toBe(true);
    expect(desk.items.some((i) => i.section === "drafts")).toBe(true);
    expect(desk.items.some((i) => i.section === "loop-health")).toBe(false);
    expect(warns).toContain("review desk section failed: loop-health: health probe crashed");
  });

  it("accept-defaults applies only non-keep defaults and leaves keep defaults untouched", async () => {
    const { db } = freshEnv();
    const { awaitingDraft, sharedRuleId } = seedFullDesk(db, NOW);
    const logs: string[] = [];
    const publishDraft = vi.fn(async () => ({ ok: true as const, version: 2, message: "published" }));

    const result = await acceptDeskDefaults(db, {
      now: () => NOW,
      log: (m) => logs.push(m),
      evolveDeps: { publishDraft },
    });

    expect(result.applied).toBeGreaterThanOrEqual(4);
    expect(result.kept).toBeGreaterThanOrEqual(4);
    expect(result.failed).toEqual([]);

    // Non-keep defaults were applied:
    expect(getRoad(db, "road_proc_1")?.state).toBe("later");
    expect(readLoopModes(db, GLOBAL_SETTINGS_PROJECT_ID).branches).toBe("report");
    expect(publishDraft).toHaveBeenCalledTimes(1);

    // Keep defaults changed nothing:
    expect(createDraftStore(db).get(awaitingDraft.id)?.status).toBe("draft");
    expect(peekAuthority(db, awaitingDraft.id, draftSha256(awaitingDraft.definition)).ok).toBe(false);
    expect(listAutonomyRows(db, "proj_a", "seo").find((r) => r.action_class === "sub_graph:seo_link_fix")?.autonomy_class).toBe("propose");
    const sharedRow = db.prepare("SELECT state FROM lane_pilot_sp_rule WHERE id = ?").get(sharedRuleId) as { state: string };
    expect(sharedRow.state).toBe("proposed");
    expect(listOpenOwnerItems(db, { key: "dec:deferred" })).toHaveLength(1);
    expect(logs.some((l) => l.startsWith("desk answer item=road:road_proc_1 option=later"))).toBe(true);
  });

  it("answering 'publish' on a draft creates an owner publish grant and routes CLI verbs", async () => {
    const { bb, db } = freshEnv();
    const { awaitingDraft, sharedRuleId } = seedFullDesk(db, NOW);
    const ctx = createCore(bb, db);

    // Direct answerDeskItem creates grant.
    const ans = await answerDeskItem(db, { itemId: `draft:${awaitingDraft.id}`, option: "publish" }, { now: () => NOW });
    expect(ans).toMatchObject({ ok: true, itemId: `draft:${awaitingDraft.id}`, option: "publish", applied: true });
    const auth = peekAuthority(db, awaitingDraft.id, draftSha256(awaitingDraft.definition));
    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.authority.kind).toBe("owner");
      if (auth.authority.kind === "owner") expect(auth.authority.via).toBe("desk");
    }

    // CLI desk show, desk answer for autonomy/shared rule/road, and agent thread refusal.
    const showRes = await runDeskCli(ctx, {}, ["show", "--json"]);
    expect(showRes.exitCode).toBe(0);
    expect(JSON.parse(showRes.stdout ?? "{}").items.length).toBeGreaterThan(0);

    const threadRefusal = await runDeskCli(ctx, {}, ["answer", "road:road_proc_1", "reject"], { threadId: "thr_agent" } as never);
    expect(threadRefusal.exitCode).toBe(1);

    const grantRes = await runDeskCli(ctx, {}, ["answer", "autonomy:proj_a:seo:sub_graph:seo_link_fix", "grant bounded_auto"]);
    expect(grantRes.exitCode).toBe(0);
    expect(listAutonomyRows(db, "proj_a", "seo").find((r) => r.action_class === "sub_graph:seo_link_fix")?.autonomy_class).toBe("bounded_auto");

    const ruleRes = await runDeskCli(ctx, {}, ["answer", `rule:${sharedRuleId}`, "activate shared"]);
    expect(ruleRes.exitCode).toBe(0);
    const ruleRow = db.prepare("SELECT state FROM lane_pilot_sp_rule WHERE id = ?").get(sharedRuleId) as { state: string };
    expect(ruleRow.state).toBe("active");

    const saveDraftRes = await runDeskCli(ctx, {}, ["answer", "road:road_proc_1", "save as draft"]);
    expect(saveDraftRes.exitCode).toBe(0);
    expect(getRoad(db, "road_proc_1")?.state).toBe("accepted");
  });

  it("materialises the review-desk schedule on the board, respects board pause, and runs lp.review-desk to Telegram + owner item", async () => {
    let clock = Date.parse("2026-11-23T08:55:00Z"); // Monday 09:55 Europe/Madrid (UTC+1)
    vi.useFakeTimers({ toFake: ["Date"], now: clock });
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("hosts.list", async () => []);
    harness.sdk.stub("projects.list", async () => []);
    harness.sdk.stub("projects.get", async () => null);
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    seedFullDesk(db, clock);
    savePushConfig(db, { timezone: "Europe/Madrid", decision_cap: "5" }, clock);

    const wfRaw = readFileSync(join(process.cwd(), "workflows/lp.review-desk.json"), "utf8");
    const reviewDeskWf = parseWorkflow(wfRaw);
    expect(reviewDeskWf.internal).toBe(true);
    expect(reviewDeskWf.startedBy).toBe("review-desk");

    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0", now: () => clock });
    const sent: string[] = [];
    mountReports(ctx, {
      engine,
      digest: async () => ({ send: false, reason: "nothing_new", text: "", keys: [], shown: 0, more: 0 }),
      ack: () => undefined,
      send: async (text) => { sent.push(text); },
      now: () => clock,
    });

    const storeStub = {
      get: (id: string) => (id === "lp.review-desk" ? { workflow: reviewDeskWf, origin: "builtin" as const, source: "builtin", sha256: "s", warnings: [] } : null),
      list: () => [{ workflow: reviewDeskWf, origin: "builtin" as const, source: "builtin", sha256: "s", warnings: [] }],
      resolve: (id: string) => (id === "lp.review-desk" ? reviewDeskWf : null),
      problems: [],
    };

    let scheduleService!: ReturnType<typeof createScheduleService>["schedules"];
    const workflowTriggers = createWorkflowTriggers(
      ctx,
      { workflowEngine: engine } as never,
      {
        loadStore: async () => ({ store: storeStub, project: "ok" }),
        isBoardPaused: () => scheduleService.pause.isPaused(),
        now: () => clock,
      },
    );

    const { schedules } = createScheduleService(ctx, {
      docsPlaces: async () => [],
      errands: {} as never,
      listedAgentProfiles: async () => [],
      startWriterTask: async () => ({} as never),
      workflowEngine: engine,
      workflowLibrary: { loadStore: async () => ({ store: storeStub, project: "ok", loopHooks: { manifest: null, sha256: null } }) } as never,
      workflowTriggers: workflowTriggers as never,
    });
    scheduleService = schedules;

    const deskSpec = SYSTEM_SCHEDULES.find((s) => s.key === "review-desk");
    expect(deskSpec).toBeDefined();
    expect(deskSpec!.definition.when).toEqual({ type: "cron", cron: "0 10 * * 1" });
    expect(deskSpec!.definition.missed).toBe("run_once");
    expect(deskSpec!.definition.overlap).toBe("skip");

    const ensureLogs: string[] = [];
    const made = await ensureSystemSchedules(
      {
        list: () => schedules.store.list(),
        save: (raw, by) => schedules.save(raw, by),
        kv: bb.storage.kv,
        log: (m) => ensureLogs.push(m),
      },
      [deskSpec!],
    );
    expect(ensureLogs).toEqual([]);
    expect(made).toEqual(["review-desk"]);

    const row = schedules.store.list().find((r) => r.created_by === "system:review-desk")!;
    expect(row).toBeDefined();
    expect(row.timezone).toBe("Europe/Madrid");
    expect(row.cron).toBe("0 10 * * 1");

    // Pause the board and advance past Monday 10:00 Europe/Madrid (09:00 UTC) -> nothing fires.
    await schedules.pause.set(true, "freeze");
    clock = Date.parse("2026-11-23T09:05:00Z");
    vi.setSystemTime(clock);
    await schedules.tick();
    expect(schedules.store.runsOf(row.id)).toHaveLength(0);
    expect(sent).toHaveLength(0);

    // Direct schedule-source trigger also respects board pause.
    const pausedTrigger = await workflowTriggers.start({
      projectId: "*",
      workflowId: "lp.review-desk",
      inputs: {},
      source: "manual",
      origin: "schedule",
      starter: "review-desk",
      detached: true,
    });
    expect(pausedTrigger).toMatchObject({ ok: false, reason: "board_paused" });

    // Resume board -> missed run_once fires lp.review-desk, posts review-desk:<week>, and sends Telegram summary.
    await schedules.pause.set(false);
    await schedules.tick();
    await engine.idle();

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.split("\n").length).toBeLessThanOrEqual(40);
    const week = deskWeekKey(clock, "Europe/Madrid");
    const openDeskItems = listOpenOwnerItems(db, { key: reviewDeskOwnerItemKey(week) });
    expect(openDeskItems).toHaveLength(1);
    expect(openDeskItems[0]!.kind).toBe("review_desk");

    // Manual runReviewDesk respects dry_run without sending.
    savePushConfig(db, { dry_run: "on" }, clock);
    const dryRes = await runReviewDesk({ db, now: clock, send: async (t) => { sent.push(t); }, log: () => undefined });
    expect(dryRes.sent).toBe(false);
    expect(dryRes.reason).toBe("dry_run");
    expect(sent).toHaveLength(1);
  });
});
