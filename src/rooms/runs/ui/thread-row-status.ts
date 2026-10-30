import { useEffect } from "react";
import { t } from "@lane-pilot/i18n";

export type ThreadRowStatus = { icon: string; label: string; tone?: "default" | "error" | "running" | "success" };
type Setter = (threadId: string, status: ThreadRowStatus | null) => void;

/** `experimental_setThreadRowStatus` of the mounted content script (vk core); null on a stock BB, where the row keeps its own look. */
let setter: Setter | null = null;

/** The content script's mount hands over its context here; the disposer clears it again. */
export function bindThreadRowStatus(next: Setter | null): void {
  setter = next;
}

/** The row status a thread's live work gets: error while something is blocked, running while anything is at work, nothing when idle. */
export function threadRowStatusOf(items: ReadonlyArray<{ column: string }>): ThreadRowStatus | null {
  if (items.some((item) => item.column === "blocked")) return { icon: "CircleAlert", label: t("liveTitle"), tone: "error" };
  if (items.some((item) => item.column !== "done")) return { icon: "LoaderCircle", label: t("liveTitle"), tone: "running" };
  return null;
}

/** Sets (or clears) the sidebar row status of this thread from its live work; a no-op where BB lacks the surface. */
export function applyThreadRowStatus(threadId: string, items: ReadonlyArray<{ column: string }>): void {
  setter?.(threadId, threadRowStatusOf(items));
}

export function useThreadRowStatus(threadId: string, items: ReadonlyArray<{ column: string }> | null): void {
  const key = JSON.stringify((items ?? []).map((item) => item.column));
  useEffect(() => {
    applyThreadRowStatus(threadId, items ?? []);
    return () => { setter?.(threadId, null); };
  }, [threadId, key]);
}
