import type { ComponentProps } from "react";
import { t, validationMessage, type Locale } from "@lane-pilot/i18n";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  PageHeader,
  Segments,
  Surface,
  SurfaceBody,
} from "@lane-pilot/ui-kit";
import { ErrandsScreen } from "../../errands/ui";
import { MemoryScreen } from "../../memory/ui";
import { DecisionsScreen } from "../../owner-waiting/ui";
import { AcceptanceCard as RawAcceptanceCard, TaskPage, WorkScreen } from "../../runs/ui";
import { ScheduleBoard } from "../../schedule/ui";
import { AgentsLoadout } from "../../settings/ui";
import { StaffList } from "../../specialist/ui";
import { ReturnStage } from "../../stage-return/ui";
import { TokenUsage } from "../../usage/ui";
import { InputsForm, WorkflowsScreen } from "../../workflow/ui";
import type { ConsoleRoute } from "../models/nav-model";
import { useAgentsLoadoutBridge } from "./agents-page-bridge";
import { ProjectHeader } from "./project-header";
import { ServiceSegment } from "./service-segment";
import { KnowledgeTab } from "./tab-knowledge";
import { OverviewScreen } from "./screens/overview-screen";
import { SystemHome } from "./screens/system-home";
import { WorkTab } from "./tab-work";
import type { LpPage } from "./use-lp-page";

const AcceptanceCard = (props: ComponentProps<typeof RawAcceptanceCard>) => (
  <RawAcceptanceCard {...props} ReturnStage={ReturnStage} />
);

export interface ConsoleSectionProps {
  route: ConsoleRoute;
  go: (next: ConsoleRoute) => void;
  projectId: string | null;
  sectionId: string | null;
  locale: Locale;
}

function SystemAgentsPanel({
  route,
  go,
  projectId,
  sectionId,
  locale,
  page,
}: ConsoleSectionProps & { page: LpPage }) {
  const bridge = useAgentsLoadoutBridge(page, projectId);
  return (
    <div className="space-y-6" data-testid="system-agents">
      <SettingsAlerts page={page} />
      <AgentsLoadout
        projectId={projectId}
        sectionId={sectionId}
        locale={locale}
        projects={page.projects}
        sections={page.sections}
        onScopeChange={(next) =>
          go({ ...route, section: "system", page: "agents", projectId: next.projectId, sectionId: next.sectionId })
        }
        {...bridge}
      />
    </div>
  );
}

function SettingsAlerts({ page }: { page: LpPage }) {
  const { error, saveError, load } = page;
  const titleOnly =
    saveError?.kind === "validation" &&
    (saveError.code === "setup_required" || saveError.code === "writer_binding_ambiguous");
  return (
    <>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t("loadError")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {saveError ? (
        <Alert
          variant="destructive"
          data-testid={saveError.kind === "cas" ? "cas-conflict" : "setting-validation-error"}
        >
          <AlertTitle className={titleOnly ? "mb-0 leading-5" : undefined}>
            {saveError.kind === "cas"
              ? t("casConflict")
              : validationMessage(saveError.code, saveError.params)}
          </AlertTitle>
          {titleOnly ? null : (
            <AlertDescription>
              <Button size="sm" variant="outline" onClick={() => void load()}>
                {t("reload")}
              </Button>
            </AlertDescription>
          )}
        </Alert>
      ) : null}
    </>
  );
}

function StaffSection({ route, go, projectId, sectionId, locale, page }: ConsoleSectionProps & { page: LpPage }) {
  const scopedProjectId = projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
  if (route.view === "hire") {
    return (
      <Surface testId="staff-hire-placeholder">
        <SurfaceBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">{t("consoleStaffHirePlaceholder")}</p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => go({ section: "staff", ...(scopedProjectId ? { projectId: scopedProjectId } : {}), ...(sectionId ? { sectionId } : {}) })}
          >
            {t("consoleStaffBackToList")}
          </Button>
        </SurfaceBody>
      </Surface>
    );
  }
  if (route.staffRef) {
    return (
      <Surface testId="staff-page-placeholder">
        <SurfaceBody className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {t("consoleStaffDetailPlaceholder")
              .replace("{project}", route.staffRef.projectId)
              .replace("{domain}", route.staffRef.domain)}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => go({ section: "staff", ...(scopedProjectId ? { projectId: scopedProjectId } : {}), ...(sectionId ? { sectionId } : {}) })}
          >
            {t("consoleStaffBackToList")}
          </Button>
        </SurfaceBody>
      </Surface>
    );
  }
  return (
    <StaffList
      projectId={scopedProjectId}
      sectionId={sectionId}
      projects={page.projects}
      hiddenProjectIds={page.hiddenProjects}
      locale={locale}
      go={(next) => go(next)}
    />
  );
}

function WorkSection({ route, go, projectId, sectionId, locale, page }: ConsoleSectionProps & { page: LpPage }) {
  const scopedProjectId = projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
  const serviceProjectIds = page.projectGroups.service.map((project) => project.id);
  if (route.taskRef) {
    return (
      <TaskPage
        runId={route.taskRef.runId}
        taskId={route.taskRef.taskId}
        projects={page.projects}
        locale={locale}
        onBack={() =>
          go({
            section: "work",
            view: "tasks",
            ...(route.projectId ? { projectId: route.projectId } : {}),
            ...(route.sectionId ? { sectionId: route.sectionId } : {}),
          })
        }
        AcceptanceCard={AcceptanceCard}
      />
    );
  }
  return (
    <WorkScreen
      view={route.view}
      projectId={scopedProjectId}
      sectionId={sectionId}
      projects={page.projects}
      serviceProjectIds={serviceProjectIds}
      locale={locale}
      compact={page.tabSelect}
      AcceptanceCard={AcceptanceCard}
      Errands={ErrandsScreen}
      InputsForm={InputsForm}
      go={(next) => go(next)}
    />
  );
}

function MemorySection({ route, go, projectId, sectionId, locale, page }: ConsoleSectionProps & { page: LpPage }) {
  const activeView = route.view === "history" ? "history" : "records";
  const scopedProjectId = projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
  return (
    <div className="space-y-4" data-testid="console-memory">
      <PageHeader title={t("consoleNavMemory")} subtitle={t("consoleMemorySubtitle")} />
      <Segments
        testId="memory-view"
        label={t("consoleNavMemory")}
        compact={page.tabSelect}
        value={activeView}
        onChange={(next) => go({ ...route, section: "memory", view: next })}
        items={[
          { id: "records", label: t("consoleMemoryTabRecords") },
          { id: "history", label: t("consoleMemoryTabHistory") },
        ]}
      />
      {activeView === "history" ? (
        <p className="text-sm text-muted-foreground" data-testid="memory-history-placeholder">
          {t("consoleMemoryHistoryPlaceholder")}
        </p>
      ) : !scopedProjectId ? (
        <Surface testId="console-memory-select-project">
          <SurfaceBody>
            <p className="text-sm text-muted-foreground">{t("consoleMemorySelectProject")}</p>
          </SurfaceBody>
        </Surface>
      ) : (
        <MemoryScreen
          projectId={scopedProjectId}
          sectionId={sectionId}
          locale={locale}
          onOpenTask={(runId, taskId) => go({ ...route, section: "work", taskRef: { runId, taskId } })}
        />
      )}
    </div>
  );
}

function SystemSection({ route, go, projectId, locale, page }: ConsoleSectionProps & { page: LpPage }) {
  const scopedProjectId = projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
  switch (route.page) {
    case "graphs":
      return (
        <WorkflowsScreen
          locale={locale}
          projectId={scopedProjectId}
          architectProjectId={scopedProjectId}
        />
      );
    case "schedules":
      return (
        <ScheduleBoard projectId={scopedProjectId} projects={page.projects} locale={locale} />
      );
    case "costs":
      return <TokenUsage projects={page.projects} />;
    case "health":
      return (
        <div className="space-y-5" data-testid="service-panel">
          <ServiceSegment page={page} />
        </div>
      );
    case "agents":
      return (
        <SystemAgentsPanel
          route={route}
          go={go}
          projectId={scopedProjectId}
          sectionId={route.sectionId ?? null}
          locale={locale}
          page={page}
        />
      );
    case "settings":
      return (
        <div className="space-y-6" data-testid="system-settings">
          <SettingsAlerts page={page} />
          <ProjectHeader page={page} />
          <WorkTab page={page} />
          <KnowledgeTab page={page} />
        </div>
      );
    default: {
      const targetScreenProject = scopedProjectId ?? GLOBAL_SETTINGS_PROJECT_ID;
      const targetScreenSection = scopedProjectId ? (route.sectionId ?? null) : null;
      const explicitKeysCount =
        page.data &&
        page.data.projectId === targetScreenProject &&
        (page.data.sectionId ?? null) === targetScreenSection
          ? page.data.explicitKeys.length
          : null;
      return (
        <SystemHome
          route={route}
          go={go}
          projectId={scopedProjectId}
          sectionId={route.sectionId ?? null}
          explicitKeysCount={explicitKeysCount}
        />
      );
    }
  }
}

function DecisionsSection({ route, go, projectId, page }: ConsoleSectionProps & { page: LpPage }) {
  const scopedProjectId = projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
  return (
    <DecisionsScreen
      view={route.view}
      onViewChange={(next) => go({ ...route, section: "decisions", view: next })}
      projectId={scopedProjectId}
      projects={page.projects}
      compact={page.tabSelect}
      onOpenTask={(runId, taskId) => go({ ...route, section: "work", taskRef: { runId, taskId } })}
      onOpenWork={() => go({ ...route, section: "work", view: "tasks" })}
      onOpenSettings={() => go({ section: "system", page: "settings", projectId: route.projectId, sectionId: route.sectionId })}
    />
  );
}

/** Maps the current `ConsoleRoute` to its screen component inside `ConsoleShell`. */
export function ConsoleRoutes(props: ConsoleSectionProps & { page: LpPage }) {
  switch (props.route.section) {
    case "overview": {
      const scopedProjectId =
        props.projectId && props.projectId !== GLOBAL_SETTINGS_PROJECT_ID ? props.projectId : null;
      return (
        <OverviewScreen
          projectId={scopedProjectId}
          sectionId={props.sectionId}
          go={props.go}
          projects={props.page.projects}
          locale={props.locale}
        />
      );
    }
    case "decisions":
      return <DecisionsSection {...props} />;
    case "staff":
      return <StaffSection {...props} />;
    case "work":
      return <WorkSection {...props} />;
    case "memory":
      return <MemorySection {...props} />;
    case "system":
      return <SystemSection {...props} />;
  }
}
