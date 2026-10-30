import { cleanCheckOutput } from "@lane-pilot/kit";
import type { Jev, JudgeContext } from "@lane-pilot/jev";
import { defineJudgment, noul, noulOf } from "@lane-pilot/jev";

/**
 * The failing check's log reaches the writer trimmed (mu: the agent fixes faster on the relevant lines than on the whole
 * output). Jev picks the chunks that help the fix, in one batched request per feedback; a line that carries an error —
 * file, line number, the complaint itself — is pinned in code and never leaves, so no error line is ever lost to a
 * wrong judgment. Short logs need no asking, and without Jev the old excerpt stands.
 */

/** A line the writer must always see: an error/fail mark, a `file:line` or `file(line,col)` pointer, an assertion. */
export const PINNED_LINE =
  /\bFAIL\b|\bAssertionError\b|\bExpected\b|\bReceived\b|error TS\d+|\bError:|✗|×|✘|✖|(?:^|[\s('"`])[\w@./+-]+\.[A-Za-z]{1,5}(?::\d+|\(\d+,\d+\))|\bat\s+[\w.<>]+\s+\([^)]*:\d+:\d+\)/i;

/** The runner's totals, pinned as well (vitest/jest print them after the details). */
const SUMMARY_LINE = /^\s*(?:Test Files|Tests|Suites|Errors?)\b/;

/** Lines of one chunk: small enough that a kept chunk is context, a dropped one is noise. */
export const LOG_CHUNK_LINES = 20;
/** The most chunks one judgment answers (its question cap); over it the head chunks win the asking, the rest stay. */
const MAX_CHUNKS_ASKED = 40;

export function splitLogChunks(cleaned: string): string[][] {
  const lines = cleaned.split("\n");
  const chunks: string[][] = [];
  for (let at = 0; at < lines.length; at += LOG_CHUNK_LINES) chunks.push(lines.slice(at, at + LOG_CHUNK_LINES));
  return chunks;
}

/** Chunks whose every pinned line must survive, marked by their own content; the rest Jev may drop. */
export function pinnedChunks(chunks: string[][]): boolean[] {
  return chunks.map((chunk) => chunk.some((line) => PINNED_LINE.test(line) || SUMMARY_LINE.test(line)));
}

export type LogChunkInput = { command: string; task: string; chunks: string[] };

export const LOG_TRIM_ID = "writer.log_trim";
export const logTrimJudgment = defineJudgment<LogChunkInput, boolean[]>({
  id: LOG_TRIM_ID,
  version: 1,
  defaultMode: "shadow",
  timeoutMs: 8_000,
  stateBuilder: (input) => ({
    failed_check: input.command.slice(0, 300),
    task: input.task.slice(0, 800),
    note: "Each `cN` question carries one chunk of the check's output, in order.",
  }),
  questions: (input) => Object.fromEntries(input.chunks.slice(0, MAX_CHUNKS_ASKED).map((chunk, index) => [`c${index + 1}`, noul(
    `Does this chunk of the failed check's output help the writer find and fix the failure described in \`task\`? Answer yes for chunks that name the error, the file or line that broke, an assertion diff, or the reason the check stopped; no for noise, progress, notices, unchanged-context dumps.`,
    { true: `keep chunk ${index + 1}: ${chunk.slice(0, 400)}`, false: "the chunk is noise or unrelated context" },
  )])),
  thresholds: {
    min_p: { default: 0.6, min: 0.1, max: 0.95, about: "least p(yes) for a chunk to be kept; pinned lines are kept regardless" },
  },
  decide: (answers, t, input) => ({
    decision: input.chunks.slice(0, MAX_CHUNKS_ASKED).map((_, index) => (noulOf(answers, `c${index + 1}`) ?? 1) >= t.min_p!),
  }),
  fallback: (input) => input.chunks.map(() => true),
  describe: (decision) => `${decision.filter(Boolean).length}/${decision.length} kept`,
});

/**
 * The kept log: every pinned chunk, the chunks `keep` marked, the others replaced by one omission note. `keep` covers
 * only the asked chunks; chunks past it stay verbatim (safer to keep than to drop what was never judged).
 */
export function joinTrimmedChunks(chunks: string[][], keep: readonly boolean[], maxChars = 0): { text: string; dropped: number } {
  const pinned = pinnedChunks(chunks);
  const out: string[] = [];
  let dropped = 0, chars = 0;
  chunks.forEach((chunk, index) => {
    const kept = pinned[index] || (index < keep.length ? keep[index] : true);
    // A pinned chunk is never cut, even over the budget; a kept one that no longer fits goes whole, not mid-line.
    if (kept && (pinned[index] || !maxChars || chars + chunk.join("\n").length <= maxChars)) { out.push(...chunk); chars += chunk.join("\n").length + 1; }
    else dropped += chunk.length;
  });
  const text = out.join("\n");
  return { text: dropped > 0 ? `${text}\n(${dropped} line${dropped === 1 ? "" : "s"} of check output omitted as noise; the full log is in the task folder.)` : text, dropped };
}

/** The failing check's output, trimmed for the feedback turn; null when there is nothing to cut or Jev may not be asked. */
export async function trimFailedCheckLog(
  jev: Jev | null,
  input: { command: string; output: string; task: string; maxChars?: number },
  ctx: JudgeContext = {},
): Promise<{ text: string; trimmed: boolean } | null> {
  const cleaned = cleanCheckOutput(input.output);
  const maxChars = input.maxChars ?? 4_000;
  if (cleaned.length <= maxChars || !jev || !jev.enabled(ctx.settings)) return null;
  const chunks = splitLogChunks(cleaned).map((chunk) => chunk.join("\n"));
  const verdict = await jev.judge(logTrimJudgment, { command: input.command, task: input.task, chunks }, ctx);
  if (verdict.by !== "jev") return null;
  const joined = joinTrimmedChunks(chunks.map((chunk) => chunk.split("\n")), verdict.decision, maxChars);
  if (joined.dropped === 0) return null;
  return { text: joined.text, trimmed: true };
}

/**
 * The failure record with its failing check's output replaced by the Jev-trimmed one, so `previousAttemptBrief` quotes
 * the relevant lines instead of the raw tail. The record itself (and the stored full log) is untouched: the trim lives
 * only in the copy the writer reads. Without Jev or a trim the same object comes back.
 */
export async function trimCheckLogsIn<T extends Record<string, unknown> | null | undefined>(
  jev: Jev | null,
  last: T,
  task: string,
  ctx: JudgeContext = {},
): Promise<T> {
  if (!last) return last;
  const checks = Array.isArray(last.verification) ? last.verification as Array<{ command?: string; exitCode?: number; stdout?: string; stderr?: string }> : null;
  const failed = checks?.find((check) => typeof check.exitCode === "number" && check.exitCode !== 0);
  if (!failed || !checks) return last;
  const trimmed = await trimFailedCheckLog(jev, { command: failed.command ?? "", output: `${failed.stderr ?? ""}\n${failed.stdout ?? ""}`, task }, ctx).catch(() => null);
  if (!trimmed?.trimmed) return last;
  return { ...last, verification: checks.map((check) => check === failed ? { ...check, stdout: trimmed.text, stderr: "" } : check) };
}
