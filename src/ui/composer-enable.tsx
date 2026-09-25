import { useEffect, useState } from "react";
import { useComposer, useComposerView, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { t, detectLocale, setLocaleOverride } from "../../i18n";
import { agentPickerLabel } from "../agent-display";
import { Button } from "../../components/ui/button";
import { Label } from "../../components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { CONTROL_H } from "./control-row";
import {
  activationDisabledPredicate,
  composerButtonDisabled,
  startBlocked,
  type ActivationBlock,
} from "../activation";
import { DEFAULT_NATIVE_AGENT } from "../native-session";

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
  requiredSessionPolicy?: "required" | "none";
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
  const [enabled, setEnabled] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [ctx, setCtx] = useState<ContextPayload | null>(null);
  const [agentId, setAgentId] = useState(DEFAULT_NATIVE_AGENT);

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
    setEnabled(false);
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

  const prepare = async () => {
    if (blocked || pending || !projectId) return;
    setPending(true);
    setError(null);
    try {
      const attach = (composer as typeof composer & {
        experimental_vkSetDispatchData?: (data: { token: string } | null) => void;
      }).experimental_vkSetDispatchData;
      if (!attach) throw new Error(t("nativeComposerUpgrade"));
      const selection = await composer.experimental_setSelection({
        providerId: "claude-code", model: "claude-opus-5[1m]", permissionMode: "full",
      });
      if (selection.providerId !== "claude-code" || selection.model !== "claude-opus-5[1m]") {
        throw new Error(t("nativeComposerModelUnavailable"));
      }
      const result = await rpc.call("prepare_native_session", { projectId, agentId });
      attach({ token: result.token });
      setEnabled(true);
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };

  useEffect(() => composer.experimental_onSubmitted(() => setEnabled(false)), [composer.experimental_onSubmitted]);

  const disable = () => {
    (composer as typeof composer & { experimental_vkSetDispatchData?: (data: null) => void })
      .experimental_vkSetDispatchData?.(null);
    setEnabled(false);
    setOpen(false);
  };

  if (view.scope.kind !== "new-thread") return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="h-7 min-h-7 px-2 text-xs" disabled={disabled} aria-label={pending ? t("enabling") : enabled ? t("nativeComposerEnabled") : t("enable")}>
          <span className="whitespace-nowrap">{pending ? t("enabling") : error ? t("failed") : enabled ? t("nativeComposerEnabled") : t("enable")}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 max-w-[min(20rem,calc(100vw-2rem))] min-w-0 space-y-3" data-testid="activation-popover">
        <div className="space-y-1">
          <Label>{t("pickAgent")}</Label>
          <Select value={agentId} onValueChange={setAgentId}>
            <SelectTrigger className={`${CONTROL_H} min-w-0 max-w-full`} aria-label={t("pickAgent")}><SelectValue /></SelectTrigger>
            <SelectContent>
              {(ctx?.mainAgents ?? [{ id: DEFAULT_NATIVE_AGENT, description: "" }]).map((agent) => (
                <SelectItem key={agent.id} value={agent.id}>{agentPickerLabel(agent, t)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">{t("nativeComposerHint")}</p>
        {blocks.filter((row) => row.code !== "pending").length ? (
          <div>
            <p className="text-xs font-medium">{t("activationBlocks")}</p>
            {blocks.filter((row) => row.code !== "pending").map((row) => <p key={row.code} className="text-xs text-muted-foreground">{blockCopy(row)}</p>)}
          </div>
        ) : null}
        {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
        {enabled ? <Button variant="outline" className={`${CONTROL_H} w-full`} onClick={disable}>{t("nativeComposerDisable")}</Button> : null}
        <Button className={`${CONTROL_H} w-full`} disabled={blocked} onClick={() => void prepare()}>
          {pending ? t("enabling") : t("prepareNativeComposer")}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
