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
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { Locale } from "../../i18n";
import { t } from "../../i18n";
import type { LanePilotDefaults } from "../lp-defaults";

type Agent = { id: string; prompt: string; description: string; sourceHash: string; sourceVersion: string; edited: boolean; tools?: string[]; disallowedTools?: string[]; skills?: string[]; mcpServers?: string[] };
type HostOption = { id: string; name: string; status: string; connected: boolean };
type Snapshot = { defaults: LanePilotDefaults; agents: Agent[]; revision: number; hosts?: HostOption[]; requiredSessionPolicy?: "required" | "none" };
type Inventory = Record<ResourceKey, InventoryGroup>;

const RESOURCE_LABEL: Record<ResourceKey, "agentAllowedTools" | "agentDisallowedTools" | "agentSkills" | "agentMcp"> = {
  tools: "agentAllowedTools",
  disallowedTools: "agentDisallowedTools",
  skills: "agentSkills",
  mcpServers: "agentMcp",
};

function ResourcePicker({
  resourceKey,
  value,
  group,
  disabled,
  onChange,
}: {
  resourceKey: ResourceKey;
  value: string[] | undefined;
  group: InventoryGroup | undefined;
  disabled: boolean;
  onChange: (next: string[] | undefined) => void;
}) {
  const [query, setQuery] = useState("");
  const mode = resourceModeOf(value);
  const names = value ?? [];
  const status = group?.status ?? "unavailable";
  const listed = mergeInventoryItems(group?.items ?? [], names).filter((item) => {
    const q = query.trim().toLowerCase();
    return q ? `${item.name} ${item.label}`.toLowerCase().includes(q) : true;
  });
  const known = new Set((group?.items ?? []).map((item) => item.name));
  return (
    <section className="space-y-2" data-testid={`agent-resource-${resourceKey}`}>
      <div className="flex items-center justify-between gap-2">
        <Label className="text-sm">{t(RESOURCE_LABEL[resourceKey])}</Label>
        <Select value={mode} disabled={disabled} onValueChange={(next) => {
          const selected = next as ResourceMode;
          if (selected === "inherit") onChange(undefined);
          else if (selected === "none") onChange([]);
          else onChange(names);
        }}>
          <SelectTrigger className="h-8 w-[11rem]" aria-label={t(RESOURCE_LABEL[resourceKey])}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{t("inheritChoice")}</SelectItem>
            <SelectItem value="none">{t("agentResourceNone")}</SelectItem>
            <SelectItem value="selected">{t("agentResourceSelected")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {status === "error" ? <p className="text-xs text-destructive">{t("agentInventoryError")}</p> : null}
      {status === "unavailable" ? <p className="text-xs text-muted-foreground">{resourceKey === "tools" || resourceKey === "disallowedTools" ? t("agentToolsUnavailable") : t("agentInventoryUnavailable")}</p> : null}
      {mode === "selected" ? (
        <div className="space-y-2">
          <Input value={query} placeholder={t("agentResourceSearch")} aria-label={t("agentResourceSearch")} onChange={(event) => setQuery(event.target.value)} />
          <ul className="max-h-40 space-y-1 overflow-y-auto" role="list">
            {listed.map((item) => (
              <li key={item.name}>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="size-4 accent-foreground"
                    checked={names.includes(item.name)}
                    disabled={disabled}
                    onChange={(event) => onChange(event.target.checked ? [...names, item.name] : names.filter((name) => name !== item.name))}
                  />
                  <span className="min-w-0 truncate">{item.label}</span>
                  {!known.has(item.name) ? <span className="text-xs text-muted-foreground">{t("agentSavedUnknown")}</span> : null}
                </label>
              </li>
            ))}
            {listed.length === 0 ? <li className="text-xs text-muted-foreground">{t("agentInventoryUnavailable")}</li> : null}
          </ul>
        </div>
      ) : null}
    </section>
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
  useEffect(() => {
    if (snapshot || scope === "projects") return;
    let current = true;
    void rpc.call("get_globals", {}).then(async (next) => {
      if (!current) return;
      setSnapshot(next); setDefaults(next.defaults); setAgents(next.agents); setHosts(next.hosts ?? []);
      const prefs = await rpc.call("get_preferences", { suggestedLocale: locale });
      if (!current) return;
      const hostId = next.defaults.qaHostId ?? next.hosts?.[0]?.id ?? null;
      try {
        setInventory(await rpc.call("get_agent_inventory", { projectId: prefs.lastProjectId, hostId }));
      } catch (cause) {
        if (current) setInventory({
          skills: { status: "error", items: [], error: String(cause) },
          mcpServers: { status: "error", items: [], error: String(cause) },
          tools: { status: "unavailable", items: [] },
          disallowedTools: { status: "unavailable", items: [] },
        });
      }
    }).catch((cause) => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [rpc, scope, snapshot, locale]);
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
            tools: resourceModeOf(agent.tools),
            disallowedTools: resourceModeOf(agent.disallowedTools),
            skills: resourceModeOf(agent.skills),
            mcpServers: resourceModeOf(agent.mcpServers),
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
  return <section hidden={scope === "projects"} className="space-y-6" data-testid="owned-settings">
    <p className="text-sm text-muted-foreground">{scope === "globals" ? t("globalsHelp") : t("agentsHelp")}</p>
    {error ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" className="min-h-11" disabled={busy} onClick={() => { void rpc.call("get_globals", {}).then(setRemote).catch((cause) => setError(String(cause))); }}>{ru ? "Загрузить текущую версию для сравнения" : "Load current version to compare"}</Button></div> : null}
    {remote ? <section className="space-y-2 rounded-md border border-border p-3"><h2 className="text-sm font-medium">{ru ? "Текущая сохранённая версия" : "Current saved version"}</h2><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{scope === "globals" ? JSON.stringify(remote.defaults, null, 2) : remote.agents.find((item) => item.id === selected)?.prompt ?? "—"}</pre><p className="text-sm">{ru ? "Ваш черновик остаётся в редакторе. Следующее сохранение заменит показанную версию." : "Your draft remains in the editor. The next save will replace the version shown here."}</p><Button variant="outline" className="min-h-11" onClick={() => { setSnapshot(remote); setRemote(null); setError(""); }}>{ru ? "Продолжить с моим черновиком" : "Continue with my draft"}</Button></section> : null}
    {!snapshot ? <p>{ru ? "Загрузка…" : "Loading…"}</p> : <>
      <fieldset disabled={busy} hidden={scope !== "globals"} className="space-y-6">
        <section className="space-y-3">
          <h2 className="text-sm font-medium">{ru ? "Расположение помощников по умолчанию" : "Default helper placement"}</h2>
          <Select value={defaults.helperPlacement ?? "plugin"} onValueChange={(value) => { setDefaults((current) => ({ ...current, helperPlacement: value as "plugin" | "project_tree" })); setSaved(false); }}>
            <SelectTrigger id="global-placement" aria-label={ru ? "Расположение помощников по умолчанию" : "Default helper placement"} className="min-h-11"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="plugin">{ru ? "В разделе Lane Pilot" : "In Lane Pilot"}</SelectItem><SelectItem value="project_tree">{ru ? "В дереве проекта" : "In the project tree"}</SelectItem></SelectContent>
          </Select>
        </section>
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{t("globalQaHost")}</h2>
            <Button type="button" size="sm" variant="ghost" className="h-8 px-2" disabled={!defaults.qaHostId} onClick={() => { setDefaults((current) => { const next = { ...current }; delete next.qaHostId; return next; }); setSaved(false); }}>{t("inheritChoice")}</Button>
          </div>
          <Select value={defaults.qaHostId ?? "__inherit__"} onValueChange={(value) => { setDefaults((current) => ({ ...current, qaHostId: value === "__inherit__" ? undefined : value })); setSaved(false); }}>
            <SelectTrigger id="global-qa-host" aria-label={t("globalQaHost")} className="min-h-11"><SelectValue placeholder={t("inheritChoice")} /></SelectTrigger>
            <SelectContent>
              <SelectItem value="__inherit__">{t("inheritChoice")}</SelectItem>
              {hosts.map((host) => <SelectItem key={host.id} value={host.id}>{host.name} · {host.connected ? t("hostConnected") : t("hostOffline")}</SelectItem>)}
            </SelectContent>
          </Select>
          {defaults.qaHostId && !hosts.some((host) => host.id === defaults.qaHostId) ? <p className="text-xs text-muted-foreground">{t("hostUnavailable")}</p> : null}
        </section>
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium">{t("globalWriterModel")}</h2>
            <Button type="button" size="sm" variant="ghost" className="h-8 px-2" disabled={!defaults.writerProviderId && !defaults.writerModel} onClick={() => { setDefaults((current) => { const next = { ...current }; delete next.writerProviderId; delete next.writerModel; delete next.writerReasoningEffort; return next; }); setSaved(false); }}>{t("inheritChoice")}</Button>
          </div>
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
        </section>
        <p className="text-xs text-muted-foreground">{ru ? "Источник: общие настройки. Явный выбор проекта имеет приоритет. Применяется при следующем запуске." : "Source: owner defaults. An explicit project choice takes precedence. Applies at the next helper launch."}</p>
      </fieldset>
      <fieldset disabled={busy} hidden={scope !== "agents"} className="space-y-4">
        <p className="text-xs text-muted-foreground">{snapshot.requiredSessionPolicy === "required" ? t("requiredSessionReady") : t("requiredSessionUnavailable")}</p>
        <div className="flex flex-wrap gap-2"><Input aria-label={ru ? "ID нового профиля" : "New profile ID"} value={newId} placeholder="my-agent" onChange={(event) => setNewId(event.target.value)} /><Button variant="outline" className="min-h-11" disabled={!/^[a-z][a-z0-9-]{0,63}$/.test(newId) || agents.some((item) => item.id === newId)} onClick={() => { setAgents((current) => [...current, { id: newId, description: newId, prompt: "", sourceHash: "", sourceVersion: "lp-owned-1", edited: true }]); setSelected(newId); setNewId(""); }}>{ru ? "Добавить профиль" : "Add profile"}</Button></div>
        <Label htmlFor="owned-agent">{ru ? "Профиль" : "Profile"}</Label>
        <Select value={selected} onValueChange={(value) => { setSelected(value); setSaved(false); }}><SelectTrigger id="owned-agent" className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{agents.map((item) => <SelectItem key={item.id} value={item.id}>{item.description}</SelectItem>)}</SelectContent></Select>
        {agent ? <>
          <Label htmlFor="agent-description">{ru ? "Название и назначение" : "Name and purpose"}</Label>
          <Input id="agent-description" className="min-h-11" value={agent.description} onChange={(event) => { setAgents((current) => current.map((item) => item.id === selected ? { ...item, description: event.target.value } : item)); setSaved(false); }} />
          <Label htmlFor="agent-prompt">{ru ? "Инструкции" : "Instructions"}</Label>
          <textarea id="agent-prompt" className="min-h-64 w-full rounded-md border border-input bg-background p-3 text-sm" value={agent.prompt} maxLength={32000} onChange={(event) => { setAgents((current) => current.map((item) => item.id === selected ? { ...item, prompt: event.target.value } : item)); setSaved(false); }} />
          {RESOURCE_KEYS.map((key) => (
            <ResourcePicker
              key={key}
              resourceKey={key}
              value={agent[key]}
              group={inventory?.[key]}
              disabled={busy}
              onChange={(next) => { setAgents((current) => current.map((item) => item.id === selected ? { ...item, [key]: next } : item)); setSaved(false); }}
            />
          ))}
          <p className="text-xs text-muted-foreground">{t("agentResourcesHelp")}</p>
          <details><summary className="cursor-pointer text-sm">{t("settingsAdvanced")}</summary><p className="break-all text-xs text-muted-foreground">Lane Pilot · {agent.sourceVersion} · SHA-256 {agent.sourceHash}</p><p className="text-sm">{ru ? "После сохранения инструкции независимы от шаблона. Native MAIN требует поддержки ядра; сохранение профиля не подтверждает её наличие. Выбор модели сессии и потолок разрешений имеют приоритет." : "Once saved, instructions are independent of the template. Native MAIN requires core support; saving a profile does not confirm that support. The session model choice and permission ceiling take precedence."}</p></details>
        </> : null}
      </fieldset>
      <Button className="min-h-11" disabled={busy || (scope === "agents" && (!agent?.prompt.trim() || !agent.description.trim()))} onClick={() => void save()}>{busy ? (ru ? "Сохранение…" : "Saving…") : (ru ? "Сохранить" : "Save")}</Button>
      {saved ? <p role="status" className="text-sm">{ru ? "Сохранено и проверено повторным чтением." : "Saved and verified by readback."}</p> : null}
    </>}
  </section>;
}
