import type { ReactNode } from "react";
import { t, validationMessage } from "@lane-pilot/i18n";
import { Alert, AlertDescription, AlertTitle } from "@lane-pilot/ui-kit";
import { Button } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@lane-pilot/ui-kit";
import { CONTROL_H } from "@lane-pilot/ui-kit";
import { OwnedSettings } from "./owned-settings";
import { PanelLayoutContext } from "@lane-pilot/ui-kit";
import { InheritanceContext } from "./setting-controls";
import { TokenUsage } from "../rooms/usage/ui/token-usage";
import { WorkflowsScreen } from "./workflows";
import { ScheduleBoard } from "../rooms/schedule/ui/schedule-board";
import { MobileScopeSelect, ScopeRail } from "./project-nav";
import { ProjectHeader } from "./project-header";
import { TAB_IDS, TAB_LABELS, type TabId } from "./tabs-model";
import { OverviewTab } from "./tab-overview";
import { TeamTab } from "./tab-team";
import { WorkTab } from "./tab-work";
import { KnowledgeTab } from "./tab-knowledge";
import { AutomationTab } from "./tab-automation";
import { RunsTab } from "./tab-runs";
import { useLanePilotPage } from "./use-lp-page";

export function LanePilotPage({ subPath = "", scope = "projects" }: { subPath?: string; scope?: "projects" | "globals" | "agents" | "tokens" | "workflows" | "schedule" }) {
  const page = useLanePilotPage({ subPath, scope });
  const {
    activeScope, projectId, projects, locale, shellRef, contentRef, compactChrome, stackControls, data, resetInherited, error, saveError, load,
    tab, goTo, visited, tabSelect, selectedProjectId, routeProjectId,
  } = page;
  const otherScope = activeScope === "agents" || activeScope === "tokens" || activeScope === "workflows" || activeScope === "schedule";
  const panels: Record<TabId, () => ReactNode> = {
    overview: () => <OverviewTab page={page} />,
    team: () => (projectId ? <TeamTab page={page} /> : null),
    work: () => <WorkTab page={page} />,
    knowledge: () => <KnowledgeTab page={page} />,
    automation: () => <AutomationTab page={page} />,
    runs: () => <RunsTab page={page} />,
  };
  return (
    <InheritanceContext.Provider value={{ locale, data, reset: (keys) => void resetInherited(keys) }}><PanelLayoutContext.Provider value={{ compactChrome, stackControls }}>
      <div ref={shellRef} className={`flex h-full min-h-0 min-w-0 flex-1 overflow-hidden ${compactChrome ? "flex-col" : "flex-row"}`} data-testid="project-picker" data-locale={locale} data-lp-chrome={compactChrome ? "compact" : "rail"} data-lp-stack={stackControls ? "1" : "0"} data-bb-ru-skip>
        <div className={compactChrome ? "flex shrink-0 flex-col gap-2 border-b border-border p-2" : "hidden"}>
          <div className="flex items-center gap-2"><MobileScopeSelect page={page} /></div>
        </div>
        <ScopeRail page={page} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
            <div ref={contentRef} className="mx-auto w-full min-w-0 max-w-5xl space-y-6 px-4 py-5">
              <OwnedSettings scope={activeScope === "agents" ? "agents" : "projects"} locale={locale} />
              {activeScope === "tokens" ? <TokenUsage projects={projects} /> : null}
              {activeScope === "workflows" ? <WorkflowsScreen locale={locale} projectId={null} architectProjectId={selectedProjectId ?? routeProjectId ?? (subPath || null)} /> : null}
              {activeScope === "schedule" ? <ScheduleBoard projectId={null} projects={projects} locale={locale} /> : null}
              <main hidden={otherScope} className="min-w-0 max-w-full space-y-6" data-testid="project-settings">
                {!projectId ? <p className="text-sm text-muted-foreground" data-testid="project-settings-empty">{t("noProjectSelected")}</p> : <>
                  <ProjectHeader page={page} />
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

                  <Tabs value={tab} onValueChange={(next) => goTo(next)}>
                    {/* Keep the plugin's own EN/RU labels out of BB's DOM-based Russianizer. */}
                    {tabSelect ? (
                      <Select value={tab} onValueChange={(next) => goTo(next)}>
                        <SelectTrigger aria-label={t("tabPick")} data-testid="tab-select" className={`${CONTROL_H} w-full min-w-0`}><SelectValue /></SelectTrigger>
                        <SelectContent>{TAB_IDS.map((id) => <SelectItem key={id} value={id}>{t(TAB_LABELS[id])}</SelectItem>)}</SelectContent>
                      </Select>
                    ) : (
                      <TabsList data-bb-ru-skip className="w-full overflow-visible">
                        {TAB_IDS.map((id) => <TabsTrigger key={id} value={id} className="flex-1 whitespace-nowrap px-2 text-[13px]" data-testid={`tab-${id}`}>{t(TAB_LABELS[id])}</TabsTrigger>)}
                      </TabsList>
                    )}
                    {/* A tab mounts when it is first opened and stays mounted after that: six tabs at once cost 25 000 DOM nodes on a big project. */}
                    {TAB_IDS.map((id) => (
                      <TabsContent key={id} value={id} forceMount={true} className="mt-4 space-y-6" hidden={tab !== id} data-testid={`${id}-panel`}>
                        {visited.current.has(id) ? panels[id]() : null}
                      </TabsContent>
                    ))}
                  </Tabs>
                </>}
              </main>
            </div>
          </div>
        </div>
      </div>
    </PanelLayoutContext.Provider></InheritanceContext.Provider>
  );
}
