import { experimental_Diff as Diff, experimental_SourceCode as SourceCode } from "@get-bb/plugin-sdk/app";
import { t, unappliedReason } from "@lane-pilot/i18n";
import { settingLabel } from "../../settings/setting-copy";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@lane-pilot/ui-kit";
import { Badge } from "@lane-pilot/ui-kit";
import { Button } from "@lane-pilot/ui-kit";
import { Card, CardContent, CardHeader, CardTitle } from "@lane-pilot/ui-kit";
import { Input } from "@lane-pilot/ui-kit";
import { Label } from "@lane-pilot/ui-kit";
import { EXTERNAL_OPS_BY_ACTION } from "../constants";
import { Disclosure } from "@lane-pilot/ui-kit";
import { Surface, SurfaceBody, SurfaceHeader } from "@lane-pilot/ui-kit";
import { CARD_BODY, CARD_HEAD, COEXISTENCE_MANAGER_KEYS, COEXISTENCE_VALUE_KEYS, compatibilityAliasRows, reasonKey, sectionKey } from "../../ui-shell/ui";
import { FieldControl, StatusBadge, StatusRow } from "../../settings/ui";
import type { LpPage } from "../../ui-shell/ui";

/** The machine and the install of Lane Pilot on it, and the technical details behind the settings. */
export function ServiceSegment({ page }: { page: LpPage }) {
  const { nativeState, data, error, confirmOpen, setConfirmOpen, pendingOp, setPendingOp, snapshotPath, setSnapshotPath, detectResult, resultPatch, resultSource, stackControls, diagnosticsGrouped, writeDraft, applySetting, displayedValue, runStack, hostLabel, nativeHostId, installNative } = page;
  return (
    <>
<section className="space-y-4" data-testid="install-panel">
            <Surface testId="native-install">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("nativeTitle").replace("{host}", hostLabel(nativeHostId))}</h2></SurfaceHeader>
              <SurfaceBody className="space-y-3">
                {!nativeHostId ? <p className="text-sm text-muted-foreground">{t("nativeNoMachine")}</p>
                  : !nativeState ? <p className="text-sm text-muted-foreground">{t("nativeChecking")}</p>
                  : <>
                    <StatusRow testId="native-install-state"
                      state={nativeState.status === "enabled" ? "ok" : nativeState.status === "installing" ? "info" : "todo"}
                      title={nativeState.status === "enabled" ? t("nativeEnabled") : nativeState.status === "installing" ? t("nativeInstalling") : nativeState.status === "offline" ? t("nativeOffline") : t("nativeAbsent")}
                      detail={nativeState.error && nativeState.status !== "enabled" ? <span className="text-destructive">{t("nativeError").replace("{error}", nativeState.error)}</span> : null} />
                    {/* The only action here, and only when the machine answers and Lane Pilot is missing there. */}
                    {nativeState.status !== "enabled" && nativeState.status !== "installing" && nativeState.status !== "offline"
                      ? <Button size="sm" data-testid="native-install-now" onClick={() => void installNative()}>{nativeState.error ? t("nativeRetry") : t("nativeInstallNow")}</Button> : null}
                  </>}
              </SurfaceBody>
            </Surface>
            {data?.legacyStack ? <Disclosure testId="legacy-stack" summary={t("legacyStackTitle")}>
              <p className="text-xs text-muted-foreground">{t("legacyStackHelp")}</p>
              <div className="space-y-2" data-testid="stack-actions">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <Button size="sm" variant="outline" className="w-full sm:w-52" data-testid="stack-detect" onClick={() => void runStack("detect")}>{t("detect")}</Button>
                  <span className="text-xs text-muted-foreground">{t("detectHelp")}</span>
                </div>
                {detectResult && (!detectResult.laneStack.present || !detectResult.matchesTarget) ? <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <Button size="sm" className="w-full sm:w-52" data-testid="install-stack" onClick={() => { setPendingOp("install"); setConfirmOpen(true); }}>{detectResult.laneStack.present ? t("updateStack") : t("install")}</Button>
                  <span className="text-xs text-muted-foreground">{t("installHelp")}</span>
                </div> : null}
                {detectResult?.openCode.present && !detectResult.coexistence?.managers.some((row) => row.manager === "opencode-plugin" && row.configured) ? <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <Button size="sm" variant="outline" className="w-full sm:w-52" data-testid="connect-opencode" onClick={() => { setPendingOp("connect"); setConfirmOpen(true); }}>{t("connectOpencode")}</Button>
                  <span className="text-xs text-muted-foreground">{t("connectHelp")}</span>
                </div> : null}
              </div>
              {detectResult ? <Card data-testid="stack-detect-result">
                <CardHeader className={CARD_HEAD}><CardTitle className="text-sm font-medium">{t("detectResult")}</CardTitle></CardHeader>
                <CardContent className={`${CARD_BODY} grid gap-2 text-sm sm:grid-cols-2`}>
                  <div><span className="text-muted-foreground">{t("detectScenario")}:</span> {detectResult.scenario}</div>
                  <div><span className="text-muted-foreground">{t("detectTargetMatch")}:</span> {detectResult.matchesTarget ? t("yes") : t("no")} ({t("targetMatchInformational")})</div>
                  <div><span className="text-muted-foreground">{t("detectLaneStack")}:</span> {detectResult.laneStack.present ? detectResult.laneStack.version ?? t("unknown") : t("no")}</div>
                  <div><span className="text-muted-foreground">{t("detectOpenCode")}:</span> {detectResult.openCode.present ? `${t("yes")} (${detectResult.openCode.version ?? t("unknown")})` : t("no")}</div>
                </CardContent>
              </Card> : null}
              {detectResult?.coexistence ? <Card data-testid="coexistence-inventory">
                <CardHeader className={CARD_HEAD}><CardTitle className="text-sm font-medium">{t("coexInventory")}</CardTitle></CardHeader>
                <CardContent className={`${CARD_BODY} divide-y divide-border`}>
                  {detectResult.coexistence.managers.map((manager) => (
                    <div key={`${manager.manager}-${manager.path}`} className="space-y-2 py-3 first:pt-0 last:pb-0" data-testid={`coex-${manager.manager}`}>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">{t(COEXISTENCE_MANAGER_KEYS[manager.manager] ?? "coexUnknownManager")}</span>
                        <Badge variant={manager.compatible === false ? "destructive" : manager.decision === "reuse" ? "default" : "outline"}>{t(COEXISTENCE_VALUE_KEYS[manager.decision] ?? "coexDecisionUnknown")}</Badge>
                      </div>
                      <div className="break-all font-mono text-xs">{manager.path}</div>
                      <div className="grid gap-1 text-xs sm:grid-cols-2">
                        <span>{t("coexInstalled")}: {manager.installed ? t("yes") : t("no")}</span>
                        <span>{t("coexConfigured")}: {manager.configured ? t("yes") : t("no")}</span>
                        <span>{t("coexLoaded")}: {manager.loaded === null ? t("coexRuntimeUnverified") : manager.loaded ? t("yes") : t("no")}</span>
                        <span>{t("coexCompatible")}: {manager.compatible === null ? t("unknown") : manager.compatible ? t("yes") : t("no")}</span>
                        <span>{t("coexModified")}: {manager.modified === null ? t("unknown") : manager.modified ? t("yes") : t("no")}</span>
                        <span>{t("coexOwner")}: {t(COEXISTENCE_VALUE_KEYS[manager.owner] ?? "coexOwnerUnknown")}</span>
                        {manager.version ? <span>{t("version")}: {manager.version}</span> : null}
                      </div>
                      {manager.missingCapabilities.length ? <p className="text-xs text-destructive">{t("coexMissingCapabilities")}: {manager.missingCapabilities.join(", ")}</p> : null}
                      <Disclosure compact summary={`${t("coexEvidence")} (${manager.evidence.length})`}>
                        <ul className="space-y-1">{manager.evidence.map((evidence, index) => <li key={`${evidence.kind}-${index}`} className="break-words">{evidence.detail}{evidence.sha256 ? ` · SHA-256 ${evidence.sha256.slice(0, 12)}` : ""}</li>)}</ul>
                      </Disclosure>
                    </div>
                  ))}
                </CardContent>
              </Card> : null}
              {snapshotPath || data.lastSnapshotPath ? <div className="space-y-1 border-t border-[var(--lp-hairline)] pt-3" data-testid="rollback-zone">
                <p className="text-xs font-medium">{t("rollbackTitle")}</p>
                <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
                  <Button size="sm" variant="destructive" className="w-full sm:w-52" data-testid="stack-rollback" onClick={() => { setPendingOp("rollback"); setConfirmOpen(true); }}>{t("rollback")}</Button>
                  <span className="text-xs text-muted-foreground">{t("rollbackHelp")}</span>
                </div>
              </div> : null}
            </Disclosure> : null}
            </section>
            <Disclosure testId="diagnostics-disclosure" summary={t("serviceTechnical")}>
              <div className="space-y-5" data-testid="diagnostics-panel">
            <p className="text-xs text-muted-foreground">{t("diagnosticsIntro")}</p>
            <Card>
              <CardHeader className={CARD_HEAD}><CardTitle className="text-sm font-medium">{t("importDetails")}</CardTitle></CardHeader>
              <CardContent className={`${CARD_BODY} space-y-1 text-xs text-muted-foreground`} data-testid="import-diagnostics">
                {data?.importSource.completed ? <>
                  <p>{t("importRouting")}: {data.importSource.routingPath ?? "—"}</p>
                  <p>{t("importNight")}: {data.importSource.nightPath ?? "—"}</p>
                </> : <p>{t("importNone")}</p>}
                <p>{t("detectWorkspace")}: {data?.workspacePath ?? "—"}</p>
                {data?.lastSnapshotPath ? <p>{t("snapshotBackupFolder")}: {data.lastSnapshotPath}</p> : null}
              </CardContent>
            </Card>

            <Surface testId="writer-trace">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("writerTrace")}</h2></SurfaceHeader>
              <SurfaceBody>
              {data?.lastWriterTrace ? <div className="space-y-1 text-xs">
                <p data-testid="writer-trace-execution">{data.lastWriterTrace.providerId}/{data.lastWriterTrace.model} · {data.lastWriterTrace.effectiveReasoningLevel} · {data.lastWriterTrace.serviceTier ?? "default"}</p>
                <p>{t("writerTraceMode")}: {data.lastWriterTrace.effortMode === "manual" ? t("writerEffortManual") : t("writerEffortAutomatic")}</p>
                <p>{t("writerTraceRequested")}: {data.lastWriterTrace.requestedReasoningLevel}</p>
                {data.lastWriterTrace.fallbackReason ? <p>{t("writerTraceReason")}: {data.lastWriterTrace.fallbackReason}</p> : null}
                {data.lastWriterTrace.selectionSource ? <p>{t("writerTraceSource")}: {data.lastWriterTrace.selectionSource.reasoningLevelSource}</p> : null}
              </div> : <p className="text-xs text-muted-foreground">{t("noDiagnosticData")}</p>}
              </SurfaceBody>
            </Surface>
            <Surface testId="cli-preview">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("cliPreview")}</h2></SurfaceHeader>
              <SurfaceBody>
              {data?.cliPreview ? <pre className="max-h-80 max-w-full overflow-auto rounded-xl border border-[var(--lp-hairline)] bg-[var(--lp-well)] p-3 text-xs text-foreground"><code>{JSON.stringify(data.cliPreview, null, 2)}</code></pre>
                : <p className="text-xs text-muted-foreground">{t("noDiagnosticData")}</p>}
              </SurfaceBody>
            </Surface>

            <Disclosure testId="restore-previous-install" summary={t("restorePreviousInstall")}>
              <p className="max-w-xl text-xs text-muted-foreground">{t("snapshotBackupHelp")}</p>
              <Label htmlFor="snapshot-path">{t("snapshotBackupFolder")}</Label>
              <Input id="snapshot-path" value={snapshotPath} onChange={(event) => setSnapshotPath(event.target.value)} />
            </Disclosure>

            <Surface>
              <SurfaceHeader><h2 className="text-sm font-medium">{t("unapplied")}</h2></SurfaceHeader>
              <SurfaceBody>
              {data?.unapplied.length ? <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
                {data.unapplied.map((item, index) => <li key={`${item.key}:${index}`}>{item.key}: {unappliedReason(item.reason)}</li>)}
              </ul> : <p className="text-xs text-muted-foreground">{t("noUnapplied")}</p>}
              </SurfaceBody>
            </Surface>

            {diagnosticsGrouped.map(({ section, rows }) => <Surface key={section}>
              <SurfaceHeader><h2 className="text-sm font-medium">{t(sectionKey(section))}</h2></SurfaceHeader>
              <SurfaceBody className="space-y-2">
                {rows.map((row) => {
                  const disabled = row.uiStatus !== "editable";
                  const value = data?.values[row.storageKey];
                  return <div key={row.storageKey} data-testid={`field-${row.id}`} data-storage-key={row.storageKey}
                    data-ui-status={row.uiStatus} className={stackControls ? "grid min-w-0 gap-2 py-1" : "grid min-w-0 gap-2 py-1 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)] md:items-center"}>
                    <div className="space-y-1">
                      <Label className="text-sm">{row.storageKey === "writer.fast_mode" ? t("legacyFastMode") : settingLabel(row)}</Label>
                      {row.storageKey === "writer.fast_mode" ? <p className="text-xs text-muted-foreground">{t("legacyFastModeExplanation")}</p> : (
                        disabled ? <p className="text-xs text-muted-foreground">{t(reasonKey(row.id))}</p> : null
                      )}
                      <StatusBadge status={row.uiStatus} />
                      <Disclosure compact summary={t("fieldTechnicalDetails")}>
                        <p>{row.area} · {row.location}</p>
                        <p>{t("casVersion")} {data?.versions[row.storageKey] ?? 0}</p>
                      </Disclosure>
                    </div>
                    {row.storageKey === "writer.fast_mode" ? <code className="text-xs">{String(value ?? "unset")}</code> : (
                      disabled ? <code className="text-xs">{String(value ?? "unset")}</code> : <FieldControl
                        row={row} value={displayedValue(row.storageKey) ?? value} disabled={disabled}
                        onDraft={(next) => { if (!disabled) writeDraft(row.storageKey, next); }}
                        onChange={(next) => { if (!disabled) void applySetting(row, next); }} />
                    )}
                  </div>;
                })}
              </SurfaceBody>
            </Surface>)}

            <Disclosure testId="compat-aliases" summary={t("compatTitle")}>
              <p className="text-xs text-muted-foreground">{t("compatIntro")}</p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {compatibilityAliasRows().map((row) => (
                  <li key={row.id} data-storage-key={row.storageKey} data-testid={`compat-${row.storageKey}`}>
                    {row.storageKey} · {row.setting}
                  </li>
                ))}
              </ul>
            </Disclosure>

            <Surface testId="cli-receipt">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("cliReceipt")}</h2></SurfaceHeader>
              <SurfaceBody className="space-y-3">
              {data?.runs.flatMap((run) => {
                const seen = new Set<string>();
                const items: Array<{ id:string; json:string }> = [];
                for (const attempt of run.attempts) if (attempt.cliReceiptJson && !seen.has(attempt.cliReceiptJson)) {
                  seen.add(attempt.cliReceiptJson); items.push({ id:attempt.id, json:attempt.cliReceiptJson });
                }
                if (run.cliReceiptJson && !seen.has(run.cliReceiptJson)) items.push({ id:run.id, json:run.cliReceiptJson });
                return items.map((item) => <div key={item.id} data-testid={`cli-receipt-${item.id}`}>
                  <h3 className="mb-2 text-xs font-medium">{t("cliReceipt")} {item.id}</h3>
                  <SourceCode content={item.json} path={`cli-receipt-${item.id}.json`} overflow="scroll" />
                </div>);
              })}
              {data?.cliReceiptJson && !data.runs.some((run) => run.cliReceiptJson || run.attempts.some((attempt) => attempt.cliReceiptJson))
                ? <SourceCode content={data.cliReceiptJson} path="cli-receipt.json" overflow="scroll" /> : null}
              </SurfaceBody>
            </Surface>

            {(resultPatch || resultSource) ? <Surface testId="writer-result">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("result")}</h2></SurfaceHeader>
              <SurfaceBody>
              {resultPatch ? <Diff patch={resultPatch} path="writer-output.txt" view="unified" /> : null}
              {resultSource ? <SourceCode content={resultSource} path="acceptance.json" overflow="scroll" /> : null}
              </SurfaceBody>
            </Surface> : null}
            {data?.lastReceiptJson ? <Surface testId="install-receipt">
              <SurfaceHeader><h2 className="text-sm font-medium">{t("installReceipt")}</h2></SurfaceHeader>
              <SurfaceBody>
              <SourceCode content={data.lastReceiptJson} path="install-receipt.json" overflow="scroll" />
              </SurfaceBody>
            </Surface> : null}
              </div>
            </Disclosure>
<AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent
            data-testid="external-ops-dialog"
            className="box-border !left-4 !right-4 !top-1/2 !w-[min(359px,calc(100vw-2rem))] !max-w-[359px] min-w-0 !translate-x-0 !-translate-y-1/2 max-h-[min(80vh,100dvh)] overflow-y-auto overflow-x-hidden p-4 sm:rounded-lg sm:!max-w-[359px]"
          >
            <AlertDialogHeader>
              <AlertDialogTitle className="text-wrap break-words">{t("confirmTitle")}</AlertDialogTitle>
              <AlertDialogDescription className="max-w-full overflow-x-hidden text-left text-wrap break-words">
                {t("confirmList")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {pendingOp === "install" ? (
              <ul className="mt-2 max-w-full list-disc overflow-x-hidden pl-4 text-left text-sm">
                {EXTERNAL_OPS_BY_ACTION.install.map((op) => (
                  <li key={op} className="break-all">{op}</li>
                ))}
              </ul>
            ) : null}
            {pendingOp === "connect" ? (
              <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmConnectOps")}</p>
            ) : null}
            {pendingOp === "rollback" ? (
              <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmRollbackOps")}</p>
            ) : null}
            <p className="mt-2 break-words text-sm text-muted-foreground">{t("confirmBody")}</p>
            <AlertDialogFooter>
              <AlertDialogCancel>{t("confirmCancel")}</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  const op = pendingOp;
                  setConfirmOpen(false);
                  if (op) void runStack(op, true);
                }}
              >
                {t("confirmContinue")}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
    </>
  );
}
