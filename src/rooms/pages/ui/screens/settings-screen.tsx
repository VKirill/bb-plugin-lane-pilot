import { useMemo, useState } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { parseMemorySettings } from "@lane-pilot/memory-core/settings";
import { HelpSup, PageHeader, Segments } from "@lane-pilot/ui-kit";
import { DocsPlaces } from "../../../docs/ui";
import { PushSettings } from "../../../owner-waiting/ui";
import { CatalogField, CatalogFields, LocaleControls, SettingsGroup, sectionKey } from "../../../ui-shell/ui";
import type { ConsoleRoute } from "../../models/nav-model";
import { extraSettingTab } from "../../models/placement";
import {
  DOCS_ENABLED_SETTING_KEY,
  MEMORY_ADVANCED_KEYS,
  MEMORY_ENABLED_KEY,
  ONBOARDING_DEPTH_KEY,
} from "../tab-knowledge";
import {
  RoleState,
  WORK_BASELINE_KEYS,
  WORK_CHECK_GROUPS,
  WORK_HELPER_PLACEMENT_KEY,
  WORK_PM_READ_ENABLED_KEY,
  WORK_PM_READ_MIN_LINES_KEY,
  WORK_QUALITY_ADVANCED_KEYS,
  WORK_QUALITY_KEY,
  WORK_WORKSPACE_ADVANCED_KEYS,
  WORK_WORKSPACE_KEY,
} from "../tab-work";
import type { LpPage } from "../use-lp-page";

export type SettingsGroupId = "work" | "memory" | "docs" | "notifications";

const GROUP_IDS: readonly SettingsGroupId[] = ["work", "memory", "docs", "notifications"];

const GROUP_LABELS: Record<SettingsGroupId, I18nKey> = {
  work: "consoleSettingsGroupWork",
  memory: "consoleSettingsGroupMemory",
  docs: "consoleSettingsGroupDocs",
  notifications: "consoleSettingsGroupNotifications",
};

function isSettingsGroupId(value: string | undefined): value is SettingsGroupId {
  return value === "work" || value === "memory" || value === "docs" || value === "notifications";
}

export interface SettingsScreenProps {
  route?: ConsoleRoute;
  go?: (next: ConsoleRoute) => void;
  page: LpPage;
}

/** P16 Settings screen: scope-level switcher (System / Project / Section) and 4 groups with rare fields folded under «More». */
export function SettingsScreen({ route, go, page }: SettingsScreenProps) {
  const {
    projectId,
    isGlobal,
    selectedSectionId,
    selectedProjectName,
    selectedSectionName,
    projects,
    sections,
    level,
    localePreference,
    chooseLocale,
    extrasGrouped,
    stackControls,
    catalogRow,
  } = page;

  const [localGroup, setLocalGroup] = useState<SettingsGroupId>("work");
  const activeGroup: SettingsGroupId = isSettingsGroupId(route?.view) ? route.view : localGroup;

  const selectGroup = (next: SettingsGroupId) => {
    setLocalGroup(next);
    if (go && route) {
      go({
        ...route,
        section: "system",
        page: "settings",
        view: next === "work" ? undefined : next,
      });
    }
  };

  const handleLevelPick = (nextLevel: "system" | "project" | "section") => {
    if (!go || !route) return;
    if (nextLevel === "system") {
      go({ ...route, section: "system", page: "settings", projectId: undefined, sectionId: undefined });
      return;
    }
    const targetProject = !isGlobal && projectId ? projectId : projects[0]?.id;
    if (!targetProject) return;
    if (nextLevel === "project") {
      go({ ...route, section: "system", page: "settings", projectId: targetProject, sectionId: undefined });
      return;
    }
    const targetSection = selectedSectionId ?? sections[0]?.id;
    if (!targetSection) return;
    go({ ...route, section: "system", page: "settings", projectId: targetProject, sectionId: targetSection });
  };

  const subtitle =
    level === "system"
      ? t("globalsHelp")
      : level === "section"
        ? t("consoleSettingsSubtitleSection")
            .replace("{section}", selectedSectionName ?? selectedSectionId ?? "")
            .replace("{project}", selectedProjectName ?? projectId ?? "")
        : t("consoleSettingsSubtitleProject").replace("{name}", selectedProjectName ?? projectId ?? "");

  const workExtras = useMemo(
    () =>
      extrasGrouped
        .map(({ section, rows }) => ({ section, rows: rows.filter((row) => extraSettingTab(row.storageKey) === "work") }))
        .filter(({ rows }) => rows.length > 0),
    [extrasGrouped],
  );

  const visibleCount = (keys: readonly string[]) => keys.filter((k) => Boolean(catalogRow(k))).length;
  const workMoreCount =
    visibleCount(WORK_WORKSPACE_ADVANCED_KEYS) +
    visibleCount(WORK_QUALITY_ADVANCED_KEYS) +
    (isGlobal ? 0 : visibleCount(WORK_BASELINE_KEYS)) +
    visibleCount([WORK_HELPER_PLACEMENT_KEY, WORK_PM_READ_MIN_LINES_KEY]) +
    WORK_CHECK_GROUPS.reduce((sum, item) => sum + visibleCount(item.keys), 0) +
    workExtras.reduce((sum, group) => sum + group.rows.length, 0);

  const memoryMoreCount = visibleCount(MEMORY_ADVANCED_KEYS);
  const docsMoreCount = visibleCount([ONBOARDING_DEPTH_KEY]);
  const moreLabel = (count: number) =>
    count > 0 ? t("consoleSettingsMoreCount").replace("{n}", String(count)) : t("consoleSettingsMore");

  const where = t("workModelInTeam");

  return (
    <div className="space-y-5" data-testid="settings-screen">
      <PageHeader
        title={t("consoleSysSettings")}
        subtitle={subtitle}
        actions={
          <Segments
            testId="settings-level-picker"
            label={t("consoleLoadoutLevelAria")}
            compact={stackControls}
            value={level}
            onChange={(next) => handleLevelPick(next as "system" | "project" | "section")}
            items={[
              { id: "system", label: t("consoleLoadoutLevelSystem") },
              { id: "project", label: t("consoleLoadoutLevelProject") },
              { id: "section", label: t("consoleLoadoutLevelSection") },
            ]}
          />
        }
      />

      <div className={stackControls ? "space-y-4" : "grid gap-6 md:grid-cols-[13.5rem_minmax(0,1fr)] md:items-start"}>
        {stackControls ? (
          <Segments
            testId="settings-groups"
            label={t("consoleSysSettings")}
            compact={true}
            value={activeGroup}
            onChange={(next) => selectGroup(next as SettingsGroupId)}
            items={GROUP_IDS.map((id) => ({ id, label: t(GROUP_LABELS[id]) }))}
          />
        ) : (
          <nav className="flex flex-col gap-1" aria-label={t("consoleSysSettings")} data-testid="settings-groups-nav">
            {GROUP_IDS.map((id) => {
              const active = activeGroup === id;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`settings-nav-${id}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => selectGroup(id)}
                  className={
                    active
                      ? "rounded-lg border border-[var(--lp-hairline)] bg-[var(--lp-card)] px-3 py-2 text-left text-sm font-medium text-foreground shadow-xs"
                      : "rounded-lg px-3 py-2 text-left text-sm text-muted-foreground hover:bg-state-hover hover:text-foreground"
                  }
                >
                  {t(GROUP_LABELS[id])}
                </button>
              );
            })}
          </nav>
        )}

        <div className="min-w-0 space-y-6">
          <div hidden={activeGroup !== "work"} data-testid="work-panel-body">
            <SettingsGroup
              testId="settings-work"
              title={t("consoleSettingsGroupWork")}
              moreTestId="settings-more-work"
              moreSummary={moreLabel(workMoreCount)}
              more={
                <div className="space-y-5">
                  <section className="space-y-2" data-testid="settings-group-workspace">
                    <CatalogFields page={page} keys={WORK_WORKSPACE_ADVANCED_KEYS} />
                  </section>
                  <section className="space-y-2" data-testid="settings-group-quality">
                    <CatalogFields page={page} keys={WORK_QUALITY_ADVANCED_KEYS} />
                  </section>
                  {isGlobal ? null : (
                    <section className="space-y-2" data-testid="settings-project-checks">
                      <h3 className="text-sm font-medium">{t("workGroupBaseline")}</h3>
                      <p className="max-w-xl text-xs text-muted-foreground">{t("workGroupBaselineHelp")}</p>
                      <CatalogFields page={page} keys={WORK_BASELINE_KEYS} />
                    </section>
                  )}
                  <section className="space-y-2" data-testid="helper-context-settings">
                    <div className="flex items-center gap-1">
                      <h3 className="text-sm font-medium">{t("sectionHelperContext")}</h3>
                      <HelpSup label={t("helperContextTechnical")}>
                        <p>{t("helperContextTechnical")}</p>
                        <p className="mt-1">{t("helperContextNoneNote")}</p>
                      </HelpSup>
                    </div>
                    <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextHelp")}</p>
                    <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextConstraint")}</p>
                    <CatalogField page={page} keyName={WORK_HELPER_PLACEMENT_KEY} />
                  </section>
                  {WORK_CHECK_GROUPS.map((item) => (
                    <section key={item.key} className="space-y-2" data-testid={`work-${item.key}`}>
                      <h3 className="text-sm font-medium">{t(item.titleKey)}</h3>
                      <CatalogFields page={page} keys={item.keys} />
                    </section>
                  ))}
                  <section className="space-y-2" data-testid="work-pm-read">
                    <h3 className="text-sm font-medium">{t("largeFileRead")}</h3>
                    <CatalogField page={page} keyName={WORK_PM_READ_MIN_LINES_KEY} />
                  </section>
                  {workExtras.map(({ section, rows }) => (
                    <section key={section} className="space-y-2" data-testid={`settings-group-${section}`}>
                      <h3 className="text-sm font-medium">{t(sectionKey(section))}</h3>
                      <div className="space-y-2">
                        {rows.map((row) => (
                          <CatalogField key={row.storageKey} page={page} keyName={row.storageKey} />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              }
            >
              <CatalogField page={page} keyName={WORK_WORKSPACE_KEY} />
              <CatalogField page={page} keyName={WORK_QUALITY_KEY} />
              {WORK_CHECK_GROUPS.map((item) => (
                <section key={item.key} className="space-y-1.5" data-testid={item.testId}>
                  <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                    <h3 className="text-sm font-medium">{t(item.titleKey)}</h3>
                    <RoleState page={page} enabledKey={item.enabled.key} fallback={item.enabled.fallback} teamLabel={where} />
                  </div>
                  <p className="max-w-xl text-xs text-muted-foreground">{t(item.helpKey)}</p>
                </section>
              ))}
              <section className="space-y-1.5" data-testid="pm-read-policy">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <h3 className="text-sm font-medium">
                    {t("largeFileRead")}
                    <HelpSup label={t("largeFileReadTechnical")}>
                      <p>{t("largeFileReadTechnical")}</p>
                    </HelpSup>
                  </h3>
                  <RoleState page={page} enabledKey={WORK_PM_READ_ENABLED_KEY} fallback={false} teamLabel={where} />
                </div>
                <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadHelp")}</p>
                <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadConstraint")}</p>
              </section>
            </SettingsGroup>
          </div>

          <div hidden={activeGroup !== "memory"} data-testid="settings-group-panel-memory">
            <SettingsGroup
              testId="settings-memory"
              title={t("settingMemoryEnabled")}
              help={<HelpSup label={t("memoryPickerTechnical")}><p>{t("memoryPickerTechnical")}</p></HelpSup>}
              moreTestId="settings-more-memory"
              moreSummary={moreLabel(memoryMoreCount)}
              more={
                <div data-testid="memory-advanced" className="space-y-2">
                  <CatalogFields page={page} keys={MEMORY_ADVANCED_KEYS} />
                </div>
              }
            >
              <section className="space-y-2" data-testid="memory-knowledge">
                <RoleState
                  page={page}
                  enabledKey={MEMORY_ENABLED_KEY}
                  fallback={parseMemorySettings({}).enabled}
                  teamLabel={where}
                />
                <p className="max-w-xl text-xs text-muted-foreground">{t("memoryPickerHelp")}</p>
              </section>
            </SettingsGroup>
          </div>

          <div hidden={activeGroup !== "docs"} data-testid="settings-group-panel-docs">
            <SettingsGroup
              testId="settings-docs"
              title={t("groupDocs")}
              help={<HelpSup label={t("docsPickerTechnical")}><p>{t("docsPickerTechnical")}</p></HelpSup>}
              moreTestId="settings-more-docs"
              moreSummary={moreLabel(docsMoreCount)}
              more={
                <div data-testid="docs-advanced">
                  <CatalogField page={page} keyName={ONBOARDING_DEPTH_KEY} />
                </div>
              }
            >
              <section className="space-y-2" data-testid="docs-knowledge">
                <CatalogField page={page} keyName={DOCS_ENABLED_SETTING_KEY} />
                <p className="max-w-xl text-xs text-muted-foreground">{t("docsPickerHelp")}</p>
                {!isGlobal && projectId ? <DocsPlaces projectId={projectId} /> : null}
              </section>
              <section className="space-y-2" data-testid="onboarding-knowledge">
                <h3 className="text-sm font-medium">
                  {t("onboardingPicker")}
                  <HelpSup label={t("onboardingPickerHelp")}>
                    <p>{t("onboardingConstraint")}</p>
                  </HelpSup>
                </h3>
                <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingPickerHelp")}</p>
                <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingConstraint")}</p>
              </section>
            </SettingsGroup>
          </div>

          <div hidden={activeGroup !== "notifications"} data-testid="settings-group-panel-notifications">
            <SettingsGroup testId="settings-notifications" title={t("consoleSettingsGroupNotifications")}>
              <section className="space-y-2" data-testid="settings-locale">
                <h3 className="text-sm font-medium">{t("consoleSettingsLanguageTitle")}</h3>
                <LocaleControls preference={localePreference} onChange={(next) => void chooseLocale(next)} />
                <p className="max-w-xl text-xs text-muted-foreground">{t("languageHelp")}</p>
              </section>
              <PushSettings />
            </SettingsGroup>
          </div>
        </div>
      </div>
    </div>
  );
}
