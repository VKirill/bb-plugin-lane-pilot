/**
 * Check output reaches the writer twice: quoted in the retry brief and saved under the task folder's logs/. The
 * terminal pads both with escape codes and redraws and npm pads the log with notices, so both sinks read the same
 * cleaned text (retry-brief-clean-output, 2026-10-06).
 */

/** A check's own complaint: the FAIL header, an assertion or diff, a compiler error, or any error/fail line. */
const FAILURE_MARK = /\bFAIL\b|\bAssertionError\b|\bError:|\bExpected\b|\bReceived\b|error TS|error|fail/i;

/** The run's summary, printed by vitest and jest alike after the details. */
const SUMMARY_MARK = /^\s*(?:Test Files|Tests)\b/;

/** Escape sequences (OSC/CSI and leftovers), other control bytes, `npm notice` lines and blank-line runs, gone. */
export function cleanCheckOutput(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;:?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "")
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "")
    .split("\n").filter((line) => !/^\s*npm notice/.test(line)).join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The failure, not the tail: from the first line of the check's own complaint up to `limit` chars, plus the summary
 * lines when they fell outside that window; without a recognisable complaint, the cleaned tail.
 */
export function failureExcerpt(text: string, limit = 1500): string {
  const cleaned = cleanCheckOutput(text);
  const lines = cleaned ? cleaned.split("\n") : [];
  const start = lines.findIndex((line) => FAILURE_MARK.test(line));
  let excerpt = start < 0 ? cleaned.slice(-limit) : lines.slice(start).join("\n").slice(0, limit);
  for (const line of lines) if (SUMMARY_MARK.test(line) && !excerpt.includes(line)) excerpt += `\n${line}`;
  return excerpt;
}
