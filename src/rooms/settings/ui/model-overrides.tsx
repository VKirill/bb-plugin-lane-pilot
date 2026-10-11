import { useEffect, useState } from "react";
import { toast } from "sonner";
import { t } from "@lane-pilot/i18n";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  Button, Surface, SurfaceBody, SurfaceHeader,
} from "@lane-pilot/ui-kit";
import type { LpPage } from "../../ui-shell/ui";

type Level = { projectId: string; projectName: string | null; sectionId: string | null; sectionName: string | null; keys: string[] };

const fill = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text);
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/**
 * The global Team tab: the projects and sections that keep their own role models over the global ones, and one action that gives
 * them all the global models back. The list is what the reset applies to; only model, provider, effort and fallback rows go.
 */
export function ModelOverridesPanel({ page }: { page: LpPage }) {
  const { rpc, projectCache } = page;
  const [levels, setLevels] = useState<Level[] | null>(null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = () => rpc.call("list_model_overrides", {}).then((next) => { setLevels(next.levels); setError(""); }, (cause) => { setLevels([]); setError(fill(t("modelOverridesLoadFailed"), { error: message(cause) })); });
  useEffect(() => { void load(); }, [rpc]);

  const reset = async () => {
    if (!levels) return;
    setBusy(true);
    try {
      const done = await rpc.call("reset_model_overrides", { levels: levels.map(({ projectId, sectionId }) => ({ projectId, sectionId })) });
      // Screens read before the reset still show the old models.
      projectCache.current.clear();
      toast.success(<span data-bb-ru-skip>{fill(t("modelOverridesDone"), { places: done.levels })}</span>);
      await load();
    } catch (cause) { setError(fill(t("modelOverridesFailed"), { error: message(cause) })); }
    finally { setBusy(false); setConfirming(false); }
  };

  const list = levels?.length ? (
    <ul className="max-h-64 min-w-0 space-y-1 overflow-y-auto text-sm" data-testid="model-overrides-list">
      {levels.map((level) => (
        <li key={`${level.projectId}/${level.sectionId ?? ""}`} className="flex min-w-0 items-baseline justify-between gap-2" data-testid="model-overrides-level">
          <span className="min-w-0 break-words">
            {level.projectName ?? level.projectId}{" · "}{level.sectionId ? level.sectionName ?? level.sectionId : t("modelOverridesWholeProject")}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">{fill(t("modelOverridesSettings"), { n: level.keys.length })}</span>
        </li>
      ))}
    </ul>
  ) : null;

  return (
    <Surface testId="model-overrides">
      <SurfaceHeader><h2 className="text-sm font-medium">{t("modelOverridesTitle")}</h2></SurfaceHeader>
      <SurfaceBody>
        <p className="max-w-2xl text-xs text-muted-foreground">{t("modelOverridesHelp")}</p>
        {error ? <p role="alert" className="break-words text-xs text-destructive" data-testid="model-overrides-error">{error}</p> : null}
        {levels === null ? <p className="text-sm text-muted-foreground">{t("modelOverridesLoading")}</p>
          : list ? (
            <>
              <p className="text-sm font-medium" data-testid="model-overrides-count">{fill(t("modelOverridesCount"), { places: levels.length })}</p>
              {list}
              <Button type="button" variant="outline" size="sm" disabled={busy} data-testid="model-overrides-reset" onClick={() => setConfirming(true)}>{t("modelOverridesReset")}</Button>
            </>
          ) : <p className="text-sm text-muted-foreground" data-testid="model-overrides-none">{t("modelOverridesNone")}</p>}
      </SurfaceBody>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent data-testid="model-overrides-dialog" className="max-h-[min(80vh,100dvh)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-wrap break-words">{t("modelOverridesConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription className="text-left text-wrap break-words">{t("modelOverridesConfirmBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          {list}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("confirmCancel")}</AlertDialogCancel>
            <AlertDialogAction data-testid="model-overrides-confirm" disabled={busy} onClick={(event) => { event.preventDefault(); void reset(); }}>{t("modelOverridesConfirm")}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Surface>
  );
}
