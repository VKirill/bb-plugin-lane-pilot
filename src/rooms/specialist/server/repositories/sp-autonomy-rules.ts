import { isOwnerRefusalReason, isToolTier, type OwnerRefusalReason, type ToolTier, TIER_RANK } from "@lane-pilot/contracts";
import { type ActionOrder, dbOrderKindOf } from "../../models/action-order";
import { classifyToolTier, estimateActionOrderCost, loadSpPolicy } from "../../tool-tiers";

/** Builds the canonical action-class key `<order_kind>:<reason_code>`. */
export function actionClassOfOrder(orderKind: string, reasonCode: string): string {
  const kind = dbOrderKindOf(orderKind);
  const code = (reasonCode || "general").trim() || "general";
  return `${kind}:${code}`;
}

/** Resolves the highest tool tier (`R/D/L/S`) of an order, including nested mutation items. */
export function resolveOrderTier(order: Pick<ActionOrder, "kind" | "tariff_known" | "server" | "tool" | "estimated_cost_usd" | "mutations" | "items"> & { _tier?: unknown }): ToolTier {
  if (isToolTier(order._tier)) {
    return order._tier;
  }
  let tier = estimateActionOrderCost(order as ActionOrder).tier;
  const nested = [...(Array.isArray(order.mutations) ? order.mutations : []), ...(Array.isArray(order.items) ? order.items : [])];
  for (const item of nested) {
    if (!item || typeof item !== "object") continue;
    const srv = typeof item.server === "string" && item.server ? item.server : undefined;
    const tool = typeof item.tool === "string" && item.tool ? item.tool : undefined;
    if (srv || tool) {
      const itemTier = classifyToolTier(srv, tool);
      if (TIER_RANK[itemTier] > TIER_RANK[tier]) tier = itemTier;
    }
  }
  return tier;
}

/** Whether an action class (or its reason_code / explicit action_class) is permanently barred from auto execution. */
export function isHighRiskActionClass(actionClass: string, order?: { action_class?: string }): boolean {
  const list = loadSpPolicy().autonomy?.high_risk_never_auto ?? [];
  if (list.length === 0) return false;
  const highRiskSet = new Set(list);
  if (highRiskSet.has(actionClass)) return true;
  const colonIdx = actionClass.indexOf(":");
  if (colonIdx >= 0 && highRiskSet.has(actionClass.slice(colonIdx + 1))) return true;
  if (order?.action_class && highRiskSet.has(order.action_class)) return true;
  return false;
}

/** Formats an owner refusal as `"<reason>: <text>"` (or `"<reason>"` when text is empty). */
export function formatRefusalDropReason(reason?: string | null, text?: string | null): string {
  const validReason: OwnerRefusalReason = isOwnerRefusalReason(reason) ? reason : "other";
  const trimmed = typeof text === "string" ? text.trim() : "";
  return trimmed ? `${validReason}: ${trimmed}` : validReason;
}

/** Parses a `drop_reason` produced by `formatRefusalDropReason`, or returns null for non-refusal drop reasons. */
export function parseRefusalDropReason(dropReason: string | null | undefined): { reason: OwnerRefusalReason; text: string } | null {
  if (!dropReason || typeof dropReason !== "string") return null;
  const trimmed = dropReason.trim();
  if (!trimmed) return null;
  const colonIdx = trimmed.indexOf(":");
  const head = (colonIdx >= 0 ? trimmed.slice(0, colonIdx) : trimmed).trim();
  if (!isOwnerRefusalReason(head)) return null;
  const text = colonIdx >= 0 ? trimmed.slice(colonIdx + 1).trim() : "";
  return { reason: head, text };
}

/**
 * Cohen's kappa between binary model predictions (`needs_owner_go=false`) and owner approvals.
 * When agreement is unanimous with zero disagreements (`p_o = 1, p_e = 1`), returns `1`.
 */
export function cohenKappa(bothYes: number, modelYesOwnerNo: number, modelNoOwnerYes: number, bothNo: number): number {
  const n = bothYes + modelYesOwnerNo + modelNoOwnerYes + bothNo;
  if (n <= 0) return 0;
  const po = (bothYes + bothNo) / n;
  const pModelYes = (bothYes + modelYesOwnerNo) / n;
  const pOwnerYes = (bothYes + modelNoOwnerYes) / n;
  const pe = pModelYes * pOwnerYes + (1 - pModelYes) * (1 - pOwnerYes);
  if (Math.abs(1 - pe) < 1e-12) {
    return po >= 1 - 1e-12 ? 1 : 0;
  }
  return Number(((po - pe) / (1 - pe)).toFixed(6));
}
