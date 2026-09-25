import { useEffect, useState } from "react";
import {
  experimental_ProviderModelPicker as ProviderModelPicker,
  experimental_useProviders as useProviders,
  useRpc,
  type ExperimentalProviderModelPickerValue,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { mergeInventoryItems, RESOURCE_KEYS, resourceModeOf, type InventoryGroup, type ResourceKey, type ResourceMode } from "../agent-inventory";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { Locale } from "../../i18n";
import { t } from "../../i18n";
import { agentPickerLabel } from "../agent-display";
import type { LanePilotDefaults } from "../lp-defaults";
import { CONTROL_H } from "./control-row";
import { Disclosure } from "./disclosure";
import { usePanelLayout } from "./panel-layout";
import { Surface, SurfaceBody, SurfaceHeader } from "./surface";

const FIELD = "min-w-0 w-full max-w-full";
const CONTROL = `${FIELD} box-border`;

function HelpTip({ label, children }: { label: string; children: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="sm" variant="ghost" className="h-7 w-7 shrink-0 p-0" aria-label={label}>
          <Icon name="CircleQuestion" className="size-4 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-w-sm text-xs text-muted-foreground">{children}</PopoverContent>
    </Popover>
  );
}

type Agent = {
  id: string; prompt: string; description: string; sourceHash: string; sourceVersion: string; edited: boolean;
  tools?: string[]; disallowedTools?: string[]; skills?: string[]; mcpServers?: string[];
  resourceModes?: Partial<Record<ResourceKey, ResourceMode>>;
};
type HostOption = { id: string; name: string; status: string; connected: boolean };
type Snapshot = { defaults: LanePilotDefaults; agents: Agent[]; revision: number; hosts?: HostOption[]; requiredSessionPolicy?: "required" | "none" };
type Inventory = Record<ResourceKey, InventoryGroup>;

const RESOURCE_LABEL: Record<ResourceKey, "agentAllowedTools" | "agentDisallowedTools" | "agentSkills" | "agentMcp"> = {
  tools: "agentAllowedTools",
  disallowedTools: "agentDisallowedTools",
  skills: "agentSkills",
  mcpServers: "agentMcp",
};

function noneLabel(resourceKey: ResourceKey): string {
  if (resourceKey === "tools") return t("agentResourceNoneTools");
  if (resourceKey === "disallowedTools") return t("agentResourceNoneDisallowed");
  return t("agentResourceNone");
}

function ResourcePicker({
  resourceKey,
  value,
  mode,
  group,
  loading,
  disabled,
  onRetry,
  onChange,
}: {
  resourceKey: ResourceKey;
  value: string[] | undefined;
  mode: ResourceMode;
  group: InventoryGroup | undefined;
  loading: boolean;
  disabled: boolean;
  onRetry: () => void;
  onChange: (next: string[] | undefined, nextMode: ResourceMode) => void;
}) {
  const [query, setQuery] = useState("");
  const names = value ?? [];
  const status = loading ? "loading" : group?.status ?? "unavailable";
  const canSelect = status === "ready" || names.length > 0;
  const listed = mergeInventoryItems(group?.items ?? [], names).filter((item) => {
    const q = query.trim().toLowerCase();
    return q ? `${item.name} ${item.label}`.toLowerCase().includes(q) : true;
  });
  const known = new Set((group?.items ?? []).map((item) => item.name));
  const errorTitle = resourceKey === "skills" ? t("agentSkillsLoadFailed") : resourceKey === "mcpServers" ? t("agentMcpLoadFailed") : t("agentInventoryError");
  const { stackControls } = usePanelLayout();
  const unknownSaved = names.some((name) => !known.has(name));
  const statusNote = status === "loading"
    ? <p className="text-xs text-muted-foreground">{t("agentInventoryLoading")}</p>
    : status === "error"
      ? (
        <div className="space-y-1">
          <p className="break-words text-xs text-destructive">{errorTitle}{group?.error ? `: ${group.error}` : ""}</p>
          <Button type="button" variant="outline" className={CONTROL_H} onClick={onRetry}>{t("agentInventoryRetry")}</Button>
        </div>
      )
      : status === "unavailable" && names.length === 0
        ? <p className="text-xs text-muted-foreground">{resourceKey === "tools" || resourceKey === "disallowedTools" ? t("agentToolsUnavailable") : t("agentInventoryUnavailable")}</p>
        : status === "ready" && (group?.items.length ?? 0) === 0 && names.length === 0
          ? <p className="text-xs text-muted-foreground">{t("agentInventoryEmpty")}</p>
          : !canSelect && !loading
            ? <p className="text-xs text-muted-foreground">{t("agentSelectedUnavailable")}</p>
            : null;
  const technical = resourceKey === "tools" || resourceKey === "disallowedTools"
    ? (
      <Disclosure compact summary={t("settingsAdvanced")}>
        <p className="break-words">{t("agentToolsTechnical")}</p>
      </Disclosure>
    )
    : null;
  const showBody = Boolean(statusNote || mode === "selected" || technical);
  return (
    <Surface testId={`agent-resource-${resourceKey}`}>
      <SurfaceHeader className={stackControls ? `flex-col items-stretch gap-2${showBody ? "" : " pb-3"}` : `justify-between${showBody ? "" : " pb-3"}`}>
        <Label className="min-w-0 truncate text-sm">{t(RESOURCE_LABEL[resourceKey])}</Label>
        <Select value={mode} disabled={disabled} onValueChange={(next) => {
          const selected = next as ResourceMode;
          if (selected === "selected" && !canSelect) return;
          if (selected === "inherit") onChange(undefined, "inherit");
          else if (selected === "none") onChange([], "none");
          else onChange(names, "selected");
        }}>
          <SelectTrigger className={stackControls ? `${CONTROL_H} ${CONTROL}` : `${CONTROL_H} w-[11rem] min-w-0 max-w-full shrink-0`} aria-label={t(RESOURCE_LABEL[resourceKey])}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t("inheritChoice")}</SelectItem>
            <SelectItem value="none">{noneLabel(resourceKey)}</SelectItem>
            <SelectItem value="selected" disabled={!canSelect}>{t("agentResourceSelected")}</SelectItem>
          </SelectContent>
        </Select>
      </SurfaceHeader>
      {showBody ? (
        <SurfaceBody>
          {statusNote}
          {mode === "selected" ? (
            <div className="min-w-0 max-w-full space-y-2">
              <p className="text-xs text-muted-foreground">{t("agentSelectedCount").replace("{n}", String(names.length))}</p>
              {unknownSaved ? <p className="text-xs text-muted-foreground">{t("agentSavedUnknownHelp")}</p> : null}
              <Input className={CONTROL} value={query} placeholder={t("agentResourceSearch")} aria-label={t("agentResourceSearch")} onChange={(event) => setQuery(event.target.value)} />
              <ul className="max-h-40 min-w-0 divide-y divide-border overflow-y-auto rounded-md border border-border" role="list">
                {listed.map((item) => (
                  <li key={item.name} className="min-w-0 px-2.5 py-2">
                    <label className="flex min-w-0 items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 shrink-0 accent-foreground"
                        checked={names.includes(item.name)}
                        disabled={disabled}
                        onChange={(event) => onChange(event.target.checked ? [...names, item.name] : names.filter((name) => name !== item.name), "selected")}
                      />
                      <span className="min-w-0 flex-1 break-all">{item.label}</span>
                      {!known.has(item.name) ? <span className="shrink-0 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">{t("agentSavedUnknown")}</span> : null}
                    </label>
                  </li>
                ))}
                {listed.length === 0 ? <li className="px-2.5 py-2 text-xs text-muted-foreground">{t("agentInventoryEmpty")}</li> : null}
              </ul>
            </div>
          ) : null}
          {technical}
        </SurfaceBody>
      ) : null}
    </Surface>
  );
}

/** Kept mounted across navigation so unsaved drafts retain their original CAS token. */
export function OwnedSettings({ scope, locale, onDefaultsSaved }: { scope: "projects" | "globals" | "agents"; locale: Locale; onDefaultsSaved?: (defaults: LanePilotDefaults) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const ru = locale === "ru";
  const providers = useProviders();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [defaults, setDefaults] = useState<LanePilotDefaults>({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [hosts, setHosts] = useState<HostOption[]>([]);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selected, setSelected] = useState("dev-orchestrator");
  const [remote, setRemote] = useState<Snapshot | null>(null);
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const loadInventory = async (next: Snapshot) => {
    const prefs = await rpc.call("get_preferences", { suggestedLocale: locale });
    const hostId = next.defaults.qaHostId ?? next.hosts?.find((host) => host.connected)?.id ?? next.hosts?.[0]?.id ?? null;
    try {
      setInventory(await rpc.call("get_agent_inventory", { projectId: prefs.lastProjectId, hostId }));
    } catch (cause) {
      setInventory((current) => current ?? {
        skills: { status: "error", items: [], error: String(cause) },
        mcpServers: { status: "error", items: [], error: String(cause) },
        tools: { status: "unavailable", items: [] },
        disallowedTools: { status: "unavailable", items: [] },
      });
    }
  };
  useEffect(() => {
    if (snapshot || scope === "projects") return;
    let current = true;
    void rpc.call("get_globals", {}).then(async (next) => {
      if (!current) return;
      setSnapshot(next); setDefaults(next.defaults); setAgents(next.agents); setHosts(next.hosts ?? []);
      await loadInventory(next);
    }).catch((cause) => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [rpc, scope, snapshot, locale]);
  const { stackControls } = usePanelLayout();
  const agent = agents.find((item) => item.id === selected);
  const save = async () => {
    if (!snapshot || busy) return;
    setBusy(true); setError(""); setSaved(false);
    try {
      if (scope === "globals") {
        const result = await rpc.call("save_globals", { defaults, expectedRevision: snapshot.revision });
        if (!result.ok) throw new Error(ru ? "Настройки изменены в другом окне. Черновик сохранён; загрузите текущую версию ниже для сравнения." : "Settings changed in another window. Your draft is retained; load the current version below to compare.");
        const readback = await rpc.call("get_globals", {});
        if (readback.revision !== result.revision) throw new Error(ru ? "После сохранения появилась новая версия. Черновик сохранён." : "A newer version appeared after saving. Your draft is retained.");
        setSnapshot((current) => current ? { ...current, defaults: readback.defaults, revision: readback.revision } : current);
        setDefaults(readback.defaults);
        onDefaultsSaved?.(readback.defaults);
      } else if (agent) {
        const original = snapshot.agents.find((item) => item.id === agent.id);
        const result = await rpc.call("save_agent_profile", {
          id: agent.id,
          prompt: agent.prompt,
          description: agent.description,
          expectedSourceHash: original?.sourceHash ?? "",
          ...(agent.tools ? { tools: agent.tools } : {}),
          ...(agent.disallowedTools ? { disallowedTools: agent.disallowedTools } : {}),
          ...(agent.skills ? { skills: agent.skills } : {}),
          ...(agent.mcpServers ? { mcpServers: agent.mcpServers } : {}),
          resourceModes: {
            tools: agent.resourceModes?.tools ?? resourceModeOf(agent.tools),
            disallowedTools: agent.resourceModes?.disallowedTools ?? resourceModeOf(agent.disallowedTools),
            skills: agent.resourceModes?.skills ?? resourceModeOf(agent.skills),
            mcpServers: agent.resourceModes?.mcpServers ?? resourceModeOf(agent.mcpServers),
          },
        });
        if (!result.ok) throw new Error(ru ? "Профиль изменён в другом окне. Ваш черновик сохранён." : "Profile changed in another window. Your draft is retained.");
        const readback = await rpc.call("get_globals", {});
        const confirmed = readback.agents.find((item) => item.id === agent.id)!;
        if (confirmed.sourceHash !== result.sourceHash) throw new Error(ru ? "После сохранения профиль снова изменился. Черновик сохранён." : "The profile changed again after saving. Your draft is retained.");
        setSnapshot((current) => current ? { ...current, agents: [...current.agents.filter((item) => item.id !== confirmed.id), confirmed] } : current);
        setAgents((current) => current.map((item) => item.id === confirmed.id ? confirmed : item));
      }
      setSaved(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <section hidden={scope === "projects"} className="min-w-0 max-w-full space-y-6" style={{ minInlineSize: 0 }} data-testid="owned-settings">
    <div className="min-w-0 space-y-1">
      <h1 className="text-xl font-medium">{scope === "globals" ? t("navGlobals") : t("navAgents")}</h1>
      <p className="text-sm text-muted-foreground">{scope === "globals" ? t("globalsHelp") : t("agentsHelp")}</p>
    </div>
    {error ? <div className="min-w-0 space-y-2"><p role="alert" className="break-words text-sm text-destructive">{error}</p><Button variant="outline" className={CONTROL_H} disabled={busy} onClick={() => { void rpc.call("get_globals", {}).then(setRemote).catch((cause) => setError(String(cause))); }}>{ru ? "Загрузить текущую версию для сравнения" : "Load current version to compare"}</Button></div> : null}
    {remote ? <section className="min-w-0 max-w-full space-y-2 rounded-md border border-border p-3"><h2 className="text-sm font-medium">{ru ? "Текущая сохранённая версия" : "Current saved version"}</h2><pre className="max-h-64 max-w-full overflow-auto whitespace-pre-wrap break-words text-xs">{scope === "globals" ? JSON.stringify(remote.defaults, null, 2) : remote.agents.find((item) => item.id === selected)?.prompt ?? "—"}</pre><p className="text-sm">{ru ? "Ваш черновик остаётся в редакторе. Следующее сохранение заменит показанную версию." : "Your draft remains in the editor. The next save will replace the version shown here."}</p><Button variant="outline" className={CONTROL_H} onClick={() => { setSnapshot(remote); setRemote(null); setError(""); }}>{ru ? "Продолжить с моим черновиком" : "Continue with my draft"}</Button></section> : null}
    {!snapshot ? <p>{ru ? "Загрузка…" : "Loading…"}</p> : <>
      <fieldset disabled={busy} hidden={scope !== "globals"} className="min-w-0 max-w-full space-y-6" style={{ minInlineSize: 0 }}>
        <Surface>
          <SurfaceHeader><h2 className="text-sm font-medium">{t("globalsSectionPlacement")}</h2></SurfaceHeader>
          <SurfaceBody>
          <Select value={defaults.helperPlacement ?? "plugin"} onValueChange={(value) => { setDefaults((current) => ({ ...current, helperPlacement: value as "plugin" | "project_tree" })); setSaved(false); }}>
            <SelectTrigger id="global-placement" aria-label={ru ? "Расположение помощников по умолчанию" : "Default helper placement"} className={`${CONTROL_H} ${CONTROL}`}><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="plugin">{ru ? "В разделе Lane Pilot" : "In Lane Pilot"}</SelectItem><SelectItem value="project_tree">{ru ? "В дереве проекта" : "In the project tree"}</SelectItem></SelectContent>
          </Select>
          </SurfaceBody>
        </Surface>
        <Surface>
          <SurfaceHeader><h2 className="text-sm font-medium">{t("globalsSectionMachine")}</h2></SurfaceHeader>
          <SurfaceBody className="space-y-5">
          <div className="min-w-0 max-w-full space-y-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <h3 className="min-w-0 text-sm font-medium">{t("globalQaHost")}</h3>
              <Button type="button" variant="ghost" className={`${CONTROL_H} shrink-0 px-2`} disabled={!defaults.qaHostId} onClick={() => { setDefaults((current) => { const next = { ...current }; delete next.qaHostId; return next; }); setSaved(false); }}>{t("inheritChoice")}</Button>
            </div>
            <Select value={defaults.qaHostId ?? "__inherit__"} onValueChange={(value) => { setDefaults((current) => ({ ...current, qaHostId: value === "__inherit__" ? undefined : value })); setSaved(false); }}>
              <SelectTrigger id="global-qa-host" aria-label={t("globalQaHost")} className={`${CONTROL_H} ${CONTROL}`}><SelectValue placeholder={t("inheritChoice")} /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__inherit__">{t("inheritChoice")}</SelectItem>
                {hosts.map((host) => <SelectItem key={host.id} value={host.id}>{host.name} · {host.connected ? t("hostConnected") : t("hostOffline")}</SelectItem>)}
              </SelectContent>
            </Select>
            {defaults.qaHostId && !hosts.some((host) => host.id === defaults.qaHostId) ? <p className="text-xs text-muted-foreground">{t("hostUnavailable")}</p> : null}
          </div>
          <div className="min-w-0 max-w-full space-y-2">
            <div className="flex min-w-0 items-center justify-between gap-2">
              <h3 className="min-w-0 text-sm font-medium">{t("globalWriterModel")}</h3>
              <Button type="button" variant="ghost" className={`${CONTROL_H} shrink-0 px-2`} disabled={!defaults.writerProviderId && !defaults.writerModel} onClick={() => { setDefaults((current) => { const next = { ...current }; delete next.writerProviderId; delete next.writerModel; delete next.writerReasoningEffort; return next; }); setSaved(false); }}>{t("inheritChoice")}</Button>
            </div>
            <div className="min-w-0 max-w-full">
              {defaults.qaHostId ? (
                providers.providers?.length || defaults.writerProviderId
                  ? <ProviderModelPicker
                      value={{
                        providerId: defaults.writerProviderId || providers.providers?.[0]?.id || "none",
                        model: defaults.writerModel || "",
                        reasoningLevel: (defaults.writerReasoningEffort || "medium") as ExperimentalProviderModelPickerValue["reasoningLevel"],
                      }}
                      routing={{ kind: "host", hostId: defaults.qaHostId }}
                      onChange={(next: ExperimentalProviderModelPickerValue) => {
                        setDefaults((current) => ({ ...current, writerProviderId: next.providerId, writerModel: next.model, writerReasoningEffort: next.reasoningLevel }));
                        setSaved(false);
                      }}
                    />
                  : <p className="text-sm text-muted-foreground">{providers.status === "loading" ? t("writerCatalogLoading") : t("writerCatalogUnavailable")}</p>
              ) : <p className="text-xs text-muted-foreground">{t("catalogNeedsMachine")}</p>}
            </div>
          </div>
          </SurfaceBody>
        </Surface>
      </fieldset>
      <fieldset disabled={busy} hidden={scope !== "agents"} className="min-w-0 max-w-full space-y-6" style={{ minInlineSize: 0 }}>
        <div className="flex min-w-0 items-start gap-1">
          <p className="text-xs text-muted-foreground">{snapshot.requiredSessionPolicy === "required" ? t("agentResourceLimitsAvailable") : t("agentResourceLimitsUnavailable")}</p>
          <HelpTip label={snapshot.requiredSessionPolicy === "required" ? t("requiredSessionReady") : t("requiredSessionUnavailable")}>
            {snapshot.requiredSessionPolicy === "required" ? t("requiredSessionReady") : t("requiredSessionUnavailable")}
          </HelpTip>
        </div>
        <Surface>
          <SurfaceHeader><h2 className="text-sm font-medium">{t("agentSectionProfile")}</h2></SurfaceHeader>
          <SurfaceBody>
          <div className={stackControls ? "flex min-w-0 flex-col gap-2" : "flex min-w-0 flex-row gap-2"} data-testid="agent-new-profile">
            <Input className={`${CONTROL_H} ${CONTROL}`} aria-label={ru ? "ID нового профиля" : "New profile ID"} value={newId} placeholder="my-agent" onChange={(event) => setNewId(event.target.value)} />
            <Button variant="outline" className={`${CONTROL_H} shrink-0`} disabled={!/^[a-z][a-z0-9-]{0,63}$/.test(newId) || agents.some((item) => item.id === newId)} onClick={() => { setAgents((current) => [...current, { id: newId, description: newId, prompt: "", sourceHash: "", sourceVersion: "lp-owned-1", edited: true }]); setSelected(newId); setNewId(""); }}>{ru ? "Добавить профиль" : "Add profile"}</Button>
          </div>
          <Label htmlFor="owned-agent">{t("agentSelectedProfile")}</Label>
          <Select value={selected} onValueChange={(value) => { setSelected(value); setSaved(false); }}><SelectTrigger id="owned-agent" className={`${CONTROL_H} ${CONTROL}`}><SelectValue /></SelectTrigger><SelectContent>{agents.map((item) => <SelectItem key={item.id} value={item.id}>{agentPickerLabel(item, t)}</SelectItem>)}</SelectContent></Select>
          {agent ? <>
            <Label htmlFor="agent-description">{ru ? "Название и назначение" : "Name and purpose"}</Label>
            <Input id="agent-description" className={`${CONTROL_H} ${CONTROL}`} value={agent.description} onChange={(event) => { setAgents((current) => current.map((item) => item.id === selected ? { ...item, description: event.target.value } : item)); setSaved(false); }} />
          </> : null}
          </SurfaceBody>
        </Surface>
        {agent ? <>
          <Surface>
            <SurfaceHeader><h2 className="text-sm font-medium">{t("agentSectionInstructions")}</h2></SurfaceHeader>
            <SurfaceBody>
            <Label htmlFor="agent-prompt" className="sr-only">{t("agentSectionInstructions")}</Label>
            <textarea id="agent-prompt" className={`min-h-64 rounded-md border border-input bg-background p-3 text-sm ${CONTROL}`} style={{ overflowWrap: "anywhere", wordBreak: "break-word" }} value={agent.prompt} maxLength={32000} onChange={(event) => { setAgents((current) => current.map((item) => item.id === selected ? { ...item, prompt: event.target.value } : item)); setSaved(false); }} />
            </SurfaceBody>
          </Surface>
          <div className="min-w-0 max-w-full space-y-3">
            <div className="flex min-w-0 items-center gap-1 px-0.5">
              <h2 className="text-sm font-medium">{t("agentSectionResources")}</h2>
              <HelpTip label={t("agentResourcesHelp")}>{t("agentResourcesHelp")}</HelpTip>
            </div>
            {RESOURCE_KEYS.map((key) => (
              <ResourcePicker
                key={key}
                resourceKey={key}
                value={agent[key]}
                mode={agent.resourceModes?.[key] ?? resourceModeOf(agent[key])}
                group={inventory?.[key]}
                loading={inventory === null}
                disabled={busy}
                onRetry={() => { if (snapshot) void loadInventory(snapshot); }}
                onChange={(next, mode) => {
                  setAgents((current) => current.map((item) => item.id === selected ? {
                    ...item,
                    [key]: next,
                    resourceModes: { ...item.resourceModes, [key]: mode },
                  } : item));
                  setSaved(false);
                }}
              />
            ))}
          </div>
          <Disclosure summary={t("settingsAdvanced")}>
            <p className="break-all text-xs text-muted-foreground">Lane Pilot · {agent.sourceVersion} · SHA-256 {agent.sourceHash}</p>
            <p className="text-sm">{ru ? "После сохранения инструкции независимы от шаблона. Native MAIN требует поддержки ядра; сохранение профиля не подтверждает её наличие. Выбор модели сессии и потолок разрешений имеют приоритет." : "Once saved, instructions are independent of the template. Native MAIN requires core support; saving a profile does not confirm that support. The session model choice and permission ceiling take precedence."}</p>
          </Disclosure>
        </> : null}
      </fieldset>
      <Button className={CONTROL_H} disabled={busy || (scope === "agents" && (!agent?.prompt.trim() || !agent.description.trim()))} onClick={() => void save()}>{busy ? (ru ? "Сохранение…" : "Saving…") : (ru ? "Сохранить" : "Save")}</Button>
      {saved ? <p role="status" className="text-sm">{ru ? "Сохранено и проверено повторным чтением." : "Saved and verified by readback."}</p> : null}
    </>}
  </section>;
}
