/**
 * The accepted result as a helper brief needs it. The stored acceptance record carries every check's full stdout/stderr
 * (65 % of the memory-maintenance brief: 45k tokens median, 164k p90 on SelfyStudio, week of 2026-10-07), the reasoning
 * trace, the duplicate acceptance object and ids. The maintainer and the night reviewer need the writer's report, the
 * files it produced and what each check said at the end; a failed check's full log is on disk at `checkLogPath`.
 */

import { cleanCheckOutput, failureExcerpt } from "@lane-pilot/kit";

const OUTPUT_CAP = 2000;
const COMMAND_CAP = 300;
const TAIL_CAP = 400;
const TAIL_LINES = 3;
const PATH_CAP = 200;
const MAX_PRODUCED = 60;
const MAX_CHECKS = 20;

const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === "string" ? value : "";
const clip = (value: string, cap: number): string => value.length > cap ? `${value.slice(0, cap)}… [+${value.length - cap} chars]` : value;

/** Cleaned output without the npm spinner (a lone `\` before the next line's text) and the `npm notice` block it leaves behind. */
function scrub(raw: string): string {
  return cleanCheckOutput(raw).split("\n").map((line) => line.replace(/^[\\|/-]+(?=\S)/, "").trimEnd())
    .filter((line) => line.trim() && !/^[\\|/-]$/.test(line.trim()) && !/^\s*npm (?:notice|warn)\b/.test(line)).join("\n");
}

/** A passing check: the test runner's final summary lines (they print before the timing lines) and the last few lines. */
function passTail(raw: string): string {
  const lines = scrub(raw).split("\n").map((line) => line.trim());
  const last = lines.slice(-TAIL_LINES);
  const summary = ["Test Files", "Tests"].map((name) => [...lines].reverse().find((line) => line.startsWith(name))).filter((line): line is string => !!line && !last.includes(line));
  return [...summary, ...last].map((line) => clip(line, 160)).join("\n").slice(-TAIL_CAP);
}

function compactCheck(check: unknown): Record<string, unknown> {
  const row = record(check);
  const exitCode = typeof row.exitCode === "number" ? row.exitCode : null;
  const raw = `${text(row.stdout)}\n${text(row.stderr)}`;
  const tail = exitCode === 0 ? passTail(raw) : failureExcerpt(scrub(`${text(row.stderr)}\n${text(row.stdout)}`), TAIL_CAP);
  return { command: clip(text(row.command), COMMAND_CAP), exitCode, ...(tail ? { tail } : {}),
    outputChars: text(row.stdout).length + text(row.stderr).length };
}

/** Same facts, a few kB instead of hundreds. Anything that is not an acceptance record is returned as it is. */
export function compactAcceptedResult(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  const source = record(result);
  const checks = Array.isArray(source.verification) ? source.verification : [];
  const produced = Array.isArray(source.produced) ? source.produced.filter((item): item is string => typeof item === "string") : [];
  const warnings = Array.isArray(source.warnings) ? source.warnings.filter((item): item is string => typeof item === "string") : [];
  return {
    status: source.status,
    output: clip(text(source.output), OUTPUT_CAP),
    produced: [...produced.slice(0, MAX_PRODUCED).map((path) => clip(path, PATH_CAP)), ...(produced.length > MAX_PRODUCED ? [`… +${produced.length - MAX_PRODUCED} more`] : [])],
    verification: [...checks.slice(0, MAX_CHECKS).map(compactCheck), ...(checks.length > MAX_CHECKS ? [{ omitted: checks.length - MAX_CHECKS }] : [])],
    ...(typeof source.checkLogPath === "string" ? { checkLogPath: source.checkLogPath } : {}),
    ...(warnings.length ? { warnings: warnings.slice(0, 10).map((item) => clip(item, 300)) } : {}),
    ...(typeof source.turns === "number" ? { turns: source.turns } : {}),
    ...(source.emergencyFallback ? { emergencyFallback: source.emergencyFallback } : {}),
  };
}
