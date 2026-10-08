import type { ReactElement } from "react";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { CONTROL_H } from "@lane-pilot/ui-kit";
import type { LpPage } from "./use-lp-page";

type Scope = "projects" | "globals" | "agents" | "tokens" | "workflows" | "schedule";
const SYSTEM_PAGES: Array<{ scope: Exclude<Scope, "projects">; label: "navGlobals" | "navAgents" | "tabTokens" | "navWorkflows" | "navSchedule"; testId?: string }> = [
  { scope: "globals", label: "navGlobals" },
  { scope: "agents", label: "navAgents" },
  { scope: "tokens", label: "tabTokens", testId: "scope-nav-tokens" },
  { scope: "workflows", label: "navWorkflows", testId: "scope-nav-workflows" },
  { scope: "schedule", label: "navSchedule", testId: "scope-nav-schedule" },
];

/** Phones: one select with the system pages, the projects (the open one with its sections) and the service projects. */
export function MobileScopeSelect({ page }: { page: LpPage }) {
  const { mobileNavValue, setActiveScope, chooseProject, setSelectedSectionId, projectGroups, activeScope, projectId, flatSections } = page;
  const projectItem = (project: { id: string; name: string }) => [
    <SelectItem key={project.id} value={`project:${project.id}`}>{project.name}</SelectItem>,
    ...(activeScope === "projects" && project.id === projectId ? flatSections.map((section) => (
      <SelectItem key={section.id} value={`section:${section.id}`} data-testid={`section-option-${section.id}`}>{`${" ".repeat(section.depth)}${section.name}`}</SelectItem>
    )) : []),
  ];
  return (
    <Select
      value={mobileNavValue}
      onValueChange={(next) => {
        if (SYSTEM_PAGES.some((item) => item.scope === next)) setActiveScope(next as Scope);
        else if (next.startsWith("project:")) chooseProject(next.slice("project:".length));
        else if (next.startsWith("section:")) { setActiveScope("projects"); setSelectedSectionId(next.slice("section:".length)); }
      }}
    >
      <SelectTrigger aria-label={t("scopeNav")} className={`${CONTROL_H} min-w-0 flex-1`} data-testid="scope-nav-mobile">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>{t("navGroupSystem")}</SelectLabel>
          {SYSTEM_PAGES.map((item) => <SelectItem key={item.scope} value={item.scope}>{t(item.label)}</SelectItem>)}
        </SelectGroup>
        <SelectGroup>
          <SelectLabel>{t("projects")}</SelectLabel>
          {projectGroups.main.flatMap(projectItem)}
        </SelectGroup>
        {projectGroups.service.length ? (
          <SelectGroup>
            <SelectLabel>{t("navGroupService")} ({projectGroups.service.length})</SelectLabel>
            {projectGroups.service.flatMap(projectItem)}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}

/** The wide left rail: system pages, then the projects with their sections, test projects folded away at the bottom. */
export function ScopeRail({ page }: { page: LpPage }) {
  const { compactChrome, activeScope, setActiveScope, projectListError, projectsLoaded, projects, projectGroups, projectId, selectedSectionId, setSelectedSectionId, sections, chooseProject, hiddenProjects, showProject } = page;
  const row = (project: { id: string; name: string }): ReactElement[] => {
    const current = activeScope === "projects" && project.id === projectId;
    const button = (
      <Button
        key={project.id}
        type="button"
        size="sm"
        variant="ghost"
        aria-current={current && !selectedSectionId ? "page" : undefined}
        data-testid={`project-item-${project.id}`}
        className={`lp-nav-item h-auto w-full justify-start px-3 py-2 text-left hover:bg-state-hover ${current ? "font-semibold text-foreground" : ""}`}
        onClick={() => chooseProject(project.id)}
      ><span className="min-w-0 truncate text-sm">{project.name}</span></Button>
    );
    if (!current || !sections.length) return [button];
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
  };
  const serviceOpen = projectGroups.service.some((project) => project.id === projectId && activeScope === "projects");
  return (
    <nav className={compactChrome ? "hidden" : "flex w-[14.5rem] shrink-0 flex-col pt-5 pb-2 pl-6 pr-2"} aria-label={t("scopeNav")} data-testid="scope-rail">
      <div className="px-3 pb-1"><span className="text-xs font-medium text-muted-foreground">{t("navGroupSystem")}</span></div>
      <div className="flex flex-col gap-1 pb-2" data-testid="scope-nav">
        {SYSTEM_PAGES.map((item) => (
          <Button key={item.scope} type="button" role="tab" size="sm" aria-selected={activeScope === item.scope} variant="ghost" className="lp-nav-item h-9 w-full justify-start px-3 text-sm hover:bg-state-hover"
            data-testid={item.testId} onClick={() => setActiveScope(item.scope)}>{t(item.label)}</Button>
        ))}
      </div>
      <div className="border-t border-[var(--lp-hairline)] px-3 pb-1 pt-3"><span className="text-xs font-medium text-muted-foreground">{t("projects")}</span></div>
      <div className="min-h-0 flex-1 overflow-y-auto pb-2">
        {projectListError ? <p role="alert" className="px-2 text-xs text-destructive">{t("projectListError")}</p> : null}
        {!projectsLoaded && !projectListError ? <p className="px-2 text-xs text-muted-foreground">{t("loadingProjects")}</p> : null}
        {projectsLoaded && projects.length === 0 && !projectListError ? <p className="px-2 text-xs text-muted-foreground">{t("noProjects")}</p> : null}
        <div className="flex flex-col gap-0.5">{projectGroups.main.flatMap(row)}</div>
        {projectGroups.service.length ? (
          <details className="mt-2 border-t border-[var(--lp-hairline)] pt-1" data-testid="service-projects" {...(serviceOpen ? { open: true } : {})}>
            <summary className="flex cursor-pointer list-none items-center gap-1 rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-state-hover [&::-webkit-details-marker]:hidden">
              <span aria-hidden>▸</span>{t("navGroupService")} ({projectGroups.service.length})
            </summary>
            <div className="flex flex-col gap-0.5">
              {projectGroups.service.map((project) => (
                <div key={project.id} className="flex min-w-0 items-center">
                  <div className="min-w-0 flex-1">{row(project)}</div>
                  {hiddenProjects.has(project.id) ? <Button type="button" size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs" onClick={() => showProject(project.id)}>{t("projectShow")}</Button> : null}
                </div>
              ))}
            </div>
          </details>
        ) : null}
      </div>
    </nav>
  );
}
