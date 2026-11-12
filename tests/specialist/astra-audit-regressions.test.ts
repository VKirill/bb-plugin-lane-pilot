import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadWorkflow, parseWorkflow, validateWorkflow, type StepContext, type Workflow } from "@lane-pilot/workflow-engine";
import { describe, expect, it, vi } from "vitest";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import { collectOwnerWaiting, listOpenOwnerItems } from "../../src/rooms/owner-waiting";
import { openDatabase } from "../../src/rooms/plugin-db";
import {
  acquireTick,
  checkCohortMaturity,
  completeTick,
  getBudgetRemainingUsd,
  mintApprovalNonce,
  recordSpecialistLedgerUsage,
  reserveBudget,
  runVerifiedSkillScript,
  specialistItemSweep,
  stageIntent,
  upsertCharter,
  upsertCohort,
} from "../../src/rooms/specialist/server";
import { normalizeOrdersInput } from "../../src/rooms/specialist/action-order";
import { getProjectArtifact } from "../../src/rooms/storage";
import { builtinWorkflows } from "../../src/rooms/workflow/builtin";
import { setupLiveSpecialistEnv } from "./live-e2e-harness";

describe("GPT-6 Astra Round 1 -> Round 2 regression suite (ASTRA-F-001..F-013)", () => {
  it("closes ASTRA-F-003 & F-004: all 125 built-in workflows pass cross-workflow propose_workflow + subworkflow validation", () => {
    const all = builtinWorkflows();
    expect(all.length).toBeGreaterThanOrEqual(120);
    const byId = new Map(all.map((w) => [w.id, w]));
    const resolve = (id: string, ver?: number) => {
      const w = byId.get(id) ?? null;
      return w && (ver === undefined || w.version === ver) ? w : null;
    };

    for (const wf of all) {
      const errs = validateWorkflow(wf, { resolve }).filter((p) => p.level === "error");
      expect(errs, `workflow ${wf.id} has cross-workflow errors`).toEqual([]);
    }

    // Broken lp.propose_workflow target is rejected with error; missing required input emits warning
    const missingPropose = loadWorkflow(
      {
        id: "test-missing-propose",
        version: 1,
        name: { en: "Missing Propose", ru: "Несуществующий граф" },
        description: { en: "Missing target", ru: "Нет цели" },
        entry: "offer",
        nodes: [
          {
            id: "offer",
            type: "action",
            action: "lp.propose_workflow",
            params: { workflow: "definitely-not-a-workflow" },
          },
        ],
        edges: [{ from: "offer", to: "end" }],
      },
      { resolve },
    );
    expect(missingPropose.ok).toBe(false);
    if (!missingPropose.ok) {
      expect(missingPropose.problems.map((e) => e.code)).toContain("propose_workflow_missing");
    }

    const badPropose = parseWorkflow({
      id: "test-bad-propose",
      version: 1,
      name: { en: "Bad Propose", ru: "Неполный вызов" },
      description: { en: "Missing input", ru: "Пропущен вход" },
      entry: "offer",
      nodes: [
        {
          id: "offer",
          type: "action",
          action: "lp.propose_workflow",
          params: { workflow: "invoice-send", inputs: { amount: 100 } },
        },
      ],
      edges: [{ from: "offer", to: "end" }],
    });
    const proposeProbs = validateWorkflow(badPropose, { resolve });
    expect(proposeProbs.map((p) => p.code)).toContain("propose_workflow_input");

    // Bare $inputs.* without {{...}} in subworkflow `with` is rejected
    const badBareRef = loadWorkflow(
      {
        id: "test-bare-sub-input",
        version: 1,
        name: { en: "Bare Sub Input", ru: "Голый $inputs" },
        description: { en: "Bare ref in with", ru: "Голая ссылка в with" },
        inputs: { topic: { type: "string", required: true } },
        entry: "sub",
        nodes: [
          {
            id: "sub",
            type: "subworkflow",
            workflow: "web-research",
            with: { query: "$inputs.topic" },
          },
        ],
        edges: [{ from: "sub", to: "end" }],
      },
      { resolve },
    );
    expect(badBareRef.ok).toBe(false);
    if (!badBareRef.ok) {
      expect(badBareRef.problems.map((e) => e.code)).toContain("subworkflow_input");
    }

    // Nested bare $inputs.* inside subworkflow `with` (e.g. by_mode.default) is ALSO rejected (Round 2 F-003)
    const badNestedBareRef = loadWorkflow(
      {
        id: "test-nested-bare-sub-input",
        version: 1,
        name: { en: "Nested Bare", ru: "Вложенный голый $inputs" },
        description: { en: "Nested bare ref", ru: "Вложенная голая ссылка" },
        inputs: { topic: { type: "string", required: true } },
        entry: "sub",
        nodes: [
          {
            id: "sub",
            type: "subworkflow",
            workflow: "web-research",
            with: { query: { by_mode: { default: "$inputs.topic" } } },
          },
        ],
        edges: [{ from: "sub", to: "end" }],
      },
      { resolve },
    );
    expect(badNestedBareRef.ok).toBe(false);
    if (!badNestedBareRef.ok) {
      expect(badNestedBareRef.problems.map((e) => e.code)).toContain("subworkflow_input");
    }
  });

  it("closes ASTRA-F-005: seo-release-protocol/release_graph_sim.py refuses synthetic example.ru data in live mode", async () => {
    const liveRes = await runVerifiedSkillScript({
      skill: "seo-release-protocol",
      script: "release_graph_sim.py",
      args: {},
      timeoutSec: 15,
      mode: "live",
    });
    expect(liveRes.usedFixtureFallback).toBe(false);
    expect(liveRes.raw.degraded_error).toBe(true);
  });

  it("closes ASTRA-F-006, F-007, and F-008: cohort age & future-date gate, scoped completeTick, and api_units vs USD cap isolation", () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    try {
      const db = openDatabase(bb);
      const now = Date.parse("2026-11-12T12:00:00Z");

      // ASTRA-F-006: young cohort with high cdfPay is STILL immature before maturityWindowDays
      upsertCohort(db, {
        projectId: "p1",
        domain: "marketing",
        cohortKey: "high_cdf_but_2d_old",
        channel: "google_ads",
        cohortDate: "2026-11-10",
        maturityWindowDays: 14,
        cdfPay: 0.95,
        nowMs: now,
      });
      expect(checkCohortMaturity(db, "p1", "marketing", "high_cdf_but_2d_old", now).mature).toBe(false);

      // Future cohortDate & impossible calendar dates (2026-02-30) are rejected
      upsertCohort(db, {
        projectId: "p1",
        domain: "marketing",
        cohortKey: "future_cohort",
        channel: "google_ads",
        cohortDate: "2099-01-01",
        maturityWindowDays: 14,
        cdfPay: 0.9,
        nowMs: now,
      });
      expect(checkCohortMaturity(db, "p1", "marketing", "future_cohort", now).mature).toBe(false);

      upsertCohort(db, {
        projectId: "p1",
        domain: "marketing",
        cohortKey: "impossible_feb30",
        channel: "google_ads",
        cohortDate: "2026-02-30",
        maturityWindowDays: 30,
        cdfPay: 0.95,
        nowMs: now,
      });
      expect(checkCohortMaturity(db, "p1", "marketing", "impossible_feb30", now).mature).toBe(false);

      // ASTRA-F-007: acquireTick with non-empty scopeId is properly completed even if completeTick omits scopeId
      const tick = acquireTick(db, {
        projectId: "p1",
        domain: "marketing",
        scopeId: "campaign:42",
        slotKey: "mkt-weekly-review:2026-W46",
        holderRunId: "run-scoped-1",
        nowMs: now,
      });
      expect(tick.ok).toBe(true);
      completeTick(db, {
        projectId: "p1",
        domain: "marketing",
        tickId: tick.tickId,
        nowMs: now + 1000,
      });
      const replay = acquireTick(db, {
        projectId: "p1",
        domain: "marketing",
        scopeId: "campaign:42",
        slotKey: "mkt-weekly-review:2026-W46",
        holderRunId: "run-scoped-2",
        nowMs: now + 2000,
      });
      expect(replay.ok).toBe(false);
      expect(replay.reason).toBe("slot_already_completed");

      // ASTRA-F-008: api_units usage never consumes USD daily cap, and domains have isolated USD caps
      upsertCharter(db, {
        projectId: "p1",
        domain: "seo",
        charter: { budgets: { daily_cap_usd: 25, cell_cap_usd: 25, rolling_24h_auto_cap_usd: 25, max_active_cells: 5 } },
      });
      recordSpecialistLedgerUsage(db, {
        projectId: "p1",
        domain: "seo",
        kind: "api_units",
        amountUsd: 500,
        reason: "crawl_units",
        nowMs: now,
      });
      recordSpecialistLedgerUsage(db, {
        projectId: "p1",
        domain: "marketing",
        kind: "llm_usd",
        amountUsd: 20,
        reason: "ads_spend",
        nowMs: now,
      });
      expect(getBudgetRemainingUsd(db, "p1", "seo", now)).toBe(25);
      const seoRes = reserveBudget(db, {
        projectId: "p1",
        domain: "seo",
        cellKey: "seo:audit",
        amountUsd: 10,
        isAuto: false,
        nowMs: now,
      });
      expect(seoRes.ok).toBe(true);
    } finally {
      harness.lifecycle.dispose();
    }
  });

  it("closes ASTRA-F-001, F-009, F-010, F-011, and F-013: folder fs.write without slash, schedule/sub_graph/direct_api honesty, exception reconciliation, and open owner sweep", async () => {
    const env = await setupLiveSpecialistEnv();
    try {
      upsertCharter(env.db, {
        projectId: env.projectId,
        domain: "marketing",
        charter: { budgets: { daily_cap_usd: 100, cell_cap_usd: 100, rolling_24h_auto_cap_usd: 100, max_active_cells: 10 } },
      });

      const execs = (
        env.engine as unknown as {
          executors: Map<string, { run: (c: StepContext<ChainRuntime>) => Promise<{ output: Record<string, unknown> }> }>;
        }
      ).executors;

      // ASTRA-F-013: fs.write with kind: "folder" and NO trailing slash writes child files inside directory
      const fsWrite = execs.get("fs.write")!;
      const folderParams = {
        kind: "folder",
        path: ".agents/marketing/campaign-pack",
        files: [{ name: "copy.md", content: "# Ad Copy\n" }],
      };
      const folderRes = await fsWrite.run({
        runId: "wf_folder_noslash",
        stepId: "write_pack",
        node: { id: "write_pack", type: "action", action: "fs.write", params: folderParams, out: [{ name: "folder", type: "string" }] },
        workflow: { id: "mkt-campaign", version: 1, name: { en: "Campaign" }, nodes: [] } as unknown as Workflow,
        runtime: env.rt,
        template: (v: unknown) => v,
        render: (s: string) => s,
        resolve: (v: unknown) => v,
        params: folderParams,
      } as unknown as StepContext<ChainRuntime>);
      expect(folderRes.output.folder).toBe(".agents/marketing/campaign-pack/");
      expect(statSync(join(env.checkout, ".agents/marketing/campaign-pack")).isDirectory()).toBe(true);
      expect(existsSync(join(env.checkout, ".agents/marketing/campaign-pack/copy.md"))).toBe(true);
      expect(getProjectArtifact(env.db, env.projectId, ".agents/marketing/campaign-pack/copy.md")).not.toBeNull();

      const dispatchExec = execs.get("sp.dispatch_tasks")!;
      const makeCtx = (runId: string, params: Record<string, unknown>) =>
        ({
          runId,
          stepId: "step_dispatch",
          stepKey: `${runId}:step_dispatch`,
          mode: "live",
          node: { id: "step_dispatch", type: "action", action: "sp.dispatch_tasks", params, out: [] },
          workflow: { id: "mkt-weekly-review", version: 1, name: { en: "Weekly Review" }, nodes: [] } as unknown as Workflow,
          runtime: env.rt,
          template: (v: unknown) => v,
          render: (s: string) => s,
          resolve: (v: unknown) => v,
          params,
        }) as unknown as StepContext<ChainRuntime>;

      // ASTRA-F-010 & F-011: bad sub_graph is blocked (not executed), direct_api with nonce+adapter executes, owner_gate stays OPEN across specialistItemSweep!
      const nonce = mintApprovalNonce(env.db, {
        projectId: env.projectId,
        actionId: "act_direct_1",
        payload: [{ entity_id: "kw_991", mutation_kind: "bids.set", server: "yandex-direct", tool: "bids.set" }],
      });
      const res1 = await dispatchExec.run(
        makeCtx("wf_dispatch_honesty_1", {
          domain: "marketing",
          orders: [
            {
              kind: "sub_graph",
              title: "Nonexistent workflow",
              workflow_id: "definitely-does-not-exist-wf",
              estimated_cost_usd: 5,
            },
            {
              kind: "direct_api",
              title: "Pause bleeding keyword",
              server: "yandex-direct",
              tool: "bids.set",
              entity_id: "kw_991",
              action_id: "act_direct_1",
              nonce_token: nonce.token,
              estimated_cost_usd: 2,
            },
            {
              kind: "owner_gate",
              title: "Confirm landing experiment",
              question: "Run split test on /pricing?",
              estimated_cost_usd: 3,
            },
          ],
        }),
      );
      expect(res1.output.blocked_count).toBe(1);
      expect(res1.output.executed_count).toBe(1);
      expect(res1.output.waiting_owner_count).toBe(1);

      // Only the 1 executed direct_api ($2) settled USD budget; blocked ($5) and waiting_owner ($3) were released!
      expect(getBudgetRemainingUsd(env.db, env.projectId, "marketing")).toBe(98);

      // ASTRA-F-011: Running specialistItemSweep MUST NOT auto-close the unanswered owner_gate question!
      const beforeSweep = listOpenOwnerItems(env.db, { source: "specialist" }).filter((i) => i.what.includes("Run split test on /pricing?"));
      expect(beforeSweep).toHaveLength(1);
      collectOwnerWaiting(env.db, Date.now(), [specialistItemSweep]);
      const afterSweep = listOpenOwnerItems(env.db, { source: "specialist" }).filter((i) => i.what.includes("Run split test on /pricing?"));
      expect(afterSweep).toHaveLength(1);

      // ASTRA-F-009: If schedules.save throws mid-flight, intent transitions to reconcile_required (failed) and never re-executes on retry
      (env.services as unknown as { schedules: { save: ReturnType<typeof vi.fn> } }).schedules.save.mockRejectedValueOnce(
        new Error("Schedule RPC socket hang up"),
      );
      const resThrow = await dispatchExec.run(
        makeCtx("wf_dispatch_throw_1", {
          domain: "marketing",
          orders: [
            {
              kind: "schedule",
              title: "Fragile cron",
              cron: "0 7 * * *",
              targetWorkflowId: "seo-monitor",
              estimated_cost_usd: 4,
            },
          ],
        }),
      );
      expect(resThrow.output.blocked_count).toBe(1);
      expect(listOpenOwnerItems(env.db, { source: "specialist" }).some((i) => i.key.startsWith("sp:reconcile:"))).toBe(true);

      // Re-running dispatch_tasks does NOT re-execute the failed/reconcile_required intent
      const saveCallsAfterThrow = (env.services as unknown as { schedules: { save: ReturnType<typeof vi.fn> } }).schedules.save.mock.calls.length;
      await dispatchExec.run(makeCtx("wf_dispatch_throw_retry", { domain: "marketing" }));
      expect((env.services as unknown as { schedules: { save: ReturnType<typeof vi.fn> } }).schedules.save.mock.calls.length).toBe(
        saveCallsAfterThrow,
      );

      // ASTRA-R2-001: Outer Tier R tool + nested Tier L mutation WITHOUT nonce MUST NOT execute!
      const mutCallsBefore = (env.services as unknown as { executeMutation: ReturnType<typeof vi.fn> }).executeMutation.mock.calls.length;
      const resNestedL = await dispatchExec.run(
        makeCtx("wf_dispatch_nested_tier_l", {
          domain: "marketing",
          orders: [
            {
              kind: "direct_api",
              title: "Outer read + nested live budget mutation",
              server: "yandex-direct",
              tool: "campaigns.get",
              mutations: [{ entity_id: "camp_77", mutation_kind: "update_campaign_budget", server: "yandex-direct", tool: "campaigns.update" }],
              estimated_cost_usd: 1,
            },
          ],
        }),
      );
      expect(resNestedL.output.executed_count).toBe(0);
      expect(resNestedL.output.waiting_owner_count).toBe(1);
      expect((env.services as unknown as { executeMutation: ReturnType<typeof vi.fn> }).executeMutation.mock.calls.length).toBe(mutCallsBefore);

      // ASTRA-R2-002: Active held intent blocks semantic duplicate from a second run!
      const resDupHeld = await dispatchExec.run(
        makeCtx("wf_dispatch_dup_held", {
          domain: "marketing",
          orders: [
            {
              kind: "owner_gate",
              title: "Confirm landing experiment duplicate",
              question: "Confirm landing experiment",
              target_scope: { scope_type: "landing", scope_value: "/pricing-v2" },
              reason_code: "cro_friction_fix",
              estimated_cost_usd: 1,
            },
          ],
        }),
      );
      expect(resDupHeld.output.waiting_owner_count).toBe(1);
      const resDupHeld2 = await dispatchExec.run(
        makeCtx("wf_dispatch_dup_held_2", {
          domain: "marketing",
          orders: [
            {
              kind: "owner_gate",
              title: "Paraphrased duplicate while held",
              question: "Should we confirm landing experiment?",
              target_scope: { scope_type: "landing", scope_value: "/pricing-v2/" },
              reason_code: "cro_friction_fix",
              estimated_cost_usd: 1,
            },
          ],
        }),
      );
      expect(resDupHeld2.output.waiting_owner_count).toBe(0);

      // ASTRA-R3-002: Unfinished 'held' intent older than 24h (86_400_001 ms) STILL blocks semantic duplicate staging
      const [ord1, ord2] = normalizeOrdersInput([
        { kind: "owner_gate", title: "Long-waiting owner gate", question: "Approve hero CTA rewrite?", target_scope: { scope_type: "landing", scope_value: "/pricing-v3/" }, reason_code: "cro_friction_fix", estimated_cost_usd: 1 },
        { kind: "owner_gate", title: "Paraphrased gate 25h later", question: "Still approve hero CTA rewrite?", target_scope: { scope_type: "landing", scope_value: "/pricing-v3/" }, reason_code: "cro_friction_fix", estimated_cost_usd: 1 },
      ], "marketing");
      const agedHeld = stageIntent(env.db, { projectId: env.projectId, domain: "marketing", sourceGraph: "mkt-landing-cro-audit", slotScope: "run_old_1", forceHold: true, nowMs: 1_000_000, order: ord1! });
      expect(agedHeld.status).toBe("held");
      const agedDup = stageIntent(env.db, { projectId: env.projectId, domain: "marketing", sourceGraph: "mkt-landing-cro-audit", slotScope: "run_old_2", nowMs: 1_000_000 + 86_400_001, order: ord2! });
      expect(agedDup).toMatchObject({ status: "dropped", dropReason: "duplicate_semantic_key" });

      // ASTRA-R2-005: sp.charter_set stores exact SHA256 of written charterText in PDAS
      const charterExec = execs.get("sp.charter_set")!;
      await charterExec.run({
        runId: "wf_charter_sha",
        stepId: "set_charter",
        node: { id: "set_charter", type: "action", action: "sp.charter_set", params: { domain: "seo", charter: { primary_kpi: "organic_leads" } }, out: [] },
        workflow: { id: "seo-project-intake", version: 1, name: { en: "SEO Intake" }, nodes: [] } as unknown as Workflow,
        runtime: env.rt,
        template: (v: unknown) => v,
        render: (s: string) => s,
        resolve: (v: unknown) => v,
        params: { domain: "seo", charter: { primary_kpi: "organic_leads" } },
      } as unknown as StepContext<ChainRuntime>);
      const charterArtifact = getProjectArtifact(env.db, env.projectId, "seo.charter");
      const { createHash } = await import("node:crypto");
      const { readFileSync } = await import("node:fs");
      const diskSha = createHash("sha256").update(readFileSync(join(env.checkout, ".agents/seo/charter.json"), "utf8")).digest("hex");
      expect(charterArtifact?.sha256).toBe(diskSha);
    } finally {
      await env.dispose();
    }
  });
});
