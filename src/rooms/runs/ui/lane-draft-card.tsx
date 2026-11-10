import { useEffect, useState } from "react";
import { useBbNavigate, useRpc, type PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";


/** The directive a PM's propose reply carries: `::lane-draft{id="dr_…"}` (SMA m_sw_chat_draft / m_sw_batch_draft). */
export const LANE_DRAFT_DIRECTIVE = "lane-draft";
const POLL_MS = 5_000;

type DraftCard = { id: string; kind: "task" | "batch"; state: "proposed" | "created"; runId: string | null; taskIds: string[];
  title: string; promise: string; groups: Array<{ area: string; titles: string[] }> };

/** A proposed task's card: its title, the PM's promise in plain words, and one «Создать» button. The button and the
 *  PM's confirmed call share the server's one enqueue path, so a second create only reads «already created». */
export function LaneDraftCardDirective({ attributes }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const draftId = attributes.id ?? "";
  const [card, setCard] = useState<DraftCard | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!draftId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => void rpc.call("task_draft_card", { draftId }).then((result) => {
      if (!alive) return;
      const next = (result ?? null) as DraftCard | null;
      setCard(next);
      if (next?.state === "proposed") timer = setTimeout(read, POLL_MS);
    }).catch(() => { if (alive) timer = setTimeout(read, POLL_MS * 3); });
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [rpc, draftId]);

  if (!card) return <div role="status" aria-busy="true" className="my-2 h-14 animate-pulse rounded-md border border-border bg-muted/40" />;
  const create = async () => {
    setBusy(true);
    try { await rpc.call("task_draft_create", { draftId }); } finally { setBusy(false); }
  };
  const firstTask = card.taskIds[0];
  return (
    <div className="my-2 min-w-0 rounded-md border border-border text-sm" data-testid="lane-draft-card">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <span className="min-w-0 truncate font-medium">{card.title}</span>
        <span className="text-xs text-muted-foreground">{card.kind === "batch" ? `пачка · ${card.groups.reduce((n, g) => n + g.titles.length, 0)}` : "задача"}</span>
      </div>
      <div className="px-3 py-2">
        <p className="text-muted-foreground">{card.promise}</p>
        {card.kind === "batch" ? (
          <ul className="mt-1.5 space-y-1">
            {card.groups.map((group) => (
              <li key={group.area || "_"}>
                {group.area ? <span className="text-xs text-muted-foreground">{group.area}</span> : null}
                <ul className="list-inside list-disc">{group.titles.map((title) => <li key={title} className="inline">{title}</li>)}</ul>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t border-border px-3 py-2">
        {card.state === "proposed"
          ? <button type="button" disabled={busy} onClick={() => void create()} data-testid="lane-draft-create"
              className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50">Создать</button>
          : <>
              <span className="text-xs text-muted-foreground">Создано · {card.taskIds.join(", ") || "—"}</span>
              {firstTask && card.runId ? (
                <button type="button" onClick={() => navigate.toPluginPanel("lane-pilot-cockpit", { subPath: "tasks" })}
                  data-testid="lane-draft-graph" className="rounded-md border border-border px-3 py-1 text-xs">Открыть граф</button>
              ) : null}
            </>}
      </div>
    </div>
  );
}
