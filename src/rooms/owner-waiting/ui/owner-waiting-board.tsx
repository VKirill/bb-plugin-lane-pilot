import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Button, Disclosure, Input, Switch } from "@lane-pilot/ui-kit";
import type { rpcContract } from "../../contracts";
import type { OwnerAction, OwnerItem, OwnerWaiting } from "../index";

/**
 * «Waiting for you» (SMA D0-3): the one screen of what only the owner can decide. Each item says what it is, why it is his, where the
 * evidence is and the exact action: a button when the plugin already has the RPC (accept or reject a rule), otherwise the command to copy
 * (a deferral's term needs a message of his own, so it is shown as a command and never as a button). Nothing here blocks the work.
 */
type Config = { enabled: boolean; quiet: string; timezone: string };
const POLL_MS = 30_000;
const SECTIONS: Array<{ source: string; title: I18nKey; folded?: boolean }> = [
  { source: "deferral_overdue", title: "ow_section_deferral_overdue" }, { source: "night", title: "ow_section_night" }, { source: "wall", title: "ow_section_wall" },
  { source: "backlog", title: "ow_section_backlog" }, { source: "memory_conflict", title: "ow_section_memory_conflict" }, { source: "rule_proposal", title: "ow_section_rule_proposal" },
  { source: "learning", title: "ow_section_learning" }, { source: "deferral_term", title: "ow_section_deferral_term", folded: true },
];
const fill = (key: I18nKey, values: Record<string, string | number>) => Object.entries(values).reduce((text, [name, value]) => text.replace(`{${name}}`, String(value)), t(key));
/** An attempt id is long and the same prefix every time: its first eight characters tell it apart, the whole id stays in the tooltip. */
const shortRef = (kind: string, ref: string) => (kind === "attempt" ? ref.replace(/^[a-z]+_/, "").slice(0, 8) : ref);
const FOLD_OVER = 8;
const chip = "inline-flex max-w-full items-center gap-1 break-all rounded-md border border-border px-1.5 text-[11px] leading-5 text-muted-foreground";

function CommandLine({ action, itemKey }: { action: OwnerAction; itemKey: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(action.cli).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => undefined);
  };
  return (
    <div className="min-w-0 space-y-1" data-testid={`owner-command-${itemKey}-${action.id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="font-medium">{action.label}</span>
        {action.needsOwnerMessage ? <span className={chip}>{t("ow_needs_message")}</span> : null}
      </div>
      <div className="flex min-w-0 items-start gap-2">
        <code className="min-w-0 flex-1 break-all rounded bg-secondary/60 px-2 py-1 text-[11px] leading-5">{action.cli}</code>
        <Button type="button" size="sm" variant="outline" className="h-7 shrink-0 px-2 text-xs" onClick={copy}>{copied ? t("ow_copied") : t("ow_copy")}</Button>
      </div>
      {action.hint ? <Disclosure summary={<span className="text-[11px] text-muted-foreground">{t("ow_how")}</span>} compact><p className="pt-1 text-[11px] leading-4 text-muted-foreground">{action.hint}</p></Disclosure> : null}
    </div>
  );
}

function ItemCard({ item, projectName, busy, onRun }: { item: OwnerItem; projectName: string | null; busy: boolean; onRun: (action: OwnerAction) => void }) {
  const buttons = item.actions.filter((action) => action.rpc);
  const commands = item.actions.filter((action) => !action.rpc);
  return (
    <li className="min-w-0 space-y-2 border-b border-border px-3.5 py-3 last:border-b-0" data-testid={`owner-item-${item.key}`}>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <p className="min-w-0 break-words text-sm font-medium">{item.what}</p>
        {projectName ? <span className="shrink-0 text-xs text-muted-foreground">{projectName}</span> : null}
      </div>
      <p className="text-xs leading-5 text-muted-foreground"><span className="font-medium text-foreground">{t("ow_why")}:</span> {item.why}</p>
      {item.evidence.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-testid={`owner-evidence-${item.key}`}>
          <span className="text-xs text-muted-foreground">{t("ow_evidence")}:</span>
          {item.evidence.map((evidence, index) => <span key={`${evidence.kind}${index}`} className={chip} title={`${evidence.ref}${evidence.label ? ` (${evidence.label})` : ""}`}>{evidence.kind}: {shortRef(evidence.kind, evidence.ref)}{evidence.label ? ` (${evidence.label})` : ""}</span>)}
        </div>
      ) : null}
      {buttons.length ? (
        <div className="flex flex-wrap gap-2">
          {buttons.map((action) => (
            <Button key={action.id} type="button" size="sm" variant={action.id === "accept" ? "default" : "outline"} disabled={busy} data-testid={`owner-run-${item.key}-${action.id}`} onClick={() => onRun(action)}>{action.label}</Button>
          ))}
        </div>
      ) : null}
      {commands.length ? <div className="space-y-2">{commands.map((action) => <CommandLine key={action.id} action={action} itemKey={item.key} />)}</div> : null}
      {buttons.length ? (
        <Disclosure summary={<span className="text-[11px] text-muted-foreground">{t("ow_action")}: CLI</span>} compact>
          <div className="space-y-2 pt-1">{buttons.map((action) => <CommandLine key={action.id} action={action} itemKey={item.key} />)}</div>
        </Disclosure>
      ) : null}
    </li>
  );
}

function PushSettings() {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<Config | null>(null);
  useEffect(() => { void rpc.call("owner_waiting_config", {}).then((value) => setConfig(value as Config)).catch(() => undefined); }, [rpc]);
  if (!config) return null;
  const save = async (patch: Record<string, string>) => {
    try { setConfig(await rpc.call("owner_waiting_config", { patch }) as Config); toast.success(t("ow_push_saved")); }
    catch (cause) { toast.error(t("ow_action_failed"), { description: cause instanceof Error ? cause.message : String(cause) }); }
  };
  return (
    <section className="space-y-2 rounded-lg border border-border p-3.5" data-testid="owner-push">
      <div><h3 className="text-sm font-semibold">{t("ow_push")}</h3><p className="text-xs text-muted-foreground">{t("ow_push_help")}</p></div>
      <label className="flex items-center gap-2 text-sm"><Switch checked={config.enabled} onCheckedChange={(on) => void save({ enabled: on ? "on" : "off" })} data-testid="owner-push-enabled" />{t("ow_push_on")}</label>
      <div className="flex flex-wrap gap-3">
        <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground basis-40">{t("ow_push_quiet")}
          <Input className="h-8" defaultValue={config.quiet} data-testid="owner-push-quiet" onBlur={(event) => { if (event.target.value !== config.quiet) void save({ quiet: event.target.value }); }} />
        </label>
        <label className="min-w-0 flex-1 space-y-1 text-xs text-muted-foreground basis-40">{t("ow_push_zone")}
          <Input className="h-8" defaultValue={config.timezone} data-testid="owner-push-zone" onBlur={(event) => { if (event.target.value !== config.timezone) void save({ timezone: event.target.value }); }} />
        </label>
      </div>
    </section>
  );
}

export function OwnerWaitingBoard({ projects }: { projects: Array<{ id: string; name: string }> }) {
  const rpc = useRpc<typeof rpcContract>();
  const [waiting, setWaiting] = useState<OwnerWaiting | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setWaiting(await rpc.call("owner_waiting", {}) as OwnerWaiting); setFailed(false); } catch { setFailed(true); }
  }, [rpc]);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  const run = async (item: OwnerItem, action: OwnerAction) => {
    if (!action.rpc) return;
    setBusy(item.key);
    try {
      await (rpc.call as (method: string, input: unknown) => Promise<unknown>)(action.rpc.method, action.rpc.input);
      toast.success(t("ow_done"));
      await load();
    } catch (cause) {
      toast.error(t("ow_action_failed"), { description: cause instanceof Error ? cause.message : String(cause) });
    } finally { setBusy(null); }
  };
  const projectName = (id: string | null) => (id ? projects.find((project) => project.id === id)?.name ?? id : null);
  const items = waiting?.items ?? [];
  const known = new Set(SECTIONS.map((section) => section.source));
  const sections = [...SECTIONS, ...[...new Set(items.filter((item) => !known.has(item.source)).map((item) => item.source))].map((source) => ({ source, title: null as I18nKey | null, folded: false }))];
  return (
    <div className="space-y-4" data-testid="owner-waiting">
      <div className="min-w-0">
        <h2 className="text-lg font-semibold">{t("ow_title")} <span className="text-sm font-normal text-muted-foreground" data-testid="owner-count">{items.length}</span></h2>
        <p className="text-sm text-muted-foreground">{t("ow_help")}</p>
      </div>
      {failed && !waiting ? <p role="alert" className="text-sm text-destructive">{t("ow_failed")}</p> : null}
      {!waiting && !failed ? <p className="text-sm text-muted-foreground">{t("ow_loading")}</p> : null}
      {waiting ? (
        <section className="space-y-1 rounded-lg border border-border p-3.5 text-sm" data-testid="owner-overnight">
          <h3 className="text-xs font-semibold text-muted-foreground">{t("ow_overnight")}</h3>
          <p data-testid="owner-red"><span className="font-medium">{t("ow_red")}:</span> {waiting.overnight.red.length
            ? waiting.overnight.red.map((row) => `${row.state} ${row.count}`).join(", ") : t("ow_red_none")}</p>
          {waiting.overnight.red.some((row) => row.attempts.length) ? (
            <div className="flex flex-wrap gap-1.5">{waiting.overnight.red.flatMap((row) => row.attempts).map((id) => <span key={id} className={chip} title={id}>attempt: {shortRef("attempt", id)}</span>)}</div>
          ) : null}
          <p data-testid="owner-accepted">{fill("ow_accepted", { n: waiting.overnight.accepted, adopted: waiting.overnight.rulesAdopted, confirmed: waiting.overnight.rulesConfirmed })}</p>
        </section>
      ) : null}
      {waiting && !items.length ? <p className="text-sm text-muted-foreground" data-testid="owner-empty">{t("ow_empty")}</p> : null}
      {sections.map((section) => {
        const rows = items.filter((item) => item.source === section.source);
        if (!rows.length) return null;
        const title = section.title ? t(section.title) : section.source;
        const list = (
          <ul className="overflow-hidden rounded-lg border border-border bg-card" data-testid={`owner-list-${section.source}`}>
            {rows.map((item) => <ItemCard key={item.key} item={item} projectName={projectName(item.projectId)} busy={busy === item.key} onRun={(action) => void run(item, action)} />)}
          </ul>
        );
        return (
          <section key={section.source} className="space-y-2" data-testid={`owner-section-${section.source}`}>
            {(section.folded || rows.length > FOLD_OVER) && !rows.some((item) => item.wake) ? (
              <Disclosure summary={<span className="text-sm font-semibold">{title} <span className="font-normal text-muted-foreground">{rows.length}</span></span>}>{list}</Disclosure>
            ) : (
              <>
                <h3 className="text-sm font-semibold">{title} <span className="font-normal text-muted-foreground">{rows.length}</span></h3>
                {list}
              </>
            )}
          </section>
        );
      })}
      <PushSettings />
    </div>
  );
}

/** The number next to the screen's name in the rail; nothing while it is 0 or cannot be read. */
export function OwnerWaitingBadge() {
  const rpc = useRpc<typeof rpcContract>();
  const [count, setCount] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () => { void rpc.call("owner_waiting", {}).then((value) => { if (live) setCount((value as OwnerWaiting).items.length); }).catch(() => undefined); };
    read();
    const timer = setInterval(read, 60_000);
    return () => { live = false; clearInterval(timer); };
  }, [rpc]);
  return count ? <span className="ml-1.5 rounded-full bg-secondary px-1.5 text-[11px] leading-5 text-muted-foreground" data-testid="owner-badge">{count}</span> : null;
}
