import { useCallback, useMemo, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Icon,
  PageHeader,
  Segments,
  Skeleton,
  StatusPill,
  Surface,
  SurfaceBody,
  SurfaceHeader,
  usePanelLayout,
} from "@lane-pilot/ui-kit";
import { LP_ALL_PROJECTS } from "@lane-pilot/ui-kit/realtime-channel";
import type { rpcContract } from "../../contracts";
import {
  DRILL_SANDBOX_PROJECT_IDS,
  HELPER_PANEL_ACTION,
  isSandboxProjectName,
  userVisibleProjects,
  type AgentListItem,
  type ListedProject,
} from "../../contracts/ui";
import { useLpRealtime, useLpRpcQuery, useOpenThreadPanel } from "../../ui-shell/ui";
import {
  CHARTERED_DOMAINS,
  computeOnTrack,
  DEFAULT_DOMAIN_ROLE,
  domainOfAgent,
  errorText,
  formatAutonomySummary,
  resolveRoleName,
  StaffCard,
  UNLISTED_DEVELOPER_IDS,
  type OverviewPayload,
  type StaffCardItem,
  type StaffFilter,
} from "./staff-list-parts";

export type { StaffFilter };

export interface StaffListProps {
  projectId: string | null;
  sectionId?: string | null;
  projects?: ReadonlyArray<ListedProject>;
  hiddenProjectIds?: ReadonlySet<string>;
  locale?: Locale;
  go: (next: {
    section: "staff";
    view?: string;
    projectId?: string;
    sectionId?: string;
    staffRef?: { projectId: string; domain: string };
  }) => void;
}

interface ProjectErrorCard {
  project: ListedProject;
  message: string;
}

interface StaffQueryResult {
  cards: StaffCardItem[];
  projectErrors: ProjectErrorCard[];
  projectsCount: number;
}

const SANDBOX_IDS = new Set<string>(DRILL_SANDBOX_PROJECT_IDS);

/** Staff list screen (P3): chartered specialists per project and task-based roles with filter and chat links. */
export function StaffList({
  projectId,
  sectionId,
  projects = [],
  hiddenProjectIds,
  locale: localeProp,
  go,
}: StaffListProps) {
  const locale = localeProp ?? detectLocale();
  const { stackControls } = usePanelLayout();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const openPanel = useOpenThreadPanel();
  const [filter, setFilter] = useState<StaffFilter>("all");

  const scopedProjectId =
    projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
  const scopedBase = useMemo(
    () => ({
      ...(scopedProjectId ? { projectId: scopedProjectId } : {}),
      ...(sectionId ? { sectionId } : {}),
    }),
    [scopedProjectId, sectionId],
  );

  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name] as const)),
    [projects],
  );

  const hiddenKey = useMemo(
    () => (hiddenProjectIds ? [...hiddenProjectIds].sort().join(",") : ""),
    [hiddenProjectIds],
  );

  const fetchStaff = useCallback(async (): Promise<StaffQueryResult> => {
    const [agentsRes, scopeProjects] = await Promise.all([
      rpc.call("list_agents", {}),
      scopedProjectId
        ? Promise.resolve<ListedProject[]>([
            { id: scopedProjectId, name: projectNames.get(scopedProjectId) ?? scopedProjectId },
          ])
        : rpc.call("list_projects", {}).then((res) =>
            userVisibleProjects(res.projects).filter(
              (project) =>
                !SANDBOX_IDS.has(project.id) &&
                !isSandboxProjectName(project.name) &&
                !hiddenProjectIds?.has(project.id),
            ),
          ),
    ]);

    const nameMap = new Map(projectNames);
    for (const project of scopeProjects) nameMap.set(project.id, project.name);

    const overviewResults = await Promise.allSettled(
      scopeProjects.map(async (project) => ({
        project,
        overview: (await rpc.call("specialist_overview", {
          projectId: project.id,
        })) as OverviewPayload,
      })),
    );

    const specialistAgents = (agentsRes.agents as AgentListItem[]).filter(
      (agent) =>
        agent.kind !== "coordinator" &&
        agent.kind !== "internal" &&
        (agent.edited || !UNLISTED_DEVELOPER_IDS.has(agent.id)),
    );
    const agentByDomain = new Map<string, AgentListItem>();
    const agentById = new Map<string, AgentListItem>();
    for (const agent of specialistAgents) {
      agentById.set(agent.id, agent);
      const dom = domainOfAgent(agent);
      if (!agentByDomain.has(dom)) agentByDomain.set(dom, agent);
    }

    const nowMs = Date.now();
    const cards: StaffCardItem[] = [];
    const projectErrors: ProjectErrorCard[] = [];
    const charteredDomainsSeen = new Set<string>();

    for (let i = 0; i < scopeProjects.length; i += 1) {
      const project = scopeProjects[i]!;
      const outcome = overviewResults[i]!;
      if (outcome.status === "rejected") {
        projectErrors.push({ project, message: errorText(outcome.reason) });
        continue;
      }

      const ov = outcome.value.overview ?? {};
      const charters = Array.isArray(ov.charters) ? ov.charters : [];
      const openBreakers = new Set(
        (ov.breakers ?? []).filter((b) => b.state === "open").map((b) => b.domain),
      );

      for (const charter of charters) {
        const pid = charter.projectId || project.id;
        const dom = charter.domain;
        charteredDomainsSeen.add(`${pid}:${dom}`);
        const mappedId = agentByDomain.get(dom)?.id ?? DEFAULT_DOMAIN_ROLE[dom] ?? dom;
        const agent = agentById.get(mappedId) ?? agentByDomain.get(dom);
        const budgetUsedUsd =
          typeof charter.budgetUsedUsd === "number"
            ? charter.budgetUsedUsd
            : typeof ov.spend30dUsd === "number"
              ? ov.spend30dUsd
              : null;
        const budgetCapUsd =
          typeof charter.budgetCapUsd === "number"
            ? charter.budgetCapUsd
            : typeof charter.monthlyCapUsd === "number"
              ? charter.monthlyCapUsd
              : typeof charter.dailyCapUsd === "number"
                ? charter.dailyCapUsd
                : null;
        const threadId =
          charter.latestThreadId ??
          charter.threadId ??
          ov.latestThreadIdByDomain?.[dom] ??
          null;

        cards.push({
          key: `${pid}:${dom}`,
          category: CHARTERED_DOMAINS.has(dom) ? "chartered" : "task",
          roleId: mappedId,
          roleName: resolveRoleName(agent, mappedId, locale),
          projectId: pid,
          projectName: nameMap.get(pid) ?? pid,
          domain: dom,
          metric: charter.metric ?? null,
          current: typeof charter.current === "number" ? charter.current : null,
          target: typeof charter.target === "number" ? charter.target : null,
          due: charter.due ?? null,
          onTrack: computeOnTrack(charter, nowMs),
          breakerOpen: openBreakers.has(dom),
          budgetUsedUsd,
          budgetCapUsd,
          autonomySummary: formatAutonomySummary(
            charter.autonomy ?? ov.autonomy?.[dom],
            charter.autonomySummary,
          ),
          threadId: threadId || null,
          summaryText: null,
        });
      }
    }

    const singleProject = scopeProjects.length === 1 ? scopeProjects[0]! : null;
    for (const agent of specialistAgents) {
      const dom = domainOfAgent(agent);
      if (CHARTERED_DOMAINS.has(dom)) continue;
      if (singleProject && charteredDomainsSeen.has(`${singleProject.id}:${dom}`)) continue;
      cards.push({
        key: `agent:${agent.id}`,
        category: "task",
        roleId: agent.id,
        roleName: resolveRoleName(agent, agent.id, locale),
        projectId: singleProject?.id ?? null,
        projectName: singleProject ? singleProject.name : t("consoleAllProjects"),
        domain: dom,
        metric: null,
        current: null,
        target: null,
        due: null,
        onTrack: null,
        breakerOpen: false,
        budgetUsedUsd: null,
        budgetCapUsd: null,
        autonomySummary: t("consoleStaffAutonomyDefault"),
        threadId: null,
        summaryText: agent.summary ?? null,
      });
    }

    return { cards, projectErrors, projectsCount: scopeProjects.length };
  }, [rpc, scopedProjectId, projectNames, hiddenProjectIds, locale]);

  const query = useLpRpcQuery<StaffQueryResult>(
    null,
    { kind: "staff-list", scopedProjectId, hiddenKey, locale },
    { pollMs: 30_000, fetcher: fetchStaff },
  );

  useLpRealtime(scopedProjectId ?? LP_ALL_PROJECTS, ["helpers", "schedule"], () => {
    void query.refetch();
  });

  const data = query.data;
  const visibleCards = useMemo(() => {
    const all = data?.cards ?? [];
    return filter === "all" ? all : all.filter((card) => card.category === filter);
  }, [data?.cards, filter]);

  const subtitle = scopedProjectId
    ? `${t("consoleStaffSubtitle")} · ${projectNames.get(scopedProjectId) ?? scopedProjectId}`
    : t("consoleStaffSubtitle");

  return (
    <div className="space-y-5" data-testid="console-staff">
      <PageHeader
        title={t("consoleNavStaff")}
        subtitle={subtitle}
        actions={
          <Button
            type="button"
            size="sm"
            data-testid="staff-hire-btn"
            onClick={() => go({ ...scopedBase, section: "staff", view: "hire" })}
          >
            <Icon name="UserRoundPlus" className="mr-1.5 size-4" aria-hidden />
            {t("consoleStaffHire")}
          </Button>
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segments
          testId="staff-filter"
          label={t("consoleStaffFilterLabel")}
          compact={stackControls}
          value={filter}
          onChange={(next) => setFilter(next as StaffFilter)}
          items={[
            { id: "all", label: t("consoleStaffFilterAll") },
            { id: "chartered", label: t("consoleStaffFilterChartered") },
            { id: "task", label: t("consoleStaffFilterTask") },
          ]}
        />
      </div>

      {query.error ? (
        <Alert variant="destructive" data-testid="staff-error">
          <AlertTitle>{t("consoleStaffLoadError")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{errorText(query.error)}</span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="staff-retry"
              onClick={() => void query.refetch()}
            >
              {t("consoleOverviewRetry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!data && query.isLoading ? (
        <div className="grid gap-4 md:grid-cols-2" data-testid="staff-loading" aria-busy="true">
          <Skeleton className="h-44 rounded-[14px]" />
          <Skeleton className="h-44 rounded-[14px]" />
        </div>
      ) : data ? (
        data.projectsCount === 0 && data.cards.length === 0 && data.projectErrors.length === 0 ? (
          <Surface testId="console-staff-empty">
            <SurfaceBody>
              <p className="text-sm text-muted-foreground">{t("consoleStaffEmpty")}</p>
            </SurfaceBody>
          </Surface>
        ) : visibleCards.length === 0 && data.projectErrors.length === 0 ? (
          <Surface testId="staff-empty-filtered">
            <SurfaceBody>
              <p className="text-sm text-muted-foreground">{t("consoleStaffEmptyFiltered")}</p>
            </SurfaceBody>
          </Surface>
        ) : (
          <div className="grid gap-4 md:grid-cols-2" data-testid="staff-grid">
            {data.projectErrors.map(({ project, message }) => (
              <Surface key={`err:${project.id}`} testId={`staff-project-error-${project.id}`}>
                <SurfaceHeader className="justify-between">
                  <h2 className="min-w-0 truncate text-sm font-semibold">{project.name}</h2>
                  <StatusPill tone="bad">{t("consoleStaffLoadError")}</StatusPill>
                </SurfaceHeader>
                <SurfaceBody>
                  <p className="text-xs text-destructive-text" role="alert">
                    {t("consoleStaffProjectLoadError")}: {message}
                  </p>
                </SurfaceBody>
              </Surface>
            ))}

            {visibleCards.map((card) => (
              <StaffCard
                key={card.key}
                card={card}
                locale={locale}
                onOpen={(pid, dom) =>
                  go({ ...scopedBase, section: "staff", staffRef: { projectId: pid, domain: dom } })
                }
                onOpenChat={(threadId, title) => {
                  if (
                    !openPanel({
                      actionId: HELPER_PANEL_ACTION,
                      title: title.slice(0, 40),
                      params: { threadId },
                    })
                  ) {
                    navigate.toThread(threadId);
                  }
                }}
              />
            ))}
          </div>
        )
      ) : null}
    </div>
  );
}
