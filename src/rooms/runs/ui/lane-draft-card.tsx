import { useEffect, useState } from "react";
import { useBbNavigate, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { Button, StatusPill } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";


/** The directive a PM's propose reply carries: `::lane-draft{id="dr_…"}` (SMA m_sw_chat_draft / m_sw_batch_draft). */
export const LANE_DRAFT_DIRECTIVE = "lane-draft";
const POLL_MS = 5_000;

type DraftCard = { id: string; kind: "task" | "batch"; state: "proposed" | "created" | "partial"; runId: string | null; taskIds: string[]; failed?: Array<{ title: string; reason: string }>;
  title: string; promise: string; groups: Array<{ area: string; titles: string[] }> };

/** A proposed task's card: its title, the PM's promise in plain words, and one «Создать» button. The button and the
 *  PM's confirmed call share the server's one enqueue path, so a second create only reads «already created». */
export function LaneDraftCardDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const draftId = attributes.id ?? "";
  // The window's project scopes both calls: a draft of another project is refused by the server.
  const scope = message.projectId ? { projectId: message.projectId } : {};
  const [card, setCard] = useState<DraftCard | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!draftId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => void rpc.call("task_draft_card", { draftId, ...scope }).then((result) => {
      if (!alive) return;
      const next = (result ?? null) as DraftCard | null;
      setCard(next);
      if (next?.state === "proposed") timer = setTimeout(read, POLL_MS);
    }).catch(() => { if (alive) timer = setTimeout(read, POLL_MS * 3); });
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [rpc, draftId, message.projectId]);

  if (!card) return <div role="status" aria-busy="true" data-bb-plugin="lane-pilot" className="my-2 h-14 animate-pulse rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-well)]" />;
  const create = async () => {
    setBusy(true);
    try { await rpc.call("task_draft_create", { draftId, ...scope }); const next = await rpc.call("task_draft_card", { draftId, ...scope }); setCard((next ?? null) as DraftCard | null); } finally { setBusy(false); }
  };
  const firstTask = card.taskIds[0];
  const batchCount = card.groups.reduce((n, g) => n + g.titles.length, 0);
  return (
    <div className="lp-card my-2 min-w-0 text-sm" data-bb-plugin="lane-pilot" data-testid="lane-draft-card">
      <div className="flex items-center justify-between gap-2.5 border-b border-[var(--lp-hairline)] px-4 py-3">
        <span className="min-w-0 truncate text-[13.5px] font-semibold text-foreground">{card.title}</span>
        <StatusPill tone="muted" className="shrink-0">
          {card.kind === "batch" ? t("draftCardKindBatch").replace("{count}", String(batchCount)) : t("draftCardKindTask")}
        </StatusPill>
      </div>
      <div className="px-4 py-3 text-[12.5px]">
        <p className="text-muted-foreground">{card.promise}</p>
        {card.kind === "batch" ? (
          <ul className="mt-2 space-y-1 text-foreground">
            {card.groups.map((group) => (
              <li key={group.area || "_"}>
                {group.area ? <span className="text-xs text-muted-foreground">{group.area}</span> : null}
                <ul className="list-inside list-disc">{group.titles.map((title) => <li key={title} className="inline">{title}</li>)}</ul>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {card.failed?.length ? <ul className="px-4 pb-2 text-xs text-destructive" data-testid="lane-draft-failed">{card.failed.map((item, index) => <li key={index} className="break-words">{item.title}: {item.reason}</li>)}</ul> : null}
      <div className="flex flex-wrap items-center gap-2 border-t border-[var(--lp-hairline)] px-4 py-3">
        {card.state === "proposed" || card.state === "partial"
          ? <Button type="button" size="sm" variant="default" disabled={busy} onClick={() => void create()} data-testid="lane-draft-create">
              {card.state === "partial" ? t("draftCardCreateRemaining") : t("draftCardCreate")}
            </Button>
          : <>
              <span className="text-xs text-muted-foreground">{t("draftCardCreated").replace("{ids}", card.taskIds.join(", ") || "—")}</span>
              {firstTask && card.runId ? (
                <Button type="button" size="sm" variant="outline" onClick={() => navigate.toPluginPanel("lane-pilot")} data-testid="lane-draft-graph">
                  {t("draftCardOpenGraph")}
                </Button>
              ) : null}
            </>}
      </div>
    </div>
  );
}
