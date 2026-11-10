import { useEffect, useState } from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t } from "@lane-pilot/i18n";

/**
 * The boundary line under the PM chat's input (SMA m_ce_boundary): who decides here. It says what the project's
 * owner.words setting makes true — every task waits for the owner's word (on), only high-risk ones do (risky, the
 * default), or nothing waits (off: no line). Other threads — writers, helpers, ordinary chats — show nothing.
 */
export function ComposerBoundary() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposer();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [line, setLine] = useState<"composerBoundary" | "composerBoundaryRisky" | null>(null);

  useEffect(() => {
    setLine(null);
    if (!threadId) return;
    let current = true;
    void rpc.call("native_thread", { threadId }).then((row) => {
      const thread = row as { role?: unknown; ownerWords?: unknown } | null;
      if (current && thread?.role === "pm") setLine(thread.ownerWords === "on" ? "composerBoundary" : thread.ownerWords === "off" ? null : "composerBoundaryRisky");
    }).catch(() => undefined);
    return () => { current = false; };
  }, [rpc, threadId]);

  if (!line) return null;
  return (
    <div style={{ fontSize: 11, opacity: 0.6, padding: "2px 8px" }}>{t(line)}</div>
  );
}
