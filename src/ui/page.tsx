import { type ReactElement } from "react";
import {
  experimental_Diff as Diff,
  experimental_SourceCode as SourceCode,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import { VISIBLE_CATALOG } from "../ui-catalog";
import { t, stateLabel, unappliedReason, validationMessage, type I18nKey } from "../../i18n";
import { settingLabel } from "../setting-copy";
import { agentPickerLabel } from "../agent-display";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { HelpSup } from "./help-sup";
import { EXTERNAL_OPS_BY_ACTION } from "../constants";
import { ATTEMPT_STATES, RUN_STATES } from "../state-machine";
import { QA_HOST_KEY, QA_WORKSPACE_KEY } from "../qa-host";
import { OwnedSettings } from "./owned-settings";
import { PanelLayoutContext } from "./panel-layout";
import { CONTROL_H } from "./control-row";
import { Disclosure } from "./disclosure";
import { RuleProposals } from "./rule-proposals";
import { CriticValue } from "./critic-value";
import { AcceptanceStats } from "./acceptance-stats";
import { WriterReuse } from "./writer-reuse";
import { AgentAccess } from "./agent-access";
import { AnamnesisTab } from "./anamnesis-tab";
import { TokenUsage } from "./token-usage";
import { WorkflowsScreen } from "./workflows";
import { ScheduleBoard } from "./schedule-board";
import { MemoryRecords } from "./memory-records";
import { DocsPlaces } from "./docs-places";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";
import { WRITER_FALLBACK_DEFAULTS, WRITER_FALLBACK_SLOTS, writerFallbackKeys } from "../writer-fallbacks";
import { CARD_BODY, CARD_HEAD, COEXISTENCE_MANAGER_KEYS, COEXISTENCE_VALUE_KEYS, COUNCIL_SEATS, MEMORY_EFFORT, MEMORY_MODEL, MEMORY_PROVIDER, MEMORY_SERVICE_TIER, MonitorRun, OPEN_ATTEMPT_STATES, RUNS_PAGE, SETTINGS_TABS, TAB_LABELS, WRITER_EFFORT, WRITER_MODEL, WRITER_PROVIDER, WRITER_SERVICE_TIER, asBoolean, canCancelAttempt, canRetryAttempt, compatibilityAliasRows, reasonKey, runTone, sectionKey } from "./page-model";
import { AdvancedRows, CheckGroup, FieldControl, InheritanceContext, LocaleControls, OverviewLoading, SettingField, SettingsGroup, StatusBadge, StatusRow } from "./setting-controls";
import { RunStages } from "./run-parts";
import { useLanePilotPage } from "./use-lp-page";

export function LanePilotPage({ subPath = "", scope = "projects" }: { subPath?: string; scope?: "projects" | "globals" | "agents" | "tokens" | "workflows" | "schedule" }) {
  const {
    pickers,
    activeScope, setActiveScope, rpc, routeProjectId, selectedProjectId, projectId,
    isGlobal, selectedSectionId, setSelectedSectionId, councilDefaults, councilSeatsTouched, fallbackTouched,
    councilsAll, setCouncilsAll, councils, council, openCouncil, sections,
    scoped, projects, projectsLoaded, projectListError, finishing, tab,
    setTab, visited, runsShown, setRunsShown, runsWindow, nativeState,
    data, setData, error, setError, saveError, setSaveError,
    confirmOpen, setConfirmOpen, pendingOp, setPendingOp, snapshotPath, setSnapshotPath,
    detectResult, resultPatch, resultSource, locale, localePreference, settingsDepth,
    setSettingsDepth, shellRef, contentRef, compactChrome, stackControls, dataRef,
    setSelectedBinding, writerRejected, setWriterRejected, chooseLocale, load, loadMoreRuns,
    tabs, diagnosticsGrouped, extrasGrouped, chooseProject, writeDraft, save,
    saveKey, applySetting, resetInherited, displayedValue, saveWriterSelection, saveCouncilSeatSelection, saveWriterFallback, councilSeatPickerValue, pickerValue,
    catalogRow, hostId, routing,
    modelPicker, inheritReset, runStack, finishRuns, jevRows, selectedProjectName,
    selectedSectionName, mobileNavValue, flatSections, tabSelect, advanced, hostLabel,
    nativeHostId, installNative, writerChosen, screenLoading, activeRuns, trackLines,
  } = useLanePilotPage({ subPath, scope });

  return (
    <InheritanceContext.Provider value={{ locale, data, reset: (keys) => void resetInherited(keys) }}><PanelLayoutContext.Provider value={{ compactChrome, stackControls }}><div ref={shellRef} className={`flex h-full min-h-0 min-w-0 flex-1 overflow-hidden ${compactChrome ? "flex-col" : "flex-row"}`} data-testid="project-picker" data-locale={locale} data-lp-chrome={compactChrome ? "compact" : "rail"} data-lp-stack={stackControls ? "1" : "0"} data-bb-ru-skip>
      <div className={compactChrome ? "flex shrink-0 flex-col gap-2 border-b border-border p-2" : "hidden"}>
        <div className="flex items-center gap-2">
          <Select
            value={mobileNavValue}
            onValueChange={(next) => {
              if (next === "globals" || next === "agents" || next === "tokens" || next === "workflows" || next === "schedule") setActiveScope(next);
              else if (next.startsWith("project:")) chooseProject(next.slice("project:".length));
              else if (next.startsWith("section:")) { setActiveScope("projects"); setSelectedSectionId(next.slice("section:".length)); }
            }}
          >
            <SelectTrigger aria-label={t("scopeNav")} className={`${CONTROL_H} min-w-0 flex-1`} data-testid="scope-nav-mobile">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="globals">{t("navGlobals")}</SelectItem>
              <SelectItem value="agents">{t("navAgents")}</SelectItem>
              <SelectItem value="tokens">{t("tabTokens")}</SelectItem>
              <SelectItem value="workflows">{t("navWorkflows")}</SelectItem>
              <SelectItem value="schedule">{t("navSchedule")}</SelectItem>
              {projects.flatMap((project) => [
                <SelectItem key={project.id} value={`project:${project.id}`}>{project.name}</SelectItem>,
                ...(activeScope === "projects" && project.id === projectId ? flatSections.map((section) => (
                  <SelectItem key={section.id} value={`section:${section.id}`} data-testid={`section-option-${section.id}`}>{`${"\u2003".repeat(section.depth)}${section.name}`}</SelectItem>
                )) : []),
              ])}
            </SelectContent>
          </Select>
        </div>
      </div>
      <nav className={compactChrome ? "hidden" : "flex w-[14.5rem] shrink-0 flex-col pt-5 pb-2 pl-6 pr-2"} aria-label={t("scopeNav")} data-testid="scope-rail">
        <div className="flex flex-col gap-1 pb-2" data-testid="scope-nav">
          <Button type="button" role="tab" size="sm" aria-selected={activeScope === "globals"} variant="ghost" className="lp-nav-item h-9 w-full justify-start px-3 text-sm hover:bg-state-hover" onClick={() => setActiveScope("globals")}>{t("navGlobals")}</Button>
          <Button type="button" role="tab" size="sm" aria-selected={activeScope === "agents"} variant="ghost" className="lp-nav-item h-9 w-full justify-start px-3 text-sm hover:bg-state-hover" onClick={() => setActiveScope("agents")}>{t("navAgents")}</Button>
          <Button type="button" role="tab" size="sm" aria-selected={activeScope === "tokens"} variant="ghost" className="lp-nav-item h-9 w-full justify-start px-3 text-sm hover:bg-state-hover" data-testid="scope-nav-tokens" onClick={() => setActiveScope("tokens")}>{t("tabTokens")}</Button>
          <Button type="button" role="tab" size="sm" aria-selected={activeScope === "workflows"} variant="ghost" className="lp-nav-item h-9 w-full justify-start px-3 text-sm hover:bg-state-hover" data-testid="scope-nav-workflows" onClick={() => setActiveScope("workflows")}>{t("navWorkflows")}</Button>
          <Button type="button" role="tab" size="sm" aria-selected={activeScope === "schedule"} variant="ghost" className="lp-nav-item h-9 w-full justify-start px-3 text-sm hover:bg-state-hover" data-testid="scope-nav-schedule" onClick={() => setActiveScope("schedule")}>{t("navSchedule")}</Button>
        </div>
        <div className="border-t border-[var(--lp-hairline)] px-3 pb-1 pt-3"><span className="text-xs font-medium text-muted-foreground">{t("projects")}</span></div>
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {projectListError ? <p role="alert" className="px-2 text-xs text-destructive">{t("projectListError")}</p> : null}
          {!projectsLoaded && !projectListError ? <p className="px-2 text-xs text-muted-foreground">{t("loadingProjects")}</p> : null}
          {projectsLoaded && projects.length === 0 && !projectListError ? <p className="px-2 text-xs text-muted-foreground">{t("noProjects")}</p> : null}
          <div className="flex flex-col gap-0.5">
            {projects.map((project) => <Button
              key={project.id}
              type="button"
              size="sm"
              variant="ghost"
              aria-current={activeScope === "projects" && project.id === projectId && !selectedSectionId ? "page" : undefined}
              data-testid={`project-item-${project.id}`}
              className={`lp-nav-item h-auto w-full justify-start px-3 py-2 text-left hover:bg-state-hover ${activeScope === "projects" && project.id === projectId ? "font-semibold text-foreground" : ""}`}
              onClick={() => chooseProject(project.id)}
            ><span className="min-w-0 truncate text-sm">{project.name}</span></Button>).flatMap((button, index) => {
              const project = projects[index]!;
              if (activeScope !== "projects" || project.id !== projectId || !sections.length) return [button];
              // The selected project's sections, nested as in Project Folders; each keeps its own settings.
              const rows: ReactElement[] = [];
              const walk = (parentId: string | null, depth: number) => {
                for (const section of sections.filter((item) => item.parentId === parentId)) {
                  rows.push(<Button
                    key={section.id}
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-current={section.id === selectedSectionId ? "page" : undefined}
                    data-testid={`section-item-${section.id}`}
                    className="lp-nav-item h-auto w-full justify-start py-1.5 text-left hover:bg-state-hover"
                    style={{ paddingLeft: `${0.5 + depth * 0.75}rem` }}
                    onClick={() => { setActiveScope("projects"); setSelectedSectionId(section.id); }}
                  ><span className="min-w-0 truncate text-xs">{section.name}</span></Button>);
                  walk(section.id, depth + 1);
                }
              };
              walk(null, 1);
              return [button, ...rows];
            })}
          </div>
        </div>
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div ref={contentRef} className={`mx-auto w-full min-w-0 space-y-6 px-4 py-5 ${activeScope === "workflows" || activeScope === "schedule" ? "max-w-5xl" : "max-w-3xl"}`}>
        <OwnedSettings scope={activeScope === "agents" ? "agents" : "projects"} locale={locale} />
        {activeScope === "tokens" ? <TokenUsage projects={projects} /> : null}
        {activeScope === "workflows" ? <WorkflowsScreen locale={locale} projectId={null} architectProjectId={selectedProjectId ?? routeProjectId ?? (subPath || null)} /> : null}
        {activeScope === "schedule" ? <ScheduleBoard projectId={null} projects={projects} locale={locale} /> : null}
        <main hidden={activeScope === "agents" || activeScope === "tokens" || activeScope === "workflows" || activeScope === "schedule"}className="min-w-0 max-w-full space-y-6" data-testid="project-settings">
        {!projectId ? <p className="text-sm text-muted-foreground" data-testid="project-settings-empty">{t("noProjectSelected")}</p> : <>
        <div className="lp-strip">
          {isGlobal ? <>
            <h1 className="break-words text-xl font-medium">{t("navGlobals")}</h1>
            <p className="text-xs text-muted-foreground">{t("globalsHelp")}</p>
            <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="language-setting">
              <LocaleControls preference={localePreference} onChange={(next) => void chooseLocale(next)} />
              <span className="text-xs text-muted-foreground">{t("languageHelp")}</span>
            </div>
          </> : <>
            <p className="text-xs text-muted-foreground">{selectedSectionName ? `${t("selectedSection")} · ${selectedProjectName}` : t("selectedProject")}</p>
            <h1 className="break-words text-xl font-medium">{selectedSectionName ?? selectedProjectName}</h1>
            {selectedSectionName ? <p className="text-xs text-muted-foreground">{t("sectionInheritsHint")}</p> : null}
          </>}
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertTitle>{t("loadError")}</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {saveError ? (() => {
          const titleOnly = saveError.kind === "validation" && (saveError.code === "setup_required" || saveError.code === "writer_binding_ambiguous");
          return (
            <Alert variant="destructive" data-testid={saveError.kind === "cas" ? "cas-conflict" : "setting-validation-error"}>
              <AlertTitle className={titleOnly ? "mb-0 leading-5" : undefined}>
                {saveError.kind === "cas" ? t("casConflict") : validationMessage(saveError.code, saveError.params)}
              </AlertTitle>
              {titleOnly ? null : (
                <AlertDescription>
                  <Button size="sm" variant="outline" onClick={() => void load()}>{t("reload")}</Button>
                </AlertDescription>
              )}
            </Alert>
          );
        })() : null}

        <Tabs value={tab} onValueChange={setTab}>
          {/* Keep the plugin's own EN/RU labels out of BB's DOM-based Russianizer. */}
          {tabSelect ? (
            <Select value={tab} onValueChange={setTab}>
              <SelectTrigger aria-label={t("tabPick")} data-testid="tab-select" className={`${CONTROL_H} w-full min-w-0`}><SelectValue /></SelectTrigger>
              <SelectContent>{tabs.map((id) => <SelectItem key={id} value={id}>{t(TAB_LABELS[id]!)}</SelectItem>)}</SelectContent>
            </Select>
          ) : (
            <TabsList data-bb-ru-skip className="w-full flex-wrap overflow-visible">
              {tabs.map((id) => <TabsTrigger key={id} value={id} className="flex-1 whitespace-nowrap px-2 text-[13px]" data-testid={`tab-${id}`}>{t(TAB_LABELS[id]!)}</TabsTrigger>)}
            </TabsList>
          )}

          <div hidden={!SETTINGS_TABS.has(tab)} className="mt-4 flex" data-testid="settings-toolbar">
              <div className={stackControls ? "lp-seg flex w-full" : "lp-seg shrink-0"} data-testid="settings-depth" aria-label={t("settingsAdvanced")}>
                {(["basic", "advanced"] as const).map((depth) => (
                  <Button key={depth} variant="ghost" className={`lp-seg-item h-[1.875rem] px-3 hover:bg-transparent aria-pressed:bg-[var(--lp-card)] aria-pressed:hover:bg-[var(--lp-card)] ${stackControls ? "min-w-0 flex-1" : ""}`} aria-pressed={settingsDepth === depth} onClick={() => setSettingsDepth(depth)}>{t(depth === "basic" ? "settingsBasic" : "settingsAdvanced")}</Button>
                ))}
              </div>
            </div>
          {tabs.includes("overview") ? <>
          <TabsContent value="overview" forceMount={true} className="space-y-6" hidden={tab !== "overview"} data-testid="overview-panel">
            {visited.current.has("overview") ? <>
            {screenLoading ? <OverviewLoading /> : <>
            <Surface testId="setup-status">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("overviewSetup")}</h2></SurfaceHeader>
              <SurfaceBody className="space-y-3">
                <StatusRow testId="status-writer" state={writerChosen ? "ok" : "todo"} title={t("writerPicker")}
                  detail={writerChosen ? `${String(data?.values[WRITER_PROVIDER])} · ${String(data?.values[WRITER_MODEL])}` : t("overviewWriterMissing")}
                  action={writerChosen ? null : <Button size="sm" variant="outline" onClick={() => setTab("settings")}>{t("overviewOpen")}</Button>} />
                {selectedSectionId ? null : <StatusRow testId="status-stack" state="info" title={t("overviewStack")} detail={t("overviewStackHelp")}
                  action={<Button size="sm" variant="outline" onClick={() => setTab("service")}>{t("overviewOpen")}</Button>} />}
                <StatusRow testId="status-start" state="info" title={t("overviewStart")} detail={t("overviewStartHelp")} />
                {selectedSectionId ? null : <StatusRow testId="status-runs" state={activeRuns ? "ok" : "info"} title={t("tabMonitor")}
                  detail={activeRuns ? t("overviewRuns").replace("{n}", String(activeRuns)) : t("overviewNoRuns")}
                  action={<Button size="sm" variant="outline" onClick={() => setTab("monitor")}>{t("overviewOpen")}</Button>} />}
              </SurfaceBody>
            </Surface>
        {data?.writerBinding && !isGlobal ? (
          <Surface testId="writer-binding">
            <SurfaceHeader><h2 className="text-sm font-medium">{t("projectMachineFolder")}</h2></SurfaceHeader>
            <SurfaceBody className="space-y-2 text-sm">
              {data.writerBinding.status === "resolved" ? (
                <p className="min-w-0 break-all">
                  {hostLabel(data.writerBinding.hostId)} · {data.writerBinding.path}
                  <span className="ml-2 text-xs text-muted-foreground">
                    {data.writerBinding.source === "session" ? t("inheritedFromSession")
                      : data.writerBinding.source === "explicit_override" ? t("inheritedFromProject")
                        : t("inheritedFromProject")}
                  </span>
                </p>
              ) : null}
              {data.writerBinding.status === "ambiguous" ? (
                <Select onValueChange={(next) => {
                  const [hostId, path] = next.split("\u0000");
                  if (!hostId || !path || !projectId) return;
                  setSelectedBinding({ hostId, path });
                  void rpc.call("save_writer_binding", { projectId, hostId, path }).then((result) => {
                    if (result.ok) { setSaveError(null); setWriterRejected(false); void load(); }
                  });
                }}>
                  <SelectTrigger data-testid="writer-binding-select" aria-label={t("projectMachineFolder")}>
                    <SelectValue placeholder={t("bindingAmbiguous")} />
                  </SelectTrigger>
                  <SelectContent>
                    {data.writerBinding.bindings.map((row) => (
                      <SelectItem key={`${row.hostId}:${row.path}`} value={`${row.hostId}\u0000${row.path}`}>
                        {hostLabel(row.hostId)} · {row.path}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {data.writerBinding.status === "setup_required" ? <p>{t("bindingSetupRequired")}</p> : null}
              {data.writerBinding.status === "offline" ? <p>{t("bindingOffline")}</p> : null}
              {data.writerBinding.status === "catalog_unavailable" ? <p>{t("writerCatalogUnavailable")}</p> : null}
              {(data.inheritedKeys ?? []).length ? <p className="text-xs text-muted-foreground">{t("inheritedFromGlobal")}</p> : null}
            </SurfaceBody>
          </Surface>
        ) : null}
        <Surface testId="main-agent">
        <SurfaceHeader><h2 className="text-sm font-medium">{t("mainAgent")}</h2></SurfaceHeader>
        <div className={stackControls ? "lp-panel-body grid gap-2" : "lp-panel-body grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center"}>
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">{t("mainAgentHelp")}</p>
          </div>
          <Select
            value={String(displayedValue("main.agent") ?? "") || "__default__"}
            onValueChange={(next) => {
              const value = next === "__default__" ? "" : next;
              writeDraft("main.agent", value);
              void rpc.call("save_setting", { ...scoped, projectId: projectId!, key: "main.agent", value, expectedVersion: data?.versions["main.agent"] ?? 0 }).then((result) => {
                if (!result.ok) { setSaveError(result.validation ? { kind: "validation", code: result.validation.code, params: result.validation.params } : { kind: "cas" }); return; }
                setSaveError(null);
                setData((current) => {
                  const nextData = current ? { ...current, values: { ...current.values, "main.agent": result.value }, versions: { ...current.versions, "main.agent": result.version }, explicitKeys: value ? [...new Set([...current.explicitKeys, "main.agent"])] : current.explicitKeys.filter((key) => key !== "main.agent") } : current;
                  dataRef.current = nextData;
                  return nextData;
                });
              }).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
            }}
          >
            <SelectTrigger aria-label={t("mainAgent")} className={`${CONTROL_H} min-w-0 max-w-full`}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">{t("mainAgentDefault")}</SelectItem>
              {(data?.mainAgents ?? []).map((agent) => <SelectItem key={agent.id} value={agent.id}>{agentPickerLabel(agent, t)}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        </Surface>
            </>}
            </> : null}
          </TabsContent>
          </> : null}
          <TabsContent value="settings" forceMount={true} className="space-y-6" hidden={tab !== "settings"} data-testid="settings-panel">
            {visited.current.has("settings") ? <>
            <SettingsGroup testId="settings-execution">
              <section className="space-y-2" data-testid="writer-picker">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("writerPicker")}<HelpSup label={t("writerPickerTechnical")}><p>{t("writerPickerTechnical")}</p></HelpSup></h3>
                  </div>
                  {inheritReset([WRITER_PROVIDER, WRITER_MODEL, WRITER_EFFORT, WRITER_SERVICE_TIER])}
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("writerPickerHelp")}</p>
                <div className="max-w-xl">{modelPicker(pickerValue, (next) => { saveWriterSelection(next); })}</div>
                <div className="max-w-xl space-y-3 pt-1" data-testid="writer-fallbacks">
                  <p className="text-xs text-muted-foreground">{t("writerFallbackHelp")}</p>
                  {WRITER_FALLBACK_SLOTS.map((slot, index) => {
                    const keys = writerFallbackKeys(slot);
                    const stored = data?.values[keys.provider];
                    const off = stored === "";
                    const fallback = WRITER_FALLBACK_DEFAULTS[index]!;
                    // A slot turned back on stores its default: it still reads as the default.
                    const configured = typeof stored === "string" && stored !== ""
                      && !(stored === fallback.providerId && data?.values[keys.model] === fallback.model && data?.values[keys.effort] === fallback.reasoningLevel);
                    const value: ExperimentalProviderModelPickerValue = configured
                      ? { providerId:String(stored), model:String(data?.values[keys.model] ?? ""), reasoningLevel:(String(data?.values[keys.effort] ?? "high") || "high") as ExperimentalProviderModelPickerValue["reasoningLevel"] }
                      : { providerId:fallback.providerId, model:fallback.model, reasoningLevel:fallback.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"] };
                    const touch = () => { fallbackTouched.current.add(slot); };
                    return (
                      <div key={slot} className="space-y-1.5" data-testid={`writer-fallback-${slot}`}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="text-sm font-medium">{t(slot === 1 ? "writerFallback1" : "writerFallback2")}</span>
                          <span className="text-xs text-muted-foreground">{off ? t("writerFallbackOffState") : configured ? t("councilSeatOwnSet") : t("writerFallbackDefault")}</span>
                          <Button type="button" size="sm" variant="ghost" className="h-7 px-2" data-testid={`writer-fallback-${slot}-toggle`}
                            onClick={() => void (off ? saveWriterFallback(slot, { providerId:fallback.providerId, model:fallback.model, reasoningLevel:fallback.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"] }) : saveWriterFallback(slot, null))}>
                            {off ? t("writerFallbackTurnOn") : t("writerFallbackTurnOff")}
                          </Button>
                        </div>
                        {off ? null : <div onPointerDownCapture={touch} onKeyDownCapture={touch}>
                          {modelPicker(value, (next) => { if (fallbackTouched.current.has(slot)) void saveWriterFallback(slot, next); })}
                        </div>}
                      </div>
                    );
                  })}
                </div>
                {trackLines.length > 0 ? (
                  <div className="max-w-xl text-xs text-muted-foreground" data-testid="routing-hints">
                    <div className="font-medium">{t("routingHintTitle")}</div>
                    {trackLines.map((row) => <div key={row.risk}>{row.text}</div>)}
                  </div>
                ) : null}
                {writerRejected && saveError ? <p className="max-w-xl text-xs text-destructive" data-testid="writer-save-error">{saveError.kind === "cas" ? t("casConflict") : validationMessage(saveError.code, saveError.params)}</p> : null}
                {(() => {
                  const effortRow = jevRows.find((row) => row.storageKey === "jev.LANE_JEV_EFFORT");
                  const automaticEffort = asBoolean(displayedValue("jev.LANE_JEV_EFFORT"), true);
                  return effortRow ? <AdvancedRows show={advanced} testId="writer-effort-mode">
                    <div className="flex items-center justify-between gap-2 pt-2">
                      <Label className="text-sm" htmlFor="writer-effort-mode">{t("writerEffortMode")}</Label>
                      <Select value={automaticEffort ? "automatic" : "manual"} onValueChange={(next) => void applySetting(effortRow, next === "automatic" ? "1" : "0")}>
                        <SelectTrigger id="writer-effort-mode" aria-label={t("writerEffortMode")} className="w-[11rem] min-w-0 max-w-full"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="automatic">{t("writerEffortAutomatic")}</SelectItem>
                          <SelectItem value="manual">{t("writerEffortManual")}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                    <p className="max-w-xl text-xs text-muted-foreground">{automaticEffort ? t("writerEffortFallbackNote") : t("writerEffortManualNote")}</p>
                    <div className="space-y-2" data-testid="jev-settings">
                      {jevRows.filter((row) => row.storageKey !== "jev.LANE_JEV_EFFORT").map((row) => {
                        const label = t("jevOpencode");
                        return <div key={row.storageKey} className="flex items-center justify-between gap-2">
                          <Label className="text-sm" htmlFor={row.id}>{label}</Label>
                          <Switch id={row.id} checked={asBoolean(displayedValue(row.storageKey), true)} aria-label={label}
                            onCheckedChange={(next) => void applySetting(row, next ? "1" : "0")} />
                        </div>;
                      })}
                    </div>
                    {(["writer.agent","sandbox.backend","verification.sandbox_unsafe","secrets.allow"] as const).map((key) => {
                      const row = catalogRow(key);
                      return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                        onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                    })}
                  </AdvancedRows> : null;
                })()}
              </section>
              <section className="space-y-2" data-testid="settings-group-workspace">
                {(() => { const row = catalogRow("adoc.040"); return row ? <SettingField row={row} value={displayedValue("adoc.040")} disabled={false}
                  onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("adoc.040", next)} /> : null; })()}
                <AdvancedRows show={advanced}>
                  {(["adoc.041","adoc.042","workspace.provider","ops.max_tasks"] as const).map((key) => {
                    const row = catalogRow(key);
                    return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                      onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                  })}
                </AdvancedRows>
              </section>
            </SettingsGroup>

            <div hidden={!advanced}><SettingsGroup title={t("sectionHelperContext")} testId="settings-helper-context" help={<HelpSup label={t("helperContextTechnical")}><p>{t("helperContextTechnical")}</p><p className="mt-1">{t("helperContextNoneNote")}</p></HelpSup>}>
              <section className="space-y-2" data-testid="helper-context-settings">
                <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextHelp")}</p>
                <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextConstraint")}</p>
                {(() => { const row = catalogRow("helper.placement"); return row ? <SettingField row={row} value={displayedValue("helper.placement")} disabled={false} onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("helper.placement", next)} /> : null; })()}
              </section>
            </SettingsGroup></div>
            {extrasGrouped.filter((group) => group.section !== "night-review" && group.section !== "browser-qa").map(({ section, rows }) => (
              <section key={section} className="space-y-2" data-testid={`settings-group-${section}`}>
                <h3 className="text-sm font-medium">{t(sectionKey(section))}</h3>
                <div className="space-y-2">
                  {rows.map((row) => (
                    <SettingField
                      key={row.storageKey}
                      row={row}
                      value={displayedValue(row.storageKey)}
                      disabled={false}
                      onChange={(next) => void applySetting(row, next)}
                      onDraft={(next) => writeDraft(row.storageKey, next)}
                    />
                  ))}
                </div>
              </section>
            ))}
            </> : null}
          </TabsContent>

          <TabsContent value="memory" forceMount={true} className="space-y-6" hidden={tab !== "memory"} data-testid="memory-panel">
            {visited.current.has("memory") ? <>
            <SettingsGroup testId="settings-memory-docs">
              <section className="space-y-2" data-testid="memory-picker">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("settingMemoryEnabled")}<HelpSup label={t("memoryPickerTechnical")}><p>{t("memoryPickerTechnical")}</p></HelpSup></h3>
                  </div>
                  <div className="flex items-center gap-2">
                    {inheritReset([MEMORY_PROVIDER, MEMORY_MODEL, MEMORY_EFFORT, MEMORY_SERVICE_TIER])}
                    {(() => { const row = catalogRow("memory.enabled"); return row ? <Switch checked={asBoolean(displayedValue("memory.enabled"), false)} aria-label={t("settingMemoryEnabled")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
                  </div>
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("memoryPickerHelp")}</p>
                <div className="max-w-xl">{modelPicker(pickers.memory.value, (next) => { void pickers.memory.save(next); })}</div>
                {activeScope !== "globals" && projectId ? <MemoryRecords projectId={projectId} /> : null}
                <AdvancedRows show={advanced} testId="memory-advanced">
                  {(["memory.maintain","memory.inject","memory.audience","memory.search_engine","memory.personal_bot","memory.core_budget","memory.note_budget","memory.index_budget","memory.context_budget"] as const).map((key) => {
                    const row = catalogRow(key);
                    return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                      onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                  })}
                </AdvancedRows>
              </section>
              <section className="space-y-2" data-testid="docs-picker">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("groupDocs")}<HelpSup label={t("docsPickerTechnical")}><p>{t("docsPickerTechnical")}</p></HelpSup></h3>
                  </div>
                  {(() => {
                    const row = catalogRow("docs.enabled");
                    if (!row) return null;
                    const raw = displayedValue("docs.enabled");
                    const mode = raw === undefined || raw === null || raw === "" || raw === "auto" ? "auto" : asBoolean(raw, false) ? "true" : "false";
                    return <Select value={mode} onValueChange={(next) => void applySetting(row, next)}>
                      <SelectTrigger aria-label={t("groupDocs")} data-testid="docs-mode" className="w-[11rem] min-w-0 max-w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="auto">{t("docsModeAuto")}</SelectItem>
                        <SelectItem value="true">{t("docsModeOn")}</SelectItem>
                        <SelectItem value="false">{t("docsModeOff")}</SelectItem>
                      </SelectContent>
                    </Select>;
                  })()}
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("docsPickerHelp")}</p>
                {activeScope !== "globals" && projectId ? <DocsPlaces projectId={projectId} /> : null}
                <div className="max-w-xl">{modelPicker(pickers.docs.value, (next) => { void pickers.docs.save(next); })}</div>
                <AdvancedRows show={advanced}>
                  {(["docs.maintain","docs.page_cap","docs.since","docs.hour"] as const).map((key) => {
                    const row = catalogRow(key);
                    return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                      onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                  })}
                </AdvancedRows>
              </section>
              <section className="space-y-2" data-testid="project-life-picker">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("groupProjectLife")}<HelpSup label={t("projectLifePickerTechnical")}><p>{t("projectLifePickerTechnical")}</p></HelpSup></h3>
                  </div>
                  {(() => { const row = catalogRow("project_life.enabled"); return row ? <Switch checked={asBoolean(displayedValue("project_life.enabled"), true)} aria-label={t("groupProjectLife")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("projectLifePickerHelp")}</p>
                <div className="max-w-xl">{modelPicker(pickers.projectLife.value, (next) => { void pickers.projectLife.save(next); })}</div>
              </section>
              <section className="space-y-2" data-testid="onboarding-picker">
                <div className="flex min-w-0 items-center gap-1">
                  <h3 className="text-sm font-medium">{t("onboardingPicker")}<HelpSup label={t("onboardingPickerHelp")}><p>{t("onboardingConstraint")}</p></HelpSup></h3>
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingPickerHelp")}</p>
                <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingConstraint")}</p>
                <div className="max-w-xl">{modelPicker(pickers.onboarding.value, (next) => { void pickers.onboarding.save(next); })}</div>
                <AdvancedRows show={advanced}>
                  {(() => { const row = catalogRow("onboarding.depth"); return row ? <SettingField row={row} value={displayedValue("onboarding.depth")} disabled={false} onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("onboarding.depth", next)} /> : null; })()}
                </AdvancedRows>
              </section>
              <section className="space-y-2" data-testid="pm-read-settings">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <h3 className="text-sm font-medium">{t("largeFileRead")}<HelpSup label={t("largeFileReadTechnical")}><p>{t("largeFileReadTechnical")}</p></HelpSup></h3>
                  </div>
                  {(() => { const row = catalogRow("pm_read.enabled"); return row ? <Switch checked={asBoolean(displayedValue("pm_read.enabled"), false)} aria-label={t("largeFileRead")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadHelp")}</p>
                <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadConstraint")}</p>
                <div className="max-w-xl">{modelPicker(pickers.pmRead.value, (next) => { void pickers.pmRead.save(next); })}</div>
                <AdvancedRows show={advanced}>
                  {(() => { const row = catalogRow("pm_read.min_lines"); return row ? <SettingField row={row} value={displayedValue("pm_read.min_lines")} disabled={false} onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("pm_read.min_lines", next)} /> : null; })()}
                </AdvancedRows>
              </section>
            </SettingsGroup>

            </> : null}
          </TabsContent>
          <TabsContent value="access" forceMount={true} className="space-y-6" hidden={tab !== "access"} data-testid="access-panel">
            {visited.current.has("access") ? <>
            {projectId ? <AgentAccess projectId={projectId} sectionId={selectedSectionId} parentSectionId={sections.find((item) => item.id === selectedSectionId)?.parentId ?? null} refreshKey={data?.versions["helper.context_mode"] ?? 0}
              modeControl={<div className="space-y-2" data-testid="access-mode-fields">
                {(["helper.context_mode", ...(displayedValue("helper.context_mode") === "selected" ? ["helper.skills", "helper.mcp_servers", "helper.bb_plugins", "helper.native_plugins"] : [])] as const).map((key) => {
                  const row = catalogRow(key);
                  return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                    onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                })}
              </div>} /> : null}
            </> : null}
          </TabsContent>

          {tabs.includes("anamnesis") ? <>
          <TabsContent value="anamnesis" forceMount={true} className="space-y-6" hidden={tab !== "anamnesis"} data-testid="anamnesis-panel">
            {visited.current.has("anamnesis") ? <AnamnesisTab /> : null}
          </TabsContent>
          </> : null}
          {tabs.includes("rules") ? <>
          <TabsContent value="rules" forceMount={true} className="space-y-6" hidden={tab !== "rules"} data-testid="rules-panel">
            {visited.current.has("rules") ? <>
            {!isGlobal && projectId ? <RuleProposals projectId={projectId} picker={modelPicker} /> : null}
            </> : null}
          </TabsContent>
          </> : null}
          {tabs.includes("schedule") ? <>
          <TabsContent value="schedule" forceMount={true} className="space-y-6" hidden={tab !== "schedule"} data-testid="schedule-panel">
            {visited.current.has("schedule") && !isGlobal && projectId ? <ScheduleBoard projectId={projectId} projects={projects} locale={locale} /> : null}
          </TabsContent>
          </> : null}
          {tabs.includes("workflows") ? <>
          <TabsContent value="workflows" forceMount={true} className="space-y-6" hidden={tab !== "workflows"} data-testid="workflows-panel">
            {visited.current.has("workflows") ? <>
            {tab === "workflows" && !isGlobal && projectId ? <WorkflowsScreen locale={locale} projectId={projectId} /> : null}
            </> : null}
          </TabsContent>
          </> : null}
          <TabsContent value="checks" forceMount={true} className="space-y-6" hidden={tab !== "checks"} data-testid="checks-panel">
            {visited.current.has("checks") ? <>
            {!isGlobal && projectId ? <WriterReuse projectId={projectId} /> : null}
            {!isGlobal && projectId ? <CriticValue projectId={projectId} /> : null}
            {!isGlobal && projectId ? <AcceptanceStats projectId={projectId} /> : null}
            {(() => { const row = catalogRow("quality_mode"); return row ? <SettingField row={row} value={displayedValue("quality_mode")} disabled={false}
              onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("quality_mode", next)} /> : null; })()}
            <CheckGroup testId="plan-critique-settings" title={t("stagePlanCritique")} help={t("planCritiqueHelp")} toggle={(() => { const row = catalogRow("plan_critique.enabled"); return row ? <Switch checked={asBoolean(displayedValue("plan_critique.enabled"), true)} aria-label={t("stagePlanCritique")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}>
              <div className="max-w-xl">{modelPicker(pickers.planCritique.value, (next) => { void pickers.planCritique.save(next); })}</div>
              <AdvancedRows show={advanced}>
                {(["plan_critique.mode","plan_critique.min_score","plan_critique.min_write_tasks","plan_critique.on_high_risk"] as const).map((key) => {
                  const row = catalogRow(key);
                  return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                    onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                })}
              </AdvancedRows>
            </CheckGroup>
            <CheckGroup testId="code-critique-settings" title={t("stageCodeCritique")} help={t("codeCritiqueHelp")} toggle={(() => { const row = catalogRow("code_critique.enabled"); return row ? <Switch checked={asBoolean(displayedValue("code_critique.enabled"), false)} aria-label={t("stageCodeCritique")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}>
              <div className="max-w-xl">{modelPicker(pickers.codeCritique.value, (next) => { void pickers.codeCritique.save(next); })}</div>
              <AdvancedRows show={advanced}>
                {(["code_critique.mode","code_critique.auto_fix","code_critique.max_rounds"] as const).map((key) => {
                  const row = catalogRow(key);
                  return row ? <SettingField key={key} row={row} value={displayedValue(key)} disabled={false}
                    onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft(key, next)} /> : null;
                })}
              </AdvancedRows>
            </CheckGroup>
            <CheckGroup testId="specialist-settings" title={t("specialistReview")} help={t("settingSpecialistEnabledHelp")} toggle={(() => { const row = catalogRow("specialist.enabled"); return row ? <Switch checked={asBoolean(displayedValue("specialist.enabled"), false)} aria-label={t("specialistReview")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}>
              <div className="max-w-xl">{modelPicker(pickers.specialist.value, (next) => { void pickers.specialist.save(next); })}</div>
              <AdvancedRows show={advanced}>
                {(() => { const row = catalogRow("specialist.when"); return row ? <SettingField row={row} value={displayedValue("specialist.when")} disabled={false}
                  onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("specialist.when", next)} /> : null; })()}
              </AdvancedRows>
            </CheckGroup>
            <CheckGroup testId="night-review-settings" title={t(sectionKey("night-review"))} help={t("nightReviewEnabled")} toggle={
              <Switch id="night-review-enabled" checked={asBoolean(displayedValue("night_review.enabled"),false)} aria-label={t("nightReviewEnabled")}
                onCheckedChange={(next)=>{const row=VISIBLE_CATALOG.find((item)=>item.storageKey==="night_review.enabled");if(row)void applySetting(row,next);}} />
            }>
              <div className="max-w-xl">{modelPicker(pickers.night.value, (next) => { void pickers.night.save(next); })}</div>
              <AdvancedRows show={advanced}>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <span><Label className="text-sm" htmlFor="night-review-auto-merge">{t("nightReviewAutoMerge")}</Label><HelpSup label={t("nightReviewAutoMergeHelp")}><p>{t("nightReviewAutoMergeHelp")}</p></HelpSup></span>
                  </div>
                  <Switch id="night-review-auto-merge" checked={asBoolean(displayedValue("night_review.auto_merge"),false)} aria-label={t("nightReviewAutoMerge")}
                    onCheckedChange={(next)=>{const row=VISIBLE_CATALOG.find((item)=>item.storageKey==="night_review.auto_merge");if(row)void applySetting(row,next);}} />
                </div>
                {(() => { const row = catalogRow("night_review.max_fix_tasks"); return row ? <SettingField row={row} value={displayedValue("night_review.max_fix_tasks")} disabled={false} onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("night_review.max_fix_tasks", next)} /> : null; })()}
              </AdvancedRows>
            </CheckGroup>
            <CheckGroup testId="browser-qa-host" title={t("globalQaHost")} help={t("browserQaHostHelp")} toggle={(() => { const row = catalogRow("browser_qa.enabled"); return row ? <Switch checked={asBoolean(displayedValue("browser_qa.enabled"), false)} aria-label={t("globalQaHost")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}>
              {(() => {
                const options = data?.qaHosts ?? [];
                const current = String(displayedValue(QA_HOST_KEY) ?? "");
                const known = options.some((host) => host.id === current);
                if (!options.length) return <p className="text-sm text-muted-foreground">{t("browserQaHostNone")}</p>;
                return <Select value={known ? current : current ? current : "__inherit__"} onValueChange={(next) => { if (next === "__inherit__") void resetInherited([QA_HOST_KEY]); else void saveKey(QA_HOST_KEY, next); }}>
                  <SelectTrigger aria-label={t("globalQaHost")} data-testid="browser-qa-host-select" className="min-w-0 max-w-xl">
                    <SelectValue placeholder={t("inheritChoice")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__inherit__">{t("inheritChoice")}</SelectItem>
                    {options.map((host) => (
                      <SelectItem key={host.id} value={host.id}>{host.name} · {host.connected ? t("hostConnected") : t("hostOffline")}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>;
              })()}
              {displayedValue(QA_HOST_KEY) && !(data?.qaHosts ?? []).some((host) => host.id === displayedValue(QA_HOST_KEY)) ? <p className="text-xs text-muted-foreground">{t("hostUnavailable")}</p> : null}
              <AdvancedRows show={advanced}>
                <Label htmlFor="browser-qa-workspace">{t("browserQaWorkspace")}</Label>
                <Input
                  id="browser-qa-workspace"
                  data-testid="browser-qa-workspace"
                  value={String(displayedValue(QA_WORKSPACE_KEY) ?? "")}
                  placeholder={data?.workspacePath ?? "/"}
                  onChange={(event) => writeDraft(QA_WORKSPACE_KEY, event.target.value)}
                  onBlur={(event) => void saveKey(QA_WORKSPACE_KEY, event.target.value)}
                />
                {extrasGrouped.filter((group) => group.section === "browser-qa").flatMap((group) => group.rows.filter((row) => row.storageKey !== "browser_qa.enabled")).map((row) => (
                  <SettingField
                    key={row.storageKey}
                    row={row}
                    value={displayedValue(row.storageKey)}
                    disabled={false}
                    onChange={(next) => void applySetting(row, next)}
                    onDraft={(next) => writeDraft(row.storageKey, next)}
                  />
                ))}
              </AdvancedRows>
            </CheckGroup>
            </> : null}
          </TabsContent>

          <TabsContent value="council" forceMount={true} className="space-y-6" hidden={tab !== "council"} data-testid="council-panel">
            {visited.current.has("council") ? <>
            <CheckGroup testId="council-settings" title={t("councilSettingsTitle")} help={t("councilSettingsHelp")} toggle={(() => { const row = catalogRow("council.judge"); return row ? <Switch checked={asBoolean(displayedValue("council.judge"), true)} aria-label={t("settingCouncilJudge")} onCheckedChange={(next) => void applySetting(row, next)} /> : null; })()}>
              {COUNCIL_SEATS.map((seat) => {
                const fallback = councilDefaults.find((row) => row.id === seat);
                const configured = Boolean(data?.values[`council.${seat}.provider`] && data?.values[`council.${seat}.model`]);
                const keys = [`council.${seat}.provider`, `council.${seat}.model`, `council.${seat}.reasoning_effort`];
                const value: ExperimentalProviderModelPickerValue = configured ? councilSeatPickerValue(seat)
                  : { providerId: fallback?.providerId ?? "", model: fallback?.model ?? "", reasoningLevel: "high" };
                const touch = () => { councilSeatsTouched.current.add(seat); };
                return (
                  <div key={seat} className="space-y-1.5" data-testid={`council-seat-${seat}`}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-medium">{t(`settingCouncilSeat_${seat}` as I18nKey)}</span>
                      <span className="text-xs text-muted-foreground">{configured ? t("councilSeatOwnSet") : fallback?.providerId && fallback.model ? t("councilSeatFromStages") : t("councilSeatNoPair")}</span>
                      {configured ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => void resetInherited(keys)}>{t("councilSeatInherit")}</Button> : null}
                    </div>
                    <div className="max-w-xl" onPointerDownCapture={touch} onKeyDownCapture={touch}>
                      {modelPicker(value, (next) => { if (councilSeatsTouched.current.has(seat)) void saveCouncilSeatSelection(seat, next); })}
                    </div>
                  </div>
                );
              })}
              {(() => { const row = catalogRow("council.max_rounds"); return row ? <SettingField row={row} value={displayedValue("council.max_rounds")} disabled={false}
                onChange={(next) => void applySetting(row, next)} onDraft={(next) => writeDraft("council.max_rounds", next)} /> : null; })()}
            </CheckGroup>
            {isGlobal ? null : <section className="lp-card min-w-0 space-y-2 p-3" data-testid="council-feed" data-bb-ru-skip>
              <h3 className="text-sm font-medium">{t("councilSessions")}</h3>
              {!councils.length ? <p className="text-xs text-muted-foreground">{t("councilEmpty")}</p> : (
                <>
                <ul className="-mx-1 space-y-0.5">
                  {(councilsAll ? councils : councils.slice(0, 5)).map((row) => {
                    // WebKit ignores line clamping on the button itself, so the clamp sits on an inner span.
                    const pill = row.state === "done" ? "lp-pill-success" : row.state === "failed" || row.state === "stopped" ? "lp-pill-danger" : "lp-pill-info";
                    return (
                      <li key={row.id}>
                        <button type="button" aria-current={council?.id === row.id ? "true" : undefined} className="w-full min-w-0 rounded-lg px-2 py-2 text-left hover:bg-state-hover aria-[current=true]:bg-state-active" onClick={() => openCouncil(row.id)}>
                          <span className="line-clamp-2 text-sm [overflow-wrap:anywhere]">{row.question}</span>
                          <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                            <span className={`rounded-full px-2 py-0.5 font-medium ${pill}`}>{t(`councilState_${row.state}` as I18nKey) || row.state}</span>
                            {t("councilRound")} {row.round}/{row.maxRounds}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {councils.length > 5 ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => setCouncilsAll((all) => !all)}>{councilsAll ? t("councilShowLess") : t("councilShowAll").replace("{n}", String(councils.length))}</Button> : null}
                </>
              )}
              {council ? (
                <div className="space-y-2 border-t border-[var(--lp-hairline)] pt-2 text-sm" data-testid="council-detail">
                  <div className="text-xs text-muted-foreground">{council.seats.map((seat) => `${seat.title}${seat.providerId && seat.model ? ` (${seat.providerId}/${seat.model})` : ""}`).join(" · ")}</div>
                  {council.agenda.length ? <ol className="list-decimal pl-5 text-xs">{council.agenda.map((item) => <li key={item}>{item}</li>)}</ol> : null}
                  <div className="max-h-96 space-y-2 overflow-y-auto">
                    {council.messages.map((message) => (
                      <div key={message.seq} className="rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-well)] p-2">
                        <div className="text-xs font-medium">{council.seats.find((seat) => seat.id === message.seatId)?.title ?? message.seatId} · {t("councilRound")} {message.round} · {message.kind}</div>
                        <div className="whitespace-pre-wrap break-words text-xs">{message.text}</div>
                      </div>
                    ))}
                  </div>
                  {council.recommendation ? <div className="text-xs"><span className="font-medium">{t("councilDecision")}: </span>{council.recommendation}{council.decisionPath ? ` (${council.decisionPath})` : ""}</div> : null}
                  {council.reason ? <div className="text-xs text-destructive">{council.reason}</div> : null}
                </div>
              ) : null}
            </section>}
            </> : null}
          </TabsContent>
          {tabs.includes("monitor") ? <>
          <TabsContent value="monitor" forceMount={true} className="space-y-4" data-testid="run-monitor" hidden={tab !== "monitor"}>
            {visited.current.has("monitor") ? <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button size="sm" variant="outline" onClick={() => projectId && void rpc.call("resume_runs", { projectId }).then(load)}>
                {t("resume")}
              </Button>
              <span className="text-xs text-muted-foreground">{t("runsResumeHelp")}</span>
            </div>
            {!data?.runs.length ? (
              <p className="text-sm text-muted-foreground">{t("emptyRuns")}</p>
            ) : (() => {
              const open = (run: MonitorRun) => run.state === "pending" || run.state === "running";
              // Runs in progress first, then the newest; the history opens 20 at a time.
              const ordered = [...data.runs].sort((a, b) => Number(open(b)) - Number(open(a)) || b.updated_at - a.updated_at);
              return <>
                <div className="space-y-3" data-testid="run-list">
                  {ordered.slice(0, runsShown).map((run) => {
                    const hasOpenAttempt = run.attempts.some((item) => OPEN_ATTEMPT_STATES.includes(item.state));
                    return <Surface key={run.id} testId={`run-${run.id}`}>
                      <SurfaceHeader className="flex-wrap justify-between">
                        <div className="flex min-w-0 items-center gap-2">
                          {run.pmThread?.title
                            ? <span className="min-w-0 truncate text-sm font-medium" title={run.id}>{run.pmThread.title}</span>
                            : <span className="min-w-0 truncate font-mono text-xs" title={run.id}>{run.id}</span>}
                          <Badge variant={runTone(run.state)}>{stateLabel(run.state)}</Badge>
                          {run.pmThread?.status ? <span className="shrink-0 text-xs text-muted-foreground">{t(run.pmThread.status === "active" ? "runChatActive" : run.pmThread.status === "gone" ? "runChatGone" : "runChatIdle")}</span> : null}
                        </div>
                        <span className="text-xs text-muted-foreground">{run.kind}{run.updated_at > 1e11 ? ` · ${new Date(run.updated_at).toLocaleString(locale)}` : ""}</span>
                      </SurfaceHeader>
                      <SurfaceBody className="space-y-2">
                        {run.attempts.map((attempt) => (
                          <div key={attempt.id} data-testid={`attempt-${attempt.id}`} className="flex min-w-0 items-center gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-xs" title={attempt.task_id}>{attempt.task_id}</div>
                              <div className="text-xs text-muted-foreground">{t("attempt")} {attempt.attempt_no || "—"}</div>
                            </div>
                            <Badge className="shrink-0" variant={runTone(run.state === "closed" ? run.state : attempt.state)}>{stateLabel(run.state === "closed" ? run.state : attempt.state)}</Badge>
                            {canCancelAttempt(run, attempt) ? <Button size="sm" variant="outline" onClick={() => void rpc.call("cancel_attempt", { attemptId: attempt.id }).then(load)}>{t("cancel")}</Button> : null}
                            {canRetryAttempt(run, attempt) ? <Button size="sm" variant="outline" onClick={() => void rpc.call("retry_attempt", { attemptId: attempt.id }).then(load)}>{t("retry")}</Button> : null}
                          </div>
                        ))}
                        {run.state !== "closed" && !hasOpenAttempt ? <Button size="sm" variant="outline" onClick={() => void finishRuns(run.id)} disabled={finishing}>{finishing ? t("finishRunBusy") : t("finishRun")}</Button> : null}
                        {run.stageCount ? <RunStages runId={run.id} count={run.stageCount} /> : null}
                      </SurfaceBody>
                    </Surface>;
                  })}
                </div>
                {ordered.length > runsShown || (data.runsTotal ?? 0) > runsWindow.current ? <Button size="sm" variant="outline" data-testid="runs-show-more" onClick={() => { setRunsShown((count) => count + RUNS_PAGE); if ((data.runsTotal ?? 0) > runsWindow.current) void loadMoreRuns(); }}>{t("runsShowMore").replace("{n}", String(Math.min(RUNS_PAGE, Math.max(ordered.length - runsShown, (data.runsTotal ?? 0) - runsWindow.current))))}</Button> : null}
              </>;
            })()}
            <p className="sr-only">{[...RUN_STATES, ...ATTEMPT_STATES].join(" ")}</p>
            </> : null}
          </TabsContent>
          </> : null}

          {tabs.includes("service") ? <>
          <TabsContent value="service" forceMount={true} className="space-y-5" hidden={tab !== "service"} data-testid="service-panel">
            {visited.current.has("service") ? <>
            <section className="space-y-4" data-testid="install-panel">
            <Surface testId="native-install">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("nativeTitle").replace("{host}", hostLabel(nativeHostId))}</h2></SurfaceHeader>
              <SurfaceBody className="space-y-3">
                {!nativeHostId ? <p className="text-sm text-muted-foreground">{t("nativeNoMachine")}</p>
                  : !nativeState ? <p className="text-sm text-muted-foreground">{t("nativeChecking")}</p>
                  : <>
                    <StatusRow testId="native-install-state"
                      state={nativeState.status === "enabled" ? "ok" : nativeState.status === "installing" ? "info" : "todo"}
                      title={nativeState.status === "enabled" ? t("nativeEnabled") : nativeState.status === "installing" ? t("nativeInstalling") : nativeState.status === "offline" ? t("nativeOffline") : t("nativeAbsent")}
                      detail={nativeState.error && nativeState.status !== "enabled" ? <span className="text-destructive">{t("nativeError").replace("{error}", nativeState.error)}</span> : null} />
                    {/* The only action here, and only when the machine answers and Lane Pilot is missing there. */}
                    {nativeState.status !== "enabled" && nativeState.status !== "installing" && nativeState.status !== "offline"
                      ? <Button size="sm" data-testid="native-install-now" onClick={() => void installNative()}>{nativeState.error ? t("nativeRetry") : t("nativeInstallNow")}</Button> : null}
                  </>}
              </SurfaceBody>
            </Surface>
            {data?.legacyStack ? <Disclosure testId="legacy-stack" summary={t("legacyStackTitle")}>
              <p className="text-xs text-muted-foreground">{t("legacyStackHelp")}</p>
              <div className="space-y-2" data-testid="stack-actions">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <Button size="sm" variant="outline" className="w-full sm:w-52" data-testid="stack-detect" onClick={() => void runStack("detect")}>{t("detect")}</Button>
                  <span className="text-xs text-muted-foreground">{t("detectHelp")}</span>
                </div>
                {detectResult && (!detectResult.laneStack.present || !detectResult.matchesTarget) ? <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <Button size="sm" className="w-full sm:w-52" data-testid="install-stack" onClick={() => { setPendingOp("install"); setConfirmOpen(true); }}>{detectResult.laneStack.present ? t("updateStack") : t("install")}</Button>
                  <span className="text-xs text-muted-foreground">{t("installHelp")}</span>
                </div> : null}
                {detectResult?.openCode.present && !detectResult.coexistence?.managers.some((row) => row.manager === "opencode-plugin" && row.configured) ? <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <Button size="sm" variant="outline" className="w-full sm:w-52" data-testid="connect-opencode" onClick={() => { setPendingOp("connect"); setConfirmOpen(true); }}>{t("connectOpencode")}</Button>
                  <span className="text-xs text-muted-foreground">{t("connectHelp")}</span>
                </div> : null}
              </div>
              {detectResult ? <Card data-testid="stack-detect-result">
                <CardHeader className={CARD_HEAD}><CardTitle className="text-sm font-medium">{t("detectResult")}</CardTitle></CardHeader>
                <CardContent className={`${CARD_BODY} grid gap-2 text-sm sm:grid-cols-2`}>
                  <div><span className="text-muted-foreground">{t("detectScenario")}:</span> {detectResult.scenario}</div>
                  <div><span className="text-muted-foreground">{t("detectTargetMatch")}:</span> {detectResult.matchesTarget ? t("yes") : t("no")} ({t("targetMatchInformational")})</div>
                  <div><span className="text-muted-foreground">{t("detectLaneStack")}:</span> {detectResult.laneStack.present ? detectResult.laneStack.version ?? t("unknown") : t("no")}</div>
                  <div><span className="text-muted-foreground">{t("detectOpenCode")}:</span> {detectResult.openCode.present ? `${t("yes")} (${detectResult.openCode.version ?? t("unknown")})` : t("no")}</div>
                </CardContent>
              </Card> : null}
              {detectResult?.coexistence ? <Card data-testid="coexistence-inventory">
                <CardHeader className={CARD_HEAD}><CardTitle className="text-sm font-medium">{t("coexInventory")}</CardTitle></CardHeader>
                <CardContent className={`${CARD_BODY} divide-y divide-border`}>
                  {detectResult.coexistence.managers.map((manager) => (
                    <div key={`${manager.manager}-${manager.path}`} className="space-y-2 py-3 first:pt-0 last:pb-0" data-testid={`coex-${manager.manager}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{t(COEXISTENCE_MANAGER_KEYS[manager.manager] ?? "coexUnknownManager")}</span>
                        <Badge variant={manager.compatible === false ? "destructive" : manager.decision === "reuse" ? "default" : "outline"}>{t(COEXISTENCE_VALUE_KEYS[manager.decision] ?? "coexDecisionUnknown")}</Badge>
                      </div>
                      <div className="break-all font-mono text-xs">{manager.path}</div>
                      <div className="grid gap-1 text-xs sm:grid-cols-2">
                        <span>{t("coexInstalled")}: {manager.installed ? t("yes") : t("no")}</span>
                        <span>{t("coexConfigured")}: {manager.configured ? t("yes") : t("no")}</span>
                        <span>{t("coexLoaded")}: {manager.loaded === null ? t("coexRuntimeUnverified") : manager.loaded ? t("yes") : t("no")}</span>
                        <span>{t("coexCompatible")}: {manager.compatible === null ? t("unknown") : manager.compatible ? t("yes") : t("no")}</span>
                        <span>{t("coexModified")}: {manager.modified === null ? t("unknown") : manager.modified ? t("yes") : t("no")}</span>
                        <span>{t("coexOwner")}: {t(COEXISTENCE_VALUE_KEYS[manager.owner] ?? "coexOwnerUnknown")}</span>
                        {manager.version ? <span>{t("version")}: {manager.version}</span> : null}
                      </div>
                      {manager.missingCapabilities.length ? <p className="text-xs text-destructive">{t("coexMissingCapabilities")}: {manager.missingCapabilities.join(", ")}</p> : null}
                      <Disclosure compact summary={`${t("coexEvidence")} (${manager.evidence.length})`}>
                        <ul className="space-y-1">{manager.evidence.map((evidence, index) => <li key={`${evidence.kind}-${index}`} className="break-words">{evidence.detail}{evidence.sha256 ? ` · SHA-256 ${evidence.sha256.slice(0, 12)}` : ""}</li>)}</ul>
                      </Disclosure>
                    </div>
                  ))}
                </CardContent>
              </Card> : null}
              {snapshotPath || data.lastSnapshotPath ? <div className="space-y-1 border-t border-[var(--lp-hairline)] pt-3" data-testid="rollback-zone">
                <p className="text-xs font-medium">{t("rollbackTitle")}</p>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <Button size="sm" variant="destructive" className="w-full sm:w-52" data-testid="stack-rollback" onClick={() => { setPendingOp("rollback"); setConfirmOpen(true); }}>{t("rollback")}</Button>
                  <span className="text-xs text-muted-foreground">{t("rollbackHelp")}</span>
                </div>
              </div> : null}
            </Disclosure> : null}
            </section>
            <Disclosure testId="diagnostics-disclosure" summary={t("serviceTechnical")}>
              <div className="space-y-5" data-testid="diagnostics-panel">
            <p className="text-xs text-muted-foreground">{t("diagnosticsIntro")}</p>
            <Card>
              <CardHeader className={CARD_HEAD}><CardTitle className="text-sm font-medium">{t("importDetails")}</CardTitle></CardHeader>
              <CardContent className={`${CARD_BODY} space-y-1 text-xs text-muted-foreground`} data-testid="import-diagnostics">
                {data?.importSource.completed ? <>
                  <p>{t("importRouting")}: {data.importSource.routingPath ?? "—"}</p>
                  <p>{t("importNight")}: {data.importSource.nightPath ?? "—"}</p>
                </> : <p>{t("importNone")}</p>}
                <p>{t("detectWorkspace")}: {data?.workspacePath ?? "—"}</p>
                {data?.lastSnapshotPath ? <p>{t("snapshotBackupFolder")}: {data.lastSnapshotPath}</p> : null}
              </CardContent>
            </Card>

            <Surface testId="writer-trace">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("writerTrace")}</h2></SurfaceHeader>
              <SurfaceBody>
              {data?.lastWriterTrace ? <div className="space-y-1 text-xs">
                <p data-testid="writer-trace-execution">{data.lastWriterTrace.providerId}/{data.lastWriterTrace.model} · {data.lastWriterTrace.effectiveReasoningLevel} · {data.lastWriterTrace.serviceTier ?? "default"}</p>
                <p>{t("writerTraceMode")}: {data.lastWriterTrace.effortMode === "manual" ? t("writerEffortManual") : t("writerEffortAutomatic")}</p>
                <p>{t("writerTraceRequested")}: {data.lastWriterTrace.requestedReasoningLevel}</p>
                {data.lastWriterTrace.fallbackReason ? <p>{t("writerTraceReason")}: {data.lastWriterTrace.fallbackReason}</p> : null}
                {data.lastWriterTrace.selectionSource ? <p>{t("writerTraceSource")}: {data.lastWriterTrace.selectionSource.reasoningLevelSource}</p> : null}
              </div> : <p className="text-xs text-muted-foreground">{t("noDiagnosticData")}</p>}
              </SurfaceBody>
            </Surface>
            <Surface testId="cli-preview">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("cliPreview")}</h2></SurfaceHeader>
              <SurfaceBody>
              {data?.cliPreview ? <pre className="max-h-80 max-w-full overflow-auto rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-well)] p-3 text-xs text-foreground"><code>{JSON.stringify(data.cliPreview, null, 2)}</code></pre>
                : <p className="text-xs text-muted-foreground">{t("noDiagnosticData")}</p>}
              </SurfaceBody>
            </Surface>

            <Disclosure testId="restore-previous-install" summary={t("restorePreviousInstall")}>
              <p className="max-w-xl text-xs text-muted-foreground">{t("snapshotBackupHelp")}</p>
              <Label htmlFor="snapshot-path">{t("snapshotBackupFolder")}</Label>
              <Input id="snapshot-path" value={snapshotPath} onChange={(event) => setSnapshotPath(event.target.value)} />
            </Disclosure>

            <Surface>
              <SurfaceHeader><h2 className="text-sm font-medium">{t("unapplied")}</h2></SurfaceHeader>
              <SurfaceBody>
              {data?.unapplied.length ? <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {data.unapplied.map((item, index) => <li key={`${item.key}:${index}`}>{item.key}: {unappliedReason(item.reason)}</li>)}
              </ul> : <p className="text-xs text-muted-foreground">{t("noUnapplied")}</p>}
              </SurfaceBody>
            </Surface>

            {diagnosticsGrouped.map(({ section, rows }) => <Surface key={section}>
              <SurfaceHeader><h2 className="text-sm font-medium">{t(sectionKey(section))}</h2></SurfaceHeader>
              <SurfaceBody className="space-y-2">
                {rows.map((row) => {
                  const disabled = row.uiStatus !== "editable";
                  const value = data?.values[row.storageKey];
                  return <div key={row.storageKey} data-testid={`field-${row.id}`} data-storage-key={row.storageKey}
                    data-ui-status={row.uiStatus} className={stackControls ? "grid min-w-0 gap-2 py-1" : "grid min-w-0 gap-2 py-1 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] md:items-center"}>
                    <div className="space-y-1">
                      <Label className="text-sm">{row.storageKey === "writer.fast_mode" ? t("legacyFastMode") : settingLabel(row)}</Label>
                      {row.storageKey === "writer.fast_mode" ? <p className="text-xs text-muted-foreground">{t("legacyFastModeExplanation")}</p> : (
                        disabled ? <p className="text-xs text-muted-foreground">{t(reasonKey(row.id))}</p> : null
                      )}
                      <StatusBadge status={row.uiStatus} />
                      <Disclosure compact summary={t("fieldTechnicalDetails")}>
                        <p>{row.area} · {row.location}</p>
                        <p>{t("casVersion")} {data?.versions[row.storageKey] ?? 0}</p>
                      </Disclosure>
                    </div>
                    {row.storageKey === "writer.fast_mode" ? <code className="text-xs">{String(value ?? "unset")}</code> : (
                      disabled ? <code className="text-xs">{String(value ?? "unset")}</code> : <FieldControl
                        row={row} value={displayedValue(row.storageKey) ?? value} disabled={disabled}
                        onDraft={(next) => { if (!disabled) writeDraft(row.storageKey, next); }}
                        onChange={(next) => { if (!disabled) void applySetting(row, next); }} />
                    )}
                  </div>;
                })}
              </SurfaceBody>
            </Surface>)}

            <Disclosure testId="compat-aliases" summary={t("compatTitle")}>
              <p className="text-xs text-muted-foreground">{t("compatIntro")}</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {compatibilityAliasRows().map((row) => (
                  <li key={row.id} data-storage-key={row.storageKey} data-testid={`compat-${row.storageKey}`}>
                    {row.storageKey} · {row.setting}
                  </li>
                ))}
              </ul>
            </Disclosure>

            <Surface testId="cli-receipt">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("cliReceipt")}</h2></SurfaceHeader>
              <SurfaceBody className="space-y-3">
              {data?.runs.flatMap((run) => {
                const seen = new Set<string>();
                const items: Array<{ id:string; json:string }> = [];
                for (const attempt of run.attempts) if (attempt.cliReceiptJson && !seen.has(attempt.cliReceiptJson)) {
                  seen.add(attempt.cliReceiptJson); items.push({ id:attempt.id, json:attempt.cliReceiptJson });
                }
                if (run.cliReceiptJson && !seen.has(run.cliReceiptJson)) items.push({ id:run.id, json:run.cliReceiptJson });
                return items.map((item) => <div key={item.id} data-testid={`cli-receipt-${item.id}`}>
                  <h3 className="mb-2 text-xs font-medium">{t("cliReceipt")} {item.id}</h3>
                  <SourceCode content={item.json} path={`cli-receipt-${item.id}.json`} overflow="scroll" />
                </div>);
              })}
              {data?.cliReceiptJson && !data.runs.some((run) => run.cliReceiptJson || run.attempts.some((attempt) => attempt.cliReceiptJson))
                ? <SourceCode content={data.cliReceiptJson} path="cli-receipt.json" overflow="scroll" /> : null}
              </SurfaceBody>
            </Surface>

            {(resultPatch || resultSource) ? <Surface testId="writer-result">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("result")}</h2></SurfaceHeader>
              <SurfaceBody>
              {resultPatch ? <Diff patch={resultPatch} path="writer-output.txt" view="unified" /> : null}
              {resultSource ? <SourceCode content={resultSource} path="acceptance.json" overflow="scroll" /> : null}
              </SurfaceBody>
            </Surface> : null}
            {data?.lastReceiptJson ? <Surface testId="install-receipt">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("installReceipt")}</h2></SurfaceHeader>
              <SurfaceBody>
              <SourceCode content={data.lastReceiptJson} path="install-receipt.json" overflow="scroll" />
              </SurfaceBody>
            </Surface> : null}
              </div>
            </Disclosure>
            </> : null}
          </TabsContent>
          </> : null}

        </Tabs>

        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent
            data-testid="external-ops-dialog"
            className="box-border !left-4 !right-4 !top-1/2 !w-[min(359px,calc(100vw-2rem))] !max-w-[359px] min-w-0 !translate-x-0 !-translate-y-1/2 max-h-[min(80vh,100dvh)] overflow-y-auto overflow-x-hidden p-4 sm:rounded-lg sm:!max-w-[359px]"
          >
            <AlertDialogHeader>
              <AlertDialogTitle className="text-wrap break-words">{t("confirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription className="max-w-full overflow-x-hidden text-left text-wrap break-words">
                {t("confirmList")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {pendingOp === "install" ? (
              <ul className="mt-2 max-w-full list-disc overflow-x-hidden pl-4 text-left text-sm">
                {EXTERNAL_OPS_BY_ACTION.install.map((op) => (
                  <li key={op} className="break-all">{op}</li>
                ))}
              </ul>
            ) : null}
            {pendingOp === "connect" ? (
              <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmConnectOps")}</p>
            ) : null}
            {pendingOp === "rollback" ? (
              <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmRollbackOps")}</p>
            ) : null}
            <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmBody")}</p>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("confirmCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const op = pendingOp;
                  setConfirmOpen(false);
                  if (op) void runStack(op, true);
                }}
              >
                {t("confirmContinue")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        </>}
        </main>
        </div>
        </div>
      </div>
    </div></PanelLayoutContext.Provider></InheritanceContext.Provider>
  );
}
