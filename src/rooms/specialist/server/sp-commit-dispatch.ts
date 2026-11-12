import { sha256Hex } from "@lane-pilot/kit";
import type { GraphNode, StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { postOwnerItem } from "../../owner-waiting";
import { renderArtifactsManifestJson } from "../../storage";
import { canonicalJson, normalizeOrdersInput } from "../action-order";
import { recordCfFeedback } from "./sp-cf-adapter";
import { registerSpCommitMemoryExecutor } from "./sp-commit-memory";
import { executeSpecialistOrder, type SpServicesDeps } from "./sp-dispatch-runner";
import { stageIntent } from "./sp-locks-intents";
import { reserveBudget, settleBudget } from "./sp-store";

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
    spDeps: SpServicesDeps;
    resolveCheckout: (ctx: ServerCore, rt: ChainRuntime) => Promise<{ hostId: string; path: string } | null>;
    readCheckoutFileText: (ctx: ServerCore, checkout: { hostId: string; path: string } | null, relOrAbs: unknown) => Promise<string | null>;
    writeCheckoutFile: (ctx: ServerCore, checkout: { hostId: string; path: string } | null, relPath: string, content: string) => Promise<string>;
  },
): void {
  const { db } = ctx;
  const { action, spDeps, resolveCheckout, readCheckoutFileText, writeCheckoutFile } = deps;

  registerSpCommitMemoryExecutor(ctx, { action, resolveCheckout, readCheckoutFileText, writeCheckoutFile });

  action("sp.dispatch_tasks", async (c, rt) => {
    const node = c.node as Extract<GraphNode, { type: "action" }>;
    const params = c.template(node.params) as Row;
    const role = asStr(params.role);
    const domain = asDomain(params.domain || (role === "seo-specialist" ? "seo" : "marketing"));
    const sourceGraph = asStr(params.sourceGraph, c.workflow.id);
    const checkout = await resolveCheckout(ctx, rt);

    if (params.orders !== undefined && params.orders !== null) {
      const inlineOrders = normalizeOrdersInput(params.orders, domain);
      for (const ord of inlineOrders) {
        stageIntent(db, {
          projectId: rt.projectId,
          domain,
          sourceGraph,
          slotScope: c.runId,
          order: ord,
        });
      }
    }

    const staged = db
      .prepare(
        "SELECT * FROM lane_pilot_sp_intent WHERE project_id = ? AND domain = ? AND source_graph = ? AND status = 'staged' ORDER BY created_at ASC",
      )
      .all(rt.projectId, domain, sourceGraph) as Array<{
      intent_id: string;
      idem_key: string;
      order_kind: string;
      estimated_cost_usd: number;
      order_json: string;
    }>;

    const dispatchedIds: string[] = [];
    const proposedIds: string[] = [];
    const waitingOwnerIds: string[] = [];
    let replayedCount = 0;
    let blockedCount = 0;
    let unknownCount = 0;
    let touchedManifestArtifacts = false;

    const claimIntentAtomically = db.transaction(
      (intentId: string): { action: "claimed" } | { action: "replayed"; dispatchId?: string; status: string } | { action: "busy" } => {
        const prior = db
          .prepare("SELECT dispatch_id, status FROM lane_pilot_sp_dispatch WHERE intent_id = ? LIMIT 1")
          .get(intentId) as { dispatch_id: string; status: string } | undefined;
        if (prior) {
          return { action: "replayed", dispatchId: prior.dispatch_id, status: prior.status };
        }
        const cur = db
          .prepare("SELECT status FROM lane_pilot_sp_intent WHERE intent_id = ?")
          .get(intentId) as { status: string } | undefined;
        if (!cur || cur.status !== "staged") {
          return { action: "busy" };
        }
        db.prepare("UPDATE lane_pilot_sp_intent SET status = 'held', drop_reason = ?, updated_at = ? WHERE intent_id = ?").run(
          `in_flight:${c.runId}`,
          Date.now(),
          intentId,
        );
        return { action: "claimed" };
      },
    );

    for (const row of staged) {
      const claimed = claimIntentAtomically(row.intent_id);
      if (claimed.action === "replayed") {
        replayedCount++;
        if (claimed.status === "dispatched" && claimed.dispatchId) {
          dispatchedIds.push(claimed.dispatchId);
        }
        continue;
      }
      if (claimed.action === "busy") {
        continue;
      }

      const bud = reserveBudget(db, {
        projectId: rt.projectId,
        domain,
        cellKey: `${domain}:${sourceGraph}`,
        amountUsd: row.estimated_cost_usd,
        isAuto: false,
        runId: c.runId,
        reason: `intent:${row.intent_id}:${row.order_kind}`,
        reuseExistingReason: true,
      });
      if (!bud.ok) {
        db.prepare("UPDATE lane_pilot_sp_intent SET status = 'staged', drop_reason = ?, updated_at = ? WHERE intent_id = ?").run(
          bud.reason ?? "budget_hold",
          Date.now(),
          row.intent_id,
        );
        unknownCount++;
        continue;
      }

      const orderObj = parseJsonSafe<Row>(row.order_json, {});
      const dispatchId = `dsp_${sha256Hex(`${row.intent_id}:${c.runId}`).slice(0, 14)}`;

      let execRes: Awaited<ReturnType<typeof executeSpecialistOrder>>;
      try {
        execRes = await executeSpecialistOrder({
          ctx,
          deps: spDeps,
          c,
          rt,
          domain,
          sourceGraph,
          intentRow: row,
          orderObj,
          checkout,
          writeCheckoutFile,
        });
      } catch (err) {
        const errMsg = (err instanceof Error ? err.message : String(err)).slice(0, 300);
        if (bud.ledgerId && row.estimated_cost_usd <= 0) {
          settleBudget(db, bud.ledgerId, "released");
        }
        const nowErr = Date.now();
        db.prepare(
          `INSERT OR IGNORE INTO lane_pilot_sp_dispatch
            (dispatch_id, intent_id, project_id, domain, source_graph, order_kind, target_ref, status, receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'reconcile_required', 'failed', ?, ?)`,
        ).run(
          dispatchId,
          row.intent_id,
          rt.projectId,
          domain,
          sourceGraph,
          row.order_kind,
          canonicalJson({ kind: row.order_kind, status: "reconcile_required", error: errMsg }),
          nowErr,
        );
        db.prepare("UPDATE lane_pilot_sp_intent SET status = 'failed', drop_reason = 'reconcile_required', updated_at = ? WHERE intent_id = ?").run(
          nowErr,
          row.intent_id,
        );
        postOwnerItem(db, {
          key: `sp:reconcile:${row.intent_id}`,
          source: "specialist",
          kind: "question",
          projectId: rt.projectId,
          what: `Сверка прерванного действия специалиста (${row.order_kind})`,
          why: `Внешний вызов завершился ошибкой (${errMsg}); автоматический повтор заблокирован во избежание дубля.`,
          wake: false,
        });
        blockedCount++;
        continue;
      }

      const nowDone = Date.now();
      if (!execRes.ok || execRes.disposition === "blocked") {
        if (bud.ledgerId) settleBudget(db, bud.ledgerId, "released");
        db.prepare(
          `INSERT OR IGNORE INTO lane_pilot_sp_dispatch
            (dispatch_id, intent_id, project_id, domain, source_graph, order_kind, target_ref, status, receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'failed', ?, ?)`,
        ).run(
          dispatchId,
          row.intent_id,
          rt.projectId,
          domain,
          sourceGraph,
          row.order_kind,
          execRes.targetRef,
          canonicalJson({ ...execRes.receipt, disposition: "blocked", blockReason: execRes.blockReason ?? "dispatch_blocked" }),
          nowDone,
        );
        db.prepare("UPDATE lane_pilot_sp_intent SET status = 'failed', drop_reason = ?, updated_at = ? WHERE intent_id = ?").run(
          execRes.blockReason ?? "dispatch_blocked",
          nowDone,
          row.intent_id,
        );
        blockedCount++;
        continue;
      }

      if (execRes.disposition === "waiting_owner" || execRes.disposition === "proposed") {
        if (bud.ledgerId) settleBudget(db, bud.ledgerId, "released");
        db.prepare(
          `INSERT OR IGNORE INTO lane_pilot_sp_dispatch
            (dispatch_id, intent_id, project_id, domain, source_graph, order_kind, target_ref, status, receipt_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'dry_run', ?, ?)`,
        ).run(
          dispatchId,
          row.intent_id,
          rt.projectId,
          domain,
          sourceGraph,
          row.order_kind,
          execRes.targetRef,
          canonicalJson({ ...execRes.receipt, disposition: execRes.disposition }),
          nowDone,
        );
        // Keep intent `held` (never `dispatched`) so `specialistItemSweep` leaves unanswered owner questions open (`ASTRA-F-011`).
        db.prepare("UPDATE lane_pilot_sp_intent SET status = 'held', drop_reason = ?, updated_at = ? WHERE intent_id = ?").run(
          execRes.disposition,
          nowDone,
          row.intent_id,
        );
        touchedManifestArtifacts = true;
        if (execRes.disposition === "proposed") proposedIds.push(dispatchId);
        else waitingOwnerIds.push(dispatchId);
        continue;
      }

      if (bud.ledgerId) settleBudget(db, bud.ledgerId, "settled");
      db.prepare(
        `INSERT INTO lane_pilot_sp_dispatch
          (dispatch_id, intent_id, project_id, domain, source_graph, order_kind, target_ref, status, receipt_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'dispatched', ?, ?)`,
      ).run(
        dispatchId,
        row.intent_id,
        rt.projectId,
        domain,
        sourceGraph,
        row.order_kind,
        execRes.targetRef,
        canonicalJson({ ...execRes.receipt, disposition: "executed" }),
        nowDone,
      );
      db.prepare("UPDATE lane_pilot_sp_intent SET status = 'dispatched', drop_reason = NULL, updated_at = ? WHERE intent_id = ?").run(
        nowDone,
        row.intent_id,
      );
      touchedManifestArtifacts = true;
      dispatchedIds.push(dispatchId);
    }

    if (checkout && rt.projectId && touchedManifestArtifacts) {
      await writeCheckoutFile(ctx, checkout, ".agents/manifest.json", renderArtifactsManifestJson(db, rt.projectId));
    }

    const out: Row = {
      dispatched_count: dispatchedIds.length,
      executed_count: dispatchedIds.length,
      proposed_count: proposedIds.length,
      waiting_owner_count: waitingOwnerIds.length,
      blocked_count: blockedCount,
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
