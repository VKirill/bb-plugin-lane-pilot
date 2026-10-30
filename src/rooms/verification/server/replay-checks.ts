/**
 * G2/G8: a check written as a chain of the same runner (`npx vitest run a.test.ts && npx vitest run b.test.ts`, or the
 * same command pasted twice) spends a suite startup per link — and a red first link has already spent the rest. The
 * replay glues what it can prove equivalent into one run:
 *   - exact repeats of one segment collapse to a single run;
 *   - segments identical everywhere but in bare positional arguments (test-file filters for vitest/jest) merge into one
 *     command with every filter.
 * A `||`, a pipe, a redirect, a flag value that differs (`--filter A` vs `--filter B`: whether the flag unions or
 * overrides is the runner's, not ours) and unequal shapes stay untouched — the chain runs as written.
 */

const PIPE_OR_REDIRECT = /(?:^|[^|])\|(?!\|)|\|\||[><`]|\\\s*\n/;

/** The chain's segments, or null when the command is not a plain `&&`/`;` sequence. */
function chainSegments(command: string): string[] | null {
  if (PIPE_OR_REDIRECT.test(command)) return null;
  const parts = command.split(/&&|;|\n/).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts : null;
}

/**
 * The chain as one command, or null when it cannot be glued safely. Two segments merge only when they have the same
 * token count and differ in positions where every segment holds a non-flag token that is not a flag's value — i.e.
 * positional filter arguments, which a test runner unions. Anything else keeps the chain.
 */
export function gluedCheckCommand(command: string): string | null {
  const parts = chainSegments(command);
  if (!parts || parts.length < 2) return null;
  const unique = [...new Set(parts)];
  if (unique.length === 1) return unique[0]!;
  const rows = unique.map((part) => part.split(/\s+/));
  const width = rows[0]!.length;
  if (!rows.every((row) => row.length === width)) return null;
  const diffCols: number[] = [];
  for (let col = 0; col < width; col++) {
    if (new Set(rows.map((row) => row[col])).size > 1) diffCols.push(col);
  }
  for (const col of diffCols) {
    const prev = rows[0]![col - 1];
    if (prev === undefined || diffCols.includes(col - 1)) return null;
    // A `--flag value` diff is the flag's value (union or override is the runner's); a `--flag=value` token is self-contained.
    if ((prev.startsWith("-") && !prev.includes("=")) || rows.some((row) => row[col]!.startsWith("-"))) return null;
  }
  const extra = diffCols.flatMap((col) => rows.slice(1).map((row) => row[col]!));
  return [...rows[0]!, ...extra].join(" ");
}

/**
 * The commands a replay actually runs: each check's command glued, then exact repeats of one (command, cwd) dropped —
 * the first, widened to the longest timeout asked. Distinct commands all stay, in order.
 */
export function glueReplayCommands<T extends { command: string; cwd?: string; timeoutSec?: number }>(commands: readonly T[]): T[] {
  const seen = new Map<string, T>();
  const out: T[] = [];
  for (const check of commands) {
    const row = { ...check, command: gluedCheckCommand(check.command) ?? check.command };
    const key = `${row.cwd ?? ""}\n${row.command}`;
    const earlier = seen.get(key);
    if (earlier) {
      earlier.timeoutSec = Math.max(earlier.timeoutSec ?? 0, row.timeoutSec ?? 0) as T["timeoutSec"];
      continue;
    }
    seen.set(key, row);
    out.push(row);
  }
  return out;
}
