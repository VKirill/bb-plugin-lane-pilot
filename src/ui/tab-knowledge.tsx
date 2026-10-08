import { t } from "../../i18n";
import { AnamnesisTab } from "./anamnesis-tab";
import { DocsPlaces } from "./docs-places";
import { MemoryRecords } from "./memory-records";
import { RuleProposals } from "./rule-proposals";
import { asBoolean } from "./page-model";
import { CatalogField, CatalogFields } from "./catalog-field";
import { AdvancedRows, SettingsGroup } from "./setting-controls";
import { HelpSup } from "./help-sup";
import { Pill } from "./pill";
import { Segments } from "./segments";
import { SEGMENT_LABELS, segmentsFor } from "./tabs-model";
import type { LpPage } from "./use-lp-page";

function State({ page, enabledKey, fallback }: { page: LpPage; enabledKey: string; fallback: boolean }) {
  const on = asBoolean(page.displayedValue(enabledKey), fallback);
  return <span className="flex items-center gap-2"><Pill tone={on ? "success" : "muted"}>{on ? t("on") : t("off")}</Pill><span className="text-xs text-muted-foreground">{t("workModelInTeam")}</span></span>;
}

/** What the system knows: the project's memory and documents, the rules it learns from failures, and (system level) what it knows about the owner. */
export function KnowledgeTab({ page }: { page: LpPage }) {
  const { projectId, isGlobal, advanced, level, segmentOf, setSegment, tabSelect } = page;
  const ids = segmentsFor("knowledge", level);
  const segment = ids.includes(segmentOf("knowledge")) ? segmentOf("knowledge") : ids[0]!;
  return (
    <div className="space-y-4">
      <Segments testId="knowledge" label={t("tabKnowledge")} compact={tabSelect} value={segment} onChange={(next) => setSegment("knowledge", next)}
        items={ids.map((id) => ({ id, label: t(SEGMENT_LABELS[id]!) }))} />
      {segment === "memory" ? (
        <SettingsGroup testId="settings-memory" title={t("settingMemoryEnabled")} help={<HelpSup label={t("memoryPickerTechnical")}><p>{t("memoryPickerTechnical")}</p></HelpSup>}>
          <section className="space-y-2" data-testid="memory-knowledge">
            <State page={page} enabledKey="memory.enabled" fallback={false} />
            <p className="max-w-xl text-xs text-muted-foreground">{t("memoryPickerHelp")}</p>
            {!isGlobal && projectId ? <MemoryRecords projectId={projectId} /> : null}
            <AdvancedRows show={advanced} testId="memory-advanced">
              <CatalogFields page={page} keys={["memory.maintain", "memory.inject", "memory.audience", "memory.search_engine", "memory.personal_bot", "memory.core_budget", "memory.note_budget", "memory.index_budget", "memory.context_budget"]} />
            </AdvancedRows>
          </section>
        </SettingsGroup>
      ) : null}
      {segment === "docs" ? (
        <SettingsGroup testId="settings-docs" title={t("groupDocs")} help={<HelpSup label={t("docsPickerTechnical")}><p>{t("docsPickerTechnical")}</p></HelpSup>}>
          <section className="space-y-2" data-testid="docs-knowledge">
            <p className="max-w-xl text-xs text-muted-foreground">{t("docsPickerHelp")}</p>
            {!isGlobal && projectId ? <DocsPlaces projectId={projectId} /> : null}
            <AdvancedRows show={advanced}><CatalogFields page={page} keys={["docs.maintain", "docs.page_cap", "docs.since", "docs.hour"]} /></AdvancedRows>
          </section>
          <section className="space-y-2" data-testid="project-life-knowledge">
            <h3 className="text-sm font-medium">{t("groupProjectLife")}<HelpSup label={t("projectLifePickerTechnical")}><p>{t("projectLifePickerTechnical")}</p></HelpSup></h3>
            <State page={page} enabledKey="project_life.enabled" fallback={true} />
            <p className="max-w-xl text-xs text-muted-foreground">{t("projectLifePickerHelp")}</p>
          </section>
          <section className="space-y-2" data-testid="onboarding-knowledge">
            <h3 className="text-sm font-medium">{t("onboardingPicker")}<HelpSup label={t("onboardingPickerHelp")}><p>{t("onboardingConstraint")}</p></HelpSup></h3>
            <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingPickerHelp")}</p>
            <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingConstraint")}</p>
            <AdvancedRows show={advanced}><CatalogField page={page} keyName="onboarding.depth" /></AdvancedRows>
          </section>
        </SettingsGroup>
      ) : null}
      {segment === "rules" && !isGlobal && projectId ? (
        <div data-testid="rules-panel"><RuleProposals projectId={projectId} /></div>
      ) : null}
      {segment === "anamnesis" ? <div data-testid="anamnesis-panel"><AnamnesisTab /></div> : null}
    </div>
  );
}
