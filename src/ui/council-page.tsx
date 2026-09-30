import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";

type CouncilRow = { id: string; runId: string; question: string; state: string; round: number; maxRounds: number; decisionPath: string | null; updatedAt: number };
type CouncilDetail = {
  id: string; question: string; state: string; round: number; maxRounds: number; agenda: string[]; criteria: string[]; decisionPath: string | null; reason: string | null; recommendation: string | null;
  speaking: string | null; speakingSince: number | null;
  seats: Array<{ id: string; title: string; providerId: string | null; model: string | null }>;
  messages: Array<{ seq: number; seatId: string; round: number; kind: string; text: string; at: number }>;
};

const TERMINAL = new Set(["done", "failed", "stopped"]);
const PROJECT_KEY = "lane-pilot:council:project";

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
  const feedEnd = useRef<HTMLDivElement | null>(null);

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
  useEffect(() => { feedEnd.current?.scrollIntoView({ block: "end" }); }, [detail?.messages.length]);

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
  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4" data-testid="council-page" data-bb-ru-skip>
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-base font-semibold">{t("councilPageTitle")}</h1>
        <select className="rounded border bg-background px-2 py-1 text-sm" value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value || null)} aria-label={t("councilPick")}>
          {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
      </div>
      {!projects.length ? <p className="text-sm text-muted-foreground">{t("councilNoProjects")}</p> : null}
      <div className="flex min-h-0 flex-1 gap-3">
        <aside className="w-64 shrink-0 space-y-1 overflow-y-auto rounded-md border p-2" data-testid="council-list">
          {!councils.length ? <p className="text-xs text-muted-foreground">{t("councilEmpty")}</p> : councils.map((row) => (
            <button key={row.id} type="button" onClick={() => setCouncilId(row.id)} className={`block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${row.id === councilId ? "bg-muted" : ""}`}>
              <div className="line-clamp-2">{row.question}</div>
              <div className="text-xs text-muted-foreground">{t(`councilState_${row.state}` as never) || row.state} · {t("councilRound")} {row.round}</div>
            </button>
          ))}
        </aside>
        <section className="flex min-h-0 flex-1 flex-col rounded-md border">
          {!detail ? <p className="p-3 text-sm text-muted-foreground">{t("councilEmpty")}</p> : (
            <>
              <header className="space-y-1 border-b p-3">
                <div className="text-sm font-medium">{detail.question}</div>
                <div className="text-xs text-muted-foreground">{detail.seats.map((seat) => `${seat.title}${seat.providerId && seat.model ? ` (${seat.providerId}/${seat.model})` : ""}`).join(" · ")}</div>
                {detail.agenda.length ? <ol className="list-decimal pl-5 text-xs">{detail.agenda.map((item) => <li key={item}>{item}</li>)}</ol> : null}
              </header>
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3" data-testid="council-messages">
                {detail.messages.map((message) => (
                  <div key={message.seq} className={`rounded p-2 ${message.seatId === "owner" ? "bg-primary/10" : message.seatId === "moderator" ? "text-muted-foreground" : "bg-muted/40"}`}>
                    <div className="text-xs font-medium">{speakerName(detail, message.seatId)}{message.seatId === "owner" || message.round === 0 ? "" : ` · ${t("councilRound")} ${message.round}`}{message.kind === "status" ? ` · ${t("councilStatusKind")}` : ""}</div>
                    <Markdown content={message.text} className="text-sm" />
                  </div>
                ))}
                {detail.speaking ? <div className="text-xs italic text-muted-foreground" data-testid="council-typing">{speakerName(detail, detail.speaking)} {t("councilTyping")}</div> : null}
                {detail.recommendation ? <div className="rounded border p-2 text-sm"><div className="font-medium">{t("councilDecision")}</div><Markdown content={detail.recommendation} className="text-sm" />{detail.decisionPath ? <div className="text-xs text-muted-foreground">{detail.decisionPath}</div> : null}</div> : null}
                {detail.reason ? <div className="text-xs text-destructive">{detail.reason}</div> : null}
                <div ref={feedEnd} />
              </div>
              <footer className="flex gap-2 border-t p-3">
                <Input value={draft} disabled={!running || busy} placeholder={t("councilSayPlaceholder")} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void say(); }} aria-label={t("councilSay")} />
                <Button type="button" size="sm" disabled={!running || busy || !draft.trim()} onClick={() => void say()}>{t("councilSay")}</Button>
                <Button type="button" size="sm" variant="outline" disabled={!running || busy} onClick={() => void say(true)}>{t("councilDecide")}</Button>
                <Button type="button" size="sm" variant="ghost" disabled={!running} onClick={() => void stop()}>{t("councilStop")}</Button>
              </footer>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
