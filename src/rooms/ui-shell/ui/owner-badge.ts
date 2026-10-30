import { useLpRpcQuery } from "./use-lp-rpc-query";

/** The count of what waits for the owner, drawn on the Lane Pilot navigation entry (BB's `experimental_useBadge` calls this). */
export function useOwnerWaitingBadge(): { count: number; tone: "neutral" | "warning" | "critical"; label: string } | null {
  const query = useLpRpcQuery("owner_waiting", {}, { pollMs: 30_000 });
  const count = ((query.data ?? null) as { items?: unknown[] } | null)?.items?.length ?? 0;
  return count > 0 ? { count, tone: "critical", label: String(count) } : null;
}
