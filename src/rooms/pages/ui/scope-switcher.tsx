import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { t } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@lane-pilot/ui-kit";
import { CONTROL_H } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import { useLpRpcQuery } from "../../ui-shell/ui";
import type { ConsoleRoute } from "../models/nav-model";
import {
  readHiddenProjects,
  splitProjects,
  userVisibleProjects,
  type ListedProject,
} from "./service-projects";

type SectionRow = { id: string; parentId: string | null; name: string; path: string; kind: "folder" | "group" };
type ProjectsPayload = { projects: ListedProject[]; lastProjectId: string | null };
type SectionsPayload = { sections: SectionRow[] };

const ALL_PROJECTS_VALUE = "__all__";

function flattenSections(sections: SectionRow[]): Array<{ id: string; name: string; depth: number }> {
  const flat: Array<{ id: string; name: string; depth: number }> = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const section of sections.filter((item) => item.parentId === parentId)) {
      flat.push({ id: section.id, name: section.name, depth });
      walk(section.id, depth + 1);
    }
  };
  walk(null, 1);
  return flat;
}

export interface ScopeSwitcherProps {
  route: ConsoleRoute;
  go: (next: ConsoleRoute) => void;
}

/** Top-level scope selector: All projects, any visible project, sections of the active project, and folded service projects. */
export function ScopeSwitcher({ route, go }: ScopeSwitcherProps) {
  const rpc = useRpc<typeof rpcContract>();
  const activeProjectId =
    route.projectId && route.projectId !== GLOBAL_SETTINGS_PROJECT_ID ? route.projectId : null;

  const fetchProjects = useCallback(() => rpc.call("list_projects", {}), [rpc]);
  const projectsQuery = useLpRpcQuery<ProjectsPayload>(null, null, { fetcher: fetchProjects });

  const fetchSections = useCallback(
    () =>
      activeProjectId
        ? rpc.call("list_sections", { projectId: activeProjectId })
        : Promise.resolve({ sections: [] }),
    [rpc, activeProjectId],
  );
  const sectionsQuery = useLpRpcQuery<SectionsPayload>(null, activeProjectId ?? "", {
    enabled: Boolean(activeProjectId),
    fetcher: fetchSections,
  });

  const [hiddenIds, setHiddenIds] = useState<string[]>(readHiddenProjects);
  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);

  const visibleProjects = useMemo(
    () => userVisibleProjects(projectsQuery.data?.projects ?? []),
    [projectsQuery.data?.projects],
  );
  const projectGroups = useMemo(
    () => splitProjects(visibleProjects, hiddenSet),
    [visibleProjects, hiddenSet],
  );
  const flatSections = useMemo(
    () => flattenSections(sectionsQuery.data?.sections ?? []),
    [sectionsQuery.data?.sections],
  );

  const selectedValue =
    activeProjectId && route.sectionId
      ? `section:${route.sectionId}`
      : activeProjectId
        ? `project:${activeProjectId}`
        : ALL_PROJECTS_VALUE;

  const serviceSelected = projectGroups.service.some((project) => project.id === activeProjectId);
  const knownSelectedProject = activeProjectId
    ? visibleProjects.some((project) => project.id === activeProjectId)
    : true;

  const renderProjectItems = (project: ListedProject): ReactElement[] => [
    <SelectItem key={project.id} value={`project:${project.id}`} data-testid={`scope-project-${project.id}`}>
      {project.name}
    </SelectItem>,
    ...(project.id === activeProjectId
      ? flatSections.map((section) => (
          <SelectItem
            key={section.id}
            value={`section:${section.id}`}
            data-testid={`scope-section-${section.id}`}
          >
            {`${" ".repeat(section.depth)}${section.name}`}
          </SelectItem>
        ))
      : []),
  ];

  const handleChange = (next: string) => {
    if (next === ALL_PROJECTS_VALUE) {
      go({ ...route, projectId: undefined, sectionId: undefined });
      return;
    }
    if (next.startsWith("project:")) {
      const nextProjectId = next.slice("project:".length);
      void rpc.call("remember_project", { projectId: nextProjectId }).catch(() => undefined);
      go({ ...route, projectId: nextProjectId, sectionId: undefined });
      return;
    }
    if (next.startsWith("section:")) {
      const nextSectionId = next.slice("section:".length);
      if (activeProjectId) {
        void rpc.call("remember_project", { projectId: activeProjectId }).catch(() => undefined);
      }
      go({ ...route, projectId: activeProjectId ?? undefined, sectionId: nextSectionId });
    }
  };

  return (
    <Select
      value={selectedValue}
      onOpenChange={(open) => {
        if (open) setHiddenIds(readHiddenProjects());
      }}
      onValueChange={handleChange}
    >
      <SelectTrigger
        aria-label={t("consoleScopeLabel")}
        className={`${CONTROL_H} w-auto min-w-[11rem] max-w-[20rem]`}
        data-testid="scope-switcher"
      >
        <SelectValue placeholder={activeProjectId ?? t("consoleAllProjects")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL_PROJECTS_VALUE} data-testid="scope-all">
          {t("consoleAllProjects")}
        </SelectItem>
        {!knownSelectedProject && activeProjectId ? (
          <SelectItem value={`project:${activeProjectId}`} data-testid={`scope-project-${activeProjectId}`}>
            {activeProjectId}
          </SelectItem>
        ) : null}
        {projectGroups.main.length > 0 ? (
          <SelectGroup>
            <SelectLabel>{t("projects")}</SelectLabel>
            {projectGroups.main.flatMap(renderProjectItems)}
          </SelectGroup>
        ) : null}
        {projectGroups.service.length > 0 ? (
          <SelectGroup>
            <details
              className="mt-1 border-t border-[var(--lp-hairline)] pt-1"
              data-testid="service-projects"
              {...(serviceSelected ? { open: true } : {})}
            >
              <summary className="flex cursor-pointer list-none items-center gap-1 rounded-sm px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-state-hover [&::-webkit-details-marker]:hidden">
                <span aria-hidden>▸</span>
                {t("navGroupService")} ({projectGroups.service.length})
              </summary>
              {projectGroups.service.flatMap(renderProjectItems)}
            </details>
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
