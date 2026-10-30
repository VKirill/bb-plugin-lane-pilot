import { useState } from "react";

import type { rpcContract } from "../../contracts";
import type { StageCell, TaskSummary } from "../logic";
import { fill, stageName, stageState } from "./format";
import { useLpRpcQuery } from "../../ui-shell/ui";

const COLOR: Record<StageCell["state"], string> = {
  passed: "bg-[var(--color-success,#16a34a)]",
  failed: "bg-destructive",
  running: "animate-pulse bg-[var(--color-attention,#d97706)]",
  pending: "border border-border bg-transparent",
  skipped: "bg-muted-foreground/25",
  canceled: "bg-muted-foreground/45",
};

/** One square per stage that ran, in the pipeline's order; a stage that took more than one round carries the count. */
export function StageStrip({ cells, testId = "stage-strip" }: { cells: readonly StageCell[]; testId?: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-[3px] pr-1.5 pt-1" data-testid={testId}>
      {cells.map((cell) => (
        <span key={cell.stageId} data-stage={cell.stageId} data-state={cell.state}
          title={`${stageName(cell.stageId)}: ${stageState(cell.state)} · ${fill("graphRounds", { n: cell.rounds, f: cell.failures })}${cell.reason ? `\n${cell.reason}` : ""}`}
          className={`relative inline-block size-3.5 shrink-0 rounded-[3px] ${COLOR[cell.state]}`}>
          {cell.rounds > 1 ? (
            <span className="absolute -right-1.5 -top-1.5 min-w-[11px] rounded-full bg-card px-[2px] text-center text-[9px] font-semibold leading-[11px] text-foreground ring-1 ring-border">{cell.rounds}</span>
          ) : null}
        </span>
      ))}
    </span>
  );
}

export type Strip = { cells: StageCell[]; summary: TaskSummary };
const POLL_MS = 15_000;

/** The cells of the given tasks (`runId:taskId`), read again every 15 s while the list is open. */
export function useStageStrips(keys: ReadonlyArray<{ runId: string; taskId: string }>): Record<string, Strip> {
  return (useLpRpcQuery("work_graph_strips", { keys: keys.slice(0, 300).map(({ runId, taskId }) => ({ runId, taskId })) }, { pollMs: POLL_MS, enabled: keys.length > 0 }).data ?? {}) as Record<string, Strip>;
}
