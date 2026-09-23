import { useState } from "react";
import {
  definePluginApp,
  useBbContext,
  useBbNavigate,
  useRpc,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./src/contracts";
import { t } from "./i18n";
import { LanePilotPage } from "./src/ui/page";
import type { PluginThreadHeaderActionProps } from "@get-bb/plugin-sdk/app";

function OpenLanePilotSettings({ projectId }: PluginThreadHeaderActionProps) {
  const navigate = useBbNavigate();
  return <button type="button" onClick={() => navigate.toPluginPanel("lane-pilot", { subPath: projectId })}
    title={t("openSettings")} aria-label={t("openSettings")}
    className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-xs text-foreground hover:bg-accent">{t("openSettings")}</button>;
}

function EnableLanePilotAction() {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId, threadId } = useBbContext();
  const navigate = useBbNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activate = async () => {
    if (!projectId || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await rpc.call("activate_pm", {
        projectId,
        sourceThreadId: threadId ?? null,
      });
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  return (
    <button
      type="button"
      onClick={activate}
      disabled={!projectId || pending}
      aria-label={pending ? t("enabling") : t("enable")}
      title={error ?? t("enable")}
      className="inline-flex h-7 items-center rounded-md border border-border bg-background px-2 text-xs font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      {pending ? t("enabling") : error ? t("failed") : t("enable")}
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "lane-pilot",
    title: t("panelTitle"),
    icon: "Workflow",
    path: "lane-pilot",
    component: ({ subPath }) => <LanePilotPage subPath={subPath} />,
  });
  app.slots.experimental_threadHeaderAction({ id: "lane-pilot-settings", title: t("panelTitle"), component: OpenLanePilotSettings });
  app.composer.customize({
    id: "lane-pilot-activation",
    scopes: ["thread", "new-thread"],
    actions: [{ id: "enable-lane-pilot", component: EnableLanePilotAction }],
  });
});
