import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { detectLocale, setLocaleOverride, t } from "../../i18n";
import { agentPickerLabel } from "../agent-display";
import { nativeAgentCliId } from "../native-session";
import { findComposerPromptBox, promptBoxFrameStyle, PROMPT_BOX_AGENT_LABEL_LEFT } from "./composer-prompt-box";
import { getPendingNativeAgent, subscribePendingNativeAgent } from "./pending-native-agent";

function shortAgentId(value: string): string {
  try { return nativeAgentCliId(value); } catch { return value; }
}

function AgentNameBadge(agent: { agentId: string; description: string }) {
  const id = shortAgentId(agent.agentId);
  const markerRef = useRef<HTMLSpanElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [frame, setFrame] = useState<ReturnType<typeof promptBoxFrameStyle> | undefined>();

  useLayoutEffect(() => {
    const sync = () => {
      const next = findComposerPromptBox(markerRef.current);
      setHost(next);
      setFrame(next ? promptBoxFrameStyle(next) : undefined);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!host) return;
    const refresh = () => setFrame(promptBoxFrameStyle(host));
    host.addEventListener("focusin", refresh);
    host.addEventListener("focusout", refresh);
    return () => {
      host.removeEventListener("focusin", refresh);
      host.removeEventListener("focusout", refresh);
    };
  }, [host]);

  const compact = host?.hasAttribute("data-promptbox-compact") ?? false;
  const chip = (
    <span
      className="pointer-events-none text-xs leading-none text-muted-foreground"
      style={{
        ...frame,
        position: host ? "absolute" : undefined,
        left: host ? PROMPT_BOX_AGENT_LABEL_LEFT : undefined,
        top: host ? (compact ? "0.375rem" : 0) : undefined,
        transform: host && !compact ? "translateY(-50%)" : undefined,
        zIndex: host ? 10 : undefined,
        padding: "0.125rem 0.5rem",
      }}
      aria-label={t("composerAgentBadge")}
    >
      {agentPickerLabel({ id, description: agent.description }, t)}
    </span>
  );

  return (
    <>
      <span ref={markerRef} hidden data-lane-pilot-agent-marker="" />
      {host ? createPortal(chip, host) : chip}
    </>
  );
}

export function ComposerAgentBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposerView();
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const pending = useSyncExternalStore(subscribePendingNativeAgent, getPendingNativeAgent, getPendingNativeAgent);
  const [bound, setBound] = useState<{ agentId: string; description: string } | null>(null);

  useEffect(() => {
    let current = true;
    void rpc.call("get_preferences", { suggestedLocale: detectLocale() }).then((result) => {
      if (!current) return;
      setLocaleOverride(result.preference === "auto" ? null : result.preference);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [rpc]);

  useEffect(() => {
    if (!threadId) {
      setBound(null);
      return;
    }
    let current = true;
    setBound(null);
    void rpc.call("native_thread", { threadId }).then((row) => {
      if (!current || !row) return;
      setBound({ agentId: row.agentType, description: row.description });
    }).catch(() => undefined);
    return () => { current = false; };
  }, [rpc, threadId]);

  if (threadId) return bound ? <AgentNameBadge {...bound} /> : null;
  return pending ? <AgentNameBadge {...pending} /> : null;
}
