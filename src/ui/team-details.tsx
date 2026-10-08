import type { ExperimentalProviderModelPickerValue } from "@get-bb/plugin-sdk/app";
import { t, validationMessage, type I18nKey } from "@lane-pilot/i18n";
import { WRITER_FALLBACK_DEFAULTS, WRITER_FALLBACK_SLOTS, writerFallbackKeys } from "../writer-fallbacks";
import { QA_HOST_KEY, QA_WORKSPACE_KEY } from "../rooms/qa/qa-host";
import { Button } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { Label } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { AdvancedRows } from "../rooms/settings/ui/setting-controls";
import { CatalogField } from "../rooms/settings/ui/catalog-field";
import { asBoolean, COUNCIL_SEATS } from "./page-model";
import type { LpPage } from "./use-lp-page";

/** The writer's own settings: the two fallbacks, how the reasoning effort is picked, the agent profile and what the runs say about the pair. */
export function WriterDetail({ page }: { page: LpPage }) {
  const { data, modelPicker, saveWriterFallback, fallbackTouched, writerRejected, saveError, advanced, jevRows, displayedValue, applySetting } = page;
  const effortRow = jevRows.find((row) => row.storageKey === "jev.LANE_JEV_EFFORT");
  const automaticEffort = asBoolean(displayedValue("jev.LANE_JEV_EFFORT"), true);
  return (
    <div className="space-y-3" data-testid="writer-detail">
      <p className="max-w-xl text-xs text-muted-foreground">{t("writerPickerHelp")}</p>
      <div className="max-w-xl space-y-3 pt-1" data-testid="writer-fallbacks">
        <p className="text-xs text-muted-foreground">{t("writerFallbackHelp")}</p>
        {WRITER_FALLBACK_SLOTS.map((slot, index) => {
          const keys = writerFallbackKeys(slot);
          const stored = data?.values[keys.provider];
          const off = stored === "";
          const fallback = WRITER_FALLBACK_DEFAULTS[index]!;
          // A slot turned back on stores its default: it still reads as the default.
          const configured = typeof stored === "string" && stored !== ""
            && !(stored === fallback.providerId && data?.values[keys.model] === fallback.model && data?.values[keys.effort] === fallback.reasoningLevel);
          const value: ExperimentalProviderModelPickerValue = configured
            ? { providerId: String(stored), model: String(data?.values[keys.model] ?? ""), reasoningLevel: (String(data?.values[keys.effort] ?? "high") || "high") as ExperimentalProviderModelPickerValue["reasoningLevel"] }
            : { providerId: fallback.providerId, model: fallback.model, reasoningLevel: fallback.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"] };
          const touch = () => { fallbackTouched.current.add(slot); };
          return (
            <div key={slot} className="space-y-1.5" data-testid={`writer-fallback-${slot}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium">{t(slot === 1 ? "writerFallback1" : "writerFallback2")}</span>
                <span className="text-xs text-muted-foreground">{off ? t("writerFallbackOffState") : configured ? t("councilSeatOwnSet") : t("writerFallbackDefault")}</span>
                <Button type="button" size="sm" variant="ghost" className="h-7 px-2" data-testid={`writer-fallback-${slot}-toggle`}
                  onClick={() => void (off ? saveWriterFallback(slot, { providerId: fallback.providerId, model: fallback.model, reasoningLevel: fallback.reasoningLevel as ExperimentalProviderModelPickerValue["reasoningLevel"] }) : saveWriterFallback(slot, null))}>
                  {off ? t("writerFallbackTurnOn") : t("writerFallbackTurnOff")}
                </Button>
              </div>
              {off ? null : <div onPointerDownCapture={touch} onKeyDownCapture={touch}>
                {modelPicker(value, (next) => { if (fallbackTouched.current.has(slot)) void saveWriterFallback(slot, next); })}
              </div>}
            </div>
          );
        })}
      </div>
      {writerRejected && saveError ? <p className="max-w-xl text-xs text-destructive" data-testid="writer-save-error">{saveError.kind === "cas" ? t("casConflict") : validationMessage(saveError.code, saveError.params)}</p> : null}
      {effortRow ? (
        <AdvancedRows show={advanced} testId="writer-effort-mode">
          <div className="flex items-center justify-between gap-2 pt-2">
            <Label className="text-sm" htmlFor="writer-effort-mode">{t("writerEffortMode")}</Label>
            <Select value={automaticEffort ? "automatic" : "manual"} onValueChange={(next) => void applySetting(effortRow, next === "automatic" ? "1" : "0")}>
              <SelectTrigger id="writer-effort-mode" aria-label={t("writerEffortMode")} className="w-[11rem] min-w-0 max-w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="automatic">{t("writerEffortAutomatic")}</SelectItem>
                <SelectItem value="manual">{t("writerEffortManual")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <p className="max-w-xl text-xs text-muted-foreground">{automaticEffort ? t("writerEffortFallbackNote") : t("writerEffortManualNote")}</p>
          <div className="space-y-2" data-testid="jev-settings">
            {jevRows.filter((row) => row.storageKey !== "jev.LANE_JEV_EFFORT").map((row) => {
              const label = t("jevOpencode");
              return <div key={row.storageKey} className="flex items-center justify-between gap-2">
                <Label className="text-sm" htmlFor={row.id}>{label}</Label>
                <Switch id={row.id} checked={asBoolean(displayedValue(row.storageKey), true)} aria-label={label}
                  onCheckedChange={(next) => void applySetting(row, next ? "1" : "0")} />
              </div>;
            })}
          </div>
          <CatalogField page={page} keyName="writer.agent" />
        </AdvancedRows>
      ) : null}
    </div>
  );
}

/** The seven seats of the directors' council, each with its own model; a seat without a pair of its own follows the stage models. */
export function CouncilDetail({ page }: { page: LpPage }) {
  const { data, councilDefaults, councilSeatsTouched, councilSeatPickerValue, saveCouncilSeatSelection, resetInherited, modelPicker } = page;
  return (
    <div className="space-y-3" data-testid="council-seats">
      <p className="max-w-xl text-xs text-muted-foreground">{t("councilSettingsHelp")}</p>
      {COUNCIL_SEATS.map((seat) => {
        const fallback = councilDefaults.find((row) => row.id === seat);
        const configured = Boolean(data?.values[`council.${seat}.provider`] && data?.values[`council.${seat}.model`]);
        const keys = [`council.${seat}.provider`, `council.${seat}.model`, `council.${seat}.reasoning_effort`];
        const value: ExperimentalProviderModelPickerValue = configured ? councilSeatPickerValue(seat)
          : { providerId: fallback?.providerId ?? "", model: fallback?.model ?? "", reasoningLevel: "high" };
        const touch = () => { councilSeatsTouched.current.add(seat); };
        return (
          <div key={seat} className="space-y-1.5" data-testid={`council-seat-${seat}`}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-sm font-medium">{t(`settingCouncilSeat_${seat}` as I18nKey)}</span>
              <span className="text-xs text-muted-foreground">{configured ? t("councilSeatOwnSet") : fallback?.providerId && fallback.model ? t("councilSeatFromStages") : t("councilSeatNoPair")}</span>
              {configured ? <Button type="button" size="sm" variant="ghost" className="h-7 px-2" onClick={() => void resetInherited(keys)}>{t("councilSeatInherit")}</Button> : null}
            </div>
            <div className="max-w-xl" onPointerDownCapture={touch} onKeyDownCapture={touch}>
              {modelPicker(value, (next) => { if (councilSeatsTouched.current.has(seat)) void saveCouncilSeatSelection(seat, next); })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The browser check: which machine runs it, in which folder and with which provider and approval. */
export function BrowserDetail({ page }: { page: LpPage }) {
  const { data, displayedValue, resetInherited, saveKey, writeDraft, advanced, extrasGrouped } = page;
  const options = data?.qaHosts ?? [];
  const current = String(displayedValue(QA_HOST_KEY) ?? "");
  const known = options.some((host) => host.id === current);
  return (
    <div className="space-y-3" data-testid="browser-qa-detail">
      <p className="max-w-xl text-xs text-muted-foreground">{t("browserQaHostHelp")}</p>
      {!options.length ? <p className="text-sm text-muted-foreground">{t("browserQaHostNone")}</p> : (
        <Select value={known ? current : current ? current : "__inherit__"} onValueChange={(next) => { if (next === "__inherit__") void resetInherited([QA_HOST_KEY]); else void saveKey(QA_HOST_KEY, next); }}>
          <SelectTrigger aria-label={t("globalQaHost")} data-testid="browser-qa-host-select" className="min-w-0 max-w-xl">
            <SelectValue placeholder={t("inheritChoice")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__inherit__">{t("inheritChoice")}</SelectItem>
            {options.map((host) => (
              <SelectItem key={host.id} value={host.id}>{host.name} · {host.connected ? t("hostConnected") : t("hostOffline")}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {displayedValue(QA_HOST_KEY) && !options.some((host) => host.id === displayedValue(QA_HOST_KEY)) ? <p className="text-xs text-muted-foreground">{t("hostUnavailable")}</p> : null}
      <AdvancedRows show={advanced}>
        <Label htmlFor="browser-qa-workspace">{t("browserQaWorkspace")}</Label>
        <Input
          id="browser-qa-workspace"
          data-testid="browser-qa-workspace"
          value={String(displayedValue(QA_WORKSPACE_KEY) ?? "")}
          placeholder={data?.workspacePath ?? "/"}
          onChange={(event) => writeDraft(QA_WORKSPACE_KEY, event.target.value)}
          onBlur={(event) => void saveKey(QA_WORKSPACE_KEY, event.target.value)}
        />
        {extrasGrouped.filter((group) => group.section === "browser-qa").flatMap((group) => group.rows.filter((row) => row.storageKey !== "browser_qa.enabled")).map((row) => (
          <CatalogField key={row.storageKey} page={page} keyName={row.storageKey} />
        ))}
      </AdvancedRows>
    </div>
  );
}
