import { experimental_useAppPanel, useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { JsonValue } from "@get-bb/plugin-sdk/app";

type ActionTabOptions = { tab: { id: string; context: { kind: "thread" }; availability: "action" }; params?: JsonValue; title?: string };
type PanelController = { openTab?: (options: ActionTabOptions) => boolean };
type LegacyNavigate = { openThreadPanel?: (options: { actionId: string; title: string; params?: JsonValue }) => boolean };

export type OpenThreadPanelOptions = { actionId: string; title: string; params?: JsonValue };

/**
 * Opens one of this plugin's thread action tabs in the side panel: `experimental_useAppPanel().openTab` where BB has it,
 * the retired `navigate.openThreadPanel` where it does not. False when the surface has no side panel.
 */
export function openThreadPanelTab(panel: PanelController | null | undefined, navigate: LegacyNavigate, options: OpenThreadPanelOptions): boolean {
  const opened = panel?.openTab?.({ tab: { id: options.actionId, context: { kind: "thread" }, availability: "action" }, params: options.params, title: options.title });
  return opened ?? navigate.openThreadPanel?.(options) ?? false;
}

export function useOpenThreadPanel(): (options: OpenThreadPanelOptions) => boolean {
  const navigate = useBbNavigate();
  const panel = experimental_useAppPanel() as PanelController;
  return (options) => openThreadPanelTab(panel, navigate as unknown as LegacyNavigate, options);
}
