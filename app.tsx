import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { detectLocale, t } from "@lane-pilot/i18n";
import type { ComponentType } from "react";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import { LanePilotPage } from "./src/rooms/ui-shell/ui/page";
import { useCockpitPageTitle, useOwnerWaitingBadge } from "./src/rooms/ui-shell/ui";
import { CouncilPage } from "./src/rooms/council/ui";
import { CockpitPage } from "./src/rooms/cockpit/ui";
import { ComposerAgentBadge } from "./src/rooms/native-agent/ui";
import { EnableLanePilotAction } from "./src/rooms/native-agent/ui";
import { HELPER_PANEL_ACTION, HelperThreadPanel, useHelperThreadIndex } from "./src/rooms/native-agent/ui";
import { RUN_CARD_DIRECTIVE, RunCardDirective, ThreadLive, LaneContextDetails, LaneContextSummary, useLaneContextVisible } from "./src/rooms/runs/ui";
import { bindThreadRowStatus } from "./src/rooms/runs/ui/thread-row-status";

/** VK core 0.46.1-vk.5: a section of the thread's info panel (feature-tested; older cores get a panel tab instead). */
type VkThreadInfoSection = (registration: { id: string; title: string; component: ComponentType<{ threadId: string; projectId: string }> }) => void;
/** The thread action tab that replaces `threadPanelAction` (feature-tested; an older BB gets the retired slot instead). */
type ExperimentalTabSlot = (registration: {
  id: string; title: string; icon: string; layout?: "padded" | "flush";
  context: { kind: "thread" }; availability: "action";
  component: ComponentType<{ threadId: string; params?: JsonValue }>;
}) => void;
import { OWNER_ASK_RENDERER_ID } from "./src/rooms/relay";
import { OwnerAsk } from "./src/rooms/relay/ui";

export default definePluginApp((app) => {
  // Live work icon on the sidebar thread row (vk core's experimental_setThreadRowStatus; stock BB keeps its own row look).
  app.contentScripts.register({
    id: "lane-pilot-row-status",
    mount: (context) => {
      bindThreadRowStatus(context.experimental_setThreadRowStatus ?? null);
      return () => bindThreadRowStatus(null);
    },
  });
  app.slots.navPanel({
    id: "lane-pilot",
    title: t("panelTitle"),
    icon: "Workflow",
    path: "lane-pilot",
    component: ({ subPath }) => <LanePilotPage subPath={subPath} />,
    // The owner-waiting count on the nav entry (SDK 0.6.53+); older BB simply draws no badge.
    experimental_useBadge: useOwnerWaitingBadge,
  });
  app.slots.navPanel({
    id: "lane-pilot-council",
    title: t("councilPageTitle"),
    icon: "Workflow",
    path: "lane-pilot-council",
    component: () => <CouncilPage />,
  });
  // The cockpit: the window's screens of the SMA map (phases, today, tasks, money, workers, forge, memory, first run, coordination, ship, system).
  app.slots.navPanel({
    id: "lane-pilot-cockpit",
    title: t("ckTitle"),
    icon: "Workflow",
    path: "lane-pilot-cockpit",
    component: ({ subPath }) => <CockpitPage subPath={subPath} />,
    // The waiting count in the window title (SDK 0.6.x); older BB keeps the plain title.
    experimental_usePageTitle: useCockpitPageTitle,
  });
  // A working helper (writer, specialist, browser check…) opens in the thread's side panel from its square.
  const threadTab = (app.slots as unknown as { experimental_tab?: ExperimentalTabSlot }).experimental_tab;
  const threadActionTab = (registration: { id: string; title: string; layout?: "padded" | "flush"; component: ComponentType<{ threadId: string; params?: JsonValue }> }) => {
    if (typeof threadTab === "function") {
      threadTab.call(app.slots, { ...registration, icon: "Workflow", context: { kind: "thread" }, availability: "action" });
    } else {
      // The retired slot: absent from new SDK types but still served on an older BB.
      const legacy = (app.slots as unknown as { threadPanelAction?: (r: { id: string; title: string; icon: string; layout?: "padded" | "flush"; component: ComponentType<{ threadId: string; params?: JsonValue }> }) => void }).threadPanelAction;
      legacy?.call(app.slots, { ...registration, icon: "Workflow" });
    }
  };
  threadActionTab({
    id: HELPER_PANEL_ACTION,
    title: t("helperPanelTitle"),
    layout: "flush",
    component: ({ threadId, params }) => <HelperThreadPanel threadId={threadId} params={params} />,
  });
  // What Lane Pilot does for this chat (tasks now, step by step), in the thread's info panel below the uncommitted files.
  const infoSection = (app.slots as unknown as { experimental_vkThreadInfoSection?: VkThreadInfoSection }).experimental_vkThreadInfoSection;
  if (typeof infoSection === "function") {
    infoSection.call(app.slots, { id: "lane-pilot-live", title: t("liveTitle"), component: ({ threadId }) => <ThreadLive threadId={threadId} locale={detectLocale()} /> });
  } else {
    threadActionTab({ id: "lane-pilot-live", title: t("liveTitle"), component: ({ threadId }) => <ThreadLive threadId={threadId} locale={detectLocale()} /> });
  }
  // A short role mark on the sidebar rows of helper threads (newer BB only; the slot is feature-tested).
  const rowMetadata = (app.slots as unknown as { experimental_threadRowMetadata?: (registration: {
    id: string;
    useData: (input: { threadIds: readonly string[] }) => Map<string, string>;
    component: ComponentType<{ thread: { id: string }; data: Map<string, string> | undefined }>;
  }) => void }).experimental_threadRowMetadata;
  if (typeof rowMetadata === "function") {
    rowMetadata.call(app.slots, {
      id: "lane-pilot-helper-role",
      useData: ({ threadIds }) => useHelperThreadIndex(threadIds),
      component: ({ thread, data }) => {
        const role = data?.get(thread.id);
        return role ? <span className="rounded bg-muted px-1 text-[10px] leading-4 text-muted-foreground" title={t("helperPanelTitle")}>{role}</span> : null;
      },
    });
  }
  // «Lane Pilot helpers» in every thread's actions menu, opening this chat's helper tab (newer BB only; the slot is feature-tested).
  const threadAction = (app.slots as unknown as { experimental_threadAction?: (registration: {
    id: string; title: string; icon: string; group: string;
    item: (input: { experimental_panel?: { openTab?: (options: { tab: { id: string; context: { kind: "thread" }; availability: "action" }; params?: JsonValue; title?: string }) => boolean } }) => { label: string; icon: string; run: () => void } | null;
  }) => void }).experimental_threadAction;
  if (typeof threadAction === "function") {
    threadAction.call(app.slots, {
      id: "lane-pilot-helpers",
      title: t("helperPanelTitle"),
      icon: "Workflow",
      group: "lane-pilot",
      item: (input) => ({
        label: t("helperPanelTitle"),
        icon: "Workflow",
        run: () => { input.experimental_panel?.openTab?.({ tab: { id: HELPER_PANEL_ACTION, context: { kind: "thread" }, availability: "action" }, params: {} }); },
      }),
    });
  }
  // The same helpers tab from the command palette (B-x3): the context only opens panel tabs, so there is nothing for a Cockpit jump to call.
  app.commands.register({
    id: "lane-pilot-helpers",
    title: t("helperPanelTitle"),
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ experimental_panel }) => { experimental_panel?.openTab?.({ tab: { id: HELPER_PANEL_ACTION, context: { kind: "thread" }, availability: "action" }, params: {} }); },
  });
  // The same live work as a context segment over the composer (A-u3; newer BB only — the slot is feature-tested).
  const contextSegment = (app.slots as unknown as { experimental_threadContextSegment?: (registration: {
    id: string; title: string; group: string; order?: number;
    summary: ComponentType<{ threadId: string }>;
    details?: ComponentType<{ threadId: string; isExpanded: boolean }>;
    useVisible?: (input: { threadId: string }) => boolean;
  }) => void }).experimental_threadContextSegment;
  if (typeof contextSegment === "function") {
    contextSegment.call(app.slots, { id: "lane-pilot-live-segment", title: t("liveTitle"), group: "lane-pilot", summary: LaneContextSummary, details: LaneContextDetails, useVisible: useLaneContextVisible });
  }
  // The PM's `::lane-run{id="…"}` line becomes a live card of the run's tasks.
  app.slots.messageDirective({ id: RUN_CARD_DIRECTIVE, component: RunCardDirective });
  // A question to the owner (PM, integration gate, repair thread, council) as BB's pending interaction; BB's
  // notification plugin sends the same interaction to the phone.
  app.slots.pendingInteraction({ id: OWNER_ASK_RENDERER_ID, component: OwnerAsk });
  app.composer.customize({
    id: "lane-pilot-activation",
    scopes: ["new-thread", "thread"],
    actions: [{ id: "enable-lane-pilot", component: EnableLanePilotAction }],
  });
  app.composer.customize({
    id: "lane-pilot-agent-badge",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "native-agent", chrome: "bare", component: ComposerAgentBadge }],
  });
});
