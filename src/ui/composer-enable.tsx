import { useEffect, useState } from "react";
import { useBbContext, useBbNavigate, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t, detectLocale, setLocaleOverride } from "../../i18n";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import {
  activationDisabledPredicate,
  classifyComposerSession,
  composerButtonDisabled,
  startBlocked,
  type ActivationBlock,
} from "../activation";

type ContextPayload = {
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
  bindingStatus: "resolved" | "ambiguous" | "setup_required" | "offline" | "catalog_unavailable" | null;
  compiledMainAgent: "supported" | "none";
  mainAgents: Array<{ id: string; description: string }>;
  writer: { providerId: string | null; model: string | null; reasoningEffort: string | null };
  liveRun: { threadId: string; runId: string } | null;
  pluginRole: string | null;
  threadStatus: string | null;
};

function blockCopy(block: ActivationBlock): string {
  if (block.code === "pending") return t("enabling");
  if (block.code === "no_projects") return t("noProjects");
  if (block.code === "need_project") return t("activationNeedProject");
  if (block.code === "need_binding") return t("noProjectBinding");
  return t("compiledMainUnavailable");
}

export function EnableLanePilotAction() {
  const rpc = useRpc<typeof rpcContract>();
  const { projectId: routeProjectId, threadId } = useBbContext();
  const navigate = useBbNavigate();
  const view = useComposerView();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<ContextPayload | null>(null);
  const [projectId, setProjectId] = useState<string>(routeProjectId ?? "");
  const [agentId, setAgentId] = useState("__default__");

  const kind = classifyComposerSession({
    composerKind: view.scope.kind,
    threadId,
    pluginRole: ctx?.pluginRole,
    threadStatus: ctx?.threadStatus,
    composerRunning: view.run.isRunning,
  });

  useEffect(() => {
    let current = true;
    void rpc.call("get_preferences", { suggestedLocale: detectLocale() }).then((result) => {
      if (!current) return;
      setLocaleOverride(result.preference === "auto" ? null : result.preference);
    }).catch(() => undefined);
    void rpc.call("activation_context", { projectId: routeProjectId ?? null, threadId: threadId ?? null }).then((next) => {
      if (!current) return;
      setCtx(next);
      setProjectId((currentId) => currentId || next.projectId || "");
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; };
  }, [rpc, routeProjectId, threadId]);

  const compiledRequested = agentId !== "__default__";
  const blocks = activationDisabledPredicate({
    pending,
    projectId: projectId || null,
    bindingStatus: ctx?.bindingStatus,
    compiledRequested,
    compiledSupported: ctx?.compiledMainAgent === "supported",
    projectCount: ctx?.projects.length,
  });
  const disabled = composerButtonDisabled(blocks);
  const blocked = startBlocked(blocks);
  const writerLabel = [ctx?.writer.providerId, ctx?.writer.model, ctx?.writer.reasoningEffort].filter(Boolean).join(" · ") || "—";

  const activate = async (sourceThreadId: string | null) => {
    if (blocked || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await rpc.call("activate_pm", {
        projectId,
        sourceThreadId,
        agentId: agentId === "__default__" ? "" : agentId,
      });
      setOpen(false);
      navigate.toThread(result.threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  if (kind === "lp-active" || ctx?.pluginRole === "pm") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 min-h-7 px-2 text-xs"
        onClick={() => ctx?.liveRun ? navigate.toThread(ctx.liveRun.threadId) : navigate.toPluginPanel("lane-pilot", { subPath: projectId || undefined })}
      >{t("openLanePilotRun")}</Button>
    );
  }

  if (kind === "ordinary-started") {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 min-h-7 px-2 text-xs"
        disabled={disabled}
        onClick={() => void activate(threadId ?? null)}
      >
        <span className="whitespace-nowrap">{pending ? t("enabling") : error ?? t("newLanePilotSession")}</span>
      </Button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 min-h-7 px-2 text-xs" disabled={disabled} aria-label={pending ? t("enabling") : t("enable")}>
          <span className="whitespace-nowrap">{pending ? t("enabling") : error ? t("failed") : t("enable")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 space-y-3" data-testid="activation-popover">
        <div className="space-y-1">
          <Label>{t("selectProject")}</Label>
          <Select value={projectId} onValueChange={setProjectId}>
            <SelectTrigger className="min-h-11" aria-label={t("selectProject")}><SelectValue placeholder={t("selectProject")} /></SelectTrigger>
            <SelectContent>
              {ctx?.projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t("pickAgent")}</Label>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger className="min-h-11" aria-label={t("pickAgent")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__default__">{t("bbDefaultAgent")}</SelectItem>
              {(ctx?.mainAgents ?? []).map((agent) => <SelectItem key={agent.id} value={agent.id}>{agent.description}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">{t("effectiveModel")}: {writerLabel}</p>
        {blocks.filter((row) => row.code !== "pending").length ? (
          <div>
            <p className="text-xs font-medium">{t("activationBlocks")}</p>
            {blocks.filter((row) => row.code !== "pending").map((row) => <p key={row.code} className="text-xs text-muted-foreground">{blockCopy(row)}</p>)}
          </div>
        ) : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        <Button className="min-h-11 w-full" disabled={blocked} onClick={() => void activate(view.scope.kind === "new-thread" ? null : threadId ?? null)}>
          {pending ? t("enabling") : t("startLanePilot")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
