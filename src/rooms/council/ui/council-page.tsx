import { useCallback, useEffect, useRef, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { Disclosure } from "@lane-pilot/ui-kit";
import { useObservedWidth } from "@lane-pilot/ui-kit";
import { useLpRealtime } from "../../ui-shell/ui";
import { CouncilOffice } from "./council-office";
import { seatColor } from "./office-behaviour";

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
const SELECT_CLASS = "h-9 rounded-none border-2 border-slate-900 bg-[var(--lp-card)] px-2 font-mono text-base shadow-[2px_2px_0_#0f172a] sm:h-8 sm:text-sm";
/** Long code, tables and paths scroll inside the message instead of widening the page. */
const MARKDOWN_CLASS = "min-w-0 text-sm font-sans [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

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

  // Replay & Inspection State
  const [replayCursor, setReplayCursor] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [highlightSeatId, setHighlightSeatId] = useState<string | null>(null);

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

  useEffect(() => {
    void loadDetail();
    setReplayCursor(null);
    setIsPlaying(false);
    setHighlightSeatId(null);
  }, [loadDetail]);

  // The server signals every message, state change and floor change of the project's councils; the poll only catches a lost signal.
  const pollMs = useLpRealtime(projectId, ["council"], () => { void loadDetail(); void loadCouncils(); });
  const live = detail ? !TERMINAL.has(detail.state) : false;
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => { void loadDetail(); void loadCouncils(); }, pollMs);
    return () => clearInterval(timer);
  }, [live, loadDetail, loadCouncils, pollMs]);

  // Replay timer
  useEffect(() => {
    if (!isPlaying || !detail || detail.messages.length === 0) return;
    const interval = setInterval(() => {
      setReplayCursor((prev) => {
        const sorted = [...detail.messages].sort((a, b) => a.seq - b.seq);
        const minSeq = sorted[0]!.seq;
        if (prev === null) return minSeq;
        const nextIdx = sorted.findIndex((m) => m.seq > prev);
        if (nextIdx === -1) {
          setIsPlaying(false);
          return prev;
        }
        return sorted[nextIdx]!.seq;
      });
    }, 2000);
    return () => clearInterval(interval);
  }, [isPlaying, detail]);

  // Auto-scroll feed on new message (if not replaying) or to active cursor
  useEffect(() => {
    if (replayCursor !== null) {
      const activeEl = feed.current?.querySelector(`[data-seq="${replayCursor}"]`);
      if (activeEl && typeof activeEl.scrollIntoView === "function") {
        activeEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } else {
      const node = feed.current;
      if (node) node.scrollTop = node.scrollHeight;
    }
  }, [detail?.messages.length, replayCursor]);

  const handleReplayToggle = () => {
    if (!detail || detail.messages.length === 0) return;
    if (isPlaying) {
      setIsPlaying(false);
    } else {
      if (replayCursor === null) {
        const first = detail.messages.reduce((min, m) => m.seq < min.seq ? m : min, detail.messages[0]!);
        setReplayCursor(first.seq);
      }
      setIsPlaying(true);
    }
  };

  const handleReplayStep = () => {
    if (!detail || detail.messages.length === 0) return;
    setIsPlaying(false);
    const sorted = [...detail.messages].sort((a, b) => a.seq - b.seq);
    if (replayCursor === null) {
      setReplayCursor(sorted[0]!.seq);
      return;
    }
    const nextIdx = sorted.findIndex((m) => m.seq > replayCursor);
    if (nextIdx !== -1) {
      setReplayCursor(sorted[nextIdx]!.seq);
    }
  };

  const handleReplayReset = () => {
    setIsPlaying(false);
    setReplayCursor(null);
    setHighlightSeatId(null);
  };

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
  const wide = width >= 1100;
  const seatLine = detail ? detail.seats.map((seat) => `${seat.title}${seat.providerId && seat.model ? ` (${seat.providerId}/${seat.model})` : ""}`).join(" · ") : "";
  const roster = detail ? (
    <>
      <div className="text-xs text-muted-foreground font-mono truncate">{seatLine}</div>
      {detail.agenda.length ? (
        <Disclosure compact summary={`${t("councilAgenda")} (${detail.agenda.length})`}>
          <ol className="list-decimal pl-5 text-xs font-mono max-h-28 overflow-y-auto">
            {detail.agenda.map((item) => <li key={item}>{item}</li>)}
          </ol>
        </Disclosure>
      ) : null}
    </>
  ) : null;
  return (
    <div ref={rootRef} className={`flex h-full min-h-0 min-w-0 flex-col overflow-hidden ${compact ? "gap-2 p-2" : "gap-3 p-4"}`} data-testid="council-page" data-council-layout={compact ? "compact" : "split"} data-bb-ru-skip>
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5 flex-1">
          <h1 className="shrink-0 text-base font-bold font-mono tracking-wide hidden sm:inline">[ {t("councilPageTitle")} ]</h1>
          <select className={`${SELECT_CLASS} min-w-0 flex-1 max-w-[16rem]`} value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value || null)} aria-label={t("councilPick")}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </div>
        {detail && detail.messages.length > 0 ? (
          <div className="flex items-center gap-1 shrink-0 font-mono text-xs">
            <button
              type="button"
              className="pixel-btn bg-amber-200 px-1.5 sm:px-2 py-1 text-slate-900 font-bold hover:bg-amber-100"
              onClick={handleReplayToggle}
              data-testid="council-replay-toggle"
            >
              {isPlaying ? `⏸` : `▶`}{compact ? "" : ` ${isPlaying ? t("councilReplayPause") : t("councilReplayPlay")}`}
            </button>
            <button
              type="button"
              className="pixel-btn bg-slate-200 px-1.5 sm:px-2 py-1 text-slate-900 font-bold hover:bg-slate-100"
              onClick={handleReplayStep}
              data-testid="council-replay-step"
            >
              ⏭{compact ? "" : ` ${t("councilReplayStep")}`}
            </button>
            {replayCursor !== null ? (
              <button
                type="button"
                className="pixel-btn bg-rose-200 px-1.5 sm:px-2 py-1 text-slate-900 font-bold hover:bg-rose-100"
                onClick={handleReplayReset}
                data-testid="council-replay-reset"
              >
                ⏹{compact ? "" : ` ${t("councilReplayReset")}`}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {!projects.length ? <p className="text-sm text-muted-foreground">{t("councilNoProjects")}</p> : null}
      {compact && councils.length ? (
        <select className={`${SELECT_CLASS} w-full min-w-0`} value={councilId ?? ""} onChange={(event) => setCouncilId(event.target.value || null)} aria-label={t("councilTitle")} data-testid="council-list">
          {councils.map((row) => <option key={row.id} value={row.id}>{`${t(`councilState_${row.state}` as never) || row.state} · ${row.question}`}</option>)}
        </select>
      ) : null}
      {projects.length > 0 && !detail ? <p className="text-sm text-muted-foreground">{t("councilEmpty")}</p> : null}
      {detail ? (
        <div className="flex min-h-0 min-w-0 flex-1 gap-3">
          {compact ? null : (
            <aside className="w-64 shrink-0 space-y-1 overflow-y-auto border-2 border-slate-900 bg-[var(--lp-well)] p-2 shadow-[2px_2px_0_#0f172a]" data-testid="council-list">
              {councils.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setCouncilId(row.id)}
                  aria-current={row.id === councilId ? "page" : undefined}
                  className={`block w-full border-2 p-2 text-left font-mono text-sm transition-all ${
                    row.id === councilId
                      ? "border-slate-900 bg-amber-100 shadow-[2px_2px_0_#0f172a] text-slate-900 font-bold"
                      : "border-transparent hover:border-slate-700 hover:bg-slate-100/50"
                  }`}
                >
                  <div className="line-clamp-2 break-words">{row.question}</div>
                  <div className="text-xs text-muted-foreground mt-1">
                    {t(`councilState_${row.state}` as never) || row.state} · {t("councilRound")} {row.round}
                  </div>
                </button>
              ))}
            </aside>
          )}
          <section className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden border-2 border-slate-900 bg-[var(--lp-card)] shadow-[4px_4px_0_#0f172a]">
            <header className="shrink-0 border-b-2 border-slate-900 bg-slate-50 p-2 sm:p-3" data-testid="council-header">
              <div className="text-sm font-bold font-mono text-slate-900 line-clamp-2">
                {detail.question}
              </div>
              {roster}
            </header>

            <div className={`flex min-h-0 min-w-0 flex-1 overflow-hidden ${wide ? "flex-row" : "flex-col"}`}>
              {/* Office Canvas Container */}
              <div
                className={`min-h-[200px] shrink-0 border-slate-900 ${
                  wide
                    ? "w-1/2 border-r-2"
                    : compact
                    ? "h-[35vh] min-h-[180px] border-b-2"
                    : "h-[42%] max-h-[280px] min-h-[200px] border-b-2"
                }`}
              >
                <CouncilOffice
                  detail={detail}
                  cursor={replayCursor}
                  highlightSeatId={highlightSeatId}
                  onSelectSpeaker={(id) => setHighlightSeatId(id === highlightSeatId ? null : id)}
                />
              </div>

              {/* Pixel-styled History Log & Composer */}
              <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-slate-100/30">
                <div
                  ref={feed}
                  className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto p-2 sm:p-3 [overflow-wrap:anywhere]"
                  data-testid="council-messages"
                >
                  {detail.messages.map((message) => {
                    const isCursor = replayCursor === message.seq;
                    const isSpeakerHighlighted = highlightSeatId === message.seatId;
                    const color = seatColor(message.seatId, detail.seats);

                    return (
                      <div
                        key={message.seq}
                        data-seq={message.seq}
                        onClick={() => {
                          setHighlightSeatId(message.seatId);
                          setReplayCursor(message.seq);
                        }}
                        className={`group relative min-w-0 cursor-pointer border-2 p-2.5 transition-all ${
                          isCursor
                            ? "border-amber-500 bg-amber-50/80 shadow-[2px_2px_0_#d97706]"
                            : isSpeakerHighlighted
                            ? "border-slate-900 bg-blue-50/80 shadow-[2px_2px_0_#0f172a]"
                            : message.seatId === "owner"
                            ? "border-rose-900/40 bg-rose-50/50 shadow-[1px_1px_0_#e11d48]"
                            : message.seatId === "moderator"
                            ? "border-slate-300 bg-slate-50 text-muted-foreground shadow-[1px_1px_0_#94a3b8]"
                            : "border-slate-900/60 bg-[var(--lp-card)] shadow-[1px_1px_0_#0f172a]"
                        }`}
                      >
                        <div className="flex items-center gap-2 mb-1.5">
                          <div
                            className="h-4 w-4 shrink-0 border border-slate-900 shadow-[1px_1px_0_#0f172a]"
                            style={{ backgroundColor: color }}
                          />
                          <span
                            className="font-mono text-xs font-bold uppercase tracking-wide"
                            style={{ color }}
                          >
                            {speakerName(detail, message.seatId)}
                          </span>
                          {message.seatId !== "owner" && message.round > 0 ? (
                            <span className="font-mono text-[10px] text-muted-foreground">
                              · {t("councilRound")} {message.round}
                            </span>
                          ) : null}
                          {message.kind === "status" ? (
                            <span className="font-mono text-[10px] bg-slate-200 px-1 text-slate-700">
                              · {t("councilStatusKind")}
                            </span>
                          ) : null}
                        </div>
                        <Markdown content={message.text} className={MARKDOWN_CLASS} />
                      </div>
                    );
                  })}

                  {detail.speaking ? (
                    <div className="font-mono text-xs text-amber-700 flex items-center gap-1.5 p-1" data-testid="council-typing">
                      <span className="animate-pulse font-bold text-sm">▮</span>
                      <span>{speakerName(detail, detail.speaking)} {t("councilTyping")}</span>
                    </div>
                  ) : null}

                  {detail.recommendation ? (
                    <div className="min-w-0 border-2 border-emerald-700 bg-emerald-50 p-2.5 text-sm shadow-[2px_2px_0_#047857]">
                      <div className="font-mono text-xs font-bold text-emerald-800 uppercase mb-1">
                        ★ {t("councilDecision")}
                      </div>
                      <Markdown content={detail.recommendation} className={MARKDOWN_CLASS} />
                      {detail.decisionPath ? (
                        <div className="mt-1 font-mono text-xs text-emerald-600">
                          {detail.decisionPath}
                        </div>
                      ) : null}
                    </div>
                  ) : null}

                  {detail.reason ? (
                    <div className="border-2 border-red-500 bg-red-50 p-2 font-mono text-xs text-red-700 shadow-[1px_1px_0_#ef4444]">
                      {detail.reason}
                    </div>
                  ) : null}
                </div>

                <footer className="flex shrink-0 flex-wrap gap-2 border-t-2 border-slate-900 bg-slate-50 p-2 sm:p-3" data-testid="council-composer">
                  <Input
                    className={`font-mono border-2 border-slate-900 rounded-none shadow-[2px_2px_0_#0f172a] ${
                      compact ? "min-w-0 basis-full" : "min-w-0 flex-1"
                    }`}
                    value={draft}
                    disabled={!running || busy}
                    placeholder={t("councilSayPlaceholder")}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void say();
                    }}
                    aria-label={t("councilSay")}
                  />
                  <Button
                    className={`pixel-btn rounded-none font-mono font-bold bg-amber-400 text-slate-900 hover:bg-amber-300 ${
                      compact ? "min-w-0 flex-1" : undefined
                    }`}
                    type="button"
                    size="sm"
                    disabled={!running || busy || !draft.trim()}
                    onClick={() => void say()}
                  >
                    {t("councilSay")}
                  </Button>
                  <Button
                    className={`pixel-btn rounded-none font-mono font-bold bg-white text-slate-900 hover:bg-slate-100 ${
                      compact ? "min-w-0 flex-1" : undefined
                    }`}
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={!running || busy}
                    onClick={() => void say(true)}
                  >
                    {t("councilDecide")}
                  </Button>
                  <Button
                    className={`pixel-btn rounded-none font-mono font-bold bg-rose-100 text-rose-900 hover:bg-rose-200 ${
                      compact ? "min-w-0 flex-1" : undefined
                    }`}
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={!running}
                    onClick={() => void stop()}
                  >
                    {t("councilStop")}
                  </Button>
                </footer>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
