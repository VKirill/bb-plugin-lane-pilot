import { readHiddenProjects, splitProjects, writeHiddenProjects } from "./service-projects";
import { resolveTab, SEGMENTS, type SegmentedTab, type TabId } from "./tabs-model";
import { selectionKeys, selectionValue, SELECTION_SPECS, type SelectionId } from "./picker-selections";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useProviders as useProviders,
  useBbContext,
  useRpc,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../contracts";
import { SECTION_ORDER, VISIBLE_CATALOG, type CatalogRow } from "@lane-pilot/settings-catalog";
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
import { Button } from "@lane-pilot/ui-kit";
import { useLpRealtime } from "./use-lp-realtime";
import { readRunsWindow } from "./runs-window";
import { chromeIsCompact, contentStacksControls, useObservedWidth } from "@lane-pilot/ui-kit";
import { userVisibleProjects } from "../project-scope";
import { DOCS_DEFAULT_SELECTION } from "../rooms/docs/docs-defaults";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { writerFallbackKeys } from "../writer-fallbacks";
import { BASIC_SETTING_KEYS, CODE_CRITIQUE_EFFORT, CODE_CRITIQUE_MODEL, CODE_CRITIQUE_PROVIDER, CODE_CRITIQUE_SERVICE_TIER, COUNCIL_SEATS, CouncilDetail, CouncilRow, DOCS_EFFORT, DOCS_MODEL, DOCS_PROVIDER, DOCS_SERVICE_TIER, JEV_KEYS, MEMORY_EFFORT, MEMORY_MODEL, MEMORY_PROVIDER, MEMORY_SERVICE_TIER, NIGHT_EFFORT, NIGHT_MODEL, NIGHT_PROVIDER, NIGHT_SERVICE_TIER, ONBOARDING_EFFORT, ONBOARDING_MODEL, ONBOARDING_PROVIDER, ONBOARDING_SERVICE_TIER, PLAN_CRITIQUE_EFFORT, PLAN_CRITIQUE_MODEL, PLAN_CRITIQUE_PROVIDER, PLAN_CRITIQUE_SERVICE_TIER, PM_READ_EFFORT, PM_READ_MODEL, PM_READ_PROVIDER, PM_READ_SERVICE_TIER, PROJECT_LIFE_EFFORT, PROJECT_LIFE_MODEL, PROJECT_LIFE_PROVIDER, PROJECT_LIFE_SERVICE_TIER, RUNS_PAGE, RoutingStats, SPECIALIST_EFFORT, SPECIALIST_MODEL, SPECIALIST_PROVIDER, SPECIALIST_SERVICE_TIER, ScreenPayload, StackDetectResult, WRITER_EFFORT, WRITER_MODEL, WRITER_PROVIDER, WRITER_SERVICE_TIER, diagnosticRows, extraSettingRows } from "./page-model";

export function useLanePilotPage({ subPath = "", scope = "projects" }: { subPath?: string; scope?: "projects" | "globals" | "agents" | "tokens" | "workflows" | "schedule" }) {
  const [activeScope, setActiveScope] = useState(scope);
  const rpc = useRpc<typeof rpcContract>();
  const { projectId: routeProjectId, threadId: routeThreadId } = useBbContext();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  // «Общие настройки» edit the global level every project inherits, with the same panel as a project.
  const projectId = activeScope === "globals" ? GLOBAL_SETTINGS_PROJECT_ID : selectedProjectId ?? routeProjectId ?? (subPath || null);
  const isGlobal = projectId === GLOBAL_SETTINGS_PROJECT_ID;
  // The project screen (get_screen and everything it feeds) is what «Projects» and «General settings» show; «Agents», «Tokens» and «Workflows» keep it hidden and must not pay for it.
  const projectScreenActive = activeScope === "projects" || activeScope === "globals";
  // A section keeps its own settings over its project's; null edits the project itself.
  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [routingStats, setRoutingStats] = useState<RoutingStats | null>(null);
  const [councilDefaults, setCouncilDefaults] = useState<Array<{ id: string; title: string; providerId: string | null; model: string | null; configured: boolean }>>([]);
  // Seat pickers report a normalized value on mount; only a choice made by hand is saved.
  const councilSeatsTouched = useRef(new Set<string>());
  // Only a change the owner made by hand is saved: the picker reports a normalized value on mount.
  const fallbackTouched = useRef(new Set<number>());
  const [councilsAll, setCouncilsAll] = useState(false);
  const [councils, setCouncils] = useState<CouncilRow[]>([]);
  const [council, setCouncil] = useState<CouncilDetail | null>(null);
  const openCouncil = (councilId: string) => { void rpc.call("get_council", { councilId }).then((detail) => setCouncil(detail as CouncilDetail)).catch(() => setCouncil(null)); };
  const [sections, setSections] = useState<Array<{ id:string; parentId:string|null; name:string; path:string; kind:"folder"|"group" }>>([]);
  const scoped = selectedSectionId ? { sectionId: selectedSectionId } : {};
  const cacheKey = (id: string, section: string | null | undefined) => `${id}|${section ?? ""}`;
  const [projects, setProjects] = useState<Array<{ id:string; name:string; kind?:string }>>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [projectListError, setProjectListError] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const providers = useProviders();
  const [tab, setTab] = useState<TabId>("overview");
  // The part of a segmented tab that is open (the tabs that have segments: knowledge, automation, runs).
  const [segments, setSegments] = useState<Record<string, string>>({ knowledge: "memory", automation: "workflows", runs: "active" });
  const segmentOf = (id: SegmentedTab) => segments[id] ?? SEGMENTS[id][0];
  const setSegment = (id: SegmentedTab, next: string) => setSegments((current) => ({ ...current, [id]: next }));
  /** Opens a tab, and a part of it. Ids of the old ten tabs work too. */
  const goTo = (id: string, segment?: string) => {
    const target = resolveTab(id);
    setTab(target.tab);
    const part = segment ?? target.segment;
    if (part && target.tab in SEGMENTS) setSegment(target.tab as SegmentedTab, part);
  };
  // A tab mounts when it is first opened and stays mounted after that: ten tabs at once cost 25 000 DOM nodes on a big project.
  const visited = useRef(new Set<string>());
  visited.current.add(tab);
  const [runsShown, setRunsShown] = useState(20);
  // How many of the newest runs the screen has fetched; the rest of the history comes by `list_runs` pages.
  const runsWindow = useRef(0);
  const [nativeState, setNativeState] = useState<{ status: string; error: string | null } | null>(null);
  const [data, setData] = useState<ScreenPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<{ kind: "cas" } | { kind: "validation"; code: "invalid_choice" | "incompatible_setting" | "setup_required" | "writer_binding_ambiguous" | "writer_host_offline" | "catalog_unavailable"; params: string[] } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [pendingOp, setPendingOp] = useState<"install" | "connect" | "rollback" | null>(null);
  const [snapshotPath, setSnapshotPath] = useState("");
  const [detectResult, setDetectResult] = useState<StackDetectResult | null>(null);
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
  const saveTailRef = useRef<Record<string, Promise<unknown>>>({});
  const writerDraftRef = useRef<ExperimentalProviderModelPickerValue | null>(null);
  const [writerDraft, setWriterDraft] = useState<ExperimentalProviderModelPickerValue | null>(null);
  const [selectedBinding, setSelectedBinding] = useState<{ hostId: string; path: string } | null>(null);
  const [writerRejected, setWriterRejected] = useState(false);
  const writerSaveTail = useRef(Promise.resolve());
  const projectCache = useRef(new Map<string, { data: ScreenPayload; drafts: Record<string, unknown>; writer: ExperimentalProviderModelPickerValue | null }>());
  const loadGeneration = useRef(0);


  useEffect(() => {
    let current = true;
    void rpc.call("list_projects", {}).then((result) => {
      if (current) {
        setProjects(userVisibleProjects(result.projects));
        setProjectsLoaded(true);
        if (!routeProjectId && !subPath) {
          const visible = userVisibleProjects(result.projects);
          const preferred = visible.find((project) => project.id === result.lastProjectId)?.id ?? visible[0]?.id ?? null;
          if (preferred) setSelectedProjectId((current) => current ?? preferred);
        }
      }
    }).catch(() => { if (current) setProjectListError(true); });
    return () => { current = false; };
  }, [routeProjectId, subPath, rpc]);

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
    const cached = projectCache.current.get(cacheKey(projectId, selectedSectionId));
    if (cached) { setData(cached.data); dataRef.current = cached.data; setDrafts(cached.drafts); draftsRef.current = cached.drafts; setWriterDraft(cached.writer); writerDraftRef.current = cached.writer; return; }
    setError(null);
    setData(null);
    draftsRef.current = {};
    setDrafts({});
    writerDraftRef.current = null;
    setWriterDraft(null);
    try {
      // The council, routing and defaults lists do not depend on the screen: they start with it, not after it.
      void rpc.call("get_council_defaults", { projectId }).then((defaults) => { if (generation === loadGeneration.current) setCouncilDefaults((defaults as { seats: typeof councilDefaults }).seats); }).catch(() => setCouncilDefaults([]));
      void rpc.call("list_councils", { projectId }).then((listed) => { if (generation === loadGeneration.current) setCouncils((listed as { councils: CouncilRow[] }).councils); }).catch(() => setCouncils([]));
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

  // The runs panel reads its list on its own: the next page of the history, and a light re-read of what is loaded
  // (no screen reload, so nothing blanks) when an attempt changes or the slow poll fires.
  const mergeRuns = (incoming: ScreenPayload["runs"], total: number, replaceAll: boolean) => setData((prev) => {
    if (!prev || prev.projectId !== projectId) return prev;
    const known = new Set(incoming.map((run) => run.id));
    return { ...prev, runsTotal: total, runs: replaceAll ? incoming : [...prev.runs.filter((run) => !known.has(run.id)), ...incoming] };
  });
  const loadMoreRuns = async () => {
    if (!projectId) return;
    const offset = runsWindow.current;
    const generation = loadGeneration.current;
    const page = await rpc.call("list_runs", { ...scoped, projectId, offset, limit: RUNS_PAGE });
    if (generation !== loadGeneration.current) return;
    runsWindow.current = offset + RUNS_PAGE;
    mergeRuns(page.runs as ScreenPayload["runs"], page.total, false);
  };
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
  const runsVisible = projectScreenActive && (tab === "overview" || (tab === "runs" && (segments.runs === "active" || segments.runs === "history")));
  useEffect(() => {
    if (!runsVisible || !projectId || isGlobal) return;
    const timer = setInterval(() => { void refreshRuns(); }, runsPollMs);
    return () => clearInterval(timer);
  }, [runsVisible, projectId, isGlobal, refreshRuns, runsPollMs]);

  useEffect(() => {
    setSelectedSectionId(null);
    setSections([]);
  }, [projectId]);
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

  const writeDraft = (key: string, value: unknown) => {
    draftsRef.current = { ...draftsRef.current, [key]: value };
    setDrafts((current) => ({ ...current, [key]: value }));
  };

  const save = async (row: CatalogRow, value: unknown) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const expectedVersion = snapshot.versions[row.storageKey] ?? 0;
    const result = await rpc.call("save_setting", { ...scoped,
      projectId,
      key: row.storageKey,
      value,
      expectedVersion,
    });
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      setData((current) => {
        const next = current ? {
          ...current,
          values: { ...current.values, [row.storageKey]: result.value },
          versions: { ...current.versions, [row.storageKey]: result.version },
        } : current;
        dataRef.current = next;
        return next;
      });
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    setData((current) => {
      const next = current ? {
        ...current,
        values: { ...current.values, [row.storageKey]: result.value },
        versions: { ...current.versions, [row.storageKey]: result.version },
        explicitKeys: [...new Set([...current.explicitKeys, row.storageKey])],
      } : current;
      dataRef.current = next;
      return next;
    });
    return true;
  };

  const saveKey = async (key: string, value: unknown) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const result = await rpc.call("save_setting", { ...scoped,
      projectId, key, value, expectedVersion: snapshot.versions[key] ?? 0,
    });
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      setData((current) => {
        const next = current ? {
          ...current,
          values: { ...current.values, [key]: result.value },
          versions: { ...current.versions, [key]: result.version },
        } : current;
        dataRef.current = next;
        return next;
      });
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    setData((current) => {
      const next = current ? {
        ...current,
        values: { ...current.values, [key]: result.value },
        versions: { ...current.versions, [key]: result.version },
        explicitKeys: [...new Set([...current.explicitKeys, key])],
      } : current;
      dataRef.current = next;
      return next;
    });
    return true;
  };

  const applySetting = async (row: CatalogRow, value: unknown) => {
    writeDraft(row.storageKey, value);
    const key = row.storageKey;
    const queued = (saveTailRef.current[key] ?? Promise.resolve()).then(async () => {
      const latest = draftsRef.current[key];
      if (latest === undefined) return true;
      const ok = await save(row, latest);
      if (ok && Object.is(draftsRef.current[key], latest)) {
        const next = { ...draftsRef.current };
        delete next[key];
        draftsRef.current = next;
        setDrafts((current) => {
          if (!Object.is(current[key], latest)) return current;
          const copy = { ...current };
          delete copy[key];
          return copy;
        });
      }
      return ok;
    });
    saveTailRef.current[key] = queued.then(() => undefined, () => undefined);
    return queued;
  };

  const resetInherited = async (keys: string[]) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot || snapshot.projectId !== projectId) return;
    try {
      const result = await rpc.call("reset_project_settings", { ...scoped, projectId, keys, expectedVersions: Object.fromEntries(keys.map((key) => [key, snapshot.versions[key] ?? 0])) });
      if (dataRef.current?.projectId !== projectId) return;
      if (!result.ok) { setSaveError(result.validation ? { kind: "validation", code: result.validation.code, params: result.validation.params } : { kind: "cas" }); return; }
      const next = await rpc.call("get_screen", { ...scoped, projectId }) as ScreenPayload;
      if (dataRef.current?.projectId !== projectId) return;
      setData(next); dataRef.current = next;
      const remaining = { ...draftsRef.current }; for (const key of keys) delete remaining[key];
      setDrafts(remaining); draftsRef.current = remaining;
      if (keys.includes(WRITER_PROVIDER)) { setWriterDraft(null); writerDraftRef.current = null; }
      setSaveError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const displayedValue = (key: string) => (
    Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] : data?.values[key]
  );

  const persistWriterSelection = async (selection: ExperimentalProviderModelPickerValue) => {
    const snapshot = dataRef.current;
    if (!projectId || !snapshot) return false;
    const result = await rpc.call("save_writer_selection", { ...scoped,
      projectId,
      threadId: routeThreadId ?? null,
      ...(selectedBinding ? { selectedBinding } : {}),
      providerId: selection.providerId,
      model: selection.model,
      reasoningLevel: selection.reasoningLevel,
      serviceTier: selection.serviceTier ?? null,
      expectedVersions: {
        "writer.provider": snapshot.versions[WRITER_PROVIDER] ?? 0,
        "writer.model": snapshot.versions[WRITER_MODEL] ?? 0,
        "writer.reasoning_effort": snapshot.versions[WRITER_EFFORT] ?? 0,
        "writer.service_tier": snapshot.versions[WRITER_SERVICE_TIER] ?? 0,
      },
    });
    const applyScreen = (values: Record<string, unknown>, versions: Record<string, number>, markExplicit = false) => {
      const current = dataRef.current;
      if (!current) return;
      const next = {
        ...current,
        values: { ...current.values, ...values },
        versions: { ...current.versions, ...versions },
        explicitKeys: markExplicit
          ? [...new Set([...current.explicitKeys, WRITER_PROVIDER, WRITER_MODEL, WRITER_EFFORT, WRITER_SERVICE_TIER])]
          : current.explicitKeys,
      };
      dataRef.current = next;
      setData(next);
    };
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      applyScreen(result.values, result.versions);
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    applyScreen(result.values, result.versions, true);
    return true;
  };

  const saveWriterSelection = (selection: ExperimentalProviderModelPickerValue) => {
    writerDraftRef.current = selection;
    setWriterDraft(selection);
    writerSaveTail.current = writerSaveTail.current
      .catch(() => undefined)
      .then(async () => {
        const latest = writerDraftRef.current;
        if (!latest) return;
        const ok = await persistWriterSelection(latest);
        setWriterRejected(!ok);
        if (ok && writerDraftRef.current === latest) {
          writerDraftRef.current = null;
          setWriterDraft(null);
        }
      })
      .then(() => undefined, () => undefined);
  };

  /** One picker-saved role (memory, night review, docs, project log, PM reads, passport, critics, specialist): the same CAS tuple through its own RPC. */
  const saveSelection = async (id: SelectionId, selection: ExperimentalProviderModelPickerValue) => {
    if (!projectId || !data) return false;
    const spec = SELECTION_SPECS[id];
    const keys = Object.values(selectionKeys(id));
    const result = await (rpc.call as unknown as (name: string, input: unknown) => Promise<{
      ok: boolean; conflict: boolean; values: Record<string, unknown>; versions: Record<string, number>;
      validation?: { code: Extract<NonNullable<typeof saveError>, { kind: "validation" }>["code"]; params: string[] };
    }>)(spec.rpc, { ...scoped,
      projectId, providerId: selection.providerId, model: selection.model, reasoningLevel: selection.reasoningLevel, serviceTier: selection.serviceTier ?? null,
      expectedVersions: Object.fromEntries(keys.map((key) => [key, data.versions[key] ?? 0])),
    });
    const merge = () => setData((current) => current ? { ...current, values: { ...current.values, ...result.values }, versions: { ...current.versions, ...result.versions } } : current);
    if (result.conflict) {
      setSaveError({ kind: "cas" });
      if (spec.conflict === "merge") merge(); else await load();
      return false;
    }
    if (!result.ok) {
      if (result.validation) setSaveError({ kind: "validation", code: result.validation.code, params: result.validation.params });
      else setSaveError({ kind: "cas" });
      return false;
    }
    setSaveError(null);
    merge();
    return true;
  };


  const saveCouncilSeatSelection = async (seat:(typeof COUNCIL_SEATS)[number], selection:ExperimentalProviderModelPickerValue)=>{
    if(!projectId||!data)return false;
    const keys=[`council.${seat}.provider`,`council.${seat}.model`,`council.${seat}.reasoning_effort`];
    const result=await rpc.call("save_council_seat_selection", { ...scoped,
      projectId,seat,providerId:selection.providerId,model:selection.model,reasoningLevel:selection.reasoningLevel,
      expectedVersions:Object.fromEntries(keys.map((key)=>[key,data.versions[key]??0])),
    });
    if(result.conflict){setSaveError({kind:"cas"});await load();return false;}
    if(!result.ok){if(result.validation)setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});else setSaveError({kind:"cas"});return false;}
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };
  const saveWriterFallback = async (slot:1|2, selection:ExperimentalProviderModelPickerValue|null)=>{
    if(!projectId||!data)return false;
    const keys=writerFallbackKeys(slot);
    const result=await rpc.call("save_writer_fallback_selection", { ...scoped, projectId, slot,
      ...(selection?{providerId:selection.providerId,model:selection.model,reasoningLevel:selection.reasoningLevel}:{off:true}),
      expectedVersions:Object.fromEntries(Object.values(keys).map((key)=>[key,data.versions[key]??0])),
    });
    if(result.conflict){setSaveError({kind:"cas"});await load();return false;}
    if(!result.ok){if(result.validation)setSaveError({kind:"validation",code:result.validation.code,params:result.validation.params});else setSaveError({kind:"cas"});return false;}
    setSaveError(null);
    setData((current)=>current?{...current,values:{...current.values,...result.values},versions:{...current.versions,...result.versions}}:current);
    return true;
  };
  const councilSeatPickerValue=(seat:(typeof COUNCIL_SEATS)[number]):ExperimentalProviderModelPickerValue=>({
    providerId:String(data?.values[`council.${seat}.provider`]??""),
    model:String(data?.values[`council.${seat}.model`]??""),
    reasoningLevel:(String(data?.values[`council.${seat}.reasoning_effort`]??"high")||"high") as ExperimentalProviderModelPickerValue["reasoningLevel"],
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
    value: selectionValue(id, data?.values, providers),
    save: (selection: ExperimentalProviderModelPickerValue) => saveSelection(id, selection),
  }])) as Record<SelectionId, { value: ExperimentalProviderModelPickerValue; save: (selection: ExperimentalProviderModelPickerValue) => Promise<boolean> }>;

  const catalogRow = (key: string) => VISIBLE_CATALOG.find((item) => item.storageKey === key);

  const hostId = data?.hostId;
  const routing = hostId ? { kind: "host" as const, hostId } : undefined;
  const modelPicker = (value: ExperimentalProviderModelPickerValue, onChange: (next: ExperimentalProviderModelPickerValue) => void) => (
    // Before the screen loads the picker would fill in the catalog's first model and report it as a choice.
    !data ? <p className="text-sm text-muted-foreground">{t("writerCatalogLoading")}</p>
    : value.providerId || (providers.providers?.length ?? 0) > 0
      ? <ProviderModelPicker value={value.providerId ? value : { providerId: providers.providers?.[0]?.id ?? "none", model: "", reasoningLevel: "none" }} routing={routing} onChange={onChange} />
      : <p className="text-sm text-muted-foreground">{providers.status === "loading" ? t("writerCatalogLoading") : t("writerCatalogUnavailable")}</p>
  );
  const inheritReset = (keys: string[]) => (
    <Button type="button" size="sm" variant="ghost" className="h-8 px-2" disabled={!keys.some((key) => data?.explicitKeys.includes(key))} onClick={() => void resetInherited(keys)}>{t("inheritChoice")}</Button>
  );

  const runStack = async (op: "detect" | "install" | "connect" | "rollback", confirm = false) => {
    if (!projectId) return;
    try {
      if (op === "detect") setDetectResult(await rpc.call("stack_detect", { projectId }) as StackDetectResult);
      if (op === "install") await rpc.call("stack_install", { projectId, confirmExternalOps: confirm });
      if (op === "connect") await rpc.call("stack_connect", { projectId, confirmExternalOps: confirm });
      if (op === "rollback") await rpc.call("stack_rollback", { projectId, ...(snapshotPath || data?.lastSnapshotPath ? { snapshotPath:snapshotPath || data?.lastSnapshotPath || undefined } : {}) });
      toast.success(<span data-bb-ru-skip>{t("toastOk")}</span>);
      await load();
    } catch (cause) {
      toast.error(<span data-bb-ru-skip>{cause instanceof Error ? cause.message : t("toastError")}</span>);
    }
  };

  const finishRuns = async (runId: string) => {
    if (!projectId || finishing) return;
    setFinishing(true);
    try {
      const result = await rpc.call("finish_run", { projectId, runId });
      if (!result.closed) toast.error(<span data-bb-ru-skip>{t("finishRunBlocked")}</span>);
      else toast.success(<span data-bb-ru-skip>{t("runClosed")}</span>);
      await load();
    } catch (cause) {
      toast.error(<span data-bb-ru-skip>{cause instanceof Error ? cause.message : t("toastError")}</span>);
    } finally { setFinishing(false); }
  };

  const jevRows = useMemo(() => {
    const seen = new Set<string>();
    return VISIBLE_CATALOG.filter((row) => JEV_KEYS.has(row.storageKey) && !seen.has(row.storageKey) && Boolean(seen.add(row.storageKey)));
  }, []);
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
  useEffect(() => {
    if (tab !== "runs" || segments.runs !== "service" || !nativeHostId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => void rpc.call("native_install_status", { hostId: nativeHostId }).then((next) => {
      if (!alive) return;
      setNativeState(next);
      if (next.status === "installing") timer = setTimeout(read, 5000);
    }).catch(() => { if (alive) setNativeState({ status: "offline", error: null }); });
    read();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [tab, segments.runs, nativeHostId, nativeState?.status === "installing", rpc]);
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


  return {
    pickers, saveSelection, subPath,
    activeScope, setActiveScope, rpc, routeProjectId, routeThreadId, selectedProjectId,
    setSelectedProjectId, projectId, isGlobal, projectScreenActive, selectedSectionId, setSelectedSectionId,
    routingStats, setRoutingStats, councilDefaults, setCouncilDefaults, councilSeatsTouched, fallbackTouched,
    councilsAll, setCouncilsAll, councils, setCouncils, council, setCouncil,
    openCouncil, sections, setSections, scoped, cacheKey, projects,
    setProjects, projectsLoaded, setProjectsLoaded, projectListError, setProjectListError, finishing,
    setFinishing, providers, tab, setTab, visited, runsShown,
    setRunsShown, runsWindow, nativeState, setNativeState, data, setData,
    error, setError, saveError, setSaveError, confirmOpen, setConfirmOpen,
    pendingOp, setPendingOp, snapshotPath, setSnapshotPath, detectResult, setDetectResult,
    resultPatch, setResultPatch, resultSource, setResultSource, locale, setLocale,
    localePreference, setLocalePreference, settingsDepth, setSettingsDepth, shellRef, contentRef,
    shellWidth, contentWidth, compactChrome, stackControls, drafts, setDrafts,
    dataRef, draftsRef, saveTailRef, writerDraftRef, writerDraft, setWriterDraft,
    selectedBinding, setSelectedBinding, writerRejected, setWriterRejected, writerSaveTail, projectCache,
    loadGeneration, chooseLocale, load, mergeRuns, loadMoreRuns, refreshRuns,
    runsPollMs, runsVisible, level, segmentOf, setSegment, goTo, diagnosticsGrouped, extrasGrouped, chooseProject,
    writeDraft, save, saveKey, applySetting, resetInherited, displayedValue,
    persistWriterSelection, saveWriterSelection, saveCouncilSeatSelection, saveWriterFallback,
    councilSeatPickerValue, savedPickerValue, pickerValue, catalogRow,
    hostId, routing, modelPicker, inheritReset, runStack, finishRuns,
    jevRows, selectedProjectName, selectedSectionName, mobileNavValue, flatSections, walkSections,
    tabSelect, wideTable, hiddenProjects, projectGroups, hideProject, showProject, advanced, hostLabel, nativeHostId, installNative, writerChosen,
    screenLoading, activeRuns, trackLines,
  };
}

export type LpPage = ReturnType<typeof useLanePilotPage>;
