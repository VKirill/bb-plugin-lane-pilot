import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { detectLocale, t } from "@lane-pilot/i18n";
import type { ComponentType } from "react";
import type { JsonValue } from "@get-bb/plugin-sdk/app";
import { LanePilotPage } from "./src/rooms/pages";
import { useOwnerWaitingBadge } from "./src/rooms/ui-shell/ui";
import { ComposerAgentBadge, ComposerBoundary } from "./src/rooms/native-agent/ui";
import { EnableLanePilotAction } from "./src/rooms/native-agent/ui";
import { HelperThreadPanel, HelperThreadsList, useHelperThreadIndex } from "./src/rooms/native-agent/ui";
import { HELPER_PANEL_ACTION } from "./src/rooms/contracts/agent-picker";
import { LANE_DRAFT_DIRECTIVE, LaneDraftCardDirective, RUN_CARD_DIRECTIVE, RunCardDirective, THREAD_LIVE_TAB_ID, ThreadLive, ThreadLivePanel } from "./src/rooms/runs/ui";
import { bindThreadRowStatus } from "./src/rooms/runs/ui";

/** VK core 0.46.1-vk.5: a section of the thread's info panel (feature-tested; older cores get a panel tab instead). */
type VkThreadInfoSection = (registration: { id: string; title: string; component: ComponentType<{ threadId: string; projectId: string }> }) => void;
/** Stock `experimental_threadInfoSection`: the host draws section chrome; the component keeps its own visible title. */
type StockThreadInfoSection = (registration: {
  id: string; group: string; order?: number;
  component: ComponentType<{ threadId: string; projectId: string; environment: unknown }>;
}) => void;
/** The thread tab slot (`action` for ad-hoc helper tabs, `fixed` for the persistent right-hand Lane Pilot panel). */
type ExperimentalTabSlot = (registration: {
  id: string; title: string; icon: string; layout?: "padded" | "flush";
  context: { kind: "thread" }; availability: "action" | "fixed";
  component: ComponentType<{ threadId: string; params?: JsonValue; environment?: { id?: string | null } | null }>;
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
  if (typeof threadTab === "function") {
    threadTab.call(app.slots, {
      id: THREAD_LIVE_TAB_ID,
      title: t("liveTitle"),
      icon: "Workflow",
      layout: "flush",
      context: { kind: "thread" },
      availability: "fixed",
      component: ({ threadId }) => <ThreadLivePanel threadId={threadId} locale={detectLocale()} HelpersList={HelperThreadsList} />,
    });
  }
  // What Lane Pilot does for this chat (tasks now, step by step), in the thread's info panel below the uncommitted files.
  const slots = app.slots as unknown as {
    experimental_threadInfoSection?: StockThreadInfoSection;
    experimental_vkThreadInfoSection?: VkThreadInfoSection;
    experimental_THREAD_INFO_SECTION_GROUPS?: { related: string };
  };
  const liveComponent = ({ threadId }: { threadId: string }) => <ThreadLive threadId={threadId} locale={detectLocale()} />;
  if (typeof slots.experimental_threadInfoSection === "function") {
    slots.experimental_threadInfoSection.call(app.slots, {
      id: "lane-pilot-live",
      group: slots.experimental_THREAD_INFO_SECTION_GROUPS?.related ?? "1_related",
      component: liveComponent,
    });
  } else {
    const infoSection = slots.experimental_vkThreadInfoSection;
    if (typeof infoSection === "function") {
      infoSection.call(app.slots, { id: "lane-pilot-live", title: t("liveTitle"), component: liveComponent });
    } else {
      threadActionTab({ id: "lane-pilot-live", title: t("liveTitle"), component: liveComponent });
    }
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
  // Dedicated header icon («Compass») opening the right-hand Lane Pilot project & session panel, plus «Lane Pilot helpers» in the menu.
  const threadAction = (app.slots as unknown as { experimental_threadAction?: (registration: {
    id: string; title: string; icon: string; group: string; placement?: "header" | "menu";
    item: (input: { experimental_panel?: { openTab?: (options: { tab: { id: string; context: { kind: "thread" }; availability: "action" | "fixed" }; params?: JsonValue; title?: string }) => boolean } }) => { label: string; icon: string; detail?: string; run: () => void } | null;
  }) => void }).experimental_threadAction;
  if (typeof threadAction === "function") {
    if (typeof threadTab === "function") {
      threadAction.call(app.slots, {
        id: "open-thread-live",
        title: t("liveTitle"),
        icon: "Workflow",
        group: "0_pilot",
        placement: "header",
        item: (input) => ({
          label: t("liveTitle"),
          icon: "Workflow",
          run: () => { input.experimental_panel?.openTab?.({ tab: { id: THREAD_LIVE_TAB_ID, context: { kind: "thread" }, availability: "fixed" } }); },
        }),
      });
    }
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
  // Command palette shortcuts for both the thread panel and the helpers tab.
  if (typeof threadTab === "function") {
    app.commands.register({
      id: "lane-pilot-live",
      title: t("liveTitle"),
      isAvailable: ({ threadId }) => threadId !== null,
      run: ({ experimental_panel }) => { experimental_panel?.openTab?.({ tab: { id: THREAD_LIVE_TAB_ID, context: { kind: "thread" }, availability: "fixed" } }); },
    });
  }
  app.commands.register({
    id: "lane-pilot-helpers",
    title: t("helperPanelTitle"),
    isAvailable: ({ threadId }) => threadId !== null,
    run: ({ experimental_panel }) => { experimental_panel?.openTab?.({ tab: { id: HELPER_PANEL_ACTION, context: { kind: "thread" }, availability: "action" }, params: {} }); },
  });
  // The PM's `::lane-run{id="…"}` line becomes a live card of the run's tasks.
  app.slots.messageDirective({ id: RUN_CARD_DIRECTIVE, component: RunCardDirective });
  // The PM's `::lane-draft{id="…"}` line becomes a proposal card with a «Создать» button (SMA m_sw_chat_draft).
  app.slots.messageDirective({ id: LANE_DRAFT_DIRECTIVE, component: LaneDraftCardDirective });
  // A question to the owner (PM, integration gate, repair thread) as BB's pending interaction; BB's
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
  // The boundary line under a PM chat's input (SMA m_ce_boundary): only there.
  app.composer.customize({
    id: "lane-pilot-boundary",
    scopes: ["thread"],
    banners: [{ id: "pm-boundary", chrome: "bare", component: ComposerBoundary }],
  });
});
