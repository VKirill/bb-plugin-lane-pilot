/** Runtime-neutral POSIX path helpers so domain models stay free of `node:path`. */

export function isAbsolutePath(path: string): boolean {
  return path.startsWith("/");
}

export function posixNormalize(path: string): string {
  const absolute = path.startsWith("/");
  const trailing = path.endsWith("/") && path.length > 1;
  const parts: string[] = [];
  for (const seg of path.split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") {
      if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
      else if (!absolute) parts.push("..");
    } else {
      parts.push(seg);
    }
  }
  const joined = parts.join("/");
  if (absolute) return joined ? `/${joined}${trailing ? "/" : ""}` : "/";
  return joined ? `${joined}${trailing ? "/" : ""}` : (trailing ? "./" : ".");
}

export function dirnamePath(path: string): string {
  if (!path) return ".";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (!trimmed) return "/";
  const idx = trimmed.lastIndexOf("/");
  if (idx < 0) return ".";
  if (idx === 0) return "/";
  return trimmed.slice(0, idx);
}

export function resolvePath(...paths: string[]): string {
  let resolved = "";
  let resolvedAbsolute = false;
  for (let i = paths.length - 1; i >= -1 && !resolvedAbsolute; i--) {
    const path = i >= 0 ? paths[i]! : "/";
    if (!path) continue;
    resolved = resolved ? `${path}/${resolved}` : path;
    resolvedAbsolute = path.startsWith("/");
  }
  const normalized = posixNormalize(resolved);
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

export function relativePath(from: string, to: string): string {
  const fromResolved = resolvePath(from);
  const toResolved = resolvePath(to);
  if (fromResolved === toResolved) return "";
  const fromParts = fromResolved === "/" ? [] : fromResolved.slice(1).split("/");
  const toParts = toResolved === "/" ? [] : toResolved.slice(1).split("/");
  let common = 0;
  const limit = Math.min(fromParts.length, toParts.length);
  while (common < limit && fromParts[common] === toParts[common]) common++;
  const up = Array.from({ length: fromParts.length - common }, () => "..");
  return [...up, ...toParts.slice(common)].join("/");
}
