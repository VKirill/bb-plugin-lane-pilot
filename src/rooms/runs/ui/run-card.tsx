import { useEffect, useState } from "react";
import { useBbNavigate, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { HELPER_PANEL_ACTION } from "../../native-agent/ui/helper-threads";

/** The directive a PM message uses for its run: `::lane-run{id="lprun_…"}` (the PM's per-run instructions name it). */
export const RUN_CARD_DIRECTIVE = "lane-run";
const POLL_MS = 5_000;
const DONE = new Set(["accepted", "blocked", "canceled", "failed"]);

type RunCard = {
  runId: string; state: string; closed: boolean;
  tasks: Array<{ id: string; title: string; state: string | null; threadId: string | null; checkLog: { hostId: string; path: string } | null }>;
};

const STATE_LABEL: Record<string, I18nKey> = {
  accepted: "runCardState_accepted", blocked: "runCardState_blocked", canceled: "runCardState_canceled", queued: "runCardState_queued",
};
const stateText = (state: string | null) => state === null ? t("runCardState_none") : t(STATE_LABEL[state] ?? "runCardState_working");

/**
 * A live card for one Lane Pilot run inside the PM's message: its tasks with their latest state, each with its writer's
 * chat and, for a task that left a failed check's log, the log in BB's file preview. The id is untrusted text from the
 * message; the card shows only what the plugin server answers for it.
 */
export function RunCardDirective({ attributes, source }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const runId = attributes.id ?? "";
  const [card, setCard] = useState<RunCard | "missing" | null>(null);
  useEffect(() => {
    if (!runId) { setCard("missing"); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => void rpc.call("get_run_card", { runId }).then((result) => {
      if (!alive) return;
      setCard(result ?? "missing");
      if (result && !result.closed && !result.tasks.every((task) => DONE.has(task.state ?? ""))) timer = setTimeout(read, POLL_MS);
    }).catch(() => { if (alive) timer = setTimeout(read, POLL_MS * 3); });
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [rpc, runId]);

  if (card === null) return <div role="status" aria-busy="true" className="my-2 h-12 animate-pulse rounded-md border border-border bg-muted/40" />;
  if (card === "missing") return <div className="my-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground" title={source}>{t("runCardGone")}</div>;
  const done = card.tasks.filter((task) => task.state === "accepted").length;
  return (
    <div className="my-2 min-w-0 rounded-md border border-border text-sm" data-testid="run-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="font-medium">{t("runCardTitle")}</span>
        <span className="text-xs text-muted-foreground">{card.closed ? t("runCardClosed") : t("runCardProgress").replace("{done}", String(done)).replace("{total}", String(card.tasks.length))}</span>
      </div>
      <ul className="divide-y divide-border">
        {card.tasks.map((task) => (
          <li key={task.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate" title={`${task.id}: ${task.title}`}>{task.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{stateText(task.state)}</span>
            {task.threadId ? (
              <button type="button" className="shrink-0 text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => {
                  if (!navigate.openThreadPanel({ actionId: HELPER_PANEL_ACTION, title: task.title.slice(0, 40), params: { threadId: task.threadId } })) navigate.toThread(task.threadId!);
                }}>{t("runCardOpenWriter")}</button>
            ) : null}
            {task.checkLog ? (
              <button type="button" className="shrink-0 text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => navigate.experimental_openFilePreview({ target: { kind: "host", hostId: task.checkLog!.hostId, path: task.checkLog!.path }, location: null })}>
                {t("runCardOpenLog")}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
