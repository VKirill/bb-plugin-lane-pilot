import { stateLabel, t } from "@lane-pilot/i18n";
import { Button } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { HowItWorks } from "./how-it-works";
import { LocaleControls, OverviewLoading, StatusRow } from "../../settings/ui/setting-controls";
import { runTone } from "./page-model";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { Pill } from "./pill";
import type { LpPage } from "./use-lp-page";

const OPEN_STATES = new Set(["pending", "running"]);

/** What is going on now, what needs the owner, what is still to set up, and how it all works. */
export function OverviewTab({ page }: { page: LpPage }) {
  const { data, error, screenLoading, writerChosen, activeRuns, selectedSectionId, isGlobal, goTo, localePreference, chooseLocale, hiddenProjects, showProject, projects } = page;
  if (isGlobal) {
    const hidden = projects.filter((project) => hiddenProjects.has(project.id));
    return (
      <div className="space-y-6">
        <Surface testId="language-setting">
          <SurfaceHeader><h2 className="text-sm font-medium">{t("language")}</h2></SurfaceHeader>
          <SurfaceBody className="space-y-2">
            <LocaleControls preference={localePreference} onChange={(next) => void chooseLocale(next)} />
            <p className="text-xs text-muted-foreground">{t("languageHelp")}</p>
          </SurfaceBody>
        </Surface>
        <HowItWorks open />
        <Surface testId="hidden-projects">
          <SurfaceHeader><h2 className="text-sm font-medium">{t("hiddenProjectsTitle")}</h2></SurfaceHeader>
          <SurfaceBody className="space-y-2">
            {hidden.length === 0 ? <p className="text-xs text-muted-foreground">{t("hiddenProjectsEmpty")}</p> : hidden.map((project) => (
              <div key={project.id} className="flex min-w-0 items-center justify-between gap-2">
                <span className="min-w-0 truncate text-sm">{project.name}</span>
                <Button size="sm" variant="outline" onClick={() => showProject(project.id)}>{t("projectShow")}</Button>
              </div>
            ))}
          </SurfaceBody>
        </Surface>
      </div>
    );
  }
  if (screenLoading) return <OverviewLoading />;
  const open = (data?.runs ?? []).filter((run) => OPEN_STATES.has(run.state));
  const failed = (data?.runs ?? []).filter((run) => run.state === "failed" || run.state === "blocked").length;
  const binding = data?.writerBinding;
  const attention: Array<{ id: string; text: string; tab: "team" | "runs" | "overview"; segment?: string }> = [];
  if (!error && data && !writerChosen) attention.push({ id: "writer", text: t("attnWriter"), tab: "team" });
  if (binding && binding.status !== "resolved") attention.push({ id: "binding", text: t(binding.status === "ambiguous" ? "bindingAmbiguous" : binding.status === "offline" ? "bindingOffline" : binding.status === "setup_required" ? "bindingSetupRequired" : "writerCatalogUnavailable"), tab: "overview" });
  if (failed > 0) attention.push({ id: "failed", text: t("attnFailedRuns").replace("{n}", String(failed)), tab: "runs", segment: "history" });
  return (
    <div className="space-y-6">
      <Surface testId="runs-now">
        <SurfaceHeader className="justify-between">
          <h2 className="text-sm font-medium">{t("overviewNow")}</h2>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => goTo("runs", "active")}>{t("overviewAllRuns")}</Button>
        </SurfaceHeader>
        <SurfaceBody className="space-y-2">
          {open.length === 0 ? <p className="text-sm text-muted-foreground">{t("overviewNoRuns")}</p> : open.slice(0, 3).map((run) => (
            <div key={run.id} className="flex min-w-0 flex-wrap items-center justify-between gap-2" data-testid={`now-${run.id}`}>
              <span className="min-w-0 truncate text-sm font-medium" title={run.id}>{run.pmThread?.title ?? run.id}</span>
              <span className="flex shrink-0 items-center gap-2">
                <Pill tone={runTone(run.state) === "success" ? "success" : "info"}>{stateLabel(run.state)}</Pill>
                {run.pmThread?.status ? <span className="text-xs text-muted-foreground">{t(run.pmThread.status === "active" ? "runChatActive" : run.pmThread.status === "gone" ? "runChatGone" : "runChatIdle")}</span> : null}
              </span>
            </div>
          ))}
          {open.length > 3 ? <p className="text-xs text-muted-foreground">{t("overviewMoreRuns").replace("{n}", String(open.length - 3))}</p> : null}
        </SurfaceBody>
      </Surface>
      <Surface testId="needs-attention">
        <SurfaceHeader><h2 className="text-sm font-medium">{t("overviewAttention")}{attention.length ? ` (${attention.length})` : ""}</h2></SurfaceHeader>
        <SurfaceBody className="space-y-2">
          {attention.length === 0 ? <p className="text-sm text-muted-foreground">{t("overviewAllClear")}</p> : attention.map((item) => (
            <div key={item.id} className="flex min-w-0 items-center justify-between gap-2" data-testid={`attention-${item.id}`}>
              <span className="min-w-0 break-words text-sm">{item.text}</span>
              {item.tab === "overview" ? null : <Button size="sm" variant="outline" className="shrink-0" onClick={() => goTo(item.tab, item.segment)}>{t("overviewOpen")}</Button>}
            </div>
          ))}
        </SurfaceBody>
      </Surface>
      <Surface testId="setup-status">
        <SurfaceHeader><h2 className="text-sm font-medium">{t("overviewSetup")}</h2></SurfaceHeader>
        <SurfaceBody className="space-y-3">
          <StatusRow testId="status-writer" state={writerChosen ? "ok" : "todo"} title={t("writerPicker")}
            detail={writerChosen ? `${String(data?.values["writer.provider"])} · ${String(data?.values["writer.model"])}` : t("overviewWriterMissing")}
            action={writerChosen ? null : <Button size="sm" variant="outline" onClick={() => goTo("team")}>{t("overviewOpen")}</Button>} />
          {selectedSectionId ? null : <StatusRow testId="status-stack" state="info" title={t("overviewStack")} detail={t("overviewStackHelp")}
            action={<Button size="sm" variant="outline" onClick={() => goTo("runs", "service")}>{t("overviewOpen")}</Button>} />}
          <StatusRow testId="status-start" state="info" title={t("overviewStart")} detail={t("overviewStartHelp")} />
          {selectedSectionId ? null : <StatusRow testId="status-runs" state={activeRuns ? "ok" : "info"} title={t("tabRuns")}
            detail={activeRuns ? t("overviewRuns").replace("{n}", String(activeRuns)) : t("overviewNoRuns")}
            action={<Button size="sm" variant="outline" onClick={() => goTo("runs", "active")}>{t("overviewOpen")}</Button>} />}
        </SurfaceBody>
      </Surface>
      <MachineAndFolder page={page} />
      <HowItWorks />
    </div>
  );
}

/** Which machine and folder the project's helpers use; a choice when several are bound. */
function MachineAndFolder({ page }: { page: LpPage }) {
  const { data, hostLabel, projectId, setSelectedBinding, rpc, setSaveError, setWriterRejected, load } = page;
  if (!data?.writerBinding) return null;
  const binding = data.writerBinding;
  return (
    <Surface testId="writer-binding">
      <SurfaceHeader><h2 className="text-sm font-medium">{t("projectMachineFolder")}</h2></SurfaceHeader>
      <SurfaceBody className="space-y-2 text-sm">
        {binding.status === "resolved" ? (
          <p className="min-w-0 break-all">
            {hostLabel(binding.hostId)} · {binding.path}
            <span className="ml-2 text-xs text-muted-foreground">{binding.source === "session" ? t("inheritedFromSession") : t("inheritedFromProject")}</span>
          </p>
        ) : null}
        {binding.status === "ambiguous" ? (
          <Select onValueChange={(next) => {
            const [hostId, path] = next.split("\u0000");
            if (!hostId || !path || !projectId) return;
            setSelectedBinding({ hostId, path });
            void rpc.call("save_writer_binding", { projectId, hostId, path }).then((result) => {
              if (result.ok) { setSaveError(null); setWriterRejected(false); void load(); }
            });
          }}>
            <SelectTrigger data-testid="writer-binding-select" aria-label={t("projectMachineFolder")}>
              <SelectValue placeholder={t("bindingAmbiguous")} />
            </SelectTrigger>
            <SelectContent>
              {binding.bindings.map((row) => (
                <SelectItem key={`${row.hostId}:${row.path}`} value={`${row.hostId}\u0000${row.path}`}>{hostLabel(row.hostId)} · {row.path}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {binding.status === "setup_required" ? <p>{t("bindingSetupRequired")}</p> : null}
        {binding.status === "offline" ? <p>{t("bindingOffline")}</p> : null}
        {binding.status === "catalog_unavailable" ? <p>{t("writerCatalogUnavailable")}</p> : null}
        {(data.inheritedKeys ?? []).length ? <p className="text-xs text-muted-foreground">{t("inheritedFromGlobal")}</p> : null}
      </SurfaceBody>
    </Surface>
  );
}
