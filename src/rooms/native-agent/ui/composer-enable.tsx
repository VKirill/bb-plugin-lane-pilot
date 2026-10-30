import { useEffect, useRef, useState } from "react";
import { useComposer, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t, detectLocale, setLocaleOverride, type I18nKey } from "@lane-pilot/i18n";
import { agentKind, composerAgentLabel, type PickableAgent } from "../agent-display";
import { Button } from "@lane-pilot/ui-kit";
import { Label } from "@lane-pilot/ui-kit";
import { Popover, PopoverContent, PopoverTrigger } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@lane-pilot/ui-kit";
import { CONTROL_H } from "@lane-pilot/ui-kit";
import {
  activationDisabledPredicate,
  composerButtonDisabled,
  startBlocked,
  type ActivationBlock,
} from "../activation";
import { DEFAULT_NATIVE_AGENT } from "../native-agent-id";
import { selectionHostId } from "../composer-selection";
import { noteChatAgentChanged, setPendingNativeAgent } from "./pending-native-agent";
import { useNativeComposerSelection } from "./composer-selection-hook";
import { takeArchitectLaunch } from "../../workflow/ui";

/** The «Без агента» row of the agent dropdown (a Select item cannot have an empty value). */
const NO_AGENT = "__none__";

const DOMAIN_ORDER = ["design", "copy", "seo", "video", "3d", "games", "visual", "social", "billing", "macos", "research", "general"];
const DOMAIN_KEY: Record<string, I18nKey> = {
  design: "domain.design",
  copy: "domain.copy",
  seo: "domain.seo",
  video: "domain.video",
  "3d": "domain.3d",
  games: "domain.games",
  visual: "domain.visual",
  social: "domain.social",
  billing: "domain.billing",
  macos: "domain.macos",
  research: "domain.research",
  general: "domain.general",
};

function groupsOf(agents: PickableAgent[]): Array<{ id: string; agents: PickableAgent[] }> {
  const buckets = new Map<string, PickableAgent[]>();
  for (const agent of agents) {
    const domain = agent.domain || "general";
    const list = buckets.get(domain) ?? [];
    list.push(agent);
    buckets.set(domain, list);
  }
  const ids = [...DOMAIN_ORDER.filter((id) => buckets.has(id)), ...[...buckets.keys()].filter((id) => !DOMAIN_ORDER.includes(id))];
  return ids.map((id) => ({ id, agents: buckets.get(id)! }));
}

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

type ChatState = { projectId: string; eligible: boolean; reason: "helper" | "provider" | "lane_started" | "specialist_run" | null };

/** Why an existing chat cannot change its agent; helper chats get no control at all. */
function lockedCopy(reason: NonNullable<ChatState["reason"]>): string | null {
  if (reason === "provider") return t("composerChatLockedProvider");
  if (reason === "lane_started") return t("composerChatLockedLane");
  return null;
}

export function EnableLanePilotAction() {
  const rpc = useRpc<typeof rpcContract>();
  const view = useComposer();
  const composer = view;
  // In an existing chat the same popover changes the agent from the chat's next message (switch_chat_agent).
  const threadId = view.scope.kind === "thread" ? view.scope.threadId : null;
  const [chat, setChat] = useState<ChatState | null>(null);
  const projectId = view.scope.kind === "new-thread" ? view.scope.projectId : chat?.projectId || null;
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
    if (!threadId) { setChat(null); return; }
    let current = true;
    setChat(null);
    setSelected(null);
    void rpc.call("chat_agent_state", { threadId }).then((state) => {
      if (!current) return;
      setChat(state);
      setSelected(state.current ? { id: state.current.agentId, description: state.current.description } : null);
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; };
  }, [rpc, threadId]);

  useEffect(() => {
    if (threadId && !projectId) return;
    let current = true;
    setCtx(null);
    if (!threadId) {
      setSelected(null);
      setPendingNativeAgent(null);
    }
    void rpc.call("activation_context", { projectId, threadId: null }).then((next) => {
      if (current) setCtx(next);
    }).catch((cause) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; };
  }, [rpc, projectId]);

  const blocks = threadId && !chat ? [{ code: "pending" as const }] : activationDisabledPredicate({
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
      if (!attach && !threadId) throw new Error(t("nativeComposerUpgrade"));
      // Opus 5.5 with the 1M context when the machine offers it, the standard context otherwise.
      let selected = false;
      for (const model of ["claude-opus-5-5[1m]", "claude-opus-5-5"]) {
        const selection = await composer.setSelection({ providerId: "claude-code", model, permissionMode: "full" });
        if (selection.providerId === "claude-code" && selection.model === model) { selected = true; break; }
      }
      if (!selected) throw new Error(t("nativeComposerModelUnavailable"));
      if (threadId) {
        // BB releases the chat's session and the next message resumes it as that agent.
        const changed = await rpc.call("switch_chat_agent", { threadId, agentId: agent });
        if (!changed.agentId) throw new Error(t("failed"));
        setSelected({ id: changed.agentId, description: changed.description ?? changed.agentId });
        noteChatAgentChanged();
        return;
      }
      const result = await rpc.call("prepare_native_session", { projectId, agentId: agent });
      attach!({ token: result.token });
      // New thread only. An existing chat cannot change host: this branch already returned when threadId is set.
      if (result.environment) await (composer as typeof composer & { experimental_setSelection?: (selection: { environment: NonNullable<typeof result.environment> }) => Promise<unknown> }).experimental_setSelection?.({ environment: result.environment });
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

  useEffect(() => composer.onSubmitted(() => {
    if (threadId) { noteChatAgentChanged(); return; }
    setSelected(null);
    setPendingNativeAgent(null);
  }), [composer.onSubmitted, threadId]);

  // A project with a main agent starts every new chat with Lane Pilot on and that agent picked, once per composer;
  // turning it off by hand stays off.
  const autoEnabled = useRef<string | null>(null);
  // «Build with the architect» in the Workflows tab asks for its agent; it wins over the project's main agent, once.
  useEffect(() => {
    if (threadId || !ctx || !projectId || ctx.projectId !== projectId || blocked || autoEnabled.current === projectId) return;
    const asked = takeArchitectLaunch(projectId);
    if (!asked) return;
    autoEnabled.current = projectId;
    void prepare(asked);
  }, [ctx, projectId, blocked]);
  useEffect(() => {
    const agent = ctx?.mainAgent;
    if (threadId || !agent || !projectId || ctx?.projectId !== projectId || blocked || autoEnabled.current === projectId) return;
    autoEnabled.current = projectId;
    void prepare(agent);
  }, [ctx, projectId, blocked]);

  const disable = () => {
    if (threadId) {
      if (pending) return;
      setPending(true);
      setError(null);
      void rpc.call("switch_chat_agent", { threadId, agentId: null })
        .then(() => { setSelected(null); noteChatAgentChanged(); })
        .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setPending(false));
      return;
    }
    (composer as typeof composer & { experimental_vkSetDispatchData?: (data: null) => void })
      .experimental_vkSetDispatchData?.(null);
    setPendingNativeAgent(null);
    setSelected(null);
  };

  const agents = ctx?.mainAgents ?? [];
  const coordinatorId = agents.find((agent) => agentKind(agent) === "coordinator")?.id ?? DEFAULT_NATIVE_AGENT;
  const specialists = agents.filter((agent) => agentKind(agent) === "specialist");
  const laneOn = selected?.id === coordinatorId;
  const locked = chat && !chat.eligible ? lockedCopy(chat.reason!) : null;
  const running = Boolean(threadId) && view.isRunning;
  const busy = blocked || pending || Boolean(chat && !chat.eligible) || running;
  const triggerLabel = pending ? t("enabling") : error ? t("failed") : !selected ? t("composerAgentMenu") : laneOn ? t("panelTitle") : composerAgentLabel(agents.find((agent) => agent.id === selected.id) ?? selected, t);

  if (view.scope.kind !== "new-thread" && !threadId) return null;
  // A helper chat of a run has its agent from the run: no control there.
  if (chat && !chat.eligible && !locked) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        {/* data-lp-agent tells a theme what the chat runs (off, lane-pilot or a specialist) without reading the label. */}
        <Button type="button" variant="outline" size="sm" className="h-7 min-h-7 max-w-[10rem] px-2 text-xs" disabled={disabled} aria-label={triggerLabel}
          data-lp-agent={!selected ? "off" : laneOn ? "lane-pilot" : "specialist"}>
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
        <div className="space-y-1">
          <Label htmlFor="lp-composer-agent">{t("composerAgentLabel")}</Label>
          <Select
            value={selected && !laneOn ? selected.id : NO_AGENT}
            disabled={busy}
            onValueChange={(id) => { if (id === NO_AGENT) disable(); else void prepare(id); }}
          >
            <SelectTrigger id="lp-composer-agent" className={`${CONTROL_H} w-full min-w-0`} aria-label={t("composerAgentLabel")}><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_AGENT}>{t("composerAgentNone")}</SelectItem>
              {groupsOf(specialists).map((group) => (
                <SelectGroup key={group.id}>
                  <SelectLabel>{t(DOMAIN_KEY[group.id] ?? "domain.general")}</SelectLabel>
                  {group.agents.map((agent) => <SelectItem key={agent.id} value={agent.id}>{composerAgentLabel(agent, t)}</SelectItem>)}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">{locked ?? (running ? t("composerChatRunning") : threadId ? t("composerChatHint") : t("nativeComposerHint"))}</p>
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
