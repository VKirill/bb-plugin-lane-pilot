import type { ReactNode } from "react";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { AdvancedRows, CatalogField, CatalogFields, Pill, SettingsGroup, asBoolean, sectionKey } from "../../ui-shell/ui";
import { extraSettingTab } from "../models/placement";
import { HelpSup } from "@lane-pilot/ui-kit";
import type { LpPage } from "./use-lp-page";

export const WORK_WORKSPACE_KEY = "adoc.040";
export const WORK_WORKSPACE_ADVANCED_KEYS = ["workspace.provider"] as const;
export const WORK_QUALITY_KEY = "quality_mode";
export const WORK_QUALITY_ADVANCED_KEYS = ["sandbox.backend", "verification.sandbox_unsafe", "secrets.allow", "plan_fact.mode"] as const;
export const WORK_BASELINE_KEYS = ["baseline.already_built", "baseline.time_cap_sec", "checks.require_red_on_base"] as const;
export const WORK_HELPER_PLACEMENT_KEY = "helper.placement";
export const WORK_PM_READ_ENABLED_KEY = "pm_read.enabled";
export const WORK_PM_READ_MIN_LINES_KEY = "pm_read.min_lines";

export const WORK_CHECK_GROUPS: ReadonlyArray<{
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

/** The state of a role whose switch lives in «Team»: this tab only shows it next to the policy it governs. */
export function RoleState({ page, enabledKey, fallback, teamLabel }: { page: LpPage; enabledKey: string; fallback: boolean; teamLabel: string }) {
  const on = asBoolean(page.displayedValue(enabledKey), fallback);
  return <span className="flex items-center gap-2"><Pill tone={on ? "success" : "muted"} testId={`state-${enabledKey}`}>{on ? t("on") : t("off")}</Pill><span className="text-xs text-muted-foreground">{teamLabel}</span></span>;
}

/** How work runs: where the writer works, how work is checked and accepted, the limits and the contract paths. */
export function WorkTab({ page }: { page: LpPage }) {
  const { advanced, extrasGrouped, isGlobal } = page;
  const where = t("workModelInTeam");
  // One level inside the panel: a titled block with the state of the role it governs, not a card in a card.
  const group = (key: string, children: ReactNode, title: string, help: string, testId: string, enabled: { key: string; fallback: boolean }) => (
    <section className="space-y-2" data-testid={testId}>
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <RoleState page={page} enabledKey={enabled.key} fallback={enabled.fallback} teamLabel={where} />
      </div>
      <p className="max-w-xl text-xs text-muted-foreground">{help}</p>
      <AdvancedRows show={advanced} testId={`work-${key}`}>{children}</AdvancedRows>
    </section>
  );
  return (
    <div className="space-y-6" data-testid="work-panel-body">
      <SettingsGroup testId="settings-execution" title={t("workGroupExecution")}>
        <section className="space-y-2" data-testid="settings-group-workspace">
          <CatalogField page={page} keyName={WORK_WORKSPACE_KEY} />
          <AdvancedRows show={advanced}><CatalogFields page={page} keys={WORK_WORKSPACE_ADVANCED_KEYS} /></AdvancedRows>
        </section>
        <section className="space-y-2" data-testid="settings-group-quality">
          <CatalogField page={page} keyName={WORK_QUALITY_KEY} />
          <AdvancedRows show={advanced}><CatalogFields page={page} keys={WORK_QUALITY_ADVANCED_KEYS} /></AdvancedRows>
        </section>
      </SettingsGroup>

      {isGlobal ? null : (
        <div hidden={!advanced}><SettingsGroup testId="settings-project-checks" title={t("workGroupBaseline")}>
          <p className="max-w-xl text-xs text-muted-foreground">{t("workGroupBaselineHelp")}</p>
          <CatalogFields page={page} keys={WORK_BASELINE_KEYS} />
        </SettingsGroup></div>
      )}

      <div hidden={!advanced}><SettingsGroup title={t("sectionHelperContext")} testId="settings-helper-context" help={<HelpSup label={t("helperContextTechnical")}><p>{t("helperContextTechnical")}</p><p className="mt-1">{t("helperContextNoneNote")}</p></HelpSup>}>
        <section className="space-y-2" data-testid="helper-context-settings">
          <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextHelp")}</p>
          <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextConstraint")}</p>
          <CatalogField page={page} keyName={WORK_HELPER_PLACEMENT_KEY} />
        </section>
      </SettingsGroup></div>

      <SettingsGroup testId="settings-checks" title={t("workGroupChecks")}>
        {WORK_CHECK_GROUPS.map((item) =>
          group(item.key, <CatalogFields page={page} keys={item.keys} />, t(item.titleKey), t(item.helpKey), item.testId, item.enabled),
        )}
        {/* night_review.* is reserved: no stage reads it (settings-catalog channels.ts), so the screen offers no live switch for it (Astra F-012, Gemini F-015.2). */}
        <section className="space-y-2" data-testid="pm-read-policy">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t("largeFileRead")}<HelpSup label={t("largeFileReadTechnical")}><p>{t("largeFileReadTechnical")}</p></HelpSup></h3>
            <RoleState page={page} enabledKey={WORK_PM_READ_ENABLED_KEY} fallback={false} teamLabel={where} />
          </div>
          <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadHelp")}</p>
          <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadConstraint")}</p>
          <AdvancedRows show={advanced}><CatalogField page={page} keyName={WORK_PM_READ_MIN_LINES_KEY} /></AdvancedRows>
        </section>
      </SettingsGroup>

      {extrasGrouped.map(({ section, rows }) => ({ section, rows: rows.filter((row) => extraSettingTab(row.storageKey) === "work") }))
        .filter(({ rows }) => rows.length > 0)
        .map(({ section, rows }) => (
          <section key={section} className="space-y-2" data-testid={`settings-group-${section}`}>
            <h3 className="text-sm font-medium">{t(sectionKey(section))}</h3>
            <div className="space-y-2">{rows.map((row) => <CatalogField key={row.storageKey} page={page} keyName={row.storageKey} />)}</div>
          </section>
        ))}
    </div>
  );
}
