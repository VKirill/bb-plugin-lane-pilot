import type { ReactNode } from "react";
import { t } from "@lane-pilot/i18n";
import { Label } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { asBoolean, sectionKey } from "./page-model";
import { extraSettingTab } from "./placement";
import { CatalogField, CatalogFields } from "../../settings/ui";
import { AdvancedRows, JevProviderNote, JevProviderPanel, SettingsGroup } from "../../settings/ui";
import { HelpSup } from "@lane-pilot/ui-kit";
import { Pill } from "./pill";
import type { LpPage } from "./use-lp-page";

/** The state of a role whose switch lives in «Team»: this tab only shows it next to the policy it governs. */
function RoleState({ page, enabledKey, fallback, teamLabel }: { page: LpPage; enabledKey: string; fallback: boolean; teamLabel: string }) {
  const on = asBoolean(page.displayedValue(enabledKey), fallback);
  return <span className="flex items-center gap-2"><Pill tone={on ? "success" : "muted"} testId={`state-${enabledKey}`}>{on ? t("on") : t("off")}</Pill><span className="text-xs text-muted-foreground">{teamLabel}</span></span>;
}

/** How work runs: where the writer works, how work is checked and accepted, the limits and the contract paths. */
export function WorkTab({ page }: { page: LpPage }) {
  const { advanced, extrasGrouped, displayedValue, applySetting, catalogRow, isGlobal } = page;
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
      {isGlobal ? <JevProviderPanel page={page} /> : null}
      <SettingsGroup testId="settings-execution" title={t("workGroupExecution")}>
        <section className="space-y-2" data-testid="settings-group-workspace">
          <CatalogField page={page} keyName="adoc.040" />
          <AdvancedRows show={advanced}><CatalogFields page={page} keys={["adoc.041", "adoc.042", "workspace.provider", "ops.max_tasks"]} /></AdvancedRows>
        </section>
        <section className="space-y-2" data-testid="settings-group-quality">
          <CatalogField page={page} keyName="quality_mode" />
          <AdvancedRows show={advanced}><CatalogFields page={page} keys={["sandbox.backend", "verification.sandbox_unsafe", "secrets.allow"]} /></AdvancedRows>
        </section>
      </SettingsGroup>

      <div hidden={!advanced}><SettingsGroup title={t("sectionHelperContext")} testId="settings-helper-context" help={<HelpSup label={t("helperContextTechnical")}><p>{t("helperContextTechnical")}</p><p className="mt-1">{t("helperContextNoneNote")}</p></HelpSup>}>
        <section className="space-y-2" data-testid="helper-context-settings">
          <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextHelp")}</p>
          <p className="max-w-xl text-xs text-muted-foreground">{t("helperContextConstraint")}</p>
          <CatalogField page={page} keyName="helper.placement" />
        </section>
      </SettingsGroup></div>

      <SettingsGroup testId="settings-checks" title={t("workGroupChecks")}>
        {group("plan", <CatalogFields page={page} keys={["plan_critique.mode", "plan_critique.min_score", "plan_critique.min_write_tasks", "plan_critique.on_high_risk"]} />,
          t("stagePlanCritique"), t("planCritiqueHelp"), "plan-critique-policy", { key: "plan_critique.enabled", fallback: true })}
        {group("code", <CatalogFields page={page} keys={["code_critique.mode", "code_critique.auto_fix", "code_critique.max_rounds"]} />,
          t("stageCodeCritique"), t("codeCritiqueHelp"), "code-critique-policy", { key: "code_critique.enabled", fallback: false })}
        {group("specialist", <CatalogField page={page} keyName="specialist.when" />,
          t("specialistReview"), t("settingSpecialistEnabledHelp"), "specialist-policy", { key: "specialist.enabled", fallback: false })}
        {group("night", <>
          <div className="flex items-center justify-between gap-2" data-storage-key="night_review.auto_merge">
            <div className="flex min-w-0 items-center gap-1">
              <span><Label className="text-sm" htmlFor="night-review-auto-merge">{t("nightReviewAutoMerge")}</Label><HelpSup label={t("nightReviewAutoMergeHelp")}><p>{t("nightReviewAutoMergeHelp")}</p></HelpSup></span>
            </div>
            <Switch id="night-review-auto-merge" checked={asBoolean(displayedValue("night_review.auto_merge"), false)} aria-label={t("nightReviewAutoMerge")}
              onCheckedChange={(next) => { const row = catalogRow("night_review.auto_merge"); if (row) void applySetting(row, next); }} />
          </div>
          <CatalogField page={page} keyName="night_review.max_fix_tasks" />
        </>, t(sectionKey("night-review")), t("nightReviewEnabled"), "night-review-policy", { key: "night_review.enabled", fallback: false })}
        <section className="space-y-2" data-testid="pm-read-policy">
          <div className="flex min-w-0 items-center justify-between gap-2">
            <h3 className="text-sm font-medium">{t("largeFileRead")}<HelpSup label={t("largeFileReadTechnical")}><p>{t("largeFileReadTechnical")}</p></HelpSup></h3>
            <RoleState page={page} enabledKey="pm_read.enabled" fallback={false} teamLabel={where} />
          </div>
          <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadHelp")}</p>
          <p className="max-w-xl text-xs text-muted-foreground">{t("largeFileReadConstraint")}</p>
          <AdvancedRows show={advanced}><CatalogField page={page} keyName="pm_read.min_lines" /></AdvancedRows>
        </section>
      </SettingsGroup>

      <SettingsGroup testId="settings-council" title={t("councilSettingsTitle")} help={<HelpSup label={t("councilSettingsTitle")}><p>{t("councilSettingsHelp")}</p></HelpSup>}>
        <RoleState page={page} enabledKey="council.judge" fallback={true} teamLabel={where} />
        <CatalogField page={page} keyName="council.max_rounds" />
      </SettingsGroup>

      {extrasGrouped.map(({ section, rows }) => ({ section, rows: rows.filter((row) => extraSettingTab(row.storageKey) === "work" && row.storageKey !== "council.max_rounds") }))
        .filter(({ rows }) => rows.length > 0)
        .map(({ section, rows }) => (
          <section key={section} className="space-y-2" data-testid={`settings-group-${section}`}>
            <h3 className="text-sm font-medium">{t(sectionKey(section))}</h3>
            <div className="space-y-2">{rows.map((row) => row.storageKey === "jev.provider"
              ? (isGlobal ? null : <JevProviderNote key={row.storageKey} page={page} />)
              : <CatalogField key={row.storageKey} page={page} keyName={row.storageKey} />)}</div>
          </section>
        ))}
    </div>
  );
}
