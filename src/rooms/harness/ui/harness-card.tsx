import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { rpcContract } from "../../contracts";
import { t, type I18nKey } from "@lane-pilot/i18n";
import { Badge } from "@lane-pilot/ui-kit";
import { Button } from "@lane-pilot/ui-kit";
import { Disclosure } from "@lane-pilot/ui-kit";
import { Switch } from "@lane-pilot/ui-kit";
import { useLpRealtime } from "../../ui-shell/ui";

type Arm = { attempts: number; acceptanceRate: number };
type Status = {
  config: { enabled: boolean; minAttempts: number; windowDays: number; maxKeysPerNight: number; editor: { providerId: string; model: string; reasoningLevel: string } };
  keys: Array<{ area: string; writerKey: string; attempts: number }>;
  active: Array<{ id: string; area: string; writerKey: string; state: "base" | "adopted"; version: number; inventory: string; tree: Record<string, string> }>;
  trials: Array<{ id: string; area: string; writerKey: string; since: number | null; decision: { action: string; reason: string; arms: { new: Arm; old: Arm } } }>;
  retired: Array<{ id: string; area: string; writerKey: string; reason: string | null; decidedAt: number | null }>;
  running: string[];
};

const message = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const pct = (rate: number) => `${Math.round(rate * 100)}%`;

/** The writer harness that learns, for one project: trials, trees in force, keys with attempts; run the editor, judge trials, switch editing on or off. */
export function HarnessCard({ projectId }: { projectId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setStatus(await rpc.call("harness_status", { projectId }) as Status); setError(null); }
    catch (cause) { setError(message(cause)); }
  }, [projectId, rpc]);

  useEffect(() => { setStatus(null); void load(); }, [load]);
  useLpRealtime(projectId, ["harness"], () => { void load(); });

  const act = async (name: string, run: () => Promise<void>) => {
    setBusy(name); setNote(null);
    try { await run(); setError(null); }
    catch (cause) { setError(message(cause)); toast.error(t("harnessFailed"), { description: message(cause) }); }
    finally { setBusy(null); }
  };
  const runEditor = (key: { area: string; writerKey: string }) => act(`edit:${key.area}:${key.writerKey}`, async () => {
    const result = await rpc.call("harness_edit", { projectId, area: key.area, writerKey: key.writerKey, wait: false }) as { status?: string; detail?: string };
    setNote(`${t("harnessEditStarted")}: ${result.status ?? ""}${result.detail ? ` — ${result.detail}` : ""}`);
    await load();
  });
  const judge = () => act("judge", async () => {
    const result = await rpc.call("harness_tick", { projectId, dryRun: false }) as { trials?: unknown[] };
    setNote(`${t("harnessJudged")}: ${result.trials?.length ?? 0}`);
    await load();
  });
  const toggle = (enabled: boolean) => act("enabled", async () => {
    await rpc.call("harness_configure", { projectId, patch: { enabled } });
    await load();
  });

  const areaLabel = (area: string) => area || t("harnessWholeProject");
  const cfg = status?.config;
  const arm = (label: I18nKey, value: Arm) => `${t(label)} ${value.attempts} ${t("harnessAttempts")}, ${t("harnessAccepted")} ${pct(value.acceptanceRate)}`;

  return (
    <section className="space-y-3" data-testid="harness-card">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("harnessTitle")}</h3>
        <p className="max-w-xl text-xs text-muted-foreground">{t("harnessHelp")}</p>
      </div>
      {error ? <p className="max-w-xl text-xs lp-text-warning" style={{ overflowWrap: "anywhere" }} data-testid="harness-error">{t("harnessFailed")}: {error}</p> : null}
      {note ? <p className="max-w-xl text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }} data-testid="harness-note">{note}</p> : null}

      {cfg ? (
        <div className="max-w-xl space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={cfg.enabled} disabled={busy !== null} onCheckedChange={(next) => void toggle(next)} aria-label={t("harnessEnabled")} data-testid="harness-enabled" />
            {t("harnessEnabled")}
          </label>
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground" style={{ overflowWrap: "anywhere" }} data-testid="harness-config">
            <span>{t("harnessMinAttempts")}: {cfg.minAttempts}</span>
            <span>{t("harnessWindowDays")}: {cfg.windowDays}</span>
            <span>{t("harnessMaxKeys")}: {cfg.maxKeysPerNight}</span>
            <span>{t("harnessEditorModel")}: {cfg.editor.model} ({cfg.editor.reasoningLevel})</span>
          </div>
        </div>
      ) : null}

      {status ? (
        <>
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-medium">{t("harnessTrials")}</span>
              <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => void judge()}>{t("harnessJudge")}</Button>
            </div>
            {status.trials.length === 0 ? <p className="text-xs text-muted-foreground">{t("harnessNoTrials")}</p> : null}
            {status.trials.map((trial) => (
              <div key={trial.id} className="lp-card max-w-xl space-y-1 p-3 text-xs" data-testid={`harness-trial-${trial.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{areaLabel(trial.area)}</span>
                  <span className="font-mono text-muted-foreground">{trial.writerKey}</span>
                  <Badge variant="secondary">{trial.decision.action}</Badge>
                  {trial.since ? <span className="text-muted-foreground">{t("harnessSince")} {new Date(trial.since).toLocaleDateString()}</span> : null}
                </div>
                <p className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>{trial.decision.reason}</p>
                <p className="text-muted-foreground">{arm("harnessArmNew", trial.decision.arms.new)} · {arm("harnessArmOld", trial.decision.arms.old)}</p>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium">{t("harnessActive")}</div>
            {status.active.length === 0 ? <p className="text-xs text-muted-foreground">{t("harnessNoActive")}</p> : null}
            {status.active.map((row) => {
              const files = Object.entries(row.tree);
              return (
                <div key={row.id} className="lp-card max-w-xl space-y-1 p-3 text-xs" data-testid={`harness-tree-${row.id}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{areaLabel(row.area)}</span>
                    <span className="font-mono text-muted-foreground">{row.writerKey}</span>
                    <Badge variant={row.state === "adopted" ? "secondary" : "outline"}>{t(`harnessState_${row.state}` as I18nKey)}</Badge>
                    <span className="text-muted-foreground">{t("harnessVersion")} {row.version}</span>
                  </div>
                  <p className="text-muted-foreground" style={{ overflowWrap: "anywhere" }}>{row.inventory}</p>
                  {files.length > 0 ? (
                    <Disclosure compact summary={`${t("harnessFiles")} (${files.length})`}>
                      <div className="space-y-2">
                        {files.map(([rel, content]) => (
                          <div key={rel} className="min-w-0">
                            <div className="font-mono" style={{ overflowWrap: "anywhere" }}>{rel}</div>
                            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border border-[var(--lp-outline)] p-2 text-[11px]" style={{ overflowWrap: "anywhere" }}>{content}</pre>
                          </div>
                        ))}
                      </div>
                    </Disclosure>
                  ) : <p className="text-muted-foreground">{t("harnessEmptyTree")}</p>}
                </div>
              );
            })}
          </div>

          <div className="space-y-2">
            <div className="text-xs font-medium">{t("harnessKeys")}</div>
            {status.keys.length === 0 ? <p className="text-xs text-muted-foreground">{t("harnessNoKeys")}</p> : null}
            {status.keys.map((key) => {
              const name = `edit:${key.area}:${key.writerKey}`;
              const running = status.running.includes(`${projectId}:${key.area}:${key.writerKey}`);
              return (
                <div key={`${key.area}|${key.writerKey}`} className="flex max-w-xl flex-wrap items-center justify-between gap-2 text-xs" data-testid={`harness-key-${key.area}-${key.writerKey}`}>
                  <span className="min-w-0" style={{ overflowWrap: "anywhere" }}>
                    <span className="font-medium">{areaLabel(key.area)}</span> <span className="font-mono text-muted-foreground">{key.writerKey}</span> · {key.attempts} {t("harnessAttempts")}
                  </span>
                  <Button size="sm" variant="outline" disabled={busy !== null || running} onClick={() => void runEditor(key)}>
                    {busy === name || running ? t("harnessEditorRunning") : t("harnessRunEditor")}
                  </Button>
                </div>
              );
            })}
          </div>
        </>
      ) : null}
    </section>
  );
}
