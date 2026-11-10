import { useCallback, useEffect, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { Badge, Button, useMediaQuery } from "@lane-pilot/ui-kit";
import { Field, Panel, fill, useCockpitRpc, useLoad, useSeen, type Rpc } from "./kit";
import { SCREENS, screenFor, searchCockpit, startScreen, type ScreenId } from "./registry";
import { PhasesScreen, TasksScreen } from "./screens-work";
import { MoneyScreen, TodayScreen, WorkersScreen } from "./screens-day";
import { CoordScreen, FirstRunScreen, ForgeScreen, MemoryScreen, ShipScreen, SystemScreen } from "./screens-ops";
import { useLpRpcQuery } from "../../ui-shell/ui";

const PROJECT_KEY = "lane-pilot:cockpit:project";
const PING_MS = 15_000;

type Screen = { hostId: string | null; runs: Array<{ id: string; state: string }> };

/**
 * The cockpit: the window's screens of the SMA map in one page (src/rooms/cockpit/ui/registry.ts). The selected project in the window, the
 * bell «awaits a decision», the door's pulse (a silent hub is said, not a blank page), the signed-out banner of the owner door, a screen
 * opened by its path or by an event, a wide-only screen said on a phone, and a fault reported from any screen.
 */
/** The selected project in the window (SMA ws_selected_project): a choice is written only after the server answered for it. */
export function useProjectChoice(rpc: Rpc) {
  const [projectId, setProjectId] = useState<string>(() => (typeof localStorage === "undefined" ? "" : localStorage.getItem(PROJECT_KEY) ?? ""));
  const [error, setError] = useState<string | null>(null);
  const choose = useCallback((id: string) =>
    rpc.call("get_screen", { projectId: id, runsLimit: 5 }).then(() => { setProjectId(id); setError(null); },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause))), [rpc]);
  return { projectId, setProjectId, choose, error };
}

export function CockpitPage({ subPath = "" }: { subPath?: string }) {
  const rpc = useCockpitRpc();
  const navigate = useBbNavigate();
  const wide = useMediaQuery("(min-width: 1024px)");
  const [route, setRoute] = useState(() => screenFor(subPath));
  useEffect(() => setRoute(screenFor(subPath)), [subPath]);
  const projects = useLoad(() => rpc.call("list_projects", {}).then((result) => result.projects), []);
  const { projectId, setProjectId, choose, error: projectError } = useProjectChoice(rpc);
  useEffect(() => { if (!projectId && projects.data?.[0]) setProjectId(projects.data[0].id); }, [projectId, projects.data, setProjectId]);
  const screen = useLoad(() => (projectId ? rpc.call("get_screen", { projectId, runsLimit: 5 }) as unknown as Promise<Screen> : Promise.resolve(null)), [projectId]);
  // The server answered for this project: only now is the choice remembered.
  useEffect(() => { if (projectId && screen.data && !screen.error) localStorage.setItem(PROJECT_KEY, projectId); }, [projectId, screen.data, screen.error]);
  const firstRun = useLoad(() => (projectId ? rpc.call("first_run_get", { projectId }) as Promise<{ needed: boolean }> : Promise.resolve(null)), [projectId]);
  // On a project never set up the first-run interview stands in front once; a real path is never overridden (SMA first run).
  useEffect(() => {
    if (!firstRun.data) return;
    const start = startScreen(subPath, firstRun.data);
    if (start !== route.id && start !== "building") open(start);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstRun.data, subPath]);
  const runId = screen.data?.runs.find((run) => run.state === "running" || run.state === "pending")?.id ?? screen.data?.runs[0]?.id ?? null;
  const hostId = screen.data?.hostId ?? null;
  const waiting = useLoad(() => rpc.call("owner_waiting", {}) as Promise<{ items?: unknown[] } | unknown[]>, []);
  const waitingCount = Array.isArray(waiting.data) ? waiting.data.length : (waiting.data as { items?: unknown[] } | null)?.items?.length ?? 0;
  const [silent, setSilent] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  const ping = useLpRpcQuery("world_version", {}, { pollMs: PING_MS });
  useEffect(() => { setSilent(ping.error != null); }, [ping.error]);
  useEffect(() => {
    // Signed out: with the owner door on (core vk owner-auth), its status says whether this browser holds the owner's session.
    void fetch("/api/v1/vk/owner/status").then((answer) => (answer.ok ? answer.json() : null)).then((status: { enforced?: boolean; owner?: boolean } | null) => setSignedOut(Boolean(status?.enforced && !status.owner))).catch(() => undefined);
  }, []);
  const open = (id: ScreenId) => { setRoute({ id, param: null }); navigate.toPluginPanel("lane-pilot-cockpit", { subPath: id }); };
  const meta = SCREENS.find((row) => row.id === route.id);
  return (
    <div className="mx-auto max-w-5xl space-y-3 p-3 sm:p-4" data-bb-plugin="lane-pilot" data-testid="cockpit">
      <header className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-base font-semibold">{t("ckTitle")}</h2>
        <select aria-label={t("ckProject")} className="h-8 max-w-56 rounded border border-border bg-background px-1 text-base sm:text-sm" value={projectId} onChange={(e) => void choose(e.target.value)} data-testid="ck-project">
          {(projects.data ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>
        {projectError ? <span className="text-xs text-destructive" role="alert" data-testid="ck-project-error">{t("ckProjectFailed")}</span> : null}
        {/* «Найти экран или работу»: the cockpit's own palette over its screens, phases and tasks. */}
        <CockpitSearch rpc={rpc} projectId={projectId} onOpen={open} />
        {/* The bell «awaits a decision»: what only the owner decides, counted. */}
        <Badge variant={waitingCount ? "default" : "outline"} data-testid="ck-bell">{fill("ckBell", { n: waitingCount })}</Badge>
      </header>
      {silent ? <p className="rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-sm" role="status" data-testid="ck-door-silent">{t("ckDoorSilent")}</p> : null}
      {signedOut ? <p className="rounded-md border border-destructive/50 bg-destructive/10 px-2 py-1 text-sm" role="status" data-testid="ck-signed-out">{t("ckSignedOut")}</p> : null}
      <nav className="flex gap-1 overflow-x-auto pb-1" aria-label={t("ckScreen_registry")}>
        {SCREENS.map((row) => <Button key={row.id} size="sm" variant={route.id === row.id ? "default" : "ghost"} className="shrink-0" onClick={() => open(row.id)}>{t(row.title)}</Button>)}
      </nav>
      {firstRun.data?.needed && route.id !== "firstrun" ? (
        <p className="flex items-center gap-2 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-1 text-sm" role="status" data-testid="ck-first-run-banner">
          {t("ckFirstRunBanner")} <Button size="sm" variant="outline" onClick={() => open("firstrun")}>{t("ckScreen_firstrun")}</Button>
        </p>
      ) : null}
      {meta?.wide && !wide ? <p className="text-sm text-muted-foreground" data-testid="ck-wide-only">{t("ckWideOnly")}</p> : null}
      {!projectId ? <p className="text-sm text-muted-foreground">{t("ckLoading")}</p> : <ScreenBody id={route.id} rpc={rpc} projectId={projectId} runId={runId} hostId={hostId} onOpen={open} />}
      <FaultForm screen={route.id} />
    </div>
  );
}

function ScreenBody({ id, rpc, projectId, runId, hostId, onOpen }: { id: ScreenId | "building"; rpc: ReturnType<typeof useCockpitRpc>; projectId: string; runId: string | null; hostId: string | null; onOpen: (id: ScreenId) => void }) {
  useSeen(rpc, id);
  switch (id) {
    case "home": return <HomeScreen onOpen={onOpen} />;
    case "phases": return <PhasesScreen rpc={rpc} projectId={projectId} />;
    case "today": return <TodayScreen rpc={rpc} projectId={projectId} />;
    case "tasks": return <TasksScreen rpc={rpc} projectId={projectId} runId={runId} hostId={hostId} />;
    case "money": return <MoneyScreen rpc={rpc} hostId={hostId} />;
    case "workers": return <WorkersScreen rpc={rpc} projectId={projectId} />;
    case "forge": return <ForgeScreen rpc={rpc} projectId={projectId} runId={runId} />;
    case "memory": return <MemoryScreen rpc={rpc} runId={runId} projectId={projectId} />;
    case "firstrun": return <FirstRunScreen rpc={rpc} projectId={projectId} />;
    case "coord": return <CoordScreen rpc={rpc} runId={runId} />;
    case "ship": return <ShipScreen rpc={rpc} projectId={projectId} hostId={hostId} />;
    case "system": return <SystemScreen rpc={rpc} projectId={projectId} />;
    case "registry": return <RegistryScreen onOpen={onOpen} />;
    default: return <Panel title={t("ckBuilding")} testId="ck-building"><p className="text-sm text-muted-foreground">{t("ckBuilding")}</p></Panel>;
  }
}

/** System home: every screen, one tap away. */
function HomeScreen({ onOpen }: { onOpen: (id: ScreenId) => void }) {
  return (
    <Panel title={t("ckScreen_home")} testId="ck-home">
      <p className="text-sm text-muted-foreground">{t("ckHomeLead")}</p>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">{SCREENS.filter((row) => row.id !== "home").map((row) => <Button key={row.id} variant="outline" onClick={() => onOpen(row.id)}>{t(row.title)}</Button>)}</div>
    </Panel>
  );
}

/** «Найти экран или работу» (SMA palette): one field over the screens, the phases and the tasks of the chosen project; Enter opens the first hit. */
function CockpitSearch({ rpc, projectId, onOpen }: { rpc: Rpc; projectId: string; onOpen: (id: ScreenId) => void }) {
  const [query, setQuery] = useState("");
  const phases = useLoad(() => (projectId && query.trim() ? rpc.call("phase_list", { projectId }) as Promise<Array<{ id: string; title: string }>> : Promise.resolve([])), [projectId, query]);
  const board = useLoad(() => (projectId && query.trim() ? rpc.call("task_board", { projectId, doneHours: 24 * 30 }) as Promise<{ items: Array<{ taskId: string | null; title: string }> }> : Promise.resolve({ items: [] })), [projectId, query]);
  const hits = searchCockpit(query, { phases: phases.data ?? [], tasks: (board.data?.items ?? []).filter((row) => row.taskId).map((row) => ({ id: row.taskId!, title: row.title })) });
  const go = (hit: (typeof hits)[number] | undefined) => hit && onOpen(hit.kind === "screen" ? hit.id as ScreenId : hit.kind === "phase" ? "phases" : "tasks");
  return (
    <span className="relative">
      <input aria-label={t("ckSearch")} placeholder={t("ckSearch")} className="h-8 w-48 rounded border border-border bg-background px-2 text-base sm:text-sm" value={query}
        onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") go(hits[0]); }} data-testid="ck-search" />
      {query.trim() ? (
        <ul className="absolute right-0 z-10 mt-1 max-h-60 w-64 overflow-auto rounded-md border border-border bg-background p-1 text-sm shadow" data-testid="ck-search-hits">
          {hits.map((hit) => <li key={`${hit.kind}-${hit.id}`}><button type="button" className="w-full rounded px-2 py-1 text-left hover:bg-muted" onClick={() => go(hit)}>{hit.title} <span className="text-xs text-muted-foreground">{hit.kind}</span></button></li>)}
        </ul>
      ) : null}
    </span>
  );
}

/** The screen registry: each screen, whether it needs a wide window, the events that open it. */
function RegistryScreen({ onOpen }: { onOpen: (id: ScreenId) => void }) {
  return (
    <Panel title={t("ckScreen_registry")} testId="ck-registry">
      <ul className="space-y-1 text-sm">{SCREENS.map((row) => <li key={row.id}><button type="button" className="hover:underline" onClick={() => onOpen(row.id)}>{t(row.title)}</button> <span className="text-xs text-muted-foreground">{row.id}{row.wide ? " · wide" : ""}{row.events.length ? ` · event/${row.events.join(", event/")}` : ""}</span></li>)}</ul>
    </Panel>
  );
}

/** Report a fault: prepares a tracker issue with version and platform for the person to copy; it sends nothing (SMA feedback). */
function FaultForm({ screen }: { screen: string }) {
  const rpc = useCockpitRpc();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [issue, setIssue] = useState<{ title: string; body: string } | null>(null);
  if (!open) return <div className="text-right"><Button size="sm" variant="ghost" onClick={() => { setOpen(true); setIssue(null); }} data-testid="ck-report-fault">{t("ckReportFault")}</Button></div>;
  if (issue) return (
    <Panel title={t("ckReportFault")} testId="ck-fault">
      <div className="space-y-2 text-sm" data-testid="ck-fault-issue">
        <p><span className="font-medium">{t("ckIssueTitle")}:</span> {issue.title}</p>
        <p className="font-medium">{t("ckIssueBody")}:</p>
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded bg-muted p-2 text-xs">{issue.body}</pre>
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void navigator.clipboard?.writeText(`${issue.title}\n\n${issue.body}`).catch(() => undefined)}>{t("ckCopy")}</Button>
          <span className="text-xs text-muted-foreground">{t("ckNothingSent")}</span>
        </div>
      </div>
    </Panel>
  );
  return (
    <Panel title={t("ckReportFault")} testId="ck-fault">
      <Field label={t("ckFaultPlaceholder")} value={text} onChange={setText} multiline />
      <Button size="sm" disabled={text.trim().length < 3} onClick={() => void rpc.call("cockpit_fault", { screen, text }).then((result) => { setIssue(result as { title: string; body: string }); setText(""); })}>{t("ckSend")}</Button>
    </Panel>
  );
}
