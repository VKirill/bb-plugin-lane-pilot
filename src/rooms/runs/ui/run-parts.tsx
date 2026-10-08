import { useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../../contracts";
import { t, stateLabel } from "@lane-pilot/i18n";
import { Badge } from "@lane-pilot/ui-kit";
import { StageResult } from "./stage-result";
import { Disclosure } from "@lane-pilot/ui-kit";
import { StageSummary, runTone, stageTitle } from "../../ui-shell/ui";

/** The stage receipts of a run: the screen carries only their count, the rows load when the list is opened. */
export function RunStages({ runId, count }: { runId: string; count: number }) {
  const rpc = useRpc<typeof rpcContract>();
  const [stages, setStages] = useState<StageSummary[] | "failed" | null>(null);
  const open = (isOpen: boolean) => {
    if (!isOpen) return;
    void rpc.call("list_run_stages", { runId }).then((listed) => setStages(listed.stages as StageSummary[])).catch(() => setStages("failed"));
  };
  return <Disclosure compact testId={`stage-receipts-${runId}`} summary={`${t("stageReceipts")} (${count})`} onToggle={open}>
    {stages === null ? <p className="text-xs text-muted-foreground">{t("stageResultLoading")}</p>
      : stages === "failed" ? <p className="text-xs text-muted-foreground">{t("stageResultFailed")}</p>
        : <div className="divide-y divide-border">
          {stages.map((stage) => (
            <div key={`${stage.taskId}-${stage.stageId}`} className="space-y-2 py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{stageTitle(stage.stageId)}</span>
                <Badge variant={runTone(stage.state)}>{stateLabel(stage.state)}</Badge>
              </div>
              <div className="break-all font-mono text-xs text-muted-foreground">{stage.taskId} · SHA-256 {stage.inputSha256.slice(0, 12)}{stage.outputSha256 ? ` / ${stage.outputSha256.slice(0, 12)}` : ""}</div>
              {stage.reason ? <p className="text-xs text-muted-foreground">{t("stageReason")}: {stage.reason}</p> : null}
              {stage.hasResult ? <StageResult runId={runId} taskId={stage.taskId} stageId={stage.stageId} /> : null}
              {!stage.hasResult && !stage.reason ? <p className="text-xs text-muted-foreground">{t("stageNoEvidence")}</p> : null}
            </div>
          ))}
        </div>}
  </Disclosure>;
}
