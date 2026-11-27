import { useEffect, useMemo, useState } from "react";
import type { AgentsLoadoutProps } from "../../settings/ui";
import { AccessModeFields, fallbackModelNames, PairPickerCell, PmRow, RoleEnabledSwitch, WriterModelCell, type FallbackCatalog } from "./tab-team";
import { BrowserDetail, WriterDetail } from "./team-details";
import type { LpPage } from "./use-lp-page";

/** Connects `AgentsLoadout` (settings room) with page-level writer/browser/switch/PM helpers without creating a settings -> pages import cycle. */
export function useAgentsLoadoutBridge(
  page: LpPage,
  projectId: string | null,
): Pick<
  AgentsLoadoutProps,
  | "pageData"
  | "stackControls"
  | "wideTable"
  | "overridesProjectCache"
  | "onResetKeys"
  | "renderPmRow"
  | "renderWriterModel"
  | "renderOnboarderModel"
  | "renderExtraPicker"
  | "renderWriterDetail"
  | "renderBrowserDetail"
  | "renderSettingSwitch"
  | "renderModeFields"
> {
  const [catalog, setCatalog] = useState<FallbackCatalog | null>(null);
  useEffect(() => {
    let live = true;
    void page.rpc
      .call("workflow_model_catalog", projectId ? { projectId } : {})
      .then((value) => {
        if (live) setCatalog(value);
      }, () => undefined);
    return () => {
      live = false;
    };
  }, [page.rpc, projectId]);
  const fallbackNames = useMemo(() => fallbackModelNames(catalog), [catalog]);

  return {
    pageData: page.data,
    stackControls: page.stackControls,
    wideTable: page.wideTable,
    overridesProjectCache: page.projectCache.current,
    onResetKeys: (keys) => page.resetInherited(keys),
    renderPmRow: () => (page.isGlobal ? null : <PmRow page={page} />),
    renderWriterModel: (open, onToggle) => (
      <WriterModelCell page={page} open={open} onToggle={onToggle} fallbackNames={fallbackNames} />
    ),
    renderOnboarderModel: () => <PairPickerCell selectionId="onboarding" page={page} />,
    renderExtraPicker: (selectionId) => (
      <PairPickerCell selectionId={selectionId as Parameters<typeof PairPickerCell>[0]["selectionId"]} page={page} />
    ),
    renderWriterDetail: () => <WriterDetail page={page} />,
    renderBrowserDetail: () => <BrowserDetail page={page} />,
    renderSettingSwitch: (spec) => <RoleEnabledSwitch spec={spec} page={page} />,
    renderModeFields: () => <AccessModeFields page={page} />,
  };
}
