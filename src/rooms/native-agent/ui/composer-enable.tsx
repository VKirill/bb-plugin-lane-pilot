import { useEffect, useRef, useState } from "react";
import { useComposer, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t, detectLocale, setLocaleOverride } from "@lane-pilot/i18n";
import { agentKind, composerAgentLabel, type PickableAgent } from "../agent-display";
import { Button } from "@lane-pilot/ui-kit";
import { Label } from "@lane-pilot/ui-kit";
import { Popover, PopoverContent, PopoverTrigger } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { CONTROL_H } from "@lane-pilot/ui-kit";
import {
  activationDisabledPredicate,
  composerButtonDisabled,
  startBlocked,
  type ActivationBlock,
} from "../activation";
import { DEFAULT_NATIVE_AGENT } from "../native-agent-id";
import { selectionHostId } from "../composer-selection";
import { setPendingNativeAgent } from "./pending-native-agent";
import { useNativeComposerSelection } from "./composer-selection-hook";
import { takeArchitectLaunch } from "../../workflow/ui";

type ContextPayload = {
  projectId: string | null;
  projects: Array<{ id: string; name: string }>;
  bindingStatus: "resolved" | "ambiguous" | "setup_required" | "offline" | "catalog_unavailable" | null;
  compiledMainAgent: "supported" | "none";
  mainAgents: PickableAgent[];
  writer: { providerId: string | null; model: string | null; reasoningEffort: string | null };
  liveRun: { threadId: string; runId: string } | null;
  pluginRole: string | null;
  threadStatus: string | null;
  requiredSessionPolicy?: "required" | "none";
  mainAgent?: string | null;
};

function blockCopy(block: ActivationBlock): string {
  if (block.code === "pending") return t("enabling");
  if (block.code === "no_projects") return t("noProjects");
  if (block.code === "need_project") return t("activationNeedProject");
  if (block.code === "need_binding") return t("noProjectBinding");
  return t("compiledMainUnavailable");
}

function nativeProjectId(scope: ReturnType<typeof useComposerView>["scope"]): string | null {
  return scope.kind === "new-thread" ? scope.projectId : null;
}

export function EnableLanePilotAction() {
  const rpc = useRpc<typeof rpcContract>();
  const composer = useComposer();
  const view = useComposerView();
  const projectId = nativeProjectId(view.scope);
  const hostId = selectionHostId(useNativeComposerSelection());
  // The agent the chat will run as on send: null = a plain chat, the coordinator = Lane Pilot on, anything else = a specialist.
  const [selected, setSelected] = useState<{ id: string; description: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<ContextPayload | null>(null);

  useEffect(() => {
    let current = true;
    void rpc.call("get_preferences", { suggestedLocale: detectLocale() }).then((result) => {
      if (!current) return;
      setLocaleOverride(result.preference === "auto" ? null : result.preference);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [rpc]);

  useEffect(() => {
    let current = true;
    setCtx(null);
    setSelected(null);
    setPendingNativeAgent(null);
    void rpc.call("activation_context", { projectId, threadId: null }).then((next) => {
      if (current) setCtx(next);
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; };
  }, [rpc, projectId]);

  const blocks = activationDisabledPredicate({
    pending,
    projectId,
    bindingStatus: ctx?.bindingStatus,
    compiledRequested: false,
    compiledSupported: true,
    projectCount: ctx?.projects.length,
    launchMode: "mention",
  });
  const disabled = composerButtonDisabled(blocks);
  const blocked = startBlocked(blocks);

  const prepare = async (agent: string) => {
    if (blocked || pending || !projectId) return;
    setPending(true);
    setError(null);
    try {
      const attach = (composer as typeof composer & {
        experimental_vkSetDispatchData?: (data: { token: string } | null) => void;
      }).experimental_vkSetDispatchData;
      if (!attach) throw new Error(t("nativeComposerUpgrade"));
      // Opus 5.5 with the 1M context when the machine offers it, the standard context otherwise.
      let selected = false;
      for (const model of ["claude-opus-5-5[1m]", "claude-opus-5-5"]) {
        const selection = await composer.experimental_setSelection({ providerId: "claude-code", model, permissionMode: "full" });
        if (selection.providerId === "claude-code" && selection.model === model) { selected = true; break; }
      }
      if (!selected) throw new Error(t("nativeComposerModelUnavailable"));
      const result = await rpc.call("prepare_native_session", { projectId, agentId: agent });
      attach({ token: result.token });
      // Claude Lane may still need installing on that machine; start now so the first send does not wait.
      if (hostId) void rpc.call("native_install_start", { hostId }).catch(() => undefined);
      setPendingNativeAgent({ agentId: result.agentId, description: result.label });
      setSelected({ id: result.agentId, description: result.label });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  useEffect(() => composer.experimental_onSubmitted(() => {
    setSelected(null);
    setPendingNativeAgent(null);
  }), [composer.experimental_onSubmitted]);

  // A project with a main agent starts every new chat with Lane Pilot on and that agent picked, once per composer;
  // turning it off by hand stays off.
  const autoEnabled = useRef<string | null>(null);
  // «Build with the architect» in the Workflows tab asks for its agent; it wins over the project's main agent, once.
  useEffect(() => {
    if (!ctx || !projectId || ctx.projectId !== projectId || blocked || autoEnabled.current === projectId) return;
    const asked = takeArchitectLaunch(projectId);
    if (!asked) return;
    autoEnabled.current = projectId;
    void prepare(asked);
  }, [ctx, projectId, blocked]);
  useEffect(() => {
    const agent = ctx?.mainAgent;
    if (!agent || !projectId || ctx?.projectId !== projectId || blocked || autoEnabled.current === projectId) return;
    autoEnabled.current = projectId;
    void prepare(agent);
  }, [ctx, projectId, blocked]);

  const disable = () => {
    (composer as typeof composer & { experimental_vkSetDispatchData?: (data: null) => void })
      .experimental_vkSetDispatchData?.(null);
    setPendingNativeAgent(null);
    setSelected(null);
  };

  const agents = ctx?.mainAgents ?? [];
  const coordinatorId = agents.find((agent) => agentKind(agent) === "coordinator")?.id ?? DEFAULT_NATIVE_AGENT;
  const specialists = agents.filter((agent) => agentKind(agent) === "specialist");
  const laneOn = selected?.id === coordinatorId;
  const busy = blocked || pending;
  const triggerLabel = pending ? t("enabling") : error ? t("failed") : !selected ? t("composerAgentMenu") : laneOn ? t("panelTitle") : composerAgentLabel(agents.find((agent) => agent.id === selected.id) ?? selected, t);

  if (view.scope.kind !== "new-thread") return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 min-h-7 max-w-[10rem] px-2 text-xs" disabled={disabled} aria-label={triggerLabel}>
          <span className="truncate whitespace-nowrap">{triggerLabel}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[min(20rem,calc(100vw-2rem))] min-w-0 max-h-[min(30rem,70vh)] space-y-3 overflow-y-auto" data-testid="activation-popover">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="lp-composer-switch">{t("panelTitle")}</Label>
            <p className="text-xs text-muted-foreground">{t("composerLanePilotHint")}</p>
          </div>
          <Switch
            id="lp-composer-switch"
            size="default"
            checked={laneOn}
            disabled={busy}
            aria-label={t("panelTitle")}
            onCheckedChange={(on) => { if (on) void prepare(coordinatorId); else disable(); }}
          />
        </div>
        <div className="space-y-1" role="radiogroup" aria-label={t("composerAgentMenu")}>
          <Label>{t("composerAgentLabel")}</Label>
          {[{ id: "", label: t("composerAgentNone") }, ...specialists.map((agent) => ({ id: agent.id, label: composerAgentLabel(agent, t) }))].map((row) => {
            const checked = row.id === "" ? !selected : selected?.id === row.id;
            return (
              <Button
                key={row.id || "none"}
                type="button"
                role="radio"
                aria-checked={checked}
                variant={checked ? "secondary" : "ghost"}
                className={`${CONTROL_H} w-full justify-start`}
                disabled={busy}
                onClick={() => { if (row.id === "") disable(); else void prepare(row.id); }}
              >
                <span className="truncate">{row.label}</span>
              </Button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{t("nativeComposerHint")}</p>
        {blocks.filter((row) => row.code !== "pending").length ? (
          <div>
            <p className="text-xs font-medium">{t("activationBlocks")}</p>
            {blocks.filter((row) => row.code !== "pending").map((row) => <p key={row.code} className="text-xs text-muted-foreground">{blockCopy(row)}</p>)}
          </div>
        ) : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
      </PopoverContent>
    </Popover>
  );
}
