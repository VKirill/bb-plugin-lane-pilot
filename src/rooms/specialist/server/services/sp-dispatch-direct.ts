import { randomUUID } from "node:crypto";
import { TIER_RANK, type ToolTier } from "@lane-pilot/contracts";
import type { StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../../contracts/server";
import { postOwnerItem, rpcLine } from "../../../owner-waiting";
import { classifyToolTier } from "../../tool-tiers";
import type { OrderExecutionResult, SpServicesDeps } from "./sp-dispatch-runner";
import { checkCohortMaturity, checkLockCollisions } from "../repositories/sp-locks-intents";
import { getBreakerState } from "../repositories/sp-store";

type Row = Record<string, unknown>;

const asStr = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v);

export interface ManualMutationEvaluation {
  effectiveTier: ToolTier;
  mutationIds: string[];
  failed: number;
  errors: string[];
}

/**
 * Evaluates a list of planned mutation items against tool tiers (`R/D/L/S`), circuit breaker,
 * cohort maturity, and active lock collisions for manual staging.
 */
export function evaluateManualMutationPlan(
  db: ServerCore["db"],
  input: {
    projectId: string;
    domain: "seo" | "marketing" | "specialist_os";
    baseTier: ToolTier;
    items: Row[];
    ignoreOwnerRunId?: string;
    emergencyAuthorised?: boolean;
    nowMs?: number;
  },
): ManualMutationEvaluation {
  const now = input.nowMs ?? Date.now();
  const emergency = Boolean(input.emergencyAuthorised);
  let effectiveTier: ToolTier = input.baseTier;
  for (const item of input.items) {
    const srv = typeof item.server === "string" && item.server ? item.server : undefined;
    const tool = typeof item.tool === "string" && item.tool ? item.tool : undefined;
    const itemTier = srv || tool ? classifyToolTier(srv, tool) : input.baseTier;
    if (TIER_RANK[itemTier] > TIER_RANK[effectiveTier]) {
      effectiveTier = itemTier;
    }
  }

  const errors: string[] = [];
  const mutationIds: string[] = [];
  let failed = 0;

  const breaker = getBreakerState(db, input.projectId, input.domain);
  if (breaker && breaker.state === "open" && (breaker.cooldown_until === null || breaker.cooldown_until > now) && !emergency) {
    return { effectiveTier, mutationIds, failed: Math.max(1, input.items.length), errors: ["breaker_open"] };
  }
  if (effectiveTier === "S" && !emergency) {
    return {
      effectiveTier,
      mutationIds,
      failed: Math.max(1, input.items.length),
      errors: ["tier_S_forbidden_without_emergency_charter"],
    };
  }

  for (const item of input.items) {
    const entityId = asStr(item.entity_id, "default_entity");
    const srv = typeof item.server === "string" && item.server ? item.server : undefined;
    const tool = typeof item.tool === "string" && item.tool ? item.tool : undefined;
    const resolvedTier = srv || tool ? classifyToolTier(srv, tool) : input.baseTier;
    if (resolvedTier === "S" && !emergency) {
      failed++;
      errors.push(`${entityId}:tier_S_tool_refused`);
      continue;
    }
    if (item.is_stop && typeof item.cohort_key === "string" && item.cohort_key) {
      const mat = checkCohortMaturity(db, input.projectId, input.domain, item.cohort_key, now);
      if (!mat.mature) {
        failed++;
        errors.push(`${entityId}:immature_cohort`);
        continue;
      }
    }
    if (typeof item.scope_type === "string" && item.scope_type && typeof item.scope_value === "string" && item.scope_value) {
      const locks = checkLockCollisions(db, {
        projectId: input.projectId,
        scopeType: item.scope_type,
        scopeValue: item.scope_value,
        ...(input.ignoreOwnerRunId ? { ignoreOwnerRunId: input.ignoreOwnerRunId } : {}),
        nowMs: now,
      });
      if (locks.length > 0 && !emergency) {
        failed++;
        errors.push(`${entityId}:locked_by_${locks[0]!.lock_id}`);
        continue;
      }
    }
    mutationIds.push(`mut_${randomUUID()}`);
  }

  return { effectiveTier, mutationIds, failed, errors };
}

/**
 * Stages `direct_api` orders for manual owner confirmation (no live external mutation adapter is wired).
 * Enforces tool-tier (`R/D/L/S`), circuit breaker, cohort maturity, and lock collision checks.
 */
export async function executeDirectApiOrder(input: {
  ctx: ServerCore;
  deps: SpServicesDeps;
  c: StepContext<ChainRuntime>;
  rt: ChainRuntime;
  domain: "seo" | "marketing" | "specialist_os";
  sourceGraph: string;
  intentRow: { intent_id: string; idem_key: string; order_kind: string; order_json: string };
  orderObj: Row;
}): Promise<OrderExecutionResult> {
  const { ctx, c, rt, domain, intentRow, orderObj } = input;
  const { db } = ctx;
  const server = asStr(orderObj.server);
  const tool = asStr(orderObj.tool);
  const targetRef = server && tool ? `${server}:${tool}` : tool || server || "direct_api";
  const tier = classifyToolTier(server || undefined, tool || undefined);
  const scopeObj = orderObj.target_scope && typeof orderObj.target_scope === "object" ? (orderObj.target_scope as Row) : null;
  const entityId = asStr(scopeObj?.scope_value || orderObj.entity_id, targetRef);

  const rawItems = Array.isArray(orderObj.mutations)
    ? orderObj.mutations
    : Array.isArray(orderObj.items)
      ? orderObj.items
      : null;

  const items: Row[] = rawItems
    ? (rawItems.filter((x) => x && typeof x === "object") as Row[])
    : [
        {
          entity_id: entityId,
          mutation_kind: tool || asStr(orderObj.action_class, "direct_api"),
          ...(server ? { server } : {}),
          ...(tool ? { tool } : {}),
          ...(scopeObj?.scope_type ? { scope_type: asStr(scopeObj.scope_type) } : {}),
          ...(scopeObj?.scope_value ? { scope_value: asStr(scopeObj.scope_value) } : {}),
          ...(orderObj.is_stop_or_kill === true ? { is_stop: true } : {}),
          ...(orderObj.cohort_key ? { cohort_key: asStr(orderObj.cohort_key) } : {}),
        },
      ];

  const evalRes = evaluateManualMutationPlan(db, {
    projectId: rt.projectId,
    domain,
    baseTier: tier,
    items,
    ignoreOwnerRunId: c.runId,
  });

  if (evalRes.errors.length > 0 || evalRes.mutationIds.length === 0) {
    const rawErr = evalRes.errors[0] ?? "mutation_blocked";
    const blockReason = rawErr.includes(":") ? rawErr.split(":").slice(1).join(":") : rawErr;
    return {
      ok: false,
      disposition: "blocked",
      targetRef,
      receipt: { kind: "direct_api", server, tool, tier: evalRes.effectiveTier, errors: evalRes.errors },
      blockReason,
    };
  }

  const itemKey = `sp:intent:${intentRow.intent_id}`;
  postOwnerItem(db, {
    key: itemKey,
    source: "specialist",
    kind: "question",
    reason: "decision",
    projectId: rt.projectId,
    what: `Ручное применение API-изменения (${targetRef}): ${asStr(orderObj.title, entityId)}`,
    why: `Внешний адаптер мутаций не подключён; подтвердите и выполните изменение (класс ${evalRes.effectiveTier}) вручную.`,
    wake: evalRes.effectiveTier === "L",
    actions: [
      {
        id: "read",
        label: "Принято",
        cli: rpcLine("owner_waiting_close", { key: itemKey }),
        rpc: { method: "owner_waiting_close", input: { key: itemKey } },
      },
    ],
  });
  return {
    ok: true,
    disposition: "waiting_owner",
    targetRef,
    receipt: { kind: "direct_api", server, tool, tier: evalRes.effectiveTier, status: "staged_manual", ownerItemKey: itemKey },
  };
}
