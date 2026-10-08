import { definePluginApp } from "@get-bb/plugin-sdk/app";
import "./app.css";
import { t } from "./i18n";
import { LanePilotPage } from "./src/ui/page";
import { CouncilPage } from "./src/ui/council-page";
import { ComposerAgentBadge } from "./src/ui/composer-agent-badge";
import { EnableLanePilotAction } from "./src/ui/composer-enable";
import { HELPER_PANEL_ACTION, HelperThreadPanel } from "./src/ui/helper-threads";
import { RUN_CARD_DIRECTIVE, RunCardDirective } from "./src/ui/run-card";
import { OWNER_ASK_RENDERER_ID } from "./src/owner-ask-shared";
import { OwnerAsk } from "./src/ui/owner-ask";

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
