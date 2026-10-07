import type { StageReceiptRow } from "../database";

/**
 * What the PM reads in the chat after lane_pilot_dispatch_writer and lane_pilot_wait_writer: a receipt (state, ids, one
 * line per stage, paths, next), not the stored stage results. The stored result of a stage (a critique with its findings
 * and raw model output, the pm-read packet) went into every reply and was 95 % of it (median 6.8k chars, p90 14.7k).
 * The full result is one call away: lane_pilot_wait_writer with `stage` (see stageDetail).
 */

/** Stages of the writer that exist from the dispatch on as «pending» rows; the reply's state says the same. */
const WRITER_PLACEHOLDERS = new Set(["writer-agent", "verification", "acceptance-receipt"]);

const clipText = (text: string, size: number): string => (text.length > size ? `${text.slice(0, size)}… [${text.length - size} more chars]` : text);
const asRecord = (value: unknown): Record<string, unknown> | null => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** One line saying what a finished stage found: the critics' decision with the finding count, pm-read's fact count. */
export function stageVerdict(stage: Pick<StageReceiptRow, "stageId" | "result">): string | undefined {
  const result = asRecord(stage.result);
  if (!result) return undefined;
  if (stage.stageId === "pm-read") {
    const facts = Array.isArray(result.keyFacts) ? result.keyFacts.length : null;
    const questions = Array.isArray(result.openQuestions) ? result.openQuestions.length : null;
    return facts === null && questions === null ? undefined : `${facts ?? 0} facts, ${questions ?? 0} open questions`;
  }
  const decision = typeof result.decision === "string" ? result.decision : typeof result.status === "string" ? result.status : null;
  if (!decision) return undefined;
  const findings = Array.isArray(result.findings) ? result.findings : Array.isArray(result.risks) ? result.risks : [];
  const summary = typeof result.summary === "string" && result.summary.trim() ? `: ${clipText(oneLine(result.summary), 160)}` : "";
  return `${decision}${findings.length ? ` (${findings.length} finding${findings.length === 1 ? "" : "s"})` : ""}${summary}`;
}

/** The stages of one task as `{stageId, state, reason?, verdict?}`. */
export function compactStages(stages: StageReceiptRow[]): Array<Record<string, unknown>> {
  return stages
    .filter((stage) => !(WRITER_PLACEHOLDERS.has(stage.stageId) && stage.state === "pending"))
    .map((stage) => {
      const verdict = stageVerdict(stage);
      return {
        stageId: stage.stageId, state: stage.state,
        ...(stage.reason ? { reason: clipText(stage.reason, 600) } : {}),
        ...(verdict ? { verdict } : {}),
      };
    });
}

/** A dispatch answer with `stages` as a receipt. Every other field (state, ids, warnings, pmReadOpenQuestions, notes) stays. */
export function compactDispatchReply(reply: Record<string, unknown>): Record<string, unknown> {
  const stages = reply.stages;
  if (!Array.isArray(stages)) return reply;
  const rows = stages as StageReceiptRow[];
  const { stages: _full, ...rest } = reply;
  return { ...rest, stages: compactStages(rows) };
}

/** Parts of an acceptance receipt the PM never acts on: the PM sent them, or they sit in the file at `acceptancePath`. */
const RECEIPT_DROPPED = ["acceptance", "runV2", "readFirst", "ownsPaths", "pmThreadId", "schemaVersion"] as const;

function compactVerification(rows: unknown): unknown {
  if (!Array.isArray(rows)) return rows;
  return rows.map((row) => {
    const check = asRecord(row);
    if (!check) return row;
    const failed = check.exitCode !== 0;
    const tail = failed ? `${String(check.stderr ?? "")}\n${String(check.stdout ?? "")}`.trim().slice(-400) : "";
    return { command: check.command, exitCode: check.exitCode, ...(check.hostError ? { hostError: true } : {}), ...(tail ? { tail } : {}) };
  });
}

function compactOneReceipt(receipt: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...receipt };
  for (const key of RECEIPT_DROPPED) delete out[key];
  if ("verification" in out) out.verification = compactVerification(out.verification);
  if (typeof out.output === "string") out.output = clipText(out.output, 600);
  if (out.emergencyFallback === null) delete out.emergencyFallback;
  return out;
}

/** The acceptance receipt of a wait answer, one task or `{ tasks: [...] }`, without the acceptance record and the check logs. */
export function compactReceipt(receipt: unknown): unknown {
  const row = asRecord(receipt);
  if (!row) return receipt;
  if (Array.isArray(row.tasks)) return { ...row, tasks: row.tasks.map((task) => asRecord(task) ? compactOneReceipt(task as Record<string, unknown>) : task) };
  return compactOneReceipt(row);
}

/** The stored results of one stage (of one task, or of every task of the run), as lane_pilot_wait_writer returns them on request. */
export function stageDetail(runId: string, stageId: string, stages: StageReceiptRow[]): Record<string, unknown> {
  const rows = stages.filter((stage) => stage.stageId === stageId);
  return {
    runId, stage: stageId,
    receipts: rows.map((stage) => {
      const result = asRecord(stage.result);
      // The raw model output repeats what the parsed fields already say.
      const { rawOutput: _raw, ...parsed } = result ?? {};
      return {
        taskId: stage.taskId, state: stage.state, attempt: stage.attempt, threadId: stage.threadId,
        ...(stage.reason ? { reason: stage.reason } : {}),
        ...(result ? { result: parsed } : stage.result != null ? { result: stage.result } : {}),
      };
    }),
    ...(rows.length ? {} : { note: `no ${stageId} receipt for this run${stages.length ? `; stages seen: ${[...new Set(stages.map((stage) => stage.stageId))].join(", ")}` : ""}` }),
  };
}
