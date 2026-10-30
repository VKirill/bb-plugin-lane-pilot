import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";

type Badge = { count: number; tone: "neutral" | "warning" | "critical" };

/** The count of what waits for the owner, drawn on the Lane Pilot navigation entry (BB's `experimental_useBadge` calls this). */
export function useOwnerWaitingBadge(): Badge | null {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () => {
      void rpc.call("owner_waiting", {}).then((value) => {
        if (live) setCount(((value as { items?: unknown[] }).items?.length) ?? 0);
      }).catch(() => undefined);
    };
    read();
    const timer = setInterval(read, 30_000);
    return () => { live = false; clearInterval(timer); };
  }, [rpc]);
  return count > 0 ? { count, tone: "critical" } : null;
}
