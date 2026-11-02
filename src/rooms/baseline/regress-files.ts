import type { RegressionRecord } from "./store";

/**
 * The files of an open regression that quarantine a waiting task (W32 rank 8, narrowed 2026-11-02 after SelfyStudio
 * cab-core-brace waited forever): only the files the check can actually touch — the row's evidence.sharedFiles plus
 * every path literal in the check command. A prefix literal joined to a variable (`'.agents/prototypes/'+p`) does
 * not name a file and does not count; joined to another literal it does (`'a/b/'+'c/d.html'` → `a/b/c/d.html`).
 * A check whose files cannot be known (no shared files, no literal) keeps the old cautious union of every file the
 * culprit and the original task changed — the caller falls back to it.
 */

/** Two or more segments, no spaces and no scheme: `a/b/c`, `.agents/prototypes/x` (a trailing slash marks a prefix). */
const PATHY = /^\.?[\w@~-]*[\w@-](?:\/[\w.@+-]+)+\/?$/;
/** One segment with a file extension: `package.json`, `editor.html`; not a number like `1.2.3`. */
const FILEY = /^\.?[A-Za-z_@~-][\w@-]*\.[\w@-]{1,10}$/;

const pathy = (text: string) => PATHY.test(text) && !text.startsWith("http");
const filey = (text: string) => pathy(text) || (FILEY.test(text) && !/^[\d.]+$/.test(text));

/** Every path literal in a shell command: quoted or bare tokens, `+` concatenations of literals joined. */
export function commandPathLiterals(command: string): string[] {
  const files = new Set<string>();
  // `'prefix/'+'rest'` (or the same in double quotes): a path literal joined to a prefix literal counts as the joined path.
  for (const match of command.matchAll(/(['"])([^'"\n]*)\1\+(['"])([^'"\n]*)\3/g)) {
    const joined = `${match[2]}${match[4]}`;
    if (filey(joined) && !joined.endsWith("/")) files.add(joined.replace(/\/+$/, ""));
  }
  for (const match of command.matchAll(/'([^'\n]*)'|"([^"\n]*)"|([^\s'"|;&<>(){}$`\\]+)/g)) {
    const raw = match[1] ?? match[2] ?? match[3]!;
    let pending = "";
    for (const part of raw.split("+")) {
      const text = pending + part;
      pending = "";
      if (!filey(part)) {
        // A prefix literal joined to a non-literal (a variable) names no file; only literal+literal counts.
        if (filey(text) && !text.endsWith("/")) files.add(text.replace(/\/+$/, ""));
        continue;
      }
      if (part.endsWith("/")) { pending = part; continue; }
      files.add(text.replace(/\/+$/, ""));
    }
  }
  return [...files];
}

/**
 * The quarantine file set of a row: evidence.sharedFiles ∪ path literals of the check command. Empty when neither is
 * known; the caller then falls back to the union of the changed files (a check it cannot read stays cautious).
 */
export function quarantineFilesOf(row: RegressionRecord): string[] {
  const shared = Array.isArray((row.evidence as { sharedFiles?: unknown } | null)?.sharedFiles)
    ? ((row.evidence as { sharedFiles: unknown[] }).sharedFiles).filter((x): x is string => typeof x === "string")
    : [];
  return [...new Set([...shared, ...commandPathLiterals(row.command)])];
}

/**
 * The files a waiting task must not share with an open regression: the narrowed set when it is known; the old union of
 * the shared files and every file the culprit and the broken task changed when it is not. `changed(taskId)` lists the
 * files an accepted attempt of the task changed.
 */
export function quarantineFileSet(row: RegressionRecord, changed: (taskId: string) => string[]): string[] {
  const narrowed = quarantineFilesOf(row);
  if (narrowed.length) return narrowed;
  return [...new Set([...(row.culpritTask ? changed(row.culpritTask) : []), ...changed(row.taskId)])];
}
