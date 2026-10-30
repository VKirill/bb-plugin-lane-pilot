import { t } from "@lane-pilot/i18n";
import { useLpRpcQuery } from "../../ui-shell/ui";
import { ThreadLive } from "./thread-live";

type LiveItem = { column: string };
type Live = { items: LiveItem[] } | null;

/** The thread's Lane Pilot work for the context segment slot (A-u3): the same `thread_live` read the info panel makes. */
const useLive = (threadId: string) => (useLpRpcQuery("thread_live", { threadId }, { pollMs: 30_000 }).data ?? null) as Live;

/** Shown while the chat has any Lane Pilot work at all (running now or done this week). */
export function useLaneContextVisible({ threadId }: { threadId: string }): boolean {
  const live = useLive(threadId);
  return Boolean(live?.items.length);
}

export function LaneContextSummary({ threadId }: { threadId: string }) {
  const live = useLive(threadId);
  const active = live?.items.filter((item) => item.column !== "done").length ?? 0;
  return <span data-testid="lane-context-summary">{t("liveNow")} · {active}</span>;
}

export function LaneContextDetails({ threadId, isExpanded }: { threadId: string; isExpanded: boolean }) {
  return isExpanded ? <ThreadLive threadId={threadId} locale={navigator.language} /> : null;
}
