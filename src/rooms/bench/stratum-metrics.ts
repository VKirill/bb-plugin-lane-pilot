import { issueQuickModelCalls } from "../workflow";

export type StratumRow = {
  taskId: string;
  stratum: string;
  accepted: boolean;
  seconds: number | null;
  tokens: number | null;
  /** Stage ids in order. The writer stage ends the count of model calls before it. */
  stages?: readonly { stageId: string }[];
};

export type StratumMetric = {
  stratum: string;
  tasks: number;
  accepted: number;
  /** Median seconds of the accepted tasks. Null when none was accepted. */
  secondsToAccept: number | null;
  /** Median model stages before the writer. Null when no row recorded stages. */
  callsBeforeWriter: number | null;
  /** Sum of measured tokens. Null when none was measured. */
  tokens: number | null;
};

const WRITER = /^(write|write-medium|writer|build)$/;

export function callsBeforeWriter(stages: readonly { stageId: string }[]): number {
  const at = stages.findIndex((stage) => WRITER.test(stage.stageId));
  return (at < 0 ? stages : stages.slice(0, at)).length;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : Math.round((sorted[mid - 1]! + sorted[mid]!) / 2);
}

/** Time to acceptance, model calls before the writer, and tokens, one row per stratum. */
export function stratumMetrics(rows: readonly StratumRow[]): StratumMetric[] {
  const keys = [...new Set(rows.map((row) => row.stratum))];
  return keys.map((stratum) => {
    const group = rows.filter((row) => row.stratum === stratum);
    const accepted = group.filter((row) => row.accepted);
    const staged = group.flatMap((row) => row.stages ? [callsBeforeWriter(row.stages)] : []);
    const tokens = group.flatMap((row) => row.tokens === null ? [] : [row.tokens]);
    return {
      stratum, tasks: group.length, accepted: accepted.length,
      secondsToAccept: median(accepted.flatMap((row) => row.seconds === null ? [] : [row.seconds])),
      callsBeforeWriter: median(staged),
      tokens: tokens.length ? tokens.reduce((sum, value) => sum + value, 0) : null,
    };
  });
}

export function renderStratumMetrics(rows: readonly StratumMetric[], settings?: Record<string, unknown> | null): string {
  const lines = rows.map((row) => {
    const time = row.secondsToAccept === null ? "no acceptance" : `${row.secondsToAccept}s to accept`;
    const calls = row.callsBeforeWriter === null ? "calls not measured" : `${row.callsBeforeWriter} model calls before the writer`;
    const tokens = row.tokens === null ? "tokens not measured" : `${row.tokens} tokens`;
    return `${row.stratum}: ${row.tasks} tasks, accepted ${row.accepted}, ${time}, ${calls}, ${tokens}`;
  });
  if (settings && rows.some((row) => row.stratum === "small")) {
    const path = issueQuickModelCalls(settings) === 1 ? "short path" : "old issue-quick";
    lines.push(`small path: ${path}, ${issueQuickModelCalls(settings)} model calls before the writer`);
  }
  return lines.join("\n");
}
