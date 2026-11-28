import { useMemo, useState } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { parseMemorySettings } from "@lane-pilot/memory-core/settings";
import { HelpSup, PageHeader, Segments } from "@lane-pilot/ui-kit";
import { DocsPlaces } from "../../../docs/ui";
import { PushSettings } from "../../../owner-waiting/ui";
import { CatalogField, CatalogFields, LocaleControls, Pill, SettingsGroup, asBoolean, sectionKey } from "../../../ui-shell/ui";
import type { ConsoleRoute } from "../../models/nav-model";
import { extraSettingTab } from "../../models/placement";
import type { LpPage } from "../use-lp-page";

const MEMORY_ENABLED_KEY = "memory.enabled";
const MEMORY_ADVANCED_KEYS = [
  "memory.maintain", "memory.maintain_every", "memory.maintain_mode", "memory.salience_min",
  "memory.pack_mode", "memory.query_floor", "memory.project_kind", "memory.inject",
  "memory.audience", "memory.search_engine", "memory.personal_bot", "memory.core_budget",
  "memory.note_budget", "memory.index_budget", "memory.context_budget", "memory.scope",
  "memory.single_claim", "memory.tag_notes", "memory.judge.enabled", "memory.judge.model",
  "memory.judge.fallback_model", "memory.judge.timeout_ms", "memory.judge.candidates",
] as const;
const DOCS_ENABLED_SETTING_KEY = "docs.enabled";
const ONBOARDING_DEPTH_KEY = "onboarding.depth";

const WORK_WORKSPACE_KEY = "adoc.040";
const WORK_WORKSPACE_ADVANCED_KEYS = ["workspace.provider"] as const;
const WORK_QUALITY_KEY = "quality_mode";
const WORK_QUALITY_ADVANCED_KEYS = ["sandbox.backend", "verification.sandbox_unsafe", "secrets.allow", "plan_fact.mode"] as const;
const WORK_BASELINE_KEYS = ["baseline.already_built", "baseline.time_cap_sec", "checks.require_red_on_base"] as const;
const WORK_HELPER_PLACEMENT_KEY = "helper.placement";
const WORK_PM_READ_ENABLED_KEY = "pm_read.enabled";
const WORK_PM_READ_MIN_LINES_KEY = "pm_read.min_lines";

const WORK_CHECK_GROUPS: ReadonlyArray<{
  key: string;
  keys: readonly string[];
  titleKey: I18nKey;
  helpKey: I18nKey;
  testId: string;
  enabled: { key: string; fallback: boolean };
}> = [
  {
    key: "plan",
    keys: ["plan_critique.mode", "plan_critique.min_score", "plan_critique.min_write_tasks", "plan_critique.on_high_risk"],
    titleKey: "stagePlanCritique",
    helpKey: "planCritiqueHelp",
    testId: "plan-critique-policy",
    enabled: { key: "plan_critique.enabled", fallback: true },
  },
  {
    key: "code",
    keys: ["code_critique.mode", "code_critique.auto_fix", "code_critique.max_rounds", "critic.code.default_for_risk"],
    titleKey: "stageCodeCritique",
    helpKey: "codeCritiqueHelp",
    testId: "code-critique-policy",
    enabled: { key: "code_critique.enabled", fallback: false },
  },
  {
    key: "specialist",
    keys: ["specialist.when"],
    titleKey: "specialistReview",
    helpKey: "settingSpecialistEnabledHelp",
    testId: "specialist-policy",
    enabled: { key: "specialist.enabled", fallback: false },
  },
];

function RoleState({ page, enabledKey, fallback, teamLabel }: { page: LpPage; enabledKey: string; fallback: boolean; teamLabel: string }) {
  const on = asBoolean(page.displayedValue(enabledKey), fallback);
  return <span className="flex items-center gap-2"><Pill tone={on ? "success" : "muted"} testId={`state-${enabledKey}`}>{on ? t("on") : t("off")}</Pill><span className="text-xs text-muted-foreground">{teamLabel}</span></span>;
}

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

      <div className={stackControls ? "space-y-4" : "grid gap-[18px] md:grid-cols-[220px_minmax(0,1fr)] md:items-start"}>
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
          <nav className="flex flex-col gap-1 lp-sys-nav" aria-label={t("consoleSysSettings")} data-testid="settings-groups-nav">
            {GROUP_IDS.map((id) => {
              const active = activeGroup === id;
              return (
                <button
                  key={id}
                  type="button"
                  data-testid={`settings-nav-${id}`}
                  aria-current={active ? "true" : undefined}
                  onClick={() => selectGroup(id)}
                  className="lp-sys-nav-item"
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
