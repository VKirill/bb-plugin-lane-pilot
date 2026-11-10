import { useEffect, useState } from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t } from "@lane-pilot/i18n";

/**
 * The boundary line under the PM chat's input (SMA m_ce_boundary): work queues only on the owner's own word here,
 * and accepting a result is his. Other threads — writers, helpers, ordinary chats — show nothing.
 */
export function ComposerBoundary() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposer();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [pm, setPm] = useState(false);

  useEffect(() => {
    setPm(false);
    if (!threadId) return;
    let current = true;
    void rpc.call("native_thread", { threadId }).then((row) => {
      if (current) setPm((row as { role?: unknown } | null)?.role === "pm");
    }).catch(() => undefined);
    return () => { current = false; };
  }, [rpc, threadId]);

  if (!pm) return null;
  return (
    <div style={{ fontSize: 11, opacity: 0.6, padding: "2px 8px" }}>{t("composerBoundary")}</div>
  );
}
