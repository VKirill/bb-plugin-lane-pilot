import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { t } from "@lane-pilot/i18n";
import { LanePilotPage } from "./src/rooms/ui-shell/ui/page";
import { CouncilPage } from "./src/rooms/council/ui";
import { ComposerAgentBadge } from "./src/rooms/native-agent/ui";
import { EnableLanePilotAction } from "./src/rooms/native-agent/ui";
import { HELPER_PANEL_ACTION, HelperThreadPanel } from "./src/rooms/native-agent/ui";
import { RUN_CARD_DIRECTIVE, RunCardDirective } from "./src/rooms/runs/ui";
import { OWNER_ASK_RENDERER_ID } from "./src/rooms/relay";
import { OwnerAsk } from "./src/rooms/relay/ui";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "lane-pilot",
    title: t("panelTitle"),
    icon: "Workflow",
    path: "lane-pilot",
    component: ({ subPath }) => <LanePilotPage subPath={subPath} />,
  });
  app.slots.navPanel({
    id: "lane-pilot-council",
    title: t("councilPageTitle"),
    icon: "Workflow",
    path: "lane-pilot-council",
    component: () => <CouncilPage />,
  });
  // A working helper (writer, specialist, browser check…) opens in the thread's side panel from its square.
  app.slots.threadPanelAction({
    id: HELPER_PANEL_ACTION,
    title: t("helperPanelTitle"),
    icon: "Workflow",
    layout: "flush",
    component: ({ threadId, params }) => <HelperThreadPanel threadId={threadId} params={params} />,
  });
  // The PM's `::lane-run{id="…"}` line becomes a live card of the run's tasks.
  app.slots.messageDirective({ id: RUN_CARD_DIRECTIVE, component: RunCardDirective });
  // A question to the owner (PM, integration gate, repair thread, council) as BB's pending interaction; BB's
  // notification plugin sends the same interaction to the phone.
  app.slots.pendingInteraction({ id: OWNER_ASK_RENDERER_ID, component: OwnerAsk });
  app.composer.customize({
    id: "lane-pilot-activation",
    scopes: ["new-thread"],
    actions: [{ id: "enable-lane-pilot", component: EnableLanePilotAction }],
  });
  app.composer.customize({
    id: "lane-pilot-agent-badge",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "native-agent", chrome: "bare", component: ComposerAgentBadge }],
  });
});
