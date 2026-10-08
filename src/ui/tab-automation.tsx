import { t } from "@lane-pilot/i18n";
import { CatalogField } from "./catalog-field";
import { extraSettingTab } from "./placement";
import { ScheduleBoard } from "../rooms/schedule/ui/schedule-board";
import { Segments } from "./segments";
import { SEGMENT_LABELS, segmentsFor } from "./tabs-model";
import { SettingsGroup } from "./setting-controls";
import { WorkflowsScreen } from "./workflows";
import type { LpPage } from "./use-lp-page";

/** Workflows (the library of chains the project manager picks from) and the schedule board with its calendar. */
export function AutomationTab({ page }: { page: LpPage }) {
  const { projectId, isGlobal, level, locale, projects, segmentOf, setSegment, tabSelect, extrasGrouped, selectedProjectId, routeProjectId, subPath, selectedSectionId } = page;
  const ids = segmentsFor("automation", level);
  const segment = ids.includes(segmentOf("automation")) ? segmentOf("automation") : ids[0]!;
  const presets = extrasGrouped.map(({ section, rows }) => ({ section, rows: rows.filter((row) => extraSettingTab(row.storageKey) === "automation") })).filter(({ rows }) => rows.length > 0);
  return (
    <div className="space-y-4">
      <Segments testId="automation" label={t("tabAutomation")} compact={tabSelect} value={segment} onChange={(next) => setSegment("automation", next)}
        items={ids.map((id) => ({ id, label: t(SEGMENT_LABELS[id]!) }))} />
      {selectedSectionId ? <p className="text-xs text-muted-foreground" data-testid="automation-project-level">{t("automationProjectLevel")}</p> : null}
      {segment === "workflows" ? (
        <div className="space-y-6" data-testid="workflows-panel">
          <WorkflowsScreen locale={locale} projectId={isGlobal ? null : projectId} architectProjectId={isGlobal ? selectedProjectId ?? routeProjectId ?? (subPath || null) : projectId} />
          {presets.map(({ section, rows }) => (
            <SettingsGroup key={section} testId={`settings-group-${section}`} title={t("automationPresets")}>
              <p className="max-w-xl text-xs text-muted-foreground">{t("automationPresetsHelp")}</p>
              <div className="space-y-2">{rows.map((row) => <CatalogField key={row.storageKey} page={page} keyName={row.storageKey} />)}</div>
            </SettingsGroup>
          ))}
        </div>
      ) : null}
      {segment === "schedule" ? (
        <div data-testid="schedule-panel"><ScheduleBoard projectId={isGlobal ? null : projectId} projects={projects} locale={locale} /></div>
      ) : null}
    </div>
  );
}
