import type { StepContext } from "@lane-pilot/workflow-engine";
import type { ChainRuntime, ServerCore } from "../../contracts/server";
import { postOwnerItem, rpcLine } from "../../owner-waiting";
import { classifyToolTier } from "../tool-tiers";
import type { OrderExecutionResult, SpServicesDeps } from "./sp-dispatch-runner";
import { applyMutationsBatch, type MutationItem } from "./sp-mutation";

type Row = Record<string, unknown>;

const asStr = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : v === null || v === undefined ? fallback : String(v);

/**
 * Dedicated `direct_api` execution branch (`ASTRA-F-010`):
 * - Classifies tool tier (`R/D/L/S`) via `classifyToolTier(server, tool)`.
 * - Requires single-use HMAC approval nonce for Tier `L` live changes (`waiting_owner` when absent).
 * - Executes through `applyMutationsBatch` (enforcing circuit breaker, cohort maturity, lock collisions, and strategy guard).
 * - Separates live execution (`disposition: "executed"`) from staged manual fallback (`disposition: "waiting_owner"`) and blocked errors (`disposition: "blocked"`).
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
  const { ctx, deps, c, rt, domain, sourceGraph, intentRow, orderObj } = input;
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

  const items: MutationItem[] = rawItems
    ? (rawItems.filter((x) => x && typeof x === "object") as MutationItem[])
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
          ...(typeof orderObj.current_value === "number" ? { current_value: orderObj.current_value } : {}),
          ...(typeof orderObj.next_value === "number" ? { next_value: orderObj.next_value } : {}),
        },
      ];

  const tierRank = (t: "R" | "D" | "L" | "S"): number => (t === "S" ? 4 : t === "L" ? 3 : t === "D" ? 2 : 1);
  let effectiveTier = tier;
  for (const item of items) {
    const itemTier = item.server || item.tool ? classifyToolTier(item.server, item.tool) : tier;
    if (tierRank(itemTier) > tierRank(effectiveTier)) {
      effectiveTier = itemTier;
    }
  }

  const nonceToken = asStr(orderObj.nonce_token || orderObj.nonceToken);
  const actionId = asStr(orderObj.action_id || orderObj.actionId, `${domain}:${sourceGraph}:${intentRow.intent_id}`);

  if (effectiveTier === "L" && !nonceToken) {
    const itemKey = `sp:intent:${intentRow.intent_id}`;
    postOwnerItem(db, {
      key: itemKey,
      source: "specialist",
      kind: "question",
      projectId: rt.projectId,
      what: `Подтверждение live-мутации API (${targetRef}) на «${entityId}»`,
      why: `${asStr(orderObj.title)} — операция класса L требует одноразового подтверждения владельца.`,
      wake: true,
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
      receipt: { kind: "direct_api", server, tool, tier, status: "awaiting_approval_nonce", ownerItemKey: itemKey },
    };
  }

  const mutRes = applyMutationsBatch(db, {
    projectId: rt.projectId,
    domain,
    tier,
    items,
    actionId,
    ...(nonceToken ? { nonceToken } : {}),
    ...(deps.executeMutation ? { executeMutation: deps.executeMutation } : {}),
    runId: c.runId,
  });

  if (mutRes.failed > 0 && mutRes.applied === 0 && mutRes.staged === 0) {
    return {
      ok: false,
      disposition: "blocked",
      targetRef,
      receipt: { kind: "direct_api", server, tool, tier, ...mutRes },
      blockReason: mutRes.errors[0] || "direct_api_blocked",
    };
  }

  if (mutRes.mode === "staged_manual" || mutRes.applied === 0) {
    const itemKey = `sp:intent:${intentRow.intent_id}`;
    postOwnerItem(db, {
      key: itemKey,
      source: "specialist",
      kind: "question",
      projectId: rt.projectId,
      what: `Ручное применение API-изменения (${targetRef}): ${asStr(orderObj.title)}`,
      why: `Внешний адаптер мутаций не подключён; изменение зафиксировано в плане (${mutRes.mutationIds.join(", ")}).`,
      wake: false,
    });
    return {
      ok: true,
      disposition: "waiting_owner",
      targetRef: mutRes.mutationIds[0] || targetRef,
      receipt: { kind: "direct_api", server, tool, tier, ...mutRes, ownerItemKey: itemKey },
    };
  }

  return {
    ok: true,
    disposition: "executed",
    targetRef: mutRes.mutationIds[0] || targetRef,
    receipt: { kind: "direct_api", server, tool, tier, ...mutRes },
  };
}
