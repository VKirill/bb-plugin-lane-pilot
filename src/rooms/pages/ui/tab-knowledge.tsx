import { t } from "@lane-pilot/i18n";
import { parseMemorySettings } from "@lane-pilot/memory-core/settings";
import { DocsPlaces } from "../../docs/ui";
import { MemoryRecords } from "../../memory/ui";
import { AdvancedRows, CatalogField, CatalogFields, Pill, SettingsGroup, asBoolean } from "../../ui-shell/ui";
import { HelpSup } from "@lane-pilot/ui-kit";
import { Segments } from "./segments";
import { SEGMENT_LABELS, segmentsFor } from "../models/tabs-model";
import type { LpPage } from "./use-lp-page";

export const MEMORY_ENABLED_KEY = "memory.enabled";
export const MEMORY_ADVANCED_KEYS = [
  "memory.maintain", "memory.maintain_every", "memory.maintain_mode", "memory.salience_min",
  "memory.pack_mode", "memory.query_floor", "memory.project_kind", "memory.inject",
  "memory.audience", "memory.search_engine", "memory.personal_bot", "memory.core_budget",
  "memory.note_budget", "memory.index_budget", "memory.context_budget", "memory.scope",
  "memory.single_claim", "memory.tag_notes", "memory.judge.enabled", "memory.judge.model",
  "memory.judge.fallback_model", "memory.judge.timeout_ms", "memory.judge.candidates",
] as const;
export const DOCS_ENABLED_SETTING_KEY = "docs.enabled";
export const ONBOARDING_DEPTH_KEY = "onboarding.depth";

function State({ page, enabledKey, fallback }: { page: LpPage; enabledKey: string; fallback: boolean }) {
  const on = asBoolean(page.displayedValue(enabledKey), fallback);
  return <span className="flex items-center gap-2"><Pill tone={on ? "success" : "muted"}>{on ? t("on") : t("off")}</Pill><span className="text-xs text-muted-foreground">{t("workModelInTeam")}</span></span>;
}

/** What the system knows: the project's memory and documents. */
export function KnowledgeTab({ page }: { page: LpPage }) {
  const { projectId, isGlobal, advanced, segmentOf, setSegment, tabSelect } = page;
  const ids = segmentsFor("knowledge");
  const segment = ids.includes(segmentOf("knowledge")) ? segmentOf("knowledge") : ids[0]!;
  return (
    <div className="space-y-4">
      <Segments testId="knowledge" label={t("tabKnowledge")} compact={tabSelect} value={segment} onChange={(next) => setSegment("knowledge", next)}
        items={ids.map((id) => ({ id, label: t(SEGMENT_LABELS[id]!) }))} />
      {segment === "memory" ? (
        <SettingsGroup testId="settings-memory" title={t("settingMemoryEnabled")} help={<HelpSup label={t("memoryPickerTechnical")}><p>{t("memoryPickerTechnical")}</p></HelpSup>}>
          <section className="space-y-2" data-testid="memory-knowledge">
            <State page={page} enabledKey={MEMORY_ENABLED_KEY} fallback={parseMemorySettings({}).enabled} />
            <p className="max-w-xl text-xs text-muted-foreground">{t("memoryPickerHelp")}</p>
            {!isGlobal && projectId ? <MemoryRecords projectId={projectId} /> : null}
            <AdvancedRows show={advanced} testId="memory-advanced">
              <CatalogFields page={page} keys={MEMORY_ADVANCED_KEYS} />
            </AdvancedRows>
          </section>
        </SettingsGroup>
      ) : null}
      {segment === "docs" ? (
        <SettingsGroup testId="settings-docs" title={t("groupDocs")} help={<HelpSup label={t("docsPickerTechnical")}><p>{t("docsPickerTechnical")}</p></HelpSup>}>
          <section className="space-y-2" data-testid="docs-knowledge">
            <CatalogField page={page} keyName={DOCS_ENABLED_SETTING_KEY} />
            <p className="max-w-xl text-xs text-muted-foreground">{t("docsPickerHelp")}</p>
            {!isGlobal && projectId ? <DocsPlaces projectId={projectId} /> : null}
          </section>
          <section className="space-y-2" data-testid="onboarding-knowledge">
            <h3 className="text-sm font-medium">{t("onboardingPicker")}<HelpSup label={t("onboardingPickerHelp")}><p>{t("onboardingConstraint")}</p></HelpSup></h3>
            <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingPickerHelp")}</p>
            <p className="max-w-xl text-xs text-muted-foreground">{t("onboardingConstraint")}</p>
            <AdvancedRows show={advanced}><CatalogField page={page} keyName={ONBOARDING_DEPTH_KEY} /></AdvancedRows>
          </section>
        </SettingsGroup>
      ) : null}
    </div>
  );
}
