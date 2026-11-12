import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { listMemoryReceipts, recordMemoryReceipt } from "@lane-pilot/memory-core";
import type { StepContext, Workflow, WorkflowStore } from "@lane-pilot/workflow-engine";
import { describe, expect, it } from "vitest";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { collectOwnerWaiting, listOpenOwnerItems, postOwnerItem } from "../../src/rooms/owner-waiting";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { actionOrderSchema } from "../../src/rooms/specialist";
import {
  checkCohortMaturity,
  runVerifiedSkillScript,
  specialistItemSweep,
  specialistLedgerSummary,
  specialistOverview,
  specialistSnapshot,
  stageIntent,
  upsertCharter,
  upsertCohort,
} from "../../src/rooms/specialist/server";
import {
  getProjectArtifact,
  listProjectArtifacts,
  listTaskTransitions,
} from "../../src/rooms/storage";
import { runWorkflowTool } from "../../src/rooms/workflow/server/workflow-tools";
import { setupLiveSpecialistEnv } from "./live-e2e-harness";

describe("Specialist OS live ActionOrder dispatch, PDAS v1 artifacts, and G-22..G-35 closures", () => {
  it("closes G-22: checkCohortMaturity treats missing cohort rows as immature (never mature:true)", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const missing = checkCohortMaturity(db, "p1", "marketing", "missing_cohort");
    expect(missing.mature).toBe(false);
    expect(missing.unknownCohort).toBe(true);
    expect(missing.reasonCode).toBe("immature_cohort");

    const now = Date.parse("2026-11-12T10:00:00Z");
    upsertCohort(db, {
      projectId: "p1",
      domain: "marketing",
      cohortKey: "young_cohort",
      channel: "yandex_direct",
      cohortDate: "2026-11-10",
      maturityWindowDays: 14,
      cdfPay: 0.25,
      nowMs: now,
    });
    const young = checkCohortMaturity(db, "p1", "marketing", "young_cohort", now);
    expect(young.mature).toBe(false);
    expect(young.unknownCohort).toBeUndefined();

    upsertCohort(db, {
      projectId: "p1",
      domain: "marketing",
      cohortKey: "mature_cohort",
      channel: "yandex_direct",
      cohortDate: "2026-10-20",
      maturityWindowDays: 14,
      cdfPay: 0.92,
      nowMs: now,
    });
    const mature = checkCohortMaturity(db, "p1", "marketing", "mature_cohort", now);
    expect(mature.mature).toBe(true);
    expect(mature.cdfPay).toBeCloseTo(0.92, 2);
  });

  it("closes G-23: runVerifiedSkillScript in live mode returns degraded_error without silently running --fixture", async () => {
    const liveRes = await runVerifiedSkillScript({
      skill: "seo-programmatic-bofu",
      script: "cf_batch_handoff.py",
      args: {},
      timeoutSec: 15,
      mode: "live",
    });
    expect(liveRes.usedFixtureFallback).toBe(false);
    expect(liveRes.raw.degraded_error).toBe(true);
  });

  it("executes all 7 ActionOrder kinds through sp.dispatch_tasks with late-bound services and PDAS v1 artifacts", async () => {
    const env = await setupLiveSpecialistEnv();
    try {
      upsertCharter(env.db, {
        projectId: env.projectId,
        domain: "marketing",
        charter: { budgets: { daily_cap_usd: 500, cell_cap_usd: 200, rolling_24h_auto_cap_usd: 200, max_active_cells: 10 } },
      });

      const stepCtx = (params: Record<string, unknown>): StepContext<ChainRuntime> =>
        ({
          runId: "wf_run_dispatch_test",
          stepId: "step_dispatch",
          stepKey: "step_dispatch#1",
          mode: "live",
          node: { id: "step_dispatch", type: "action", action: "sp.dispatch_tasks", params, out: [] },
          workflow: { id: "mkt-weekly-review", version: 1, name: { en: "Weekly Review" }, nodes: [] } as unknown as Workflow,
          runtime: env.rt,
          template: (v: unknown) => v,
          render: (s: string) => s,
          resolve: (v: unknown) => v,
          params,
        }) as unknown as StepContext<ChainRuntime>;

      const orders = [
        {
          kind: "schedule",
          title: "Daily CTR Watch",
          cron: "0 9 * * *",
          targetWorkflowId: "seo-monitor",
          inputs: { domain: "example.com" },
          estimated_cost_usd: 0,
        },
        {
          kind: "code_task",
          title: "Fix CLS on hero banner",
          rationale: "LCP/CLS regression on mobile",
          acceptance_criteria: ["CLS < 0.05 on mobile"],
          target_paths: ["src/hero.tsx"],
          priority: "high",
          estimated_cost_usd: 0,
        },
        {
          kind: "specialist_handoff",
          to_domain: "copy",
          agent_id: "copy-lead",
          title: "Rewrite hero headline",
          brief: "Align headline with JTBD push force",
          context_paths: [".agents/passport/PASSPORT.json"],
          estimated_cost_usd: 0,
        },
        {
          kind: "create_extension",
          ext_kind: "workflow",
          title: "Weekly hero CRO check",
          slug: "custom-cro-check",
          rationale: "Weekly hero CRO check",
          spec: { version: 1 },
          estimated_cost_usd: 0,
        },
        {
          kind: "create_extension",
          ext_kind: "skill",
          title: "CRO micro heuristics",
          slug: "cro-micro-heuristics",
          rationale: "Reusable form friction checklist",
          spec: { checklist: ["max 3 fields"] },
          estimated_cost_usd: 0,
        },
        {
          kind: "content_batch",
          title: "Comparison pages Q4",
          pages: [
            { slug: "vs-linear", cluster: "pm-tools", intent: "commercial" },
            { slug: "vs-jira", cluster: "pm-tools", intent: "commercial" },
          ],
          estimated_cost_usd: 0,
        },
        {
          kind: "owner_gate",
          title: "Approve $2k paid search test",
          question: "Approve $2,000 Google Ads test on US SaaS keywords?",
          options: ["Approve", "Defer"],
          estimated_cost_usd: 0,
        },
      ];

      const dispatchExec = (
        env.engine as unknown as { executors: Map<string, { run: (c: StepContext<ChainRuntime>) => Promise<{ output: Record<string, unknown> }> }> }
      ).executors.get("sp.dispatch_tasks");
      expect(dispatchExec).toBeDefined();

      const res = await dispatchExec!.run(
        stepCtx({
          domain: "marketing",
          actionClass: "low_risk_ops",
          orders,
        }),
      );

      expect(Number(res.output.executed_count)).toBeGreaterThanOrEqual(2);
      expect(Number(res.output.proposed_count)).toBe(3);
      expect(Number(res.output.waiting_owner_count)).toBeGreaterThanOrEqual(1);
      expect(Number(res.output.blocked_count)).toBe(0);
      expect(
        Number(res.output.executed_count) +
          Number(res.output.proposed_count) +
          Number(res.output.waiting_owner_count),
      ).toBe(7);

      // 1. schedule saved via late-bound services.schedules without invalid `enabled` key
      expect(env.savedSchedules).toHaveLength(1);
      expect(env.savedSchedules[0]).not.toHaveProperty("enabled");

      // 2. code_task wrote .agents/todos/items/<slug>, triggered backlog.scan, and indexed PDAS artifact
      expect(env.backlogScans).toContain(env.projectId);
      const todoArtifacts = listProjectArtifacts(env.db, env.projectId, { kind: "backlog_item" });
      expect(todoArtifacts.length).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(env.checkout, todoArtifacts[0]!.rel_path))).toBe(true);

      // 3. create_extension wrote skill draft + workflow draft
      expect(listProjectArtifacts(env.db, env.projectId, { kind: "extension_skill" }).length).toBeGreaterThanOrEqual(1);

      // 4. content_batch never fabricated hardcoded vs-competitor-a
      const cfBatches = env.db
        .prepare("SELECT batch_id, item_count FROM lane_pilot_sp_cf_batch WHERE project_id = ?")
        .all(env.projectId) as Array<{ batch_id: string; item_count: number }>;
      expect(cfBatches.length).toBeGreaterThanOrEqual(1);
      expect(cfBatches[0]!.item_count).toBe(2);
      const cfStagingArts = listProjectArtifacts(env.db, env.projectId, { kind: "cf_batch_manifest" });
      expect(cfStagingArts.length).toBeGreaterThanOrEqual(1);
      const stagedManifestText = readFileSync(join(env.checkout, cfStagingArts[0]!.rel_path), "utf8");
      expect(stagedManifestText).toContain("vs-linear");
      expect(stagedManifestText).not.toContain("vs-competitor-a");

      // 5. owner_gate posted valid OwnerWaiting item
      const openOwner = listOpenOwnerItems(env.db, { source: "specialist" });
      expect(openOwner.length).toBeGreaterThanOrEqual(1);

      // 6. .agents/manifest.json updated with PDAS v1 schema
      const manifest = JSON.parse(readFileSync(join(env.checkout, ".agents/manifest.json"), "utf8")) as {
        schema: string;
        artifacts: Array<{ rel_path: string }>;
      };
      expect(manifest.schema).toBe("lp.project-manifest/1");
      expect(manifest.artifacts.length).toBeGreaterThanOrEqual(3);
    } finally {
      await env.dispose();
    }
  });

  it("writes lane_pilot_sp_eval_run, question answers, api_units ledger, fs.write folder files, and sweeps resolved owner items", async () => {
    const env = await setupLiveSpecialistEnv();
    try {
      const execs = (
        env.engine as unknown as { executors: Map<string, { run: (c: StepContext<ChainRuntime>) => Promise<{ output: Record<string, unknown> }> }> }
      ).executors;

      // Test fs.write folder mode with `files` array (G-28 + PDAS v1)
      const fsWrite = execs.get("fs.write")!;
      const fsParams = {
        path: ".agents/seo/pages/pricing/",
        files: [
          { path: "brief.md", content: "# Pricing SEO Brief\n" },
          { name: "meta.json", content: JSON.stringify({ title: "Pricing" }) },
        ],
      };
      const fsOut = await fsWrite.run({
        runId: "wf_fs_folder",
        stepId: "write_folder",
        nodeId: "write_folder",
        node: {
          id: "write_folder",
          type: "action",
          action: "fs.write",
          params: fsParams,
          out: [{ name: "folder", type: "string" }],
        },
        workflow: { id: "seo-page-build", version: 1, name: { en: "SEO Page Build" }, nodes: [] } as unknown as Workflow,
        runtime: env.rt,
        template: (v: unknown) => v,
        render: (s: string) => s,
        resolve: (v: unknown) => v,
        params: fsParams,
      } as unknown as StepContext<ChainRuntime>);
      expect(fsOut.output.folder).toBe(".agents/seo/pages/pricing/");
      expect(existsSync(join(env.checkout, ".agents/seo/pages/pricing/brief.md"))).toBe(true);
      expect(existsSync(join(env.checkout, ".agents/seo/pages/pricing/meta.json"))).toBe(true);
      expect(getProjectArtifact(env.db, env.projectId, ".agents/seo/pages/pricing/brief.md")?.domain).toBe("seo");

      // Test sp.commit_memory writing eval_run + question answers + api_units + shadow questions (no fake hardcoded questions!)
      mkdirSync(join(env.checkout, ".agents/specialist"), { recursive: true });
      const shadowPath = ".agents/specialist/shadow-questions.json";
      writeFileSync(
        join(env.checkout, shadowPath),
        JSON.stringify([{ question_id: "q_checkout_friction", question_ru: "На каком шаге отваливаются при оплате?" }]),
        "utf8",
      );

      const commitExec = execs.get("sp.commit_memory")!;
      const commitParams = {
        domain: "marketing",
        summary: { note: "Nightly eval completed" },
        shadowQuestions: JSON.parse(readFileSync(join(env.checkout, shadowPath), "utf8")),
        answeredQuestions: [{ questionId: "q_checkout_friction", answer: "42% drop at card CVV" }],
        apiUnitsSpent: 42,
        evalReport: {
          suite: "golden_20",
          passed: 19,
          total: 20,
          calibration_ece: 0.03,
          false_action_rate: 0.0,
        },
      };
      const commitRes = await commitExec.run({
        runId: "wf_eval_1",
        stepId: "commit_eval",
        node: {
          id: "commit_eval",
          type: "action",
          action: "sp.commit_memory",
          params: commitParams,
          out: [{ name: "questions_added", type: "number" }, { name: "swept_questions", type: "number" }],
        },
        workflow: { id: "lp.specialist-eval", version: 1, name: { en: "Specialist Eval" }, nodes: [] } as unknown as Workflow,
        runtime: env.rt,
        template: (v: unknown) => v,
        render: (s: string) => s,
        resolve: (v: unknown) => v,
        params: commitParams,
      } as unknown as StepContext<ChainRuntime>);
      expect(commitRes.output.questions_added).toBe(1);
      expect(commitRes.output.swept_questions).toBe(1);

      const evalRows = env.db
        .prepare("SELECT * FROM lane_pilot_sp_eval_run WHERE project_id = ? AND role = 'growth-marketer'")
        .all(env.projectId) as Array<Record<string, unknown>>;
      expect(evalRows).toHaveLength(1);

      const qRow = env.db
        .prepare("SELECT status, answer_text FROM lane_pilot_sp_question_state WHERE project_id = ? AND question_id = 'q_checkout_friction'")
        .get(env.projectId) as { status: string; answer_text: string } | undefined;
      expect(qRow?.status).toBe("answered");
      expect(qRow?.answer_text).toContain("42%");

      const ledger = specialistLedgerSummary(env.db, Date.now(), env.projectId);
      expect(ledger.apiUnits30d).toBeGreaterThanOrEqual(42);

      // Test dead-table closures: listTaskTransitions + listMemoryReceipts + specialistOverview + specialistItemSweep
      env.db
        .prepare("INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('t_1', 'sp-live-run', 'bb', '{}', ?)")
        .run(Date.now());
      env.db
        .prepare("INSERT INTO lane_pilot_task_transition (task_id, field, reason, at) VALUES ('t_1', 'state', 'dispatched', ?)")
        .run(Date.now());
      expect(listTaskTransitions(env.db, "sp-live-run")).toHaveLength(1);

      recordMemoryReceipt(env.db as never, {
        projectId: env.projectId,
        role: "writer",
        returnedIds: ["m1", "m2"],
        packedIds: ["m1"],
        tokens: 180,
      });
      expect(listMemoryReceipts(env.db as never, env.projectId, 10)).toHaveLength(1);

      const staged = stageIntent(env.db, {
        projectId: env.projectId,
        domain: "marketing",
        sourceGraph: "mkt-weekly-review",
        order: actionOrderSchema.parse({
          kind: "owner_gate",
          domain: "marketing",
          title: "Sweep test gate",
          reason_code: "owner_approval_required",
          action_class: "budget_change",
          estimated_cost_usd: 0,
          question: "Proceed?",
        }),
        forceHold: true,
      });
      postOwnerItem(env.db, {
        key: `sp:intent:${staged.intentId}`,
        source: "specialist",
        kind: "decision",
        projectId: env.projectId,
        wake: false,
        what: "Sweep test gate",
        why: "Testing specialistItemSweep",
        evidence: [],
        actions: [{ id: "ok", label: "OK", cli: "bb lane-pilot owner-waiting close" }],
      });
      expect(listOpenOwnerItems(env.db, { source: "specialist" }).some((i) => i.key === `sp:intent:${staged.intentId}`)).toBe(true);
      env.db.prepare("UPDATE lane_pilot_sp_intent SET status = 'dispatched' WHERE intent_id = ?").run(staged.intentId);
      collectOwnerWaiting(env.db, Date.now(), [specialistItemSweep]);
      expect(listOpenOwnerItems(env.db, { source: "specialist" }).some((i) => i.key === `sp:intent:${staged.intentId}`)).toBe(false);

      const ov = specialistOverview(env.db, env.projectId);
      expect(ov.evalRunsCount).toBe(1);
      expect(ov.taskTransitionsCount).toBe(1);
      expect(ov.memoryReceiptsCount).toBe(1);
      expect(ov.artifactsCount).toBeGreaterThanOrEqual(2);
      expect(specialistSnapshot(env.db, env.projectId).evalRunsCount).toBe(1);
    } finally {
      await env.dispose();
    }
  });

  it("closes G-27: runWorkflowTool blocks published parent workflow with tested subworkflow unless liveTrial is true", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "r1", "p1", "bb", "/tmp/p1", "none", undefined, "local");
    setRunThread(db, "r1", "pm1");

    const childWf: Workflow = {
      id: "child-tested-wf",
      version: 1,
      name: { en: "Child Tested", ru: "Дочерний тест" },
      status: "tested",
      inputs: [],
      entry: "step1",
      nodes: [{ id: "step1", type: "action", action: "noop", params: {}, out: [] }],
      edges: [],
    } as unknown as Workflow;
    const parentWf: Workflow = {
      id: "parent-published-wf",
      version: 1,
      name: { en: "Parent Published", ru: "Родительский граф" },
      status: "published",
      inputs: [],
      entry: "call_child",
      nodes: [{ id: "call_child", type: "subworkflow", workflow: "child-tested-wf", with: {}, out: [] }],
      edges: [],
    } as unknown as Workflow;

    const catalog = new Map<string, Workflow>([
      ["child-tested-wf", childWf],
      ["parent-published-wf", parentWf],
    ]);
    const fakeStore = {
      get: (id: string) => (catalog.has(id) ? { workflow: catalog.get(id)!, source: "builtin" } : undefined),
      list: () => [...catalog.values()].map((workflow) => ({ workflow, source: "builtin" })),
      resolve: (id: string) => catalog.get(id),
    } as unknown as WorkflowStore;

    let startedCount = 0;
    const deps = {
      db,
      store: async () => fakeStore,
      engine: () => ({
        start: () => {
          startedCount += 1;
          return { runId: `run_${startedCount}`, created: true, done: Promise.resolve() };
        },
        get: (runId: string) => ({ runId, status: "running" }),
        snapshot: () => undefined,
      }),
      runtime: () => ({}) as ChainRuntime,
      warn: () => {},
    };

    const blockedRaw = await runWorkflowTool(
      deps as never,
      { workflowId: "parent-published-wf", inputs: {}, liveTrial: false },
      { projectId: "p1", threadId: "pm1" },
    );
    const blocked = JSON.parse(blockedRaw) as { status: string; reason: string };
    expect(blocked.status).toBe("refused");
    expect(blocked.reason).toContain("child-tested-wf");
    expect(blocked.reason).toContain("liveTrial");
    expect(startedCount).toBe(0);

    const allowedRaw = await runWorkflowTool(
      deps as never,
      { workflowId: "parent-published-wf", inputs: {}, liveTrial: true },
      { projectId: "p1", threadId: "pm1" },
    );
    const allowed = JSON.parse(allowedRaw) as { workflowRunId: string };
    expect(allowed.workflowRunId).toBe("run_1");
    expect(startedCount).toBe(1);
  });
});
