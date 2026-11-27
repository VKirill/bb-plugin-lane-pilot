import { useMemo } from "react";
import { useBbContext } from "@get-bb/plugin-sdk/app";
import { BrakeButton } from "../../owner-waiting/ui";
import { InheritanceContext } from "../../ui-shell/ui";
import { LEGACY_SCOPES, parseConsoleRoute, type ConsoleRoute } from "../models/nav-model";
import { ConsoleRoutes } from "./console-routes";
import { ConsoleShell } from "./console-shell";
import { useConsoleRoute } from "./use-console-route";
import { useLanePilotPage } from "./use-lp-page";

export type LanePilotScope =
  | "projects"
  | "globals"
  | "agents"
  | "tokens"
  | "workflows"
  | "schedule"
  | "tasks"
  | "waiting"
  | "errands";

/** Root Lane Pilot console panel. Preserves `subPath` and legacy `scope` callers. */
export function LanePilotPage({
  subPath = "",
  scope = "projects",
}: {
  subPath?: string;
  scope?: LanePilotScope;
}) {
  const { projectId: contextProjectId } = useBbContext();
  const initialRoute = useMemo<ConsoleRoute>(() => {
    const base =
      scope && scope !== "projects" && LEGACY_SCOPES[scope]
        ? LEGACY_SCOPES[scope]!
        : parseConsoleRoute(subPath);
    return base.projectId ? base : contextProjectId ? { ...base, projectId: contextProjectId } : base;
  }, [scope, subPath, contextProjectId]);

  const { route, go } = useConsoleRoute(subPath, initialRoute);
  const page = useLanePilotPage({ subPath, scope, consoleRoute: route, onNavigate: go });
  const projectId = route.projectId ?? null;
  const sectionId = route.sectionId ?? null;

  return (
    <InheritanceContext.Provider
      value={{
        locale: page.locale,
        data: page.data,
        reset: (keys) => void page.resetInherited(keys),
      }}
    >
      <ConsoleShell route={route} go={go} headerExtras={<BrakeButton />}>
        <ConsoleRoutes
          route={route}
          go={go}
          projectId={projectId}
          sectionId={sectionId}
          locale={page.locale}
          page={page}
        />
      </ConsoleShell>
    </InheritanceContext.Provider>
  );
}
