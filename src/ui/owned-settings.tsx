import { useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contracts";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { Locale } from "../../i18n";
import { t } from "../../i18n";
import type { LanePilotDefaults } from "../lp-defaults";

type Agent = { id: string; prompt: string; description: string; sourceHash: string; sourceVersion: string; edited: boolean; tools?: string[]; disallowedTools?: string[]; skills?: string[]; mcpServers?: string[] };
type Snapshot = { defaults: LanePilotDefaults; agents: Agent[]; revision: number };

/** Kept mounted across navigation so unsaved drafts retain their original CAS token. */
export function OwnedSettings({ scope, locale, onDefaultsSaved }: { scope: "projects" | "globals" | "agents"; locale: Locale; onDefaultsSaved?: (defaults: LanePilotDefaults) => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const ru = locale === "ru";
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [defaults, setDefaults] = useState<LanePilotDefaults>({});
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selected, setSelected] = useState("dev-orchestrator");
  const [remote, setRemote] = useState<Snapshot | null>(null);
  const [resourceText, setResourceText] = useState<Record<string, string>>({});
  const [newId, setNewId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (snapshot || scope === "projects") return;
    let current = true;
    void rpc.call("get_globals", {}).then((next) => {
      if (!current) return;
      setSnapshot(next); setDefaults(next.defaults); setAgents(next.agents);
    }).catch((cause) => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [rpc, scope, snapshot]);
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
        const result = await rpc.call("save_agent_profile", { id: agent.id, prompt: agent.prompt, description: agent.description, ...(agent.tools ? { tools: agent.tools } : {}), ...(agent.disallowedTools ? { disallowedTools: agent.disallowedTools } : {}), ...(agent.skills ? { skills: agent.skills } : {}), ...(agent.mcpServers ? { mcpServers: agent.mcpServers } : {}), expectedSourceHash: original?.sourceHash ?? "" });
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
  return <section hidden={scope === "projects"} className="space-y-5" data-testid="owned-settings">
    <p className="text-sm text-muted-foreground">{scope === "globals" ? t("globalsHelp") : t("agentsHelp")}</p>
    {error ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button variant="outline" className="min-h-11" disabled={busy} onClick={() => { void rpc.call("get_globals", {}).then(setRemote).catch((cause) => setError(String(cause))); }}>{ru ? "Загрузить текущую версию для сравнения" : "Load current version to compare"}</Button></div> : null}
    {remote ? <section className="space-y-2 rounded-md border border-border p-3"><h2 className="text-sm font-medium">{ru ? "Текущая сохранённая версия" : "Current saved version"}</h2><pre className="max-h-64 overflow-auto whitespace-pre-wrap text-xs">{scope === "globals" ? JSON.stringify(remote.defaults, null, 2) : remote.agents.find((item) => item.id === selected)?.prompt ?? "—"}</pre><p className="text-sm">{ru ? "Ваш черновик остаётся в редакторе. Следующее сохранение заменит показанную версию." : "Your draft remains in the editor. The next save will replace the version shown here."}</p><Button variant="outline" className="min-h-11" onClick={() => { setSnapshot(remote); setRemote(null); setError(""); }}>{ru ? "Продолжить с моим черновиком" : "Continue with my draft"}</Button></section> : null}
    {!snapshot ? <p>{ru ? "Загрузка…" : "Loading…"}</p> : <>
      <fieldset disabled={busy} hidden={scope !== "globals"} className="space-y-0 divide-y divide-border">
        <div className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center">
          <Label htmlFor="global-placement">{ru ? "Расположение помощников по умолчанию" : "Default helper placement"}</Label>
          <Select value={defaults.helperPlacement ?? "plugin"} onValueChange={(value) => { setDefaults((current) => ({ ...current, helperPlacement: value as "plugin" | "project_tree" })); setSaved(false); }}>
            <SelectTrigger id="global-placement" aria-label={ru ? "Расположение помощников по умолчанию" : "Default helper placement"} className="min-h-11"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="plugin">{ru ? "В разделе Lane Pilot" : "In Lane Pilot"}</SelectItem><SelectItem value="project_tree">{ru ? "В дереве проекта" : "In the project tree"}</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center">
          <Label htmlFor="global-writer-provider">{t("globalWriterProvider")}</Label>
          <Input id="global-writer-provider" className="min-h-11" value={defaults.writerProviderId ?? ""} onChange={(event) => { setDefaults((current) => ({ ...current, writerProviderId: event.target.value || undefined })); setSaved(false); }} />
        </div>
        <div className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center">
          <Label htmlFor="global-writer-model">{t("globalWriterModel")}</Label>
          <Input id="global-writer-model" className="min-h-11" value={defaults.writerModel ?? ""} onChange={(event) => { setDefaults((current) => ({ ...current, writerModel: event.target.value || undefined })); setSaved(false); }} />
        </div>
        <div className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center">
          <Label htmlFor="global-writer-effort">{t("globalWriterEffort")}</Label>
          <Input id="global-writer-effort" className="min-h-11" value={defaults.writerReasoningEffort ?? ""} onChange={(event) => { setDefaults((current) => ({ ...current, writerReasoningEffort: event.target.value || undefined })); setSaved(false); }} />
        </div>
        <div className="grid gap-2 py-3 md:grid-cols-[minmax(0,1fr)_minmax(11rem,16rem)] md:items-center">
          <Label htmlFor="global-qa-host">{t("globalQaHost")}</Label>
          <Input id="global-qa-host" className="min-h-11" value={defaults.qaHostId ?? ""} onChange={(event) => { setDefaults((current) => ({ ...current, qaHostId: event.target.value || undefined })); setSaved(false); }} />
        </div>
        <p className="py-3 text-xs text-muted-foreground">{ru ? "Источник: общие настройки. Явный выбор проекта имеет приоритет. Применяется при следующем запуске." : "Source: owner defaults. An explicit project choice takes precedence. Applies at the next helper launch."}</p>
      </fieldset>
      <fieldset disabled={busy} hidden={scope !== "agents"} className="space-y-4">
        <div className="flex flex-wrap gap-2"><Input aria-label={ru ? "ID нового профиля" : "New profile ID"} value={newId} placeholder="my-agent" onChange={(event) => setNewId(event.target.value)} /><Button variant="outline" className="min-h-11" disabled={!/^[a-z][a-z0-9-]{0,63}$/.test(newId) || agents.some((item) => item.id === newId)} onClick={() => { setAgents((current) => [...current, { id: newId, description: newId, prompt: "", sourceHash: "", sourceVersion: "lp-owned-1", edited: true }]); setSelected(newId); setNewId(""); }}>{ru ? "Добавить профиль" : "Add profile"}</Button></div>
        <Label htmlFor="owned-agent">{ru ? "Профиль" : "Profile"}</Label>
        <Select value={selected} onValueChange={(value) => { setSelected(value); setSaved(false); }}><SelectTrigger id="owned-agent" className="min-h-11"><SelectValue /></SelectTrigger><SelectContent>{agents.map((item) => <SelectItem key={item.id} value={item.id}>{item.description}</SelectItem>)}</SelectContent></Select>
        {agent ? <>
          <Label htmlFor="agent-description">{ru ? "Название и назначение" : "Name and purpose"}</Label>
          <Input id="agent-description" className="min-h-11" value={agent.description} onChange={(event) => { setAgents((current) => current.map((item) => item.id === selected ? { ...item, description: event.target.value } : item)); setSaved(false); }} />
          <Label htmlFor="agent-prompt">{ru ? "Инструкции" : "Instructions"}</Label>
          <textarea id="agent-prompt" className="min-h-64 w-full rounded-md border border-input bg-background p-3 text-sm" value={agent.prompt} maxLength={32000} onChange={(event) => { setAgents((current) => current.map((item) => item.id === selected ? { ...item, prompt: event.target.value } : item)); setSaved(false); }} />
          {(["tools", "disallowedTools", "skills", "mcpServers"] as const).map((key) => <div key={key} className="space-y-1"><Label htmlFor={`agent-${key}`}>{({ tools: ru ? "Разрешённые инструменты" : "Allowed tools", disallowedTools: ru ? "Запрещённые инструменты" : "Disallowed tools", skills: ru ? "Навыки профиля" : "Profile skills", mcpServers: ru ? "MCP-серверы профиля" : "Profile MCP servers" })[key]}</Label><Input id={`agent-${key}`} className="min-h-11" value={resourceText[`${selected}:${key}`] ?? (agent[key] ?? []).join(", ")} onChange={(event) => { setResourceText((current) => ({ ...current, [`${selected}:${key}`]: event.target.value })); const names = event.target.value.split(",").map((value) => value.trim()).filter(Boolean); setAgents((current) => current.map((item) => item.id === selected ? { ...item, [key]: names } : item)); setSaved(false); }} /></div>)}
          <p className="text-xs text-muted-foreground">{ru ? "Имена через запятую. Это ресурсы native-профиля; строгая изоляция сессии требует отдельной поддержки ядра и учитывает ограничения родителя." : "Comma-separated names. These are native profile resources; strict session isolation requires separate core support and respects the parent ceiling."}</p>
          <details><summary className="min-h-11 cursor-pointer text-sm">{ru ? "? Источник и применение" : "? Source and timing"}</summary><p className="break-all text-xs text-muted-foreground">Lane Pilot · {agent.sourceVersion} · SHA-256 {agent.sourceHash}</p><p className="text-sm">{ru ? "После сохранения инструкции независимы от шаблона. Native MAIN требует поддержки ядра; сохранение профиля не подтверждает её наличие. Выбор модели сессии и потолок разрешений имеют приоритет." : "Once saved, instructions are independent of the template. Native MAIN requires core support; saving a profile does not confirm that support. The session model choice and permission ceiling take precedence."}</p></details>
        </> : null}
      </fieldset>
      <Button className="min-h-11" disabled={busy || (scope === "agents" && (!agent?.prompt.trim() || !agent.description.trim()))} onClick={() => void save()}>{busy ? (ru ? "Сохранение…" : "Saving…") : (ru ? "Сохранить" : "Save")}</Button>
      {saved ? <p role="status" className="text-sm">{ru ? "Сохранено и проверено повторным чтением." : "Saved and verified by readback."}</p> : null}
    </>}
  </section>;
}
