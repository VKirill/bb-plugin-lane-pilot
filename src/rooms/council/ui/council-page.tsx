import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { Markdown, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { Disclosure } from "@lane-pilot/ui-kit";
import { useObservedWidth } from "@lane-pilot/ui-kit";
import { useLpRealtime } from "../../ui-shell/ui";
import { seatColor, stripMarkdown } from "./office-behaviour";

// The office (and three.js with it) loads only on the desktop layout, never below 1024 px.
const CouncilOffice = lazy(() => import("./council-office").then((module) => ({ default: module.CouncilOffice })));

type CouncilRow = { id: string; runId: string; question: string; state: string; round: number; maxRounds: number; decisionPath: string | null; updatedAt: number };
type CouncilDetail = {
  id: string; question: string; state: string; round: number; maxRounds: number; agenda: string[]; criteria: string[]; decisionPath: string | null; reason: string | null; recommendation: string | null;
  speaking: string | null; speakingSince: number | null;
  seats: Array<{ id: string; title: string; providerId: string | null; model: string | null }>;
  messages: Array<{ seq: number; seatId: string; round: number; kind: string; text: string; at: number }>;
};

const TERMINAL = new Set(["done", "failed", "stopped"]);
const PROJECT_KEY = "lane-pilot:council:project";
const DRAWER_KEY = "lane-pilot:council:drawer";
/** Below this block width the page is the chat only (layout.md §5). */
const DESKTOP_MIN = 1024;
const DRAWER_WIDE_MIN = 1280;
const DRAWER_WIDE = 380;
const DRAWER_NARROW = 340;
const CHAT_COLUMN_MAX = 720;
const EMPTY_OFFICE_DETAIL = { id: "", state: "", speaking: null, speakingSince: null, seats: [], messages: [] };
/** 16px text on phones keeps iOS from zooming into the native select. */
const SELECT_CLASS = "h-9 rounded-none border-2 border-slate-900 bg-[var(--lp-card)] px-2 font-mono text-base shadow-[2px_2px_0_#0f172a] sm:h-8 sm:text-sm";
/** Long code, tables and paths scroll inside the message instead of widening the page. */
const MARKDOWN_CLASS = "min-w-0 text-sm font-sans [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";
const PIXEL_CARD = "border-2 border-slate-900 bg-[var(--lp-card)] shadow-[4px_4px_0_#0f172a]";

function speakerName(detail: CouncilDetail, seatId: string): string {
  if (seatId === "owner") return t("councilOwner");
  if (seatId === "chair") return t("councilChair");
  if (seatId === "moderator") return t("councilModerator");
  return detail.seats.find((seat) => seat.id === seatId)?.title ?? seatId;
}

function readDrawerOpen(): boolean {
  return typeof localStorage !== "undefined" && localStorage.getItem(DRAWER_KEY) === "open";
}

/** The boardroom: on desktop the office floor with a chat drawer, below 1024 px the same council as a chat page. */
export function CouncilPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([]);
  const [projectId, setProjectId] = useState<string | null>(() => (typeof localStorage === "undefined" ? null : localStorage.getItem(PROJECT_KEY)));
  const [councils, setCouncils] = useState<CouncilRow[]>([]);
  const [councilId, setCouncilId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CouncilDetail | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState<boolean>(readDrawerOpen);
  const [decisionOpen, setDecisionOpen] = useState(false);

  // Replay & Inspection State
  const [replayCursor, setReplayCursor] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [highlightSeatId, setHighlightSeatId] = useState<string | null>(null);

  const feed = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const width = useObservedWidth(rootRef);
  const desktop = width >= DESKTOP_MIN;
  const drawerWidth = width >= DRAWER_WIDE_MIN ? DRAWER_WIDE : DRAWER_NARROW;

  useEffect(() => {
    if (typeof localStorage !== "undefined") localStorage.setItem(DRAWER_KEY, drawerOpen ? "open" : "closed");
  }, [drawerOpen]);

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
    setDecisionOpen(false);
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
  }, [detail?.messages.length, replayCursor, drawerOpen, desktop]);

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
  const compact = !desktop;
  const hasDecision = Boolean(detail && (detail.recommendation || detail.reason));

  const selectSpeaker = (seatId: string) => setHighlightSeatId((current) => (current === seatId ? null : seatId));

  // ---- Shared pieces: the top bar, the header, the decision, the feed and the composer ----

  const topBar = (
    <div className="flex h-11 min-w-0 items-center gap-1.5 border-2 border-slate-900 bg-[var(--lp-card)] px-2 shadow-[2px_2px_0_#0f172a]" data-testid="council-topbar">
      {desktop && width >= DRAWER_WIDE_MIN ? (
        <h1 className="shrink-0 text-sm font-bold font-mono tracking-wide">[ {t("councilPageTitle")} ]</h1>
      ) : null}
      <select className={`${SELECT_CLASS} min-w-0 max-w-[10rem] shrink ${compact ? "max-w-[12rem]" : ""}`} value={projectId ?? ""} onChange={(event) => setProjectId(event.target.value || null)} aria-label={t("councilPick")}>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      {councils.length ? (
        <select className={`${SELECT_CLASS} min-w-0 flex-1`} value={councilId ?? ""} onChange={(event) => setCouncilId(event.target.value || null)} aria-label={t("councilTitle")} data-testid="council-list">
          {councils.map((row) => <option key={row.id} value={row.id}>{`${t(`councilState_${row.state}` as never) || row.state} · ${row.question}`}</option>)}
        </select>
      ) : (
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={t("councilEmpty")}>{projects.length ? t("councilEmpty") : ""}</span>
      )}
      {detail ? (
        <span className={`hidden shrink-0 border border-slate-900 px-1.5 py-0.5 font-mono text-[11px] font-bold sm:inline ${running ? "bg-amber-200 animate-pulse" : detail.state === "done" ? "bg-emerald-200" : "bg-rose-200"}`}>
          {t(`councilState_${detail.state}` as never) || detail.state} · {detail.round}/{detail.maxRounds}
        </span>
      ) : null}
      {detail && detail.messages.length > 0 ? (
        <div className="flex shrink-0 items-center gap-1 font-mono text-xs">
          <button type="button" className="pixel-btn bg-amber-200 px-1.5 py-1 text-slate-900 font-bold hover:bg-amber-100" onClick={handleReplayToggle} data-testid="council-replay-toggle">
            {isPlaying ? `⏸` : `▶`}{compact ? "" : ` ${isPlaying ? t("councilReplayPause") : t("councilReplayPlay")}`}
          </button>
          <button type="button" className="pixel-btn bg-slate-200 px-1.5 py-1 text-slate-900 font-bold hover:bg-slate-100" onClick={handleReplayStep} data-testid="council-replay-step">
            ⏭{compact ? "" : ` ${t("councilReplayStep")}`}
          </button>
          {replayCursor !== null ? (
            <button type="button" className="pixel-btn bg-rose-200 px-1.5 py-1 text-slate-900 font-bold hover:bg-rose-100" onClick={handleReplayReset} data-testid="council-replay-reset">
              ⏹{compact ? "" : ` ${t("councilReplayReset")}`}
            </button>
          ) : null}
        </div>
      ) : null}
      {desktop ? (
        <button
          type="button"
          className="pixel-btn shrink-0 bg-white px-1.5 py-1 font-mono text-xs font-bold text-slate-900 hover:bg-slate-100"
          onClick={() => setDrawerOpen((open) => !open)}
          aria-pressed={drawerOpen}
          data-testid="council-drawer-toggle"
        >
          💬 {detail?.messages.length ?? 0}
        </button>
      ) : null}
    </div>
  );

  const header = detail ? (
    <header className="shrink-0 border-2 border-slate-900 bg-slate-50 p-2 shadow-[2px_2px_0_#0f172a]" data-testid="council-header">
      <div className="text-sm font-bold font-mono text-slate-900 line-clamp-3">{detail.question}</div>
    </header>
  ) : null;

  const decisionPanel = detail && hasDecision ? (
    <div className={`shrink-0 min-w-0 border-2 p-2 text-sm shadow-[2px_2px_0_#0f172a] ${detail.reason ? "border-red-500 bg-red-50" : "border-emerald-700 bg-emerald-50"}`} data-testid="council-decision">
      <div className="flex items-center justify-between gap-2">
        <span className={`font-mono text-xs font-bold uppercase ${detail.reason ? "text-red-700" : "text-emerald-800"}`}>★ {t("councilDecision")}</span>
        <button type="button" className="font-mono text-xs" onClick={() => setDecisionOpen((open) => !open)} aria-expanded={decisionOpen}>{decisionOpen ? "▴" : "▾"}</button>
      </div>
      <div className={`mt-1 min-w-0 overflow-y-auto ${decisionOpen ? "max-h-[40%]" : "max-h-16 overflow-hidden"}`}>
        {detail.reason ? <div className="font-mono text-xs text-red-700">{detail.reason}</div> : null}
        {detail.recommendation ? <Markdown content={detail.recommendation} className={MARKDOWN_CLASS} /> : null}
      </div>
      {detail.decisionPath ? <div className="mt-1 font-mono text-xs text-emerald-700">{detail.decisionPath}</div> : null}
    </div>
  ) : null;

  const disclosures = detail ? (
    <div className="flex shrink-0 flex-col gap-1">
      {detail.agenda.length ? (
        <Disclosure compact summary={`${t("councilAgenda")} (${detail.agenda.length})`}>
          <ol className="list-decimal pl-5 text-xs font-mono max-h-28 overflow-y-auto">
            {detail.agenda.map((item) => <li key={item}>{item}</li>)}
          </ol>
        </Disclosure>
      ) : null}
      <Disclosure compact summary={`${detail.seats.length}`} testId="council-seats">
        <ul className="space-y-1 text-xs font-mono">
          {detail.seats.map((seat) => (
            <li key={seat.id}>
              <button
                type="button"
                onClick={() => selectSpeaker(seat.id)}
                className={`flex w-full min-w-0 items-center gap-2 border p-1 text-left ${highlightSeatId === seat.id ? "border-slate-900 bg-blue-50" : "border-transparent hover:border-slate-400"}`}
              >
                <span className="h-3 w-3 shrink-0 border border-slate-900" style={{ backgroundColor: seatColor(seat.id, detail.seats) }} />
                <span className="min-w-0 truncate">{seat.title}</span>
                {seat.providerId && seat.model ? <span className="min-w-0 truncate text-muted-foreground">{seat.providerId}/{seat.model}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      </Disclosure>
    </div>
  ) : null;

  const feedList = detail ? (
    <div ref={feed} className="min-h-0 min-w-0 flex-1 space-y-2 overflow-y-auto p-2 [overflow-wrap:anywhere]" data-testid="council-messages">
      {detail.messages.map((message) => {
        const isCursor = replayCursor === message.seq;
        const isSpeakerHighlighted = highlightSeatId === message.seatId;
        const color = seatColor(message.seatId, detail.seats);
        const isDimmed = replayCursor !== null && message.seq > replayCursor;

        return (
          <div
            key={message.seq}
            data-seq={message.seq}
            onClick={() => {
              setHighlightSeatId(message.seatId);
              setReplayCursor(message.seq);
            }}
            className={`group relative min-w-0 cursor-pointer border-2 p-2 transition-all ${isDimmed ? "opacity-40" : ""} ${
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
            <div className="flex items-center gap-2 mb-1">
              <div className="h-3.5 w-3.5 shrink-0 border border-slate-900 shadow-[1px_1px_0_#0f172a]" style={{ backgroundColor: color }} />
              <span className="font-mono text-[11px] font-bold uppercase tracking-wide" style={{ color }}>
                {speakerName(detail, message.seatId)}
              </span>
              {message.seatId !== "owner" && message.round > 0 ? (
                <span className="font-mono text-[10px] text-muted-foreground">· {t("councilRound")} {message.round}</span>
              ) : null}
              {message.kind === "status" ? (
                <span className="font-mono text-[10px] bg-slate-200 px-1 text-slate-700">· {t("councilStatusKind")}</span>
              ) : null}
              {isCursor ? <span className="ml-auto font-mono text-[10px] font-bold text-amber-700">⏵</span> : null}
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
    </div>
  ) : null;

  const composer = detail ? (
    <footer className="flex shrink-0 flex-wrap gap-2 border-t-2 border-slate-900 bg-slate-50 p-2" data-testid="council-composer">
      {running ? (
        <>
          <Input
            className="font-mono border-2 border-slate-900 rounded-none shadow-[2px_2px_0_#0f172a] min-w-0 basis-full"
            value={draft}
            disabled={busy}
            placeholder={t("councilSayPlaceholder")}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void say();
            }}
            aria-label={t("councilSay")}
          />
          <Button className="pixel-btn rounded-none font-mono font-bold bg-amber-400 text-slate-900 hover:bg-amber-300 min-w-0 flex-1" type="button" size="sm" disabled={busy || !draft.trim()} onClick={() => void say()}>
            {t("councilSay")}
          </Button>
          <Button className="pixel-btn rounded-none font-mono font-bold bg-white text-slate-900 hover:bg-slate-100 min-w-0 flex-1" type="button" size="sm" variant="outline" disabled={busy} onClick={() => void say(true)}>
            {t("councilDecide")}
          </Button>
          <Button className="pixel-btn rounded-none font-mono font-bold bg-rose-100 text-rose-900 hover:bg-rose-200 min-w-0 flex-1" type="button" size="sm" variant="ghost" onClick={() => void stop()}>
            {t("councilStop")}
          </Button>
        </>
      ) : (
        <div className="font-mono text-xs text-muted-foreground">{t(`councilState_${detail.state}` as never) || detail.state}</div>
      )}
    </footer>
  ) : null;

  // ---- Desktop: the office is the page; the drawer docks on the right, the top bar floats ----

  const drawerPanel = detail && drawerOpen ? (
    <section className={`absolute bottom-2 right-2 top-2 z-40 flex min-h-0 flex-col ${PIXEL_CARD}`} style={{ width: drawerWidth }} data-testid="council-drawer">
      <div className="flex shrink-0 items-start gap-2 border-b-2 border-slate-900 p-2">
        <div className="min-w-0 flex-1">{header}</div>
        <button type="button" className="pixel-btn shrink-0 bg-white px-2 py-1 font-mono text-xs font-bold" onClick={() => setDrawerOpen(false)}>✕</button>
      </div>
      {decisionPanel ? <div className="shrink-0 p-2">{decisionPanel}</div> : null}
      <div className="shrink-0 space-y-1 p-2">{disclosures}</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-100/30">{feedList}</div>
      {composer}
    </section>
  ) : null;

  const peek = detail && !drawerOpen ? (() => {
    const last = detail.messages[detail.messages.length - 1];
    return (
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className={`absolute bottom-2 right-2 z-30 w-[320px] max-w-[calc(100%-16px)] p-2 text-left ${PIXEL_CARD}`}
        data-testid="council-peek"
      >
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 shrink-0 border border-slate-900" style={{ backgroundColor: last ? seatColor(last.seatId, detail.seats) : "#94a3b8" }} />
          <span className="min-w-0 truncate font-mono text-[11px] font-bold uppercase">{last ? speakerName(detail, last.seatId) : t("councilEmpty")}</span>
          {detail.recommendation ? <span className="shrink-0 font-mono text-[10px] font-bold text-emerald-700">★ {t("councilDecision")}</span> : null}
          <span className="ml-auto shrink-0 font-mono text-[11px]">💬 {detail.messages.length} ›</span>
        </div>
        <div className="mt-1 line-clamp-2 text-xs">{last ? stripMarkdown(last.text) : ""}</div>
        {detail.speaking ? <div className="mt-1 font-mono text-[11px] text-amber-700">▮ {speakerName(detail, detail.speaking)} {t("councilTyping")}</div> : null}
      </button>
    );
  })() : null;

  // ---- Chat page (< 1024): one column, the feed is the only scrolling part ----

  const chatPage = (
    <div className={`flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-hidden ${width > 0 && width < 640 ? "p-2" : "p-4"}`} style={{ maxWidth: width >= 640 ? CHAT_COLUMN_MAX : undefined, width: "100%", margin: "0 auto" }}>
      {header}
      {decisionPanel}
      {disclosures}
      <section className={`flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden ${PIXEL_CARD}`}>
        {feedList}
        {composer}
      </section>
    </div>
  );

  return (
    <div ref={rootRef} className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden" data-testid="council-page" data-council-layout={desktop ? "desktop" : "chat"} data-bb-ru-skip>
      {desktop ? (
        <>
          <div className="absolute inset-y-0 left-0" style={{ right: drawerOpen && detail ? drawerWidth + 16 : 0 }}>
            {detail ? (
              <Suspense fallback={null}>
                <CouncilOffice
                  detail={detail}
                  cursor={replayCursor}
                  highlightSeatId={highlightSeatId}
                  onSelectSpeaker={selectSpeaker}
                />
              </Suspense>
            ) : (
              <Suspense fallback={null}>
                <CouncilOffice
                  detail={EMPTY_OFFICE_DETAIL}
                  cursor={null}
                  highlightSeatId={null}
                />
              </Suspense>
            )}
          </div>
          <div className="absolute left-2 top-2 z-30" style={{ right: drawerOpen && detail ? drawerWidth + 16 : 8 }}>
            {topBar}
          </div>
          {!projects.length ? <p className="absolute left-3 top-16 z-30 bg-[var(--lp-card)] px-2 text-sm text-muted-foreground">{t("councilNoProjects")}</p> : null}
          {drawerPanel}
          {peek}
        </>
      ) : (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 px-2 pt-2" style={{ maxWidth: width >= 640 ? CHAT_COLUMN_MAX : undefined, width: "100%", margin: "0 auto" }}>
            {topBar}
          </div>
          {!projects.length ? <p className="p-4 text-sm text-muted-foreground">{t("councilNoProjects")}</p> : null}
          {projects.length > 0 && !detail ? <p className="p-4 text-sm text-muted-foreground">{t("councilEmpty")}</p> : null}
          {chatPage}
        </div>
      )}
    </div>
  );
}
