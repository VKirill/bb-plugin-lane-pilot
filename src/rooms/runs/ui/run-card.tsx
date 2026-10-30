import { useEffect, useState } from "react";
import { useBbNavigate, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { HELPER_PANEL_ACTION } from "../../native-agent/ui";
import { useOpenThreadPanel } from "../../ui-shell/ui";

/** The directive a PM message uses for its run: `::lane-run{id="lprun_…"}` (the PM's per-run instructions name it). */
export const RUN_CARD_DIRECTIVE = "lane-run";
const POLL_MS = 5_000;
const DONE = new Set(["accepted", "blocked", "canceled", "failed"]);

type RunCard = {
  runId: string; state: string; closed: boolean;
  tasks: Array<{ id: string; title: string; state: string | null; threadId: string | null; checkLog: { hostId: string; path: string } | null; background?: string[] }>;
};

// Every ended state of an attempt has its own words: a failed one shown as «In progress» told the owner to wait for a failure (audit 2026-10-28).
const STATE_LABEL: Record<string, I18nKey> = {
  accepted: "runCardState_accepted", blocked: "runCardState_blocked", canceled: "runCardState_canceled", queued: "runCardState_queued",
  validation_failed: "runCardState_validation_failed", provider_error: "runCardState_provider_error", empty_output: "runCardState_empty_output",
  spawn_rejected: "runCardState_spawn_rejected", internal_error: "runCardState_internal_error",
};
const stateText = (state: string | null) => state === null ? t("runCardState_none") : t(STATE_LABEL[state] ?? "runCardState_working");
const BACKGROUND_LABEL: Record<string, I18nKey> = { "memory-maintenance": "runCardStage_memory", "project-life": "runCardStage_projectLife", "docs-maintenance": "runCardStage_docs" };
const backgroundText = (stages: string[] | undefined) => stages?.length
  ? t("runCardBackgroundFailed").replace("{stages}", stages.map((stage) => BACKGROUND_LABEL[stage] ? t(BACKGROUND_LABEL[stage]!) : stage).join(", ")) : null;

/**
 * A live card for one Lane Pilot run inside the PM's message: its tasks with their latest state, each with its writer's
 * chat and, for a task that left a failed check's log, the log in BB's file preview. The id is untrusted text from the
 * message; the card shows only what the plugin server answers for it.
 */
/**
 * The chat is virtualized: a message leaves the page and mounts again while the owner scrolls. A card that started from a
 * 48 px placeholder each time grew to its full height a moment later, and the chat jumped (2026-10-09). The last card of a
 * run is kept here, so a mount shows it at once; and the list shows a few rows with a «show all» toggle so its height stays small.
 */
const lastCard = new Map<string, RunCard | "missing">();
const ROWS_SHOWN = 5;

export function RunCardDirective({ attributes, source }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const openPanel = useOpenThreadPanel();
  const runId = attributes.id ?? "";
  const [card, setCardState] = useState<RunCard | "missing" | null>(() => lastCard.get(runId) ?? null);
  const [expanded, setExpanded] = useState(false);
  // The last read failed: the card says so instead of pulsing (no card yet) or showing old rows as current.
  const [offline, setOffline] = useState(false);
  const setCard = (value: RunCard | "missing") => { lastCard.set(runId, value); setCardState(value); };
  useEffect(() => {
    if (!runId) { setCard("missing"); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // An open run is read until it closes: a run with no tasks yet, or with every task ended (blocked ones can be resumed from outside),
    // still gets new ones; those are read less often.
    const read = () => void rpc.call("get_run_card", { runId }).then((result) => {
      if (!alive) return;
      setOffline(false);
      setCard(result ?? "missing");
      if (result && !result.closed) timer = setTimeout(read, result.tasks.length && !result.tasks.every((task) => DONE.has(task.state ?? "")) ? POLL_MS : POLL_MS * 3);
    }).catch(() => { if (alive) { setOffline(true); timer = setTimeout(read, POLL_MS * 3); } });
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [rpc, runId]);

  if (card === null) {
    return offline
      ? <div role="status" data-testid="run-card-offline" className="my-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground">{t("runCardLoadFailed")}</div>
      : <div role="status" aria-busy="true" className="my-2 h-12 animate-pulse rounded-md border border-border bg-muted/40" />;
  }
  if (card === "missing") return <div className="my-2 rounded-md border border-border px-3 py-2 text-sm text-muted-foreground" title={source}>{t("runCardGone")}</div>;
  // The counter counts work, not rows: «T3», «T3.2», «T3.4» are one task sent again, done when its latest member is accepted
  // (magicseo 2026-10-30 showed «9 of 17» with all nine pieces of work accepted). The rows keep every attempt's history.
  const family = (id: string) => id.replace(/(\.\d+)+$/, "").replace(/-mainfix$/, "");
  const latest = new Map(card.tasks.map((task) => [family(task.id), task.state] as const));
  const done = [...latest.values()].filter((state) => state === "accepted").length;
  const shown = expanded ? card.tasks : card.tasks.slice(0, ROWS_SHOWN);
  return (
    <div className="my-2 min-w-0 rounded-md border border-border text-sm" data-testid="run-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="font-medium">{t("runCardTitle")}</span>
        <span className="text-xs text-muted-foreground">{card.closed ? t("runCardClosed") : t("runCardProgress").replace("{done}", String(done)).replace("{total}", String(latest.size))}</span>
      </div>
      {offline ? <div role="status" data-testid="run-card-stale" className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">{t("runCardStale")}</div> : null}
      <ul className="divide-y divide-border">
        {shown.map((task) => (
          <li key={task.id} className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5">
            <span className="min-w-0 flex-1 truncate" title={`${task.id}: ${task.title}`}>{task.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{stateText(task.state)}</span>
            {backgroundText(task.background) ? <span data-testid="run-card-background" className="shrink-0 text-xs text-amber-600 dark:text-amber-400">{backgroundText(task.background)}</span> : null}
            {task.threadId ? (
              <button type="button" className="shrink-0 text-xs underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => {
                  if (!openPanel({ actionId: HELPER_PANEL_ACTION, title: task.title.slice(0, 40), params: { threadId: task.threadId } })) navigate.toThread(task.threadId!);
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
      {card.tasks.length > ROWS_SHOWN ? (
        <button type="button" data-testid="run-card-toggle" className="w-full border-t border-border px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setExpanded((open) => !open)}>
          {expanded ? t("runCardShowLess") : t("runCardShowAll").replace("{count}", String(card.tasks.length))}
        </button>
      ) : null}
    </div>
  );
}
