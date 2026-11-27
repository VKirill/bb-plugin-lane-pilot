import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import {
  CONSOLE_SECTIONS,
  buildConsolePath,
  parseConsoleRoute,
  resolveLegacyRoute,
  type ConsoleRoute,
} from "../models/nav-model";

function detectLegacyFallback(subPath: string): ConsoleRoute | null {
  const parts = subPath.trim().replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if ((CONSOLE_SECTIONS as readonly string[]).includes(parts[0]!)) return null;
  return resolveLegacyRoute(subPath);
}

/**
 * Console route state synchronized with BB panel `subPath` navigation.
 * Falls back to local state with a one-time warning if the host SDK lacks `subPath` support.
 */
export function useConsoleRoute(
  subPath: string,
  initialOverride?: ConsoleRoute,
): { route: ConsoleRoute; go: (next: ConsoleRoute) => void } {
  const navigate = useBbNavigate();
  const [route, setRoute] = useState<ConsoleRoute>(() => initialOverride ?? parseConsoleRoute(subPath));
  const lastSubPath = useRef(subPath);
  const loggedLegacy = useRef(false);
  const warnedSync = useRef(false);

  useEffect(() => {
    if (loggedLegacy.current) return;
    const legacy = detectLegacyFallback(subPath);
    if (legacy) {
      loggedLegacy.current = true;
      console.info("[lane-pilot:console] legacy route", {
        from: subPath,
        to: buildConsolePath(legacy),
      });
    }
  }, [subPath]);

  useEffect(() => {
    if (lastSubPath.current === subPath) return;
    lastSubPath.current = subPath;
    const parsed = parseConsoleRoute(subPath);
    setRoute((current) => ({
      ...parsed,
      projectId: parsed.projectId ?? current.projectId,
      sectionId:
        parsed.projectId && parsed.projectId !== current.projectId
          ? parsed.sectionId
          : (parsed.sectionId ?? current.sectionId),
    }));
  }, [subPath]);

  const go = useCallback(
    (next: ConsoleRoute) => {
      setRoute(next);
      const nextSubPath = buildConsolePath(next);
      const panelNav = navigate?.toPluginPanel;
      if (typeof panelNav !== "function") {
        if (!warnedSync.current) {
          warnedSync.current = true;
          console.warn("[lane-pilot:console] route sync unavailable", "toPluginPanel is unavailable");
        }
        return;
      }
      try {
        panelNav.call(navigate, "lane-pilot", { subPath: nextSubPath });
      } catch (error) {
        if (!warnedSync.current) {
          warnedSync.current = true;
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[lane-pilot:console] route sync unavailable", message);
        }
      }
    },
    [navigate],
  );

  return { route, go };
}
