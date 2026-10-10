import { useEffect, useState } from "react";
import { t } from "@lane-pilot/i18n";
import { Button, CONTROL_H, Input, usePanelLayout } from "@lane-pilot/ui-kit";
import { Pill, type LpPage } from "../../ui-shell/ui";
import { SettingsGroup } from "./setting-controls";

type ProviderId = "openlux" | "typesafe";
type Status = { chosen: ProviderId; effective: ProviderId | null; catalog: "ok" | "unavailable"; providers: Array<{ id: ProviderId; keyName: string; model: string; hasKey: boolean }> };
type TestResult = { ok: boolean; provider: ProviderId; model: string | null; latencyMs: number; error: string | null };

const NAME: Record<ProviderId, string> = { openlux: "OpenLux", typesafe: "TypeSafe" };
const HINT: Record<ProviderId, "jevOpenluxHint" | "jevTypesafeHint"> = { openlux: "jevOpenluxHint", typesafe: "jevTypesafeHint" };
const fill = (text: string, values: Record<string, string | number>) => Object.entries(values).reduce((out, [key, value]) => out.replaceAll(`{${key}}`, String(value)), text);
const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);

/** The provider the page shows as chosen: the stored value, the catalog default when it is unset or unknown. */
function chosenOf(page: LpPage): ProviderId {
  const raw = page.displayedValue("jev.provider") ?? page.catalogRow("jev.provider")?.defaultValue;
  return raw === "typesafe" ? "typesafe" : "openlux";
}

/**
 * The Jev block of the global settings: which provider serves Jev, whether each has a key in Env Catalog (a yes or no, the key is
 * never shown), a field to save a key, one test request and a warning when the chosen provider cannot serve.
 */
export function JevProviderPanel({ page }: { page: LpPage }) {
  const { rpc, catalogRow, applySetting } = page;
  const { stackControls } = usePanelLayout();
  const chosen = chosenOf(page);
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState("");
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ openlux: "", typesafe: "" });
  const [saving, setSaving] = useState<ProviderId | null>(null);
  const [saved, setSaved] = useState<ProviderId | null>(null);
  const [saveError, setSaveError] = useState("");
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<string | null>(null);
  const [testOk, setTestOk] = useState(false);

  const load = () => rpc.call("jev_provider_status", {}).then((next) => { setStatus(next as Status); setLoadError(""); }, (cause) => setLoadError(message(cause)));
  useEffect(() => { void load(); }, [rpc]);

  const choose = async (next: ProviderId) => {
    const row = catalogRow("jev.provider");
    if (!row || next === chosen) return;
    setTest(null);
    await applySetting(row, next);
    await load();
  };
  const saveKey = async (provider: ProviderId) => {
    setSaving(provider); setSaved(null); setSaveError("");
    try {
      setStatus(await rpc.call("jev_provider_save_key", { provider, key: keys[provider] }) as Status);
      setKeys((current) => ({ ...current, [provider]: "" }));
      setSaved(provider); setTest(null);
    } catch (cause) { setSaveError(message(cause)); }
    finally { setSaving(null); }
  };
  const runTest = async () => {
    const wanted = status?.providers.find((item) => item.id === chosen);
    if (wanted && !wanted.hasKey) { setTestOk(false); setTest(fill(t("jevTestNoKey"), { name: wanted.keyName })); return; }
    setTesting(true); setTest(null);
    try {
      const result = await rpc.call("jev_provider_test", {}) as TestResult;
      setTestOk(result.ok);
      setTest(result.ok
        ? fill(t("jevTestOk"), { provider: NAME[result.provider], model: result.model ?? "", ms: result.latencyMs })
        : fill(t("jevTestFail"), { error: result.error ?? "", ms: result.latencyMs }));
    } catch (cause) { setTestOk(false); setTest(fill(t("jevTestFail"), { error: message(cause), ms: 0 })); }
    finally { setTesting(false); }
  };

  const chosenKey = status?.providers.find((item) => item.id === chosen);
  const warning = !status ? null
    : status.catalog === "unavailable" ? t("jevWarnCatalog")
    : status.effective === null ? t("jevWarnNone")
    : status.effective !== chosen ? fill(t("jevWarnFallback"), { chosen: NAME[chosen], name: chosenKey?.keyName ?? "" })
    : null;

  return (
    <div data-storage-key="jev.provider">
      <SettingsGroup testId="jev-provider" title={t("jevTitle")}>
        <p className="max-w-xl text-xs text-muted-foreground">{t("jevHelp")}</p>
        {warning ? <p role="alert" data-testid="jev-warning" className="lp-pill-warning break-words rounded-xl px-3 py-2 text-xs">{warning}</p> : null}
        <div className="min-w-0 space-y-2">
          <div className="text-sm font-medium" id="jev-provider-label">{t("jevProviderLabel")}</div>
          <div className="lp-seg flex w-full" role="group" aria-labelledby="jev-provider-label" data-testid="jev-provider-switch">
            {(["openlux", "typesafe"] as const).map((id) => (
              <Button key={id} type="button" variant="ghost" data-testid={`jev-choose-${id}`} aria-pressed={chosen === id}
                className="lp-seg-item h-[1.875rem] min-w-0 flex-1 px-3 hover:bg-transparent aria-pressed:bg-[var(--lp-card)] aria-pressed:hover:bg-[var(--lp-card)]"
                onClick={() => void choose(id)}>{NAME[id]}</Button>
            ))}
          </div>
          {status?.effective ? <p className="text-xs text-muted-foreground" data-testid="jev-serving">{fill(t("jevServing"), { provider: NAME[status.effective] })}</p> : null}
        </div>
        {loadError ? <p role="alert" className="break-words text-xs text-destructive">{fill(t("jevLoadFailed"), { error: loadError })}</p> : null}
        {(["openlux", "typesafe"] as const).map((id) => {
          const info = status?.providers.find((item) => item.id === id);
          const busy = saving === id;
          return (
            <section key={id} className="min-w-0 space-y-2" data-testid={`jev-key-${id}`}>
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <h3 className="min-w-0 text-sm font-medium">{NAME[id]}<span className="ml-2 text-xs font-normal text-muted-foreground">{t(HINT[id])}</span></h3>
                {info ? <Pill tone={info.hasKey ? "success" : "warning"} testId={`jev-key-state-${id}`}>{info.hasKey ? t("jevKeyHas") : t("jevKeyMissing")}</Pill> : null}
              </div>
              <p className="break-all text-xs text-muted-foreground">{info ? `${info.keyName} · ${info.model}` : "…"}</p>
              <div className={stackControls ? "flex min-w-0 flex-col gap-2" : "flex min-w-0 flex-row gap-2"}>
                <Input type="password" autoComplete="new-password" spellCheck={false} className={`${CONTROL_H} min-w-0 w-full`} data-testid={`jev-key-input-${id}`}
                  value={keys[id]} placeholder={t("jevKeyPlaceholder")} aria-label={fill(t("jevKeyField"), { name: info?.keyName ?? NAME[id] })}
                  onChange={(event) => { setKeys((current) => ({ ...current, [id]: event.target.value })); setSaved(null); }}
                  onKeyDown={(event) => { if (event.key === "Enter" && keys[id].trim() && !busy) void saveKey(id); }} />
                <Button type="button" variant="outline" className={`${CONTROL_H} shrink-0`} data-testid={`jev-key-save-${id}`} disabled={busy || !keys[id].trim() || status?.catalog === "unavailable"}
                  onClick={() => void saveKey(id)}>{busy ? t("jevKeySaving") : t("jevKeySave")}</Button>
              </div>
              {saved === id ? <p role="status" className="text-xs lp-text-success" data-testid={`jev-key-saved-${id}`}>{t("jevKeySaved")}</p> : null}
            </section>
          );
        })}
        {saveError ? <p role="alert" className="break-words text-xs text-destructive" data-testid="jev-save-error">{saveError}</p> : null}
        <p className="max-w-xl text-xs text-muted-foreground">{t("jevKeyNote")}</p>
        <div className="flex min-w-0 flex-col gap-2">
          <Button type="button" variant="outline" className={`${CONTROL_H} ${stackControls ? "w-full" : "self-start"}`} data-testid="jev-test" disabled={testing} onClick={() => void runTest()}>{testing ? t("jevTesting") : t("jevTest")}</Button>
          {test ? <p role="status" data-testid="jev-test-result" data-ok={testOk} className={`break-words text-xs ${testOk ? "lp-text-success" : "text-destructive"}`}>{test}</p> : null}
        </div>
      </SettingsGroup>
    </div>
  );
}

/** At a project or section level the provider is not set: the value is the global one, so the page says where to change it. */
export function JevProviderNote({ page }: { page: LpPage }) {
  return (
    <p className="max-w-xl text-xs text-muted-foreground" data-storage-key="jev.provider" data-testid="jev-provider-note">
      {fill(t("jevProjectNote"), { provider: NAME[chosenOf(page)] })}
    </p>
  );
}
