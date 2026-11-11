import { randomUUID } from "node:crypto";
import { sha256Hex } from "@lane-pilot/kit";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { canonicalJson, normalizeOrdersInput } from "../action-order";
import { evaluateAutonomyGate } from "../tool-tiers";
import { recordCfFeedback, stageAndDispatchCfBatch } from "./sp-cf-adapter";
import { acquireLock, stageIntent } from "./sp-locks-intents";
import { advanceCursor, completeTick, reserveBudget, settleBudget } from "./sp-store";

type Row = Record<string, unknown>;
type ActionReg = (key: string, run: (c: StepContext<ChainRuntime>, rt: ChainRuntime) => Promise<Row>) => void;

const asStr = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v));
const asDomain = (v: unknown): "seo" | "marketing" | "specialist_os" =>
  v === "seo" || v === "specialist_os" ? v : "marketing";

function parseJsonSafe<T>(val: unknown, fallback: T): T {
  if (val === null || val === undefined) return fallback;
  if (typeof val === "object") return val as T;
  if (typeof val === "string" && val.trim()) {
    try {
      return JSON.parse(val) as T;
    } catch {
      return fallback;
    }
  }
  return fallback;
}

/**
 * Registers the outbox commit, dispatch, and Content Factory feedback executors (`sp.commit_memory`, `sp.dispatch_tasks`, `sp.cf_feedback`).
 */
export function registerSpCommitAndDispatchExecutors(
  ctx: ServerCore,
  deps: {
    action: ActionReg;
    resolveCheckout: (ctx: ServerCore, rt: ChainRuntime) => Promise<{ hostId: string; path: string } | null>;
    writeCheckoutFile: (ctx: ServerCore, checkout: { hostId: string; path: string } | null, relPath: string, content: string) => Promise<string>;
  },
): void {
  const { db } = ctx;
  const { action, resolveCheckout, writeCheckoutFile } = deps;

  action("sp.commit_memory", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const phase = asStr(params.phase, "intents");
    const role = asStr(params.role);
    const domain = asDomain(params.domain || (role === "seo-specialist" ? "seo" : "marketing"));
    const orders = normalizeOrdersInput(params.orders, domain);
    const ownerAnswer = asStr(params.ownerAnswer);
    const forceHold = phase === "hold" || ownerAnswer === "hold" || ownerAnswer === "decline" || ownerAnswer === "abort";

    let stagedCount = 0;
    let heldCount = 0;
    let droppedCount = 0;
    const droppedReasons: string[] = [];
    const journalIds: string[] = [];

    if (phase === "outage") {
      const repairGraph = asStr(params.repairGraph, "mkt-tracking-setup");
      const res = stageIntent(db, {
        projectId: rt.projectId,
        domain,
        sourceGraph: c.workflow.id,
        tickId: asStr(params.tickId) || null,
        order: {
          kind: "sub_graph",
          title: `Auto-repair outage via ${repairGraph}`,
          domain,
          reason_code: asStr(params.reasonCode, "tracking_outage"),
          action_class: "diagnostics",
          workflow_id: repairGraph,
          is_stop_or_kill: false,
          requires_owner_go: false,
          tariff_known: true,
        },
      });
      if (res.status === "staged") stagedCount++;
      journalIds.push(res.intentId);
    } else {
      for (const ord of orders) {
        const res = stageIntent(db, {
          projectId: rt.projectId,
          domain,
          sourceGraph: c.workflow.id,
          tickId: asStr(params.tickId) || null,
          slotScope: c.runId,
          order: ord,
          forceHold,
        });
        journalIds.push(res.intentId);
        if (res.status === "staged") stagedCount++;
        else if (res.status === "held" || res.status === "queued_conflict") heldCount++;
        else {
          droppedCount++;
          if (res.dropReason) droppedReasons.push(res.dropReason);
        }
      }
      if (phase === "hold" && heldCount === 0) heldCount = Math.max(1, orders.length);
    }

    let lockId = asStr(params.lockId);
    let locksCreated = 0;
    if (params.lockSpec) {
      const spec = parseJsonSafe<Row>(params.lockSpec, {});
      if (typeof spec.scope_value === "string" && spec.scope_value) {
        const lk = acquireLock(db, {
          projectId: rt.projectId,
          domain,
          scopeType: (spec.scope_type as "experiment" | "url") || "experiment",
          scopeValue: spec.scope_value,
          ownerGraph: c.workflow.id,
          ownerRunId: c.runId,
          reasonCode: "experiment_launch",
        });
        if (lk.lockId) {
          lockId = lk.lockId;
          locksCreated += 1;
        }
      }
    }
    if (params.locks && typeof params.locks === "object") {
      const lks = params.locks as Row;
      const items = Array.isArray(lks.items) ? lks.items.map(String) : [];
      const unlockDays = typeof lks.unlock_days === "number" ? Math.max(21, Math.min(45, lks.unlock_days)) : 21;
      for (const item of items) {
        if (!item) continue;
        const lk = acquireLock(db, {
          projectId: rt.projectId,
          domain,
          scopeType: "seo_indexation",
          scopeValue: item,
          ownerGraph: c.workflow.id,
          ownerRunId: c.runId,
          reasonCode: "seo_indexation_lock",
          ttlMs: unlockDays * 86_400_000,
        });
        if (lk.ok) locksCreated += 1;
      }
    }

    if (Array.isArray(params.cursorUpdates)) {
      for (let i = 0; i < params.cursorUpdates.length; i++) {
        const cu = parseJsonSafe<Row>(params.cursorUpdates[i], {});
        if (Object.keys(cu).length > 0) {
          advanceCursor(db, { projectId: rt.projectId, domain, streamKey: `stream_${i}`, nextCursor: cu });
        }
      }
    }

    let rightsStatus = "unchanged";
    if (phase === "rights" && params.perClass) {
      const perClass = parseJsonSafe<Record<string, Row>>(params.perClass, {});
      for (const [cls, stats] of Object.entries(perClass)) {
        const n = typeof stats.n === "number" ? stats.n : 0;
        const k = typeof stats.k === "number" ? stats.k : 0;
        const kappa = typeof stats.cohen_kappa === "number" ? stats.cohen_kappa : 0.7;
        const gate = evaluateAutonomyGate({ actionClass: cls, samplesN: n, successesK: k, cohenKappa: kappa });
        const nextClass = ownerAnswer === "demote" ? "propose" : gate.allowedClass;
        if (nextClass === "bounded_auto") rightsStatus = "promoted";
        else if (ownerAnswer === "demote") rightsStatus = "demoted";
        db.prepare(
          `INSERT INTO lane_pilot_sp_autonomy
            (project_id, domain, action_class, autonomy_class, samples_n, successes_k, wilson_lb, cohen_kappa, high_risk, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT(project_id, domain, action_class) DO UPDATE SET
            autonomy_class = excluded.autonomy_class,
            samples_n = excluded.samples_n,
            successes_k = excluded.successes_k,
            wilson_lb = excluded.wilson_lb,
            cohen_kappa = excluded.cohen_kappa,
            updated_at = excluded.updated_at`,
        ).run(rt.projectId, domain, cls, nextClass, n, k, gate.wilsonLb, kappa, Date.now());
      }
    }

    if (phase === "receipt" && params.tickId) {
      completeTick(db, { projectId: rt.projectId, domain, tickId: asStr(params.tickId), markSlotCompleted: true });
    }

    const commitId = `spc_${randomUUID()}`;
    const summaryObj = { workflow: c.workflow.id, phase, stagedCount, heldCount, droppedCount, lockId };
    db.prepare(
      "INSERT INTO lane_pilot_sp_memory_commit (commit_id, project_id, domain, phase, run_id, summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(commitId, rt.projectId, domain, phase, c.runId, canonicalJson(summaryObj), Date.now());

    const checkout = await resolveCheckout(ctx, rt);
    const reportRel = `.agents/${domain}/memory/commit-${c.workflow.id}-${node.id}.json`;
    await writeCheckoutFile(ctx, checkout, reportRel, JSON.stringify(summaryObj, null, 2));

    let questionsAdded = 0;
    if (params.newShadowQuestions && checkout && !forceHold) {
      const shadowRel = `.agents/${domain}/questions.ext.json`;
      if (Array.isArray(params.newShadowQuestions)) {
        questionsAdded = params.newShadowQuestions.length;
        await writeCheckoutFile(ctx, checkout, shadowRel, JSON.stringify({ questions: params.newShadowQuestions }, null, 2));
      } else {
        questionsAdded = 1;
        await writeCheckoutFile(
          ctx,
          checkout,
          shadowRel,
          JSON.stringify(
            {
              questions: [
                {
                  question_id: `SHD-${domain.toUpperCase()}-${c.runId.slice(0, 6)}`,
                  domain,
                  target_graphs: [c.workflow.id],
                  trigger_situation: `ingested from ${String(params.newShadowQuestions)}`,
                  contour: "periodic_ttl_sweep",
                  question_ru: "Подтвердите актуальность новых правил атрибуции после обновления курса?",
                  options_ru: ["Да", "Нет"],
                  safe_default: "Да",
                  impact_weight: 0.78,
                  ttl_days: 30,
                  periodic_reverify_query: "attribution_reverify",
                  auto_resolvable_via_mcp: false,
                  source_citation: String(params.newShadowQuestions),
                },
              ],
            },
            null,
            2,
          ),
        );
      }
    }

    const dispatchedSoFar = (
      db
        .prepare("SELECT COUNT(*) AS c FROM lane_pilot_sp_dispatch WHERE project_id = ? AND domain = ? AND source_graph = ?")
        .get(rt.projectId, domain, c.workflow.id) as { c: number }
    ).c;

    const defaults: Row = {
      held: heldCount,
      intents: stagedCount,
      dropped: droppedCount,
      dropped_json: JSON.stringify(droppedReasons),
      journal_ids: journalIds,
      questions_added: questionsAdded,
      locks_created: locksCreated,
      batch_id: `cfb_${c.runId.slice(0, 8)}`,
      owner_cards: Array.isArray(params.ownerQuestions) ? params.ownerQuestions.length : 0,
      lock_id: lockId || `lock_${c.runId.slice(0, 8)}`,
      frozen_sources: phase === "outage" ? ["primary_telemetry"] : [],
      alerts: 0,
      report_path: reportRel,
      dispatched_count: dispatchedSoFar,
      swept_questions: 0,
      summary: `${c.workflow.id}:${phase} staged=${stagedCount} held=${heldCount}`,
    };

    const out: Row = {};
    for (const f of node.out) {
      if (f.name === "final_status" && f.type === "enum") {
        const vals = f.values ?? [];
        if (phase === "rights" && vals.includes(rightsStatus)) out.final_status = rightsStatus;
        else if (ownerAnswer === "approve" && vals.includes("launched")) out.final_status = "launched";
        else if (ownerAnswer === "approve" && vals.includes("done")) out.final_status = "done";
        else if (typeof params.decision === "string" && vals.includes(params.decision)) out.final_status = params.decision;
        else out.final_status = vals[0] ?? "";
      } else if (defaults[f.name] !== undefined) {
        out[f.name] = defaults[f.name];
      } else {
        out[f.name] = f.type === "number" ? 0 : f.type === "boolean" ? false : f.type === "array" ? [] : "";
      }
    }
    return out;
  });

  action("sp.dispatch_tasks", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const role = asStr(params.role);
    const domain = asDomain(params.domain || (role === "seo-specialist" ? "seo" : "marketing"));
    const sourceGraph = asStr(params.sourceGraph, c.workflow.id);

    const staged = db
      .prepare(
        "SELECT * FROM lane_pilot_sp_intent WHERE project_id = ? AND domain = ? AND source_graph = ? AND status = 'staged' ORDER BY created_at ASC",
      )
      .all(rt.projectId, domain, sourceGraph) as Array<{
      intent_id: string;
      order_kind: string;
      estimated_cost_usd: number;
      order_json: string;
    }>;

    const dispatchedIds: string[] = [];
    let replayedCount = 0;
    let unknownCount = 0;

    for (const row of staged) {
      const prior = db
        .prepare("SELECT dispatch_id FROM lane_pilot_sp_dispatch WHERE intent_id = ? LIMIT 1")
        .get(row.intent_id) as { dispatch_id: string } | undefined;
      if (prior) {
        replayedCount++;
        dispatchedIds.push(prior.dispatch_id);
        continue;
      }

      const bud = reserveBudget(db, {
        projectId: rt.projectId,
        domain,
        cellKey: `${domain}:${sourceGraph}`,
        amountUsd: row.estimated_cost_usd,
        isAuto: false,
        runId: c.runId,
        reason: `dispatch:${row.order_kind}`,
      });
      if (!bud.ok) {
        unknownCount++;
        continue;
      }

      const orderObj = parseJsonSafe<Row>(row.order_json, {});
      let receipt: Row = { kind: row.order_kind, sourceGraph };
      let targetRef = asStr(orderObj.workflow_id || orderObj.title || row.order_kind);

      if (row.order_kind === "content_batch" && orderObj.cf_batch) {
        const cfRes = stageAndDispatchCfBatch(db, { projectId: rt.projectId, rawBatch: orderObj.cf_batch });
        receipt = { ...receipt, cf: cfRes };
        targetRef = cfRes.batchId;
        if (!cfRes.ok && bud.ledgerId) {
          settleBudget(db, bud.ledgerId, "released");
          db.prepare("UPDATE lane_pilot_sp_intent SET status = 'failed', drop_reason = ?, updated_at = ? WHERE intent_id = ?").run(
            `cf_blocked:${cfRes.failedGates.map((g) => g.gate).join(",")}`,
            Date.now(),
            row.intent_id,
          );
          continue;
        }
      }

      if (bud.ledgerId) settleBudget(db, bud.ledgerId, "settled");
      const dispatchId = `dsp_${sha256Hex(`${row.intent_id}:${c.runId}`).slice(0, 14)}`;
      db.prepare(
        `INSERT INTO lane_pilot_sp_dispatch
          (dispatch_id, intent_id, project_id, domain, source_graph, order_kind, target_ref, status, receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?)`,
      ).run(dispatchId, row.intent_id, rt.projectId, domain, sourceGraph, row.order_kind, targetRef, canonicalJson(receipt), Date.now());
      db.prepare("UPDATE lane_pilot_sp_intent SET status = 'dispatched', updated_at = ? WHERE intent_id = ?").run(
        Date.now(),
        row.intent_id,
      );
      dispatchedIds.push(dispatchId);
    }

    const out: Row = {
      dispatched_count: dispatchedIds.length,
      replayed_count: replayedCount,
      unknown_count: unknownCount,
      dispatched_ids: dispatchedIds,
    };
    const filtered: Row = {};
    for (const f of node.out) {
      if (out[f.name] !== undefined) filtered[f.name] = out[f.name];
    }
    return Object.keys(filtered).length ? filtered : out;
  });

  action("sp.cf_feedback", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const status =
      params.status === "completed" || params.status === "frozen" ? params.status : ("awaiting_indexation" as const);
    const urls = Array.isArray(params.publishedUrls) ? params.publishedUrls.map(String) : [];
    const res = recordCfFeedback(db, {
      projectId: rt.projectId,
      batchId: asStr(params.batchId, `batch_${c.runId.slice(0, 8)}`),
      status,
      ...(typeof params.indexationRate14d === "number" ? { indexationRate14d: params.indexationRate14d } : {}),
      publishedUrls: urls,
      ...(typeof params.lockDays === "number" ? { lockDays: params.lockDays } : {}),
    });
    return {
      updated: res.updated,
      locks_acquired: res.locksAcquired,
      frozen: res.frozen,
    };
  });
}
