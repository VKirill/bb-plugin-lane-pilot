import { readHiddenProjects, splitProjects, writeHiddenProjects } from "./service-projects";
import { resolveLegacyRoute, type ConsoleRoute } from "../models/nav-model";
import { resolveTab, SEGMENTS, type SegmentedTab, type TabId } from "../models/tabs-model";
import { selectionValue, SELECTION_SPECS, type SelectionId } from "./picker-selections";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useProviders as useProviders,
  useBbContext,
  useRpc,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { userVisibleProjects } from "../../contracts/project-scope";
import { GLOBAL_SETTINGS_PROJECT_ID, SECTION_ORDER, type CatalogRow } from "@lane-pilot/settings-catalog";
import { SETTINGS_REGISTRY } from "../../settings-registry";
import {
  t,
  setLocaleOverride,
  detectLocale,
  detectLocaleHint,
  subscribeToLocaleHintChanges,
  type I18nKey,
  type Locale,
  type LocalePreference,
} from "@lane-pilot/i18n";
import { Button, chromeIsCompact, contentStacksControls, useObservedWidth } from "@lane-pilot/ui-kit";
import { ScreenPayload, useLpPoll, useLpRealtime } from "../../ui-shell/ui";
import { readRunsWindow } from "../../runs/ui";
import { BASIC_SETTING_KEYS, RoutingStats, WRITER_EFFORT, WRITER_MODEL, WRITER_PROVIDER, WRITER_SERVICE_TIER, diagnosticRows, extraSettingRows } from "./page-model";
import { useLpPageSavers } from "./use-lp-page-savers";

export function useLanePilotPage({
  subPath = "",
  scope = "projects",
  consoleRoute,
  onNavigate,
}: {
  subPath?: string;
  scope?: "projects" | "globals" | "agents" | "tokens" | "workflows" | "schedule" | "tasks" | "waiting" | "errands";
  consoleRoute?: ConsoleRoute;
  onNavigate?: (next: ConsoleRoute) => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId: routeProjectId, threadId: routeThreadId } = useBbContext();
  // The plugin's own page (no project in the route, no project link) opens on «General settings», not on the last project (owner's word 2026-11-01).
  const [activeScope, setActiveScope] = useState(scope === "projects" && !subPath && !routeProjectId ? "globals" : scope);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // The address may carry a tab after the project id (`<project>/<tab>`; «access» is the team's old name), so a link can open a tab of a project.
  const [routeProject, routeTab] = (() => { const [head, rest] = subPath.replace(/^\/+/, "").split("/", 2); return [head || null, rest || null]; })();
  const consoleNeedsSettings =
    consoleRoute?.section === "system" &&
    (consoleRoute.page === "settings" || consoleRoute.page === "agents" || consoleRoute.page === "health");
  // «Общие настройки» edit the global level every project inherits, with the same panel as a project.
  const projectId = consoleRoute
    ? (consoleRoute.projectId ?? (consoleNeedsSettings ? GLOBAL_SETTINGS_PROJECT_ID : null))
    : (activeScope === "globals" ? GLOBAL_SETTINGS_PROJECT_ID : selectedProjectId ?? routeProjectId ?? routeProject);
  const isGlobal = projectId === GLOBAL_SETTINGS_PROJECT_ID;
  // The project screen (get_screen and everything it feeds) is what «Projects» and «General settings» show; other views must not pay for it.
  const projectScreenActive = consoleRoute
    ? (consoleRoute.section === "overview" && Boolean(consoleRoute.projectId)) || consoleNeedsSettings
    : (activeScope === "projects" || activeScope === "globals");
  // A section keeps its own settings over its project's; null edits the project itself.
  const [rawSelectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const selectedSectionId = consoleRoute ? (consoleRoute.sectionId ?? null) : rawSelectedSectionId;
  const [routingStats, setRoutingStats] = useState<RoutingStats | null>(null);
  // Only a change the owner made by hand is saved: the picker reports a normalized value on mount.
  const fallbackTouched = useRef(new Set<number>());
  const [sections, setSections] = useState<Array<{ id:string; parentId:string|null; name:string; path:string; kind:"folder"|"group" }>>([]);
  const scoped = selectedSectionId ? { sectionId: selectedSectionId } : {};
  const cacheKey = (id: string, section: string | null | undefined) => `${id}|${section ?? ""}`;
  const [projects, setProjects] = useState<Array<{ id:string; name:string; kind?:string }>>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectListError, setProjectListError] = useState(false);
  const providers = useProviders();
  const routeTarget = resolveTab(routeTab ?? "");
  const [tab, setTab] = useState<TabId>(routeTarget.tab);
  // The part of a segmented tab that is open (the tabs that have segments: knowledge, automation, runs).
  const [segments, setSegments] = useState<Record<string, string>>({ knowledge: "memory", automation: "workflows", runs: "board",
    ...(routeTarget.segment && routeTarget.tab in SEGMENTS ? { [routeTarget.tab]: routeTarget.segment } : {}) });
  const segmentOf = (id: SegmentedTab) => segments[id] ?? SEGMENTS[id][0];
  const setSegment = (id: SegmentedTab, next: string) => setSegments((current) => ({ ...current, [id]: next }));
  /** Opens a tab, and a part of it. Ids of the old ten tabs work too. */
  const goTo = (id: string, segment?: string) => {
    const target = resolveTab(id);
    const part = segment ?? target.segment;
    if (onNavigate && consoleRoute) {
      const legacy = resolveLegacyRoute(part ? `${target.tab}/${part}` : target.tab);
      if (legacy) {
        onNavigate({ ...legacy, projectId: consoleRoute.projectId, sectionId: consoleRoute.sectionId });
        return;
      }
    }
    setTab(target.tab);
    if (part && target.tab in SEGMENTS) setSegment(target.tab as SegmentedTab, part);
  };
  // A tab mounts when it is first opened and stays mounted after that: ten tabs at once cost 25 000 DOM nodes on a big project.
  const visited = useRef(new Set<string>());
  visited.current.add(tab);
  // How many of the newest runs the screen has fetched; the rest of the history comes by `list_runs` pages.
  const runsWindow = useRef(0);
  const [nativeState, setNativeState] = useState<{ status: string; error: string | null } | null>(null);
  const [data, setData] = useState<ScreenPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingOp, setPendingOp] = useState<"install" | "connect" | "rollback" | null>(null);
  const [snapshotPath, setSnapshotPath] = useState("");
  const [resultPatch, setResultPatch] = useState<string | null>(null);
  const [resultSource, setResultSource] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>(detectLocale);
  const [localePreference, setLocalePreference] = useState<LocalePreference>("auto");
  const [settingsDepth, setSettingsDepth] = useState<"basic" | "advanced">("basic");
  const shellRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const shellWidth = useObservedWidth(shellRef);
  const contentWidth = useObservedWidth(contentRef);
  const compactChrome = chromeIsCompact(shellWidth);
  const stackControls = contentStacksControls(contentWidth);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const dataRef = useRef<ScreenPayload | null>(null);
  const draftsRef = useRef<Record<string, unknown>>({});
  const writerDraftRef = useRef<ExperimentalProviderModelPickerValue | null>(null);
  const [writerDraft, setWriterDraft] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [selectedBinding, setSelectedBinding] = useState<{ hostId: string; path: string } | null>(null);
  // What the other role pickers show while their saves are on the way (the writer's picker has writerDraft), and the queue of each.
  const [pickerDrafts, setPickerDrafts] = useState<Record<string, ExperimentalProviderModelPickerValue>>({});
  const pickerDraftsRef = useRef<Record<string, ExperimentalProviderModelPickerValue>>({});
  const projectCache = useRef(new Map<string, { data: ScreenPayload; drafts: Record<string, unknown>; writer: ExperimentalProviderModelPickerValue | null }>());
  const loadGeneration = useRef(0);

  useEffect(() => {
    let current = true;
    void rpc.call("list_projects", {}).then((result) => {
      if (current) {
        setProjects(userVisibleProjects(result.projects));
        setProjectsLoaded(true);
        if (!routeProjectId && !routeProject) {
          const visible = userVisibleProjects(result.projects);
          const preferred = visible.find((project) => project.id === result.lastProjectId)?.id ?? visible[0]?.id ?? null;
          if (preferred) setSelectedProjectId((current) => current ?? preferred);
        }
      }
    }).catch(() => { if (current) setProjectListError(true); });
    return () => { current = false; };
  }, [routeProjectId, routeProject, rpc]);

  useEffect(() => {
    let current = true;
    const suggestedLocale = detectLocaleHint();
    void rpc.call("get_preferences", { suggestedLocale }).then((result) => {
      if (!current) return;
      setLocalePreference(result.preference);
      setLocaleOverride(result.preference === "auto" ? null : result.preference);
      setLocale(result.locale);
    });
    const onLocale = (event: Event) => {
      const next = (event as CustomEvent<Locale>).detail;
      if (next === "en" || next === "ru") { setLocaleOverride(next); setLocale(next); }
    };
    globalThis.addEventListener?.("lane-pilot-locale", onLocale);
    return () => { current = false; globalThis.removeEventListener?.("lane-pilot-locale", onLocale); };
  }, [rpc]);

  useEffect(() => {
    if (localePreference !== "auto") return;
    return subscribeToLocaleHintChanges((next) => {
      setLocaleOverride(null);
      setLocale(next);
      globalThis.dispatchEvent?.(new CustomEvent("lane-pilot-locale", { detail: next }));
    });
  }, [localePreference]);

  const chooseLocale = async (next: LocalePreference) => {
    const suggestedLocale = detectLocaleHint();
    const resolved = next === "auto" ? suggestedLocale : next;
    setLocalePreference(next);
    setLocaleOverride(next === "auto" ? null : next);
    setLocale(resolved);
    globalThis.dispatchEvent?.(new CustomEvent("lane-pilot-locale", { detail: resolved }));
    await rpc.call("set_locale", { locale: next, suggestedLocale });
  };

  dataRef.current = data;
  draftsRef.current = drafts;

  const load = useCallback(async () => {
    if (!projectId) return;
    const generation = ++loadGeneration.current;
    pickerDraftsRef.current = {};
    setPickerDrafts({});
    const cached = projectCache.current.get(cacheKey(projectId, selectedSectionId));
    if (cached) { setData(cached.data); dataRef.current = cached.data; setDrafts(cached.drafts); draftsRef.current = cached.drafts; setWriterDraft(cached.writer); writerDraftRef.current = cached.writer; return; }
    setError(null);
    setData(null);
    draftsRef.current = {};
    setDrafts({});
    writerDraftRef.current = null;
    setWriterDraft(null);
    try {
      // The routing list does not depend on the screen: it starts with it, not after it.
      void rpc.call("get_routing_hint", { projectId }).then((hint) => { if (generation === loadGeneration.current) setRoutingStats(hint as RoutingStats); }).catch(() => setRoutingStats(null));
      const next = await rpc.call("get_screen", { ...scoped, projectId }) as ScreenPayload;
      if (generation !== loadGeneration.current) return;
      setData(next);
      runsWindow.current = next.runsLimit ?? next.runs.length;
      if (next.lastSnapshotPath) setSnapshotPath(next.lastSnapshotPath);
      setResultSource(next.writerResultJson);
      setResultPatch(next.writerResultPatch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId, selectedSectionId, rpc]);

  useEffect(() => {
    if (!projectScreenActive) return;
    // Coming back from another scope keeps what is loaded; a different project or section loads its own screen.
    const held = dataRef.current;
    if (held && held.projectId === projectId && (held.sectionId ?? null) === selectedSectionId) return;
    void load();
  }, [load, projectScreenActive]);

  // The overview re-reads the runs it shows lightly (no screen reload, so nothing blanks) when an attempt changes or the slow poll fires;
  // the «Tasks» tab is the board, which reads on its own.
  const mergeRuns = (incoming: ScreenPayload["runs"], total: number, replaceAll: boolean) => setData((prev) => {
    if (!prev || prev.projectId !== projectId) return prev;
    const known = new Set(incoming.map((run) => run.id));
    return { ...prev, runsTotal: total, runs: replaceAll ? incoming : [...prev.runs.filter((run) => !known.has(run.id)), ...incoming] };
  });
  const refreshRuns = useCallback(async () => {
    if (!projectId || isGlobal || !dataRef.current || dataRef.current.projectId !== projectId) return;
    const generation = loadGeneration.current;
    try {
      // In pages of at most 200 (the contract's limit): one call of the whole window was refused from the 211th run on.
      const page = await readRunsWindow(rpc as unknown as Parameters<typeof readRunsWindow>[0], { ...(selectedSectionId ? { sectionId: selectedSectionId } : {}), projectId }, runsWindow.current);
      if (generation === loadGeneration.current) mergeRuns(page.runs as ScreenPayload["runs"], page.total, true);
    } catch { /* the next signal or poll retries */ }
  }, [projectId, isGlobal, selectedSectionId, rpc]);
  const runsPollMs = useLpRealtime(isGlobal || !projectScreenActive ? null : projectId, ["helpers"], () => { void refreshRuns(); });
  const runsVisible = consoleRoute
    ? (consoleRoute.section === "overview" && Boolean(consoleRoute.projectId) && !isGlobal)
    : (projectScreenActive && tab === "overview");
  useLpPoll(runsVisible && projectId && !isGlobal ? runsPollMs : undefined, () => { void refreshRuns(); });

  useEffect(() => {
    if (consoleRoute) return;
    setSelectedSectionId(null);
    setSections([]);
  }, [projectId, consoleRoute]);
  useEffect(() => {
    if (consoleRoute?.section === "system" && consoleRoute.page === "settings" && consoleRoute.view === "docs") {
      setSegments((current) => (current.knowledge === "docs" ? current : { ...current, knowledge: "docs" }));
    }
  }, [consoleRoute?.section, consoleRoute?.page, consoleRoute?.view]);
  useEffect(() => {
    if (!projectId || isGlobal || !projectScreenActive) return;
    let current = true;
    void rpc.call("list_sections", { projectId }).then((result) => { if (current) setSections(result.sections); }).catch(() => undefined);
    return () => { current = false; };
  }, [projectId, projectScreenActive, rpc]);

  // Leaving the global level drops cached project screens: their inherited values may have changed.
  useEffect(() => {
    if (!isGlobal) return;
    return () => projectCache.current.clear();
  }, [isGlobal]);

  // The same six tabs at every level; what a level does not have (rules at the system level, runs there) is said inside the tab.
  const level: "system" | "project" | "section" = isGlobal ? "system" : selectedSectionId ? "section" : "project";

  const diagnosticsGrouped = useMemo(() => {
    const map = new Map<string, CatalogRow[]>();
    for (const section of SECTION_ORDER) map.set(section, []);
    for (const row of diagnosticRows()) {
      const list = map.get(row.section) ?? [];
      list.push(row);
      map.set(row.section, list);
    }
    return SECTION_ORDER.filter((section) => (map.get(section) ?? []).length > 0)
      .map((section) => ({ section, rows: map.get(section) ?? [] }));
  }, []);

  const extrasGrouped = useMemo(() => {
    const map = new Map<string, CatalogRow[]>();
    for (const section of SECTION_ORDER) map.set(section, []);
    for (const row of extraSettingRows()) {
      if (settingsDepth === "basic" && !BASIC_SETTING_KEYS.has(row.storageKey)) continue;
      const list = map.get(row.section) ?? [];
      list.push(row);
      map.set(row.section, list);
    }
    return SECTION_ORDER.filter((section) => (map.get(section) ?? []).length > 0)
      .map((section) => ({ section, rows: map.get(section) ?? [] }));
  }, [settingsDepth, locale]);

  const chooseProject = (next: string) => {
    if (dataRef.current) projectCache.current.set(cacheKey(dataRef.current.projectId, dataRef.current.sectionId), { data: dataRef.current, drafts: { ...draftsRef.current }, writer: writerDraftRef.current });
    setActiveScope("projects");
    setSelectedProjectId(next);
    setSelectedSectionId(null);
    setProjectListError(false);
    void rpc.call("remember_project", { projectId: next }).catch(() => setProjectListError(true));
  };

  const savers = useLpPageSavers({
    rpc, projectId, selectedSectionId, scoped, routeThreadId, selectedBinding, snapshotPath,
    dataRef, setData, setError, drafts, setDrafts, draftsRef,
    writerDraftRef, setWriterDraft, pickerDraftsRef, setPickerDrafts, reload: load,
  });

  const savedPickerValue: ExperimentalProviderModelPickerValue = {
    providerId: String(data?.values[WRITER_PROVIDER] ?? ""),
    model: String(data?.values[WRITER_MODEL] ?? ""),
    reasoningLevel: (String(data?.values[WRITER_EFFORT] ?? "none") || "none") as ExperimentalProviderModelPickerValue["reasoningLevel"],
    ...(providers.providers?.find((provider) => provider.id === String(data?.values[WRITER_PROVIDER] ?? ""))?.serviceTiers?.length
      ? { serviceTier: data?.values[WRITER_SERVICE_TIER] === "fast" ? "fast" : "default" }
      : {}),
  };
  const pickerValue = writerDraft ?? savedPickerValue;

  /** Every picker-saved role: what its picker shows and how a choice is saved. */
  const pickers = Object.fromEntries((Object.keys(SELECTION_SPECS) as SelectionId[]).map((id) => [id, {
    value: pickerDrafts[id] ?? selectionValue(id, data?.values, providers),
    save: (selection: ExperimentalProviderModelPickerValue) => savers.saveSelection(id, selection),
  }])) as Record<SelectionId, { value: ExperimentalProviderModelPickerValue; save: (selection: ExperimentalProviderModelPickerValue) => Promise<boolean> }>;

  const catalogRow = (key: string) => SETTINGS_REGISTRY.visible.find((item) => item.storageKey === key);

  const hostId = data?.hostId;
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;
  const modelPicker = (value: ExperimentalProviderModelPickerValue, onChange: (next: ExperimentalProviderModelPickerValue) => void) => (
    // Before the screen loads the picker would fill in the catalog's first model and report it as a choice.
    !data ? <p className="text-sm text-muted-foreground">{t("overviewLoading")}</p>
    : value.providerId || (providers.providers?.length ?? 0) > 0
      ? <ProviderModelPicker value={value.providerId ? value : { providerId: providers.providers?.[0]?.id ?? "none", model: "", reasoningLevel: "none" }} routing={routing} onChange={onChange} />
      : <p className="text-sm text-muted-foreground">{providers.status === "loading" ? t("writerCatalogLoading") : t("writerCatalogUnavailable")}</p>
  );
  const inheritReset = (keys: string[]) => (
    <Button type="button" size="sm" variant="ghost" className="h-8 px-2" disabled={!keys.some((key) => data?.explicitKeys.includes(key))} onClick={() => void savers.resetInherited(keys)}>{t("inheritChoice")}</Button>
  );

  const selectedProjectName = projects.find((item) => item.id === projectId)?.name ?? projectId;
  const selectedSectionName = sections.find((item) => item.id === selectedSectionId)?.name ?? null;
  const mobileNavValue = activeScope === "projects" ? (selectedSectionId ? `section:${selectedSectionId}` : projectId ? `project:${projectId}` : "projects") : activeScope;
  // The selected project's sections in tree order, for the phone menu.
  const flatSections: Array<{ id: string; name: string; depth: number }> = [];
  const walkSections = (parentId: string | null, depth: number) => {
    for (const section of sections.filter((item) => item.parentId === parentId)) { flatSections.push({ id: section.id, name: section.name, depth }); walkSections(section.id, depth + 1); }
  };
  walkSections(null, 1);
  // Phones get a menu; wider screens keep every tab visible and wrap the row instead of scrolling it.
  const tabSelect = contentWidth > 0 && contentWidth < 680;
  // The roles table needs about 45rem for its five columns; narrower, every role becomes a card.
  const wideTable = contentWidth === 0 || contentWidth >= 720;
  // Test projects and the ones the owner hid sit under «Service» in the list.
  const [hiddenIds, setHiddenIds] = useState<string[]>(readHiddenProjects);
  const hiddenProjects = useMemo(() => new Set(hiddenIds), [hiddenIds]);
  const projectGroups = useMemo(() => splitProjects(projects, hiddenProjects), [projects, hiddenProjects]);
  const hideProject = (id: string) => setHiddenIds((current) => { const next = [...new Set([...current, id])]; writeHiddenProjects(next); return next; });
  const showProject = (id: string) => setHiddenIds((current) => { const next = current.filter((item) => item !== id); writeHiddenProjects(next); return next; });
  const advanced = settingsDepth === "advanced";
  const hostLabel = (id: string | null | undefined) => (id ? data?.qaHosts?.find((host) => host.id === id)?.name ?? id : "—");
  const nativeHostId = data?.writerBinding?.status === "resolved" ? data.writerBinding.hostId : null;
  const installNative = async () => {
    if (!nativeHostId) return;
    await rpc.call("native_install_start", { hostId: nativeHostId });
    setNativeState((current) => ({ status: "installing", error: current?.error ?? null }));
  };
  // Read the machine's state while Maintenance is open, and every 5 s while it installs.
  const healthActive = consoleRoute
    ? (consoleRoute.section === "system" && consoleRoute.page === "health")
    : (tab === "runs" && segments.runs === "service");
  useEffect(() => {
    if (!healthActive || !nativeHostId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => void rpc.call("native_install_status", { hostId: nativeHostId }).then((next) => {
      if (!alive) return;
      setNativeState(next);
      if (next.status === "installing") timer = setTimeout(read, 5000);
    }).catch(() => { if (alive) setNativeState({ status: "offline", error: null }); });
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [healthActive, nativeHostId, nativeState?.status === "installing", rpc]);
  const writerChosen = Boolean(data?.values[WRITER_PROVIDER] && data?.values[WRITER_MODEL]);
  // The overview waits for the screen instead of showing the defaults («no model», «no runs») that the data then replaces.
  const screenLoading = !data && !error && Boolean(projectId);
  const activeRuns = (data?.runs ?? []).filter((run) => run.state === "pending" || run.state === "running").length;
  const trackLines = (() => {
    if (!routingStats) return [];
    const rate = (row: { acceptedFirstTry: number; tasks: number }) => row.acceptedFirstTry / row.tasks;
    const current = routingStats.current;
    return ["low", "medium", "high", "unknown"].flatMap((risk) => {
      const own = current ? routingStats.stats.find((row) => row.risk === risk && row.providerId === current.providerId && row.model === current.model) : undefined;
      const best = routingStats.stats.filter((row) => row.risk === risk && row.tasks >= 5)
        .reduce<RoutingStats["stats"][number] | undefined>((top, row) => (!top || rate(row) > rate(top) ? row : top), undefined);
      const parts: string[] = [];
      if (own) parts.push(t("trackOwn").replace("{first}", String(own.acceptedFirstTry)).replace("{tasks}", String(own.tasks)));
      // Name another pair only when it really did better, so a lone pair is never called «the best».
      if (best && best !== own && (!own || rate(best) > rate(own))) parts.push(t("trackBetter").replace("{pair}", `${best.providerId}/${best.model}`).replace("{first}", String(best.acceptedFirstTry)).replace("{tasks}", String(best.tasks)));
      return parts.length ? [{ risk, text: `${t(`trackRisk_${risk}` as I18nKey)}: ${parts.join("; ")}` }] : [];
    });
  })();

  const effectiveTab: TabId = consoleRoute
    ? consoleRoute.section === "system" && consoleRoute.page === "settings"
      ? "work"
      : consoleRoute.section === "system" && consoleRoute.page === "agents"
        ? "team"
        : consoleRoute.section === "system" && consoleRoute.page === "health"
          ? "runs"
          : "overview"
    : tab;

  return {
    pickers, subPath: routeProject,
    activeScope, setActiveScope, rpc, routeProjectId, routeThreadId, selectedProjectId,
    setSelectedProjectId, projectId, isGlobal, projectScreenActive, selectedSectionId, setSelectedSectionId,
    routingStats, setRoutingStats, fallbackTouched,
    sections, setSections, scoped, cacheKey, projects,
    setProjects, projectsLoaded, setProjectsLoaded, projectListError, setProjectListError,
    providers, tab: effectiveTab, setTab, visited, runsWindow, nativeState, setNativeState, data, setData,
    error, setError, confirmOpen, setConfirmOpen,
    pendingOp, setPendingOp, snapshotPath, setSnapshotPath,
    resultPatch, setResultPatch, resultSource, setResultSource, locale, setLocale,
    localePreference, setLocalePreference, settingsDepth, setSettingsDepth, shellRef, contentRef,
    shellWidth, contentWidth, compactChrome, stackControls, drafts, setDrafts,
    dataRef, draftsRef, writerDraftRef, writerDraft, setWriterDraft,
    selectedBinding, setSelectedBinding, projectCache,
    loadGeneration, chooseLocale, load, mergeRuns, refreshRuns,
    runsPollMs, runsVisible, level, segmentOf, setSegment, goTo, diagnosticsGrouped, extrasGrouped, chooseProject,
    pickerDrafts, savedPickerValue, pickerValue, catalogRow,
    hostId, routing, modelPicker, inheritReset,
    selectedProjectName, selectedSectionName, mobileNavValue, flatSections, walkSections,
    tabSelect, wideTable, hiddenProjects, projectGroups, hideProject, showProject, advanced, hostLabel, nativeHostId, installNative, writerChosen,
    screenLoading, activeRuns, trackLines,
    ...savers,
  };
}

export type LpPage = ReturnType<typeof useLanePilotPage>;
