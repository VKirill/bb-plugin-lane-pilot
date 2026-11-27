import type { ComponentProps } from "react";
import { t, validationMessage, type I18nKey, type Locale } from "@lane-pilot/i18n";
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
import { AcceptanceCard as RawAcceptanceCard, WorkScreen } from "../../runs/ui";
import { ScheduleBoard } from "../../schedule/ui";
import { OwnedSettings } from "../../settings/ui";
import { ReturnStage } from "../../stage-return/ui";
import { TokenUsage } from "../../usage/ui";
import { InputsForm, WorkflowsScreen } from "../../workflow/ui";
import { SYSTEM_PAGES, type ConsoleRoute, type SystemPage } from "../models/nav-model";
import { ProjectHeader } from "./project-header";
import { ServiceSegment } from "./service-segment";
import { KnowledgeTab } from "./tab-knowledge";
import { OverviewScreen } from "./screens/overview-screen";
import { SpecialistStatusCard } from "./tab-overview";
import { TeamTab } from "./tab-team";
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

const SYSTEM_PAGE_TITLES: Record<SystemPage, I18nKey> = {
  graphs: "consoleSysGraphs",
  agents: "consoleSysAgents",
  schedules: "consoleSysSchedules",
  costs: "consoleSysCosts",
  health: "consoleSysHealth",
  settings: "consoleSysSettings",
};

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

function StaffSection({ projectId, page }: ConsoleSectionProps & { page: LpPage }) {
  if (projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID) {
    return (
      <div className="space-y-4" data-testid="console-staff">
        <SpecialistStatusCard page={page} projectId={projectId} />
      </div>
    );
  }
  const mainProjects = page.projectGroups.main;
  if (mainProjects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="console-staff-empty">
        {t("consoleStaffEmpty")}
      </p>
    );
  }
  return (
    <div className="space-y-4" data-testid="console-staff">
      {mainProjects.map((project) => (
        <div key={project.id} className="space-y-2">
          <h2 className="text-sm font-medium">{project.name}</h2>
          <SpecialistStatusCard page={page} projectId={project.id} />
        </div>
      ))}
    </div>
  );
}

function WorkSection({ route, go, projectId, sectionId, locale, page }: ConsoleSectionProps & { page: LpPage }) {
  const scopedProjectId = projectId && projectId !== GLOBAL_SETTINGS_PROJECT_ID ? projectId : null;
  const serviceProjectIds = page.projectGroups.service.map((project) => project.id);
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
        <div className="space-y-6" data-testid="system-agents">
          <SettingsAlerts page={page} />
          <TeamTab page={page} />
          <OwnedSettings scope="agents" locale={locale} />
        </div>
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
    default:
      return (
        <div className="space-y-4" data-testid="console-system-hub">
          <PageHeader title={t("consoleNavSystem")} subtitle={t("consoleSystemLead")} />
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {SYSTEM_PAGES.map((sysPage) => (
              <button
                key={sysPage}
                type="button"
                data-testid={`system-tile-${sysPage}`}
                className="lp-card flex flex-col items-start gap-1 p-4 text-left transition-colors hover:bg-state-hover"
                onClick={() => go({ ...route, section: "system", page: sysPage })}
              >
                <span className="text-sm font-medium text-foreground">
                  {t(SYSTEM_PAGE_TITLES[sysPage])}
                </span>
              </button>
            ))}
          </div>
        </div>
      );
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
