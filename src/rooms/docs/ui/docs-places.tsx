import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../../contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Badge } from "@lane-pilot/ui-kit";
import { Button } from "@lane-pilot/ui-kit";
import { Disclosure } from "@lane-pilot/ui-kit";

type Place = {
  hostId: string; path: string; name: string; scopes: string[]; mode: "auto" | "on" | "off";
  verdict: { need: boolean; reason: string; confidence: number | null; at: number;
    facts: { codeFiles: number; contentFiles: number; commits30d: number; manifests: string[]; docsPages: number } } | null;
  cadence: "nightly" | "weekly" | "paused"; lastReadAt: number | null;
};

const REASON = (reason: string) => `docsReason_${reason}` as I18nKey;
const CADENCE = (cadence: Place["cadence"]) => `docsCadence_${cadence}` as I18nKey;

/** Each folder of the project on each machine: whether it keeps docs, why, how often, and when tasks last read them. */
export function DocsPlaces({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (recheck = false) => {
    setBusy(true);
    try { setPlaces((await rpc.call("docs_overview", { projectId, ...(recheck ? { recheck: true } : {}) }) as { places: Place[] }).places); }
    catch { setPlaces([]); }
    finally { setBusy(false); }
  }, [projectId, rpc]);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="max-w-xl space-y-2" data-testid="docs-places">
      <p className="text-xs text-muted-foreground">{t("docsAutoHelp")}</p>
      <Disclosure compact summary={`${t("docsPlaces")} (${places?.length ?? "…"})`}>
        <div className="space-y-2 pt-1">
          {(places ?? []).map((place) => (
            <div key={`${place.hostId}:${place.path}`} className="space-y-0.5 text-xs" data-testid={`docs-place-${place.name}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{place.name}</span>
                <Badge variant={place.mode === "off" || (place.mode === "auto" && place.verdict && !place.verdict.need) ? "outline" : "secondary"}>
                  {place.mode === "on" ? t("docsModeOn") : place.mode === "off" ? t("docsModeOff") : place.verdict?.need ? t("docsNeeded") : t("docsNotNeeded")}
                </Badge>
                <span className="text-muted-foreground">{place.hostId}</span>
              </div>
              <div className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>{place.path}</div>
              {place.mode === "auto" && place.verdict ? <div className="text-muted-foreground">
                {t(REASON(place.verdict.reason))} · code {place.verdict.facts.codeFiles}, content {place.verdict.facts.contentFiles}, commits/30d {place.verdict.facts.commits30d}
                {place.verdict.need ? ` · ${t(CADENCE(place.cadence))}` : ""}
              </div> : null}
              {place.verdict?.need || place.mode === "on" ? <div className="text-muted-foreground">
                {place.lastReadAt ? `${t("docsLastRead")}: ${new Date(place.lastReadAt).toLocaleDateString()}` : t("docsNeverRead")}
              </div> : null}
            </div>
          ))}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(true)}>{t("docsRecheck")}</Button>
        </div>
      </Disclosure>
    </div>
  );
}
