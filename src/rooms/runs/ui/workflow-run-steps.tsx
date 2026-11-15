import { useState } from "react";
import { useBbNavigate, useRpc } from "@get-bb/plugin-sdk/app";
import { t, type I18nKey, type Locale } from "@lane-pilot/i18n";
import { Disclosure } from "@lane-pilot/ui-kit";
import type { z } from "zod";
import type { rpcContract } from "../../contracts";

type Snapshot = NonNullable<z.infer<(typeof rpcContract)["workflow_run_snapshot"]["output"]>["snapshot"]>;
type Step = Snapshot["steps"][number];

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const clock = (ms: number | null, locale: Locale) =>
  ms === null ? null : new Date(ms).toLocaleTimeString(locale === "ru" ? "ru-RU" : "en-US", { hour: "2-digit", minute: "2-digit" });
// Engine step states (succeeded, canceled, waiting) are not task-stage states; the same stage_state_* keys with a raw fallback.
const stepState = (state: string) => { const key = `stage_state_${state}` as I18nKey; const text = t(key); return !text || text === key ? state : text; };

/**
 * What a workflow card's steps produced: the same bounded, redacted `workflow_run_snapshot` the Workflows screen reads,
 * fetched only when the owner opens the disclosure — handoff, error and output per step plus the thread that ran it.
 */
export function WorkflowRunSteps({ runId, locale }: { runId: string; locale: string }) {
  const loc: Locale = locale === "ru" ? "ru" : "en";
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [snapshot, setSnapshot] = useState<Snapshot | "failed" | null>(null);
  const open = (isOpen: boolean) => {
    if (!isOpen || snapshot !== null) return;
    void rpc.call("workflow_run_snapshot", { runId }).then((result) => setSnapshot(result.snapshot ?? "failed")).catch(() => setSnapshot("failed"));
  };
  const nodes = snapshot !== null && snapshot !== "failed" ? new Map(snapshot.graph.nodes.map((node) => [node.id, node])) : null;
  return (
    <Disclosure compact testId={`wf-run-steps-${runId}`} summary={t("boardStepResults")} onToggle={open} className="mt-3">
      {snapshot === null ? <p className="px-2 pb-2 text-xs text-muted-foreground">{t("stageResultLoading")}</p>
        : snapshot === "failed" ? <p className="px-2 pb-2 text-xs text-muted-foreground">{t("stageResultFailed")}</p>
        : <ol className="space-y-3 pb-1 pt-2" data-testid="wf-run-step-details">
          {snapshot.steps.map((step) => {
            const node = nodes?.get(step.nodeId);
            const start = clock(step.startedAt, loc);
            const end = clock(step.endedAt, loc);
            const span = start && end ? `${start}–${end}` : end ?? start;
            return (
              <li key={step.key} className="space-y-1">
                <div className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-medium">{node ? node.title?.[loc] ?? node.label ?? step.nodeId : step.nodeId}</span>
                  {step.visit > 1 ? <span className="text-xs text-muted-foreground">#{step.visit}</span> : null}
                  {step.attempt > 1 ? <span className="text-xs text-muted-foreground">×{step.attempt}</span> : null}
                  <span className="text-xs text-muted-foreground">{stepState(step.state)}</span>
                  <span className="font-mono text-[11px] text-muted-foreground">{step.key}</span>
                  {span ? <span className="text-xs text-muted-foreground">{span}</span> : null}
                </div>
                {step.handoff ? <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{clip(step.handoff, 1200)}</p> : null}
                {step.error ? <p className="break-words text-xs text-muted-foreground">{clip(step.error, 500)}</p> : null}
                {step.output ? (
                  <Disclosure compact summary={t("tokenUsageOutput")}>
                    <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(step.output, null, 2)}</pre>
                  </Disclosure>
                ) : null}
                {step.threadId ? (
                  <button type="button" className="text-xs text-muted-foreground underline decoration-input underline-offset-2 hover:decoration-current" onClick={() => navigate.toThread(step.threadId!)}>{t("boardOpenThread")}</button>
                ) : null}
              </li>
            );
          })}
        </ol>}
    </Disclosure>
  );
}
