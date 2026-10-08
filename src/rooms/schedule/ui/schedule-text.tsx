import { useEffect, useState } from "react";
import { ThreadChat, useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";

/**
 * «Create by text»: the owner says what to schedule in the project manager's own chat, which already has the `lane_pilot_schedule`
 * tool; the new card shows up on the board by the `schedule` signal. With the manager's chat open it is shown right here; without one,
 * a new chat opens with the start of the sentence in its composer.
 */
export function ScheduleTextCreate({ projectId, projects, onClose }: { projectId: string | null; projects: ReadonlyArray<{ id: string; name: string }>; onClose: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [project, setProject] = useState(projectId ?? projects[0]?.id ?? "");
  const [pmThread, setPmThread] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (!project) { setPmThread(null); return; }
    let live = true;
    setPmThread(undefined);
    void rpc.call("activation_context", { projectId: project, threadId: null })
      .then((result) => { if (live) setPmThread(result.liveRun?.threadId ?? null); })
      .catch(() => { if (live) setPmThread(null); });
    return () => { live = false; };
  }, [project, rpc]);

  return (
    <Surface testId="schedule-text">
      <SurfaceHeader className="justify-between">
        <h2 className="text-sm font-medium">{t("schTextTitle")}</h2>
        <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-xs" data-testid="sch-text-close" onClick={onClose}>{t("schTextClose")}</Button>
      </SurfaceHeader>
      <SurfaceBody>
        <p className="text-xs text-muted-foreground">{t("schTextHint")}</p>
        <p className="text-xs text-muted-foreground">{t("schTextExamples")}</p>
        {!projectId && projects.length ? (
          <div className="max-w-xs space-y-1">
            <label className="block text-xs font-medium" htmlFor="sch-text-project">{t("schTextProject")}</label>
            <Select value={project} onValueChange={setProject}>
              <SelectTrigger id="sch-text-project" className="h-8 w-full text-sm" data-testid="sch-text-project"><SelectValue /></SelectTrigger>
              <SelectContent>{projects.map((item) => <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ) : null}
        {pmThread ? (
          <div className="space-y-2">
            <div className="lp-card flex h-[24rem] min-h-[18rem] flex-col overflow-hidden" data-testid="sch-text-chat"><div className="min-h-0 flex-1"><ThreadChat threadId={pmThread} variant="compact" /></div></div>
            <Button type="button" size="sm" variant="outline" className="h-8 px-3 text-sm" data-testid="sch-text-open-thread" onClick={() => navigate.toThread(pmThread)}>{t("schTextOpenThread")}</Button>
          </div>
        ) : pmThread === null ? (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground" data-testid="sch-text-nochat">{t("schTextNoChat")}</p>
            <Button type="button" size="sm" className="lp-accent h-8 px-3 text-sm" data-testid="sch-text-compose" onClick={() => navigate.toCompose({ initialPrompt: t("schTextPrompt"), focusPrompt: true })}>{t("schTextOpenCompose")}</Button>
          </div>
        ) : null}
      </SurfaceBody>
    </Surface>
  );
}
