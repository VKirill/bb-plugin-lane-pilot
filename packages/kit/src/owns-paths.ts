function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

/**
 * Glob → regex for ownership patterns. `*` and `?` stay inside one folder; `**` crosses folders, also inside a
 * name (src/**greeting-card*); a whole double-star segment may match no folder at all (a, **, b matches a/b).
 */
function globRegex(pattern: string): RegExp {
  const parts = normalize(pattern).split("/");
  let source = "";
  parts.forEach((part, index) => {
    const last = index === parts.length - 1;
    if (part === "**") { source += last ? ".*" : "(?:.*/)?"; return; }
    let piece = "";
    for (let k = 0; k < part.length; k++) {
      const char = part[k]!;
      if (char === "*" && part[k + 1] === "*") { piece += ".*"; k++; }
      else if (char === "*") piece += "[^/]*";
      else if (char === "?") piece += "[^/]";
      else piece += escapeRegExp(char);
    }
    source += piece + (last ? "" : "/");
  });
  return new RegExp(`^${source}$`);
}

export function fnmatch(path: string, pattern: string): boolean {
  return globRegex(pattern).test(normalize(path));
}

/**
 * Whether a changed file falls under an owns_paths / never_touch pattern:
 * - a plain path (no wildcard) names that file or everything under it, with or without a trailing slash;
 * - a pattern ending in a double-star segment is everything under any folder matching the rest
 *   (e.g. «*_cards_core» or «packages, *, .vite» followed by a double star);
 * - any other pattern is a glob (single star within a folder, double star across folders).
 */
export function matchOwnsPath(file: string, pattern: string): boolean {
  const path = normalize(file);
  const pat = normalize(pattern).replace(/\/+$/, (tail) => (pattern.endsWith("/**") ? tail : ""));
  if (!/[*?\[]/.test(pat)) return path === pat || path.startsWith(`${pat}/`);
  if (pat.endsWith("/**")) {
    const base = pat.slice(0, -3);
    if (!/[*?\[]/.test(base)) return path === base || path.startsWith(`${base}/`);
    const parts = path.split("/");
    for (let k = 1; k <= parts.length; k++) if (fnmatch(parts.slice(0, k).join("/"), base)) return true;
    return false;
  }
  return fnmatch(path, pat);
}

export function fileAllowedByOwns(file: string, ownsPaths: string[]): boolean {
  return ownsPaths.some((pattern) => matchOwnsPath(file, pattern));
}

export function fileBlockedByNeverTouch(file: string, neverTouch: string[]): boolean {
  return neverTouch.some((pattern) => matchOwnsPath(file, pattern));
}

/** The part of a pattern before its first wildcard: «apps/bot/**» → «apps/bot», «src/*.ts» → «src». */
function literalBase(pattern: string): string {
  const parts: string[] = [];
  for (const part of normalize(pattern).split("/")) {
    if (/[*?\[]/.test(part)) break;
    parts.push(part);
  }
  return parts.join("/").replace(/\/+$/, "");
}

/**
 * Whether two tasks may touch the same file. Conservative: patterns overlap when one's literal base contains
 * the other's, so a false «overlap» only makes a task wait, never lets two writers edit one file at once.
 */
export function ownsPathsOverlap(a: string[], b: string[]): boolean {
  return a.some((left) => b.some((right) => {
    const x = literalBase(left), y = literalBase(right);
    return !x || !y || x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  }));
}
