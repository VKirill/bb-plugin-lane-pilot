import { useCallback, useMemo, useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { AutonomyClass } from "@lane-pilot/contracts";
import { detectLocale, t, type Locale } from "@lane-pilot/i18n";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  ConfirmDialog,
  Segments,
  Skeleton,
  usePanelLayout,
} from "@lane-pilot/ui-kit";
import { toast } from "sonner";
import {
  HELPER_PANEL_ACTION,
  type AgentListItem,
  type AgentLoadoutOutput,
  type ListedProject,
  type RepoTrustOutput,
  type SpecialistDetailOutput,
} from "../../contracts/ui";
import type { ScheduleBoardContract } from "../../schedule";
import { useLpRealtime, useLpRpcQuery, useOpenThreadPanel } from "../../ui-shell/ui";
import {
  CHARTERED_DOMAINS,
  domainOfAgent,
  errorText,
  resolveRoleName,
} from "./staff-list-parts";
import { StaffAutonomyTab, StaffLoadoutTab } from "./staff-page-autonomy-loadout";
import { CharterEditor } from "./charter-editor";
import { StaffPageHeader, StaffUnknownState } from "./staff-page-header";
import {
  extractCharterSummary,
  pickTickSchedule,
  resolveStaffRoleId,
  resolveStaffTab,
  resolveStaffThreadId,
  scheduleMatchesDomain,
  STAFF_PAGE_TABS,
  STAFF_TAB_LABELS,
  type StaffScheduleItem,
} from "./staff-page-helpers";
import { StaffCharterTab, StaffCostsTab, StaffShiftsTab } from "./staff-page-tabs";

export interface StaffPageProps {
  staffRef: { projectId: string; domain: string };
  view?: string;
  sectionId?: string | null;
  projects?: ReadonlyArray<ListedProject>;
  locale?: Locale;
  go: (next: {
    section: "staff" | "work" | "system";
    view?: string;
    page?: "graphs";
    projectId?: string;
    sectionId?: string;
    staffRef?: { projectId: string; domain: string };
    taskRef?: { runId: string; taskId: string };
  }) => void;
}

/** Employee detail page (P4): goal header, schedule controls, charter, shifts, autonomy + repo trust, loadout, and cost caps. */
export function StaffPage({
  staffRef,
  view,
  sectionId,
  projects = [],
  locale: localeProp,
  go,
}: StaffPageProps) {
  const locale = localeProp ?? detectLocale();
  const { stackControls } = usePanelLayout();
  const rpc = useRpc<ScheduleBoardContract>();
  const navigate = useBbNavigate();
  const openPanel = useOpenThreadPanel();

  const activeTab = resolveStaffTab(view);
  const { projectId, domain } = staffRef;

  const [pauseOpen, setPauseOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);

  const fetchDetail = useCallback(
    () => rpc.call("specialist_detail", { projectId, domain }) as Promise<SpecialistDetailOutput>,
    [rpc, projectId, domain],
  );
  const detailQuery = useLpRpcQuery<SpecialistDetailOutput>(
    null,
    { kind: "staff-detail", projectId, domain },
    { pollMs: 30_000, fetcher: fetchDetail },
  );

  const fetchAgents = useCallback(async (): Promise<AgentListItem[]> => {
    try {
      const res = await rpc.call("list_agents", {});
      return (res.agents as AgentListItem[]) ?? [];
    } catch {
      return [];
    }
  }, [rpc]);
  const agentsQuery = useLpRpcQuery<AgentListItem[]>(
    null,
    { kind: "staff-agents" },
    { fetcher: fetchAgents },
  );

  const fetchSchedules = useCallback(async (): Promise<StaffScheduleItem[]> => {
    try {
      const res = await rpc.call("schedule_list", { projectId });
      return res.schedules.filter((s) => scheduleMatchesDomain(s, domain));
    } catch {
      return [];
    }
  }, [rpc, projectId, domain]);
  const schedulesQuery = useLpRpcQuery<StaffScheduleItem[]>(
    null,
    { kind: "staff-schedules", projectId, domain },
    { pollMs: 30_000, fetcher: fetchSchedules },
  );

  const agents = agentsQuery.data ?? [];
  const roleId = useMemo(() => resolveStaffRoleId(agents, domain), [agents, domain]);
  const agent = useMemo(
    () => agents.find((a) => a.id === roleId || domainOfAgent(a) === domain),
    [agents, roleId, domain],
  );
  const roleName = useMemo(
    () => resolveRoleName(agent, roleId, locale),
    [agent, roleId, locale],
  );
  const projectName = useMemo(
    () => projects.find((p) => p.id === projectId)?.name ?? projectId,
    [projects, projectId],
  );

  const fetchRepoTrust = useCallback(
    () =>
      rpc.call("repo_trust", {
        projectId,
        ...(sectionId ? { sectionId } : {}),
      }) as Promise<RepoTrustOutput>,
    [rpc, projectId, sectionId],
  );
  const repoTrustQuery = useLpRpcQuery<RepoTrustOutput>(
    null,
    { kind: "staff-repo-trust", projectId, sectionId },
    { enabled: activeTab === "autonomy", fetcher: fetchRepoTrust },
  );

  const fetchLoadout = useCallback(
    () =>
      rpc.call("agent_loadout", {
        projectId,
        ...(sectionId ? { sectionId } : {}),
        role: roleId,
      }) as Promise<AgentLoadoutOutput>,
    [rpc, projectId, sectionId, roleId],
  );
  const loadoutQuery = useLpRpcQuery<AgentLoadoutOutput>(
    null,
    { kind: "staff-loadout", projectId, sectionId, roleId },
    { enabled: activeTab === "loadout", fetcher: fetchLoadout },
  );

  useLpRealtime(projectId, ["helpers", "schedule"], () => {
    void detailQuery.refetch();
    void schedulesQuery.refetch();
  });

  const detail = detailQuery.data;
  const matchingSchedules = schedulesQuery.data ?? [];
  const tickSchedule = useMemo(
    () => pickTickSchedule(matchingSchedules, domain),
    [matchingSchedules, domain],
  );
  const activeSchedules = useMemo(
    () => matchingSchedules.filter((s) => s.state !== "paused"),
    [matchingSchedules],
  );

  const summary = useMemo(
    () => extractCharterSummary(detail, projectId, domain),
    [detail, projectId, domain],
  );
  const threadId = useMemo(
    () => resolveStaffThreadId(summary.threadId, matchingSchedules),
    [summary.threadId, matchingSchedules],
  );

  const backToList = useCallback(() => {
    go({
      section: "staff",
      ...(sectionId ? { sectionId } : {}),
    });
  }, [go, sectionId]);

  const handleRunNow = async () => {
    if (!tickSchedule) {
      toast.error(t("consoleStaffRunNowNoSchedule"));
      return;
    }
    setRunBusy(true);
    try {
      const res = await rpc.call("schedule_run_now", { id: tickSchedule.id });
      if (res.ok) {
        toast.success(t("consoleStaffRunNowOk"));
        void detailQuery.refetch();
        void schedulesQuery.refetch();
      } else {
        toast.error(res.reason ?? t("consoleStaffActionError"));
      }
    } catch (cause) {
      toast.error(errorText(cause));
    } finally {
      setRunBusy(false);
    }
  };

  const handlePauseConfirm = async () => {
    for (const sched of activeSchedules) {
      await rpc.call("schedule_pause", { id: sched.id });
    }
    toast.success(t("consoleStaffPauseOk"));
    void schedulesQuery.refetch();
    void detailQuery.refetch();
  };

  const handleOpenChat = () => {
    if (!threadId) return;
    if (
      !openPanel({
        actionId: HELPER_PANEL_ACTION,
        title: roleName.slice(0, 40),
        params: { threadId },
      })
    ) {
      navigate.toThread(threadId);
    }
  };

  const handleSetAutonomy = async (
    actionClass: string,
    level: AutonomyClass,
  ): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const res = await rpc.call("specialist_autonomy_set", {
      projectId,
      domain,
      actionClass,
      level,
    });
    if (!res.ok) {
      return { ok: false, reason: res.reason };
    }
    toast.success(t("consoleStaffAutonomySaved"));
    await detailQuery.refetch();
    return { ok: true };
  };

  const hasDetailState = Boolean(
    detail &&
      (detail.charter ||
        detail.shifts.last ||
        detail.shifts.next ||
        detail.shifts.recent.length > 0 ||
        detail.northStar ||
        detail.caps.length > 0 ||
        detail.autonomy.length > 0 ||
        detail.loopHealth),
  );
  const projectKnown = projects.length === 0 || projects.some((p) => p.id === projectId);
  const agentKnown = Boolean(agent);
  const isUnknownStaff =
    Boolean(detail) &&
    !detailQuery.isLoading &&
    !hasDetailState &&
    matchingSchedules.length === 0 &&
    (!projectKnown || !agentKnown || CHARTERED_DOMAINS.has(domain));

  if (isUnknownStaff) {
    return (
      <StaffUnknownState
        projectName={projectName}
        domain={domain}
        onBack={backToList}
      />
    );
  }

  return (
    <div className="space-y-5" data-testid="staff-page">
      <StaffPageHeader
        roleName={roleName}
        projectName={projectName}
        domain={domain}
        locale={locale}
        detail={detail}
        summary={summary}
        matchingSchedules={matchingSchedules}
        activeSchedulesCount={activeSchedules.length}
        hasTickSchedule={Boolean(tickSchedule)}
        runBusy={runBusy}
        hasThread={Boolean(threadId)}
        onBack={backToList}
        onRunNow={() => void handleRunNow()}
        onPause={() => setPauseOpen(true)}
        onOpenChat={handleOpenChat}
      />

      <Segments
        testId="staff-tabs"
        label={t("consoleStaffTabsAria")}
        compact={stackControls}
        value={activeTab}
        onChange={(next) =>
          go({
            ...(sectionId ? { sectionId } : {}),
            section: "staff",
            staffRef,
            view: next,
          })
        }
        items={STAFF_PAGE_TABS.map((tabId) => ({
          id: tabId,
          label: t(STAFF_TAB_LABELS[tabId]),
        }))}
      />

      {detailQuery.error ? (
        <Alert variant="destructive" data-testid="staff-page-error">
          <AlertTitle>{t("consoleStaffPageLoadError")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
            <span>{errorText(detailQuery.error)}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void detailQuery.refetch()}>
              {t("consoleOverviewRetry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {!detail && detailQuery.isLoading ? (
        <div className="space-y-4" data-testid="staff-page-loading" aria-busy="true">
          <Skeleton className="h-36 w-full rounded-[14px]" />
          <Skeleton className="h-44 w-full rounded-[14px]" />
        </div>
      ) : detail ? (
        <>
          {activeTab === "charter" ? (
            view === "edit" ? (
              <CharterEditor
                projectId={projectId}
                domain={domain}
                charter={detail.charter}
                onClose={() =>
                  go({
                    ...(sectionId ? { sectionId } : {}),
                    section: "staff",
                    staffRef,
                    view: "charter",
                  })
                }
                onRefresh={async () => {
                  await detailQuery.refetch();
                }}
              />
            ) : (
              <StaffCharterTab
                detail={detail}
                summary={summary}
                locale={locale}
                onEditCharter={() =>
                  go({
                    ...(sectionId ? { sectionId } : {}),
                    section: "staff",
                    staffRef,
                    view: "edit",
                  })
                }
                onOpenShifts={() =>
                  go({
                    ...(sectionId ? { sectionId } : {}),
                    section: "staff",
                    staffRef,
                    view: "shifts",
                  })
                }
              />
            )
          ) : null}

          {activeTab === "shifts" ? (
            <StaffShiftsTab
              shifts={detail.shifts}
              locale={locale}
              onOpenGraph={(workflowId) =>
                go({
                  ...(sectionId ? { sectionId } : {}),
                  section: "system",
                  page: "graphs",
                  projectId,
                  view: workflowId,
                })
              }
              onOpenRun={(runId) =>
                go({
                  ...(sectionId ? { sectionId } : {}),
                  section: "work",
                  projectId,
                  taskRef: { runId, taskId: runId },
                })
              }
            />
          ) : null}

          {activeTab === "autonomy" ? (
            <StaffAutonomyTab
              autonomy={detail.autonomy}
              repoTrust={repoTrustQuery.data}
              repoTrustLoading={repoTrustQuery.isLoading}
              repoTrustError={repoTrustQuery.error}
              onSetAutonomy={handleSetAutonomy}
            />
          ) : null}

          {activeTab === "loadout" ? (
            <StaffLoadoutTab
              loadout={loadoutQuery.data}
              loading={loadoutQuery.isLoading}
              error={loadoutQuery.error}
              roleId={roleId}
              domain={domain}
            />
          ) : null}

          {activeTab === "costs" ? (
            <StaffCostsTab caps={detail.caps} locale={locale} />
          ) : null}
        </>
      ) : null}

      <ConfirmDialog
        open={pauseOpen}
        title={t("consoleStaffPauseTitle")}
        body={t("consoleStaffPauseBody")
          .replace("{name}", roleName)
          .replace("{count}", String(activeSchedules.length))}
        confirmLabel={t("consoleStaffPauseConfirm")}
        cancelLabel={t("consoleHireCancelBtn")}
        tone="danger"
        onOpenChange={setPauseOpen}
        onConfirm={handlePauseConfirm}
      />
    </div>
  );
}
