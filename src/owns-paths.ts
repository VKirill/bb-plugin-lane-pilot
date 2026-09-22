function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globPartToRegex(part: string): string {
  let source = "";
  for (const char of part) {
    if (char === "*") source += "[^/]*";
    else if (char === "?") source += "[^/]";
    else source += escapeRegExp(char);
  }
  return source;
}

export function fnmatch(path: string, pattern: string): boolean {
  const source = normalize(pattern)
    .split("/")
    .map((part) => part === "**" ? ".*" : globPartToRegex(part))
    .join("/");
  return new RegExp(`^${source}$`).test(normalize(path));
}

export function matchOwnsPath(file: string, pattern: string): boolean {
  const path = normalize(file);
  const pat = normalize(pattern);
  if (pat.endsWith("/**")) {
    const prefix = pat.slice(0, -3).replace(/\/$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (/[*?\[]/.test(pat)) return fnmatch(path, pat);
  return path === pat || path.startsWith(pat.endsWith("/") ? pat : `${pat}/`);
}

export function fileAllowedByOwns(file: string, ownsPaths: string[]): boolean {
  return ownsPaths.some((pattern) => matchOwnsPath(file, pattern));
}

export function fileBlockedByNeverTouch(file: string, neverTouch: string[]): boolean {
  return neverTouch.some((pattern) => matchOwnsPath(file, pattern));
}
