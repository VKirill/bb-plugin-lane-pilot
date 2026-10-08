import { useState } from "react";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Icon } from "@lane-pilot/ui-kit";
import { Popover, PopoverContent, PopoverTrigger } from "@lane-pilot/ui-kit";
import { Skeleton } from "@lane-pilot/ui-kit";
import { Pill } from "./pill";
import { DEPTH_TABS } from "./tabs-model";
import type { LpPage } from "./use-lp-page";

/** The title of the page with chips for what matters at a glance: runs in progress, the writer's model, the machine. */
export function ProjectHeader({ page }: { page: LpPage }) {
  const { isGlobal, selectedSectionName, selectedProjectName, selectedSectionId, data, screenLoading, activeRuns, writerChosen, hostLabel, goTo, hideProject, projectId, tab, settingsDepth, setSettingsDepth, stackControls } = page;
  const [menuOpen, setMenuOpen] = useState(false);
  const binding = data?.writerBinding;
  const host = binding?.status === "resolved" ? data?.qaHosts?.find((item) => item.id === binding.hostId) : undefined;
  const depthToggle = DEPTH_TABS.has(tab) ? (
    <div className={stackControls ? "lp-seg flex w-full" : "lp-seg shrink-0"} data-testid="settings-depth" aria-label={t("settingsAdvanced")}>
      {(["basic", "advanced"] as const).map((depth) => (
        <Button key={depth} variant="ghost" className={`lp-seg-item h-[1.875rem] px-3 hover:bg-transparent aria-pressed:bg-[var(--lp-card)] aria-pressed:hover:bg-[var(--lp-card)] ${stackControls ? "min-w-0 flex-1" : ""}`} aria-pressed={settingsDepth === depth} onClick={() => setSettingsDepth(depth)}>{t(depth === "basic" ? "settingsBasic" : "settingsAdvanced")}</Button>
      ))}
    </div>
  ) : null;
  if (isGlobal) {
    return (
      <div className="lp-strip space-y-1" data-testid="project-header">
        <h1 className="break-words text-xl font-medium">{t("navGlobals")}</h1>
        <p className="text-xs text-muted-foreground">{t("globalsHelp")}</p>
        {depthToggle ? <div className="pt-2">{depthToggle}</div> : null}
      </div>
    );
  }
  return (
    <div className="lp-strip space-y-2" data-testid="project-header">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="break-words text-xl font-medium">{selectedSectionName ?? selectedProjectName}</h1>
          <p className="break-words text-xs text-muted-foreground" data-testid="project-subline">
            {selectedSectionName ? `${t("selectedSection")} · ${selectedProjectName}` : t("scopeWholeProject")}
            {binding?.status === "resolved" && binding.path ? ` · ${binding.path}` : ""}
          </p>
          {selectedSectionName ? <p className="text-xs text-muted-foreground">{t("sectionInheritsHint")}</p> : null}
        </div>
        <Popover open={menuOpen} onOpenChange={setMenuOpen}>
          <PopoverTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="size-8 shrink-0 p-0" aria-label={t("projectMenu")} data-testid="project-menu"><Icon name="MoreHorizontal" className="size-4" /></Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 space-y-1 p-1">
            <Button type="button" variant="ghost" size="sm" className="w-full justify-start" data-testid="project-menu-service" onClick={() => { setMenuOpen(false); goTo("runs", "service"); }}>{t("projectMenuService")}</Button>
            {selectedSectionId || !projectId ? null : (
              <Button type="button" variant="ghost" size="sm" className="w-full justify-start" data-testid="project-hide" onClick={() => { setMenuOpen(false); hideProject(projectId); }}>{t("projectHide")}</Button>
            )}
          </PopoverContent>
        </Popover>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid="project-chips" aria-busy={screenLoading}>
        {screenLoading ? <>
          <Skeleton className="h-5 w-20 rounded-full" /><Skeleton className="h-5 w-36 rounded-full" /><Skeleton className="h-5 w-28 rounded-full" />
        </> : data ? <>
          {activeRuns > 0 ? <Pill tone="info" testId="chip-runs">{t("chipRunning").replace("{n}", String(activeRuns))}</Pill> : null}
          {writerChosen
            ? <Pill tone="neutral" testId="chip-model">{`${String(data.values["writer.provider"])} · ${String(data.values["writer.model"])}`}</Pill>
            : <Pill tone="warning" testId="chip-model">{t("chipNoModel")}</Pill>}
          {binding?.status === "resolved"
            ? <Pill tone={host?.connected === false ? "danger" : "success"} testId="chip-machine">{`${hostLabel(binding.hostId)} · ${host?.connected === false ? t("hostOffline") : t("hostConnected")}`}</Pill>
            : binding ? <Pill tone="warning" testId="chip-machine">{t("chipNoMachine")}</Pill> : null}
        </> : null}
      </div>
      {depthToggle ? <div className="pt-1">{depthToggle}</div> : null}
    </div>
  );
}
