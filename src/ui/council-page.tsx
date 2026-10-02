import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Disclosure } from "./disclosure";
import { useObservedWidth } from "./panel-layout";

type CouncilRow = { id: string; runId: string; question: string; state: string; round: number; maxRounds: number; decisionPath: string | null; updatedAt: number };
type CouncilDetail = {
  id: string; question: string; state: string; round: number; maxRounds: number; agenda: string[]; criteria: string[]; decisionPath: string | null; reason: string | null; recommendation: string | null;
  speaking: string | null; speakingSince: number | null;
  seats: Array<{ id: string; title: string; providerId: string | null; model: string | null }>;
  messages: Array<{ seq: number; seatId: string; round: number; kind: string; text: string; at: number }>;
};

const TERMINAL = new Set(["done", "failed", "stopped"]);
const PROJECT_KEY = "lane-pilot:council:project";
/** Below this the council list (16rem) and the chat no longer fit side by side. */
const COUNCIL_COMPACT_MAX = 640;
/** 16px text on phones keeps iOS from zooming into the native select. */
const SELECT_CLASS = "h-9 rounded-md border bg-background px-2 text-base sm:h-8 sm:text-sm";
/** Long code, tables and paths scroll inside the message instead of widening the page. */
const MARKDOWN_CLASS = "min-w-0 text-sm [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

function speakerName(detail: CouncilDetail, seatId: string): string {
  if (seatId === "owner") return t("councilOwner");
  if (seatId === "chair") return t("councilChair");
  if (seatId === "moderator") return t("councilModerator");
  return detail.seats.find((seat) => seat.id === seatId)?.title ?? seatId;
}

/** The boardroom: every council of a project as a chat, live while it runs, with the owner's composer. */
export function CouncilPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string | null>(() => (typeof localStorage === "undefined" ? null : localStorage.getItem(PROJECT_KEY)));
  const [councils, setCouncils] = useState<CouncilRow[]>([]);
  const [councilId, setCouncilId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CouncilDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const feed = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const width = useObservedWidth(rootRef);

  useEffect(() => {
    void rpc.call("list_projects", {}).then((result) => {
      const rows = (result as { projects: Array<{ id: string; name: string }> }).projects ?? [];
      setProjects(rows);
      setProjectId((current) => current && rows.some((row) => row.id === current) ? current : rows[0]?.id ?? null);
    }).catch(() => setProjects([]));
  }, [rpc]);

  const loadCouncils = useCallback(async () => {
    if (!projectId) return;
    try {
      const listed = await rpc.call("list_councils", { projectId }) as { councils: CouncilRow[] };
      setCouncils(listed.councils);
      setCouncilId((current) => current && listed.councils.some((row) => row.id === current) ? current : listed.councils[0]?.id ?? null);
    } catch { setCouncils([]); }
  }, [projectId, rpc]);

  useEffect(() => { if (projectId && typeof localStorage !== "undefined") localStorage.setItem(PROJECT_KEY, projectId); void loadCouncils(); }, [projectId, loadCouncils]);

  const loadDetail = useCallback(async () => {
    if (!councilId) { setDetail(null); return; }
    try { setDetail(await rpc.call("get_council", { councilId }) as CouncilDetail); } catch { setDetail(null); }
  }, [councilId, rpc]);

  useEffect(() => { void loadDetail(); }, [loadDetail]);
  useEffect(() => {
    if (!detail || TERMINAL.has(detail.state)) return;
    const timer = setInterval(() => { void loadDetail(); void loadCouncils(); }, 2000);
    return () => clearInterval(timer);
  }, [detail, loadDetail, loadCouncils]);
  // Scroll only the feed: scrollIntoView would also scroll the BB page around the panel on phones.
  useEffect(() => { const node = feed.current; if (node) node.scrollTop = node.scrollHeight; }, [detail?.messages.length]);

  const say = async (decide = false) => {
    if (!councilId || busy) return;
    const text = draft.trim();
    if (!text && !decide) return;
    setBusy(true);
    try {
      await rpc.call("council_say", { councilId, ...(text ? { text } : {}), ...(decide ? { decide: true } : {}) });
      setDraft("");
      await loadDetail();
    } finally { setBusy(false); }
  };
  const stop = async () => { if (!councilId) return; await rpc.call("council_stop", { councilId }); await loadDetail(); };

  const running = detail ? !TERMINAL.has(detail.state) : false;
  const compact = width > 0 && width <= COUNCIL_COMPACT_MAX;
  const seatLine = detail ? detail.seats.map((seat) => `${seat.title}${seat.providerId && seat.model ? ` (${seat.providerId}/${seat.model})` : ""}`).join(" · ") : "";
  const roster = detail ? (
    <>
      <div className="text-xs text-muted-foreground">{seatLine}</div>
      {detail.agenda.length ? <ol className="list-decimal pl-5 text-xs">{detail.agenda.map((item) => <li key={item}>{item}</li>)}</ol> : null}
    </>
  ) : null;
  return (
    <div ref={rootRef} className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${compact ? "gap-2 p-2" : "gap-3 p-4"}`} data-testid="council-page" data-council-layout={compact ? "compact" : "split"} data-bb-ru-skip>
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="shrink-0 text-base font-semibold">{t("councilPageTitle")}</h1>
        <select className={`${SELECT_CLASS} min-w-0 ${compact ? "flex-1" : "max-w-[16rem]"}`} value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value || null)} aria-label={t("councilPick")}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>
      {!projects.length ? <p className="text-sm text-muted-foreground">{t("councilNoProjects")}</p> : null}
      {compact && councils.length ? (
        <select className={`${SELECT_CLASS} w-full min-w-0`} value={councilId ?? ""} onChange={(event) => setCouncilId(event.target.value || null)} aria-label={t("councilTitle")} data-testid="council-list">
          {councils.map((row) => <option key={row.id} value={row.id}>{`${t(`councilState_${row.state}` as never) || row.state} · ${row.question}`}</option>)}
        </select>
      ) : null}
      {projects.length > 0 && !detail ? <p className="text-sm text-muted-foreground">{t("councilEmpty")}</p> : null}
      {detail ? <div className="flex min-h-0 min-w-0 flex-1 gap-3">
        {compact ? null : (
          <aside className="w-64 shrink-0 space-y-1 overflow-y-auto rounded-md border p-2" data-testid="council-list">
            {councils.map((row) => (
              <button key={row.id} type="button" onClick={() => setCouncilId(row.id)} className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${row.id === councilId ? "bg-muted" : ""}`}>
                <div className="line-clamp-2 break-words">{row.question}</div>
                <div className="text-xs text-muted-foreground">{t(`councilState_${row.state}` as never) || row.state} · {t("councilRound")} {row.round}</div>
              </button>
            ))}
          </aside>
        )}
        <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-md border">
            <>
              <header className={`max-h-[40%] shrink-0 space-y-1 overflow-y-auto border-b [overflow-wrap:anywhere] ${compact ? "p-2" : "p-3"}`} data-testid="council-header">
                <div className={`text-sm font-medium ${compact ? "line-clamp-4" : ""}`}>{detail.question}</div>
                {compact ? <Disclosure compact summary={`${t("councilTitle")} · ${t("councilRound")} ${detail.round}/${detail.maxRounds}`}>{roster}</Disclosure> : roster}
              </header>
              <div ref={feed} className={`min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto [overflow-wrap:anywhere] ${compact ? "p-2" : "p-3"}`} data-testid="council-messages">
                {detail.messages.map((message) => (
                  <div key={message.seq} className={`min-w-0 rounded p-2 ${message.seatId === "owner" ? "bg-primary/10" : message.seatId === "moderator" ? "text-muted-foreground" : "bg-muted/40"}`}>
                    <div className="text-xs font-medium">{speakerName(detail, message.seatId)}{message.seatId === "owner" || message.round === 0 ? "" : ` · ${t("councilRound")} ${message.round}`}{message.kind === "status" ? ` · ${t("councilStatusKind")}` : ""}</div>
                    <Markdown content={message.text} className={MARKDOWN_CLASS} />
                  </div>
                ))}
                {detail.speaking ? <div className="text-xs italic text-muted-foreground" data-testid="council-typing">{speakerName(detail, detail.speaking)} {t("councilTyping")}</div> : null}
                {detail.recommendation ? <div className="min-w-0 rounded border p-2 text-sm"><div className="font-medium">{t("councilDecision")}</div><Markdown content={detail.recommendation} className={MARKDOWN_CLASS} />{detail.decisionPath ? <div className="text-xs text-muted-foreground">{detail.decisionPath}</div> : null}</div> : null}
                {detail.reason ? <div className="text-xs text-destructive">{detail.reason}</div> : null}
              </div>
              <footer className={`flex shrink-0 flex-wrap gap-2 border-t ${compact ? "p-2" : "p-3"}`} data-testid="council-composer">
                <Input className={compact ? "min-w-0 basis-full" : "min-w-0 flex-1"} value={draft} disabled={!running || busy} placeholder={t("councilSayPlaceholder")} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void say(); }} aria-label={t("councilSay")} />
                <Button className={compact ? "min-w-0 flex-1" : undefined} type="button" size="sm" disabled={!running || busy || !draft.trim()} onClick={() => void say()}>{t("councilSay")}</Button>
                <Button className={compact ? "min-w-0 flex-1" : undefined} type="button" size="sm" variant="outline" disabled={!running || busy} onClick={() => void say(true)}>{t("councilDecide")}</Button>
                <Button className={compact ? "min-w-0 flex-1" : undefined} type="button" size="sm" variant="ghost" disabled={!running} onClick={() => void stop()}>{t("councilStop")}</Button>
              </footer>
            </>
        </section>
      </div> : null}
    </div>
  );
}
